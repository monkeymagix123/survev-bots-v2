import { MapObjectDefs } from "../../../../../shared/defs/mapObjectDefs";
import type { ObstacleDef } from "../../../../../shared/defs/mapObjectsTyping";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { collider } from "../../../../../shared/utils/collider";
import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import type { Game } from "../../game";
import type { Building } from "../../objects/building";
import type { Obstacle } from "../../objects/obstacle";
import type { Player } from "../../objects/player";
import type { Structure } from "../../objects/structure";
import { isBotUnarmed } from "../botDecisionSupport";
import { BotTuning } from "../botTuning";
import type { BotMacroGoal, BotTacticalGoal } from "../botCombat";

type FailedWaypoint = {
    pos: Vec2;
    until: number;
};

type RouteTrace = {
    blocked: boolean;
    hitDist: number;
    len: number;
    hitObstacle?: Obstacle;
};

type WarehouseTransition = {
    buildingId: number;
    mode: "enter" | "exit";
    goal: Vec2;
    opening: Vec2;
    until: number;
};

type StairTransition = {
    structureId: number;
    stairIndex: number;
    targetLayer: 0 | 1;
    goal: Vec2;
    until: number;
};

type BuildingDoorTransition = {
    buildingId: number;
    doorId: number;
    mode: "enter" | "exit" | "interior";
    targetSide?: -1 | 1;
    goal: Vec2;
    until: number;
};

type WaypointPick = {
    pos: Vec2;
    ttl: number;
    meta: WaypointMeta;
};

type InterestWaypointCandidate = {
    pos: Vec2;
    score: number;
    macroGoal: BotMacroGoal;
    targetZoneId?: number;
    targetBuildingId?: number;
};

type WaypointMeta = {
    macroGoal: BotMacroGoal;
    targetZoneId?: number;
    targetBuildingId?: number;
    targetZonePos?: Vec2;
    zoneScore?: number;
};

type DoorSideSign = -1 | 1;

export class BotNavigationLite {
    waypoint?: Vec2;
    waypointTtl = 0;
    waypointMeta?: WaypointMeta;

    private _time = 0;
    private _strafeTicker = 0;
    private _strafeSign = 1;
    private _detourWaypoint?: Vec2;
    private _detourGoal?: Vec2;
    private _detourUntil = -Infinity;
    private _detourCommitUntil = -Infinity;
    private _detourBlockerId?: number;
    private _detourSideSign?: -1 | 1;
    private _failedWaypoints: FailedWaypoint[] = [];
    private _forceDetourGoal?: Vec2;
    private _forceDetourUntil = -Infinity;
    private _progressPos?: Vec2;
    private _progressGoal?: Vec2;
    private _stuckTimer = 0;
    private _nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;
    private _fallbackGoal?: Vec2;
    private _fallbackMode?: "waypoint" | "center";
    private _stairTransition?: StairTransition;
    private _buildingDoorTransition?: BuildingDoorTransition;
    private _warehouseTransition?: WarehouseTransition;
    private readonly _routeTraceCache = new Map<string, RouteTrace>();

    tick(dt: number, hasTarget: boolean): void {
        this._time += dt;

        if (!hasTarget) {
            this.waypointTtl -= dt;
        }

        if (this._detourWaypoint && this._time >= this._detourUntil) {
            this._clearDetour();
        }
        if (this._forceDetourGoal && this._time >= this._forceDetourUntil) {
            this._clearForcedDetour();
        }
        if (this._stairTransition && this._time >= this._stairTransition.until) {
            this._clearStairTransition();
        }
        if (
            this._buildingDoorTransition &&
            this._time >= this._buildingDoorTransition.until
        ) {
            this._clearBuildingDoorTransition();
        }
        if (
            this._warehouseTransition &&
            this._time >= this._warehouseTransition.until
        ) {
            this._clearWarehouseTransition();
        }

        this._failedWaypoints = this._failedWaypoints.filter(
            (entry) => entry.until > this._time,
        );
    }

    isHardStuck(): boolean {
        return this._stuckTimer >= BotTuning.navigation.hardUnstuckSec;
    }

    resetForHardUnstuck(): void {
        this.waypoint = undefined;
        this.waypointTtl = 0;
        this.waypointMeta = undefined;
        this._clearDetour();
        this._clearFallback();
        this._clearForcedDetour();
        this._clearStairTransition();
        this._clearBuildingDoorTransition();
        this._clearWarehouseTransition();
        this._progressPos = undefined;
        this._progressGoal = undefined;
        this._stuckTimer = 0;
        this._nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;
        this._failedWaypoints = [];
        this._routeTraceCache.clear();
    }

    getSafeZoneGoal(game: Game, player: Player): Vec2 {
        const gas = game.gas;
        const inset = BotTuning.navigation.safeZoneGoalInset;
        const delta = v2.sub(player.pos, gas.posNew);
        if (v2.lengthSqr(delta) <= 0.0001) {
            return v2.copy(gas.posNew);
        }

        const dir = v2.normalizeSafe(delta, v2.create(1, 0));
        const safeRadius = Math.max(gas.radNew - inset, 0);
        const goal = v2.add(gas.posNew, v2.mul(dir, safeRadius));
        game.map.clampToMapBounds(goal, player.rad);
        return goal;
    }

    ensureWaypoint(game: Game, player: Player): void {
        const waypointReached =
            !!this.waypoint &&
            v2.distance(player.pos, this.waypoint) <= BotTuning.navigation.arriveDist;

        if (!this.waypoint || this.waypointTtl <= 0 || waypointReached) {
            const nextWaypoint = this._pickWaypoint(game, player);
            this.waypoint = nextWaypoint.pos;
            this.waypointTtl = nextWaypoint.ttl;
            this.waypointMeta = nextWaypoint.meta;
        }
    }

    getGoal(
        game: Game,
        player: Player,
        gasEmergency: boolean,
        targetPos?: Vec2,
        overrideGoal?: Vec2,
        arriveDist: number = BotTuning.navigation.arriveDist,
    ): Vec2 | undefined {
        this._routeTraceCache.clear();

        const desiredGoal = this._getDesiredGoal(
            game,
            gasEmergency,
            targetPos,
            overrideGoal,
        );
        if (!desiredGoal) {
            return undefined;
        }

        if (v2.distance(player.pos, desiredGoal) <= arriveDist) {
            this._clearDetour();
            this._clearFallback();
            this._clearForcedDetour();
            this._clearStairTransition();
            this._clearBuildingDoorTransition();
            this._clearWarehouseTransition();
        }

        if (
            this._detourWaypoint &&
            this._reachedPoint(player.pos, this._detourWaypoint, arriveDist)
        ) {
            this._clearDetour();
        }
        if (
            this._fallbackGoal &&
            this._reachedPoint(player.pos, this._fallbackGoal, arriveDist)
        ) {
            this._clearFallback();
        }
        if (
            this._warehouseTransition &&
            this._reachedPoint(
                player.pos,
                this._warehouseTransition.opening,
                arriveDist,
            )
        ) {
            this._clearWarehouseTransition();
        }

        const routeGoal = this._fallbackMode
            ? this._getFallbackGoal(game)
            : desiredGoal;
        if (!routeGoal) {
            return undefined;
        }

        const structuredGoal = this._resolveStructuredGoal(
            game,
            player,
            routeGoal,
            gasEmergency,
        );
        const activeGoal = structuredGoal ?? routeGoal;

        const directTrace = this._traceRoute(game, player, player.pos, activeGoal);
        const forceDetour = this._shouldForceDetour(activeGoal);

        const detourCommitted = this._time < this._detourCommitUntil;
        if (
            this._detourWaypoint &&
            this._detourGoal &&
            this._sameGoal(activeGoal, this._detourGoal) &&
            this._isNavPointValid(game, player, this._detourWaypoint, gasEmergency) &&
            !this._isRecentlyFailed(this._detourWaypoint) &&
            !this._traceRoute(game, player, player.pos, this._detourWaypoint).blocked &&
            (directTrace.blocked || forceDetour || detourCommitted)
        ) {
            return this._detourWaypoint;
        }

        if (!directTrace.blocked && !forceDetour) {
            this._clearDetour();
            return activeGoal;
        }

        const detour = this._pickDetourWaypoint(
            game,
            player,
            activeGoal,
            directTrace,
            gasEmergency,
        );
        if (detour) {
            this._detourWaypoint = detour.pos;
            this._detourGoal = v2.copy(activeGoal);
            this._detourUntil = this._time + BotTuning.navigation.detourTtlSec;
            this._detourCommitUntil =
                this._time + BotTuning.navigation.detourCommitSec;
            this._detourBlockerId = detour.blockerId;
            this._detourSideSign = detour.sideSign;
            return detour.pos;
        }

        return activeGoal;
    }

    getTravelTacticalGoal(
        game: Game,
        player: Player,
        goal: Vec2 | undefined,
        fallback: BotTacticalGoal,
    ): BotTacticalGoal {
        if (!goal) return fallback;

        const stairTactical = this._classifyStairTravelTacticalGoal(game, player, goal);
        if (stairTactical) return stairTactical;

        const activeBuildingTransition =
            this._getActiveBuildingDoorTransitionForGoal(goal);
        if (activeBuildingTransition?.mode === "enter") {
            return "enter_building";
        }
        if (activeBuildingTransition?.mode === "exit") {
            return "exit_building";
        }
        if (
            activeBuildingTransition?.mode === "interior" &&
            this.getTravelUseDoorTarget(game, player, goal)
        ) {
            return "use_door";
        }

        const buildingTactical = this._classifyBuildingTravelTacticalGoal(
            game,
            player,
            goal,
        );
        if (buildingTactical) return buildingTactical;

        return fallback;
    }

    getTravelUseDoorTarget(
        game: Game,
        player: Player,
        goal: Vec2 | undefined,
    ): Obstacle | undefined {
        const transition = goal
            ? this._getActiveBuildingDoorTransitionForGoal(goal)
            : undefined;
        if (!goal || !transition) {
            return undefined;
        }

        const buildingObj = game.objectRegister.getById(transition.buildingId);
        const doorObj = game.objectRegister.getById(transition.doorId);
        if (
            !buildingObj ||
            buildingObj.__type !== ObjectType.Building ||
            !doorObj ||
            doorObj.__type !== ObjectType.Obstacle
        ) {
            return undefined;
        }

        const building = buildingObj as Building;
        const door = doorObj as Obstacle;
        if (
            !door.isDoor ||
            !door.door ||
            door.dead ||
            door.destroyed ||
            door.door.locked ||
            !door.door.canUse ||
            door.door.autoOpen ||
            door.door.open ||
            !util.sameLayer(door.layer, player.layer)
        ) {
            return undefined;
        }

        const inside = this._isPointInsideBuilding(building, player.pos, player.layer);
        if (
            (transition.mode === "enter" && inside) ||
            (transition.mode === "exit" && !inside)
        ) {
            return undefined;
        }

        return door;
    }

    private _getActiveBuildingDoorTransitionForGoal(
        goal: Vec2,
    ): BuildingDoorTransition | undefined {
        const transition = this._buildingDoorTransition;
        if (!transition) return undefined;
        if (!this._sameGoal(goal, transition.goal)) return undefined;
        if (this._time >= transition.until) return undefined;
        return transition;
    }

    observeMovement(params: {
        dt: number;
        game: Game;
        player: Player;
        goal?: Vec2;
        arriveDist?: number;
        moveLeft: boolean;
        moveRight: boolean;
        moveUp: boolean;
        moveDown: boolean;
    }): void {
        const {
            dt,
            game,
            player,
            goal,
            arriveDist = BotTuning.navigation.arriveDist,
            moveLeft,
            moveRight,
            moveUp,
            moveDown,
        } = params;
        const attemptedMove = moveLeft || moveRight || moveUp || moveDown;
        const intentionalStationary =
            !goal || v2.distance(player.pos, goal) <= arriveDist;

        if (!attemptedMove) {
            if (intentionalStationary) {
                this._progressPos = v2.copy(player.pos);
                this._progressGoal = goal ? v2.copy(goal) : undefined;
                this._stuckTimer = 0;
                this._nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;
                this._clearFallback();
                this._clearForcedDetour();
                return;
            }

            if (
                !goal ||
                !this._progressGoal ||
                !this._sameGoal(goal, this._progressGoal)
            ) {
                this._progressPos = v2.copy(player.pos);
                this._progressGoal = goal ? v2.copy(goal) : undefined;
                this._stuckTimer = 0;
                this._nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;
            }
            this._advanceStuckRecovery(dt, game, player, goal);
            return;
        }

        if (
            !goal ||
            !this._progressPos ||
            !this._progressGoal ||
            !this._sameGoal(goal, this._progressGoal)
        ) {
            this._progressPos = v2.copy(player.pos);
            this._progressGoal = goal ? v2.copy(goal) : undefined;
            this._stuckTimer = 0;
            this._nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;
            return;
        }

        const progressDist = v2.distance(player.pos, this._progressPos);
        if (progressDist >= BotTuning.navigation.progressDist) {
            this._progressPos = v2.copy(player.pos);
            this._progressGoal = v2.copy(goal);
            this._stuckTimer = 0;
            this._nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;
            this._clearFallback();
            this._clearForcedDetour();
            return;
        }

        this._advanceStuckRecovery(dt, game, player, goal);
    }

    private _advanceStuckRecovery(
        dt: number,
        game: Game,
        player: Player,
        goal: Vec2,
    ): void {
        this._stuckTimer += dt;

        if (
            this._stuckTimer >= BotTuning.navigation.fallbackCenterAfterSec &&
            this._fallbackMode !== "center"
        ) {
            this._fallbackMode = "center";
            this._fallbackGoal = undefined;
        } else if (
            this._stuckTimer >= BotTuning.navigation.fallbackWaypointAfterSec &&
            !this._fallbackMode
        ) {
            this._fallbackMode = "waypoint";
            this._fallbackGoal = this._pickWaypoint(game, player).pos;
            this._clearDetour();
            this._clearForcedDetour();
        }

        if (
            this._stuckTimer >= this._nextRepathAt &&
            this._nextRepathAt < BotTuning.navigation.fallbackWaypointAfterSec
        ) {
            this._invalidateRoute(goal);
            this._nextRepathAt += BotTuning.navigation.stuckRepathAfterSec;
            this._progressPos = v2.copy(player.pos);
            this._progressGoal = v2.copy(goal);
        }
    }

    applyMovementInput(params: {
        msg: {
            moveLeft: boolean;
            moveRight: boolean;
            moveUp: boolean;
            moveDown: boolean;
        };
        player: Player;
        goal?: Vec2;
        hasTarget: boolean;
        gasEmergency: boolean;
        distToTarget?: number;
        allowStrafe: boolean;
        strafeSign?: -1 | 1;
        anchor: boolean;
        aimDir: Vec2;
        dt: number;
        moveDeadzone?: number;
    }): void {
        const {
            msg,
            player,
            goal,
            hasTarget,
            gasEmergency,
            distToTarget,
            allowStrafe,
            strafeSign,
            anchor,
            aimDir,
            dt,
            moveDeadzone = 1,
        } = params;

        msg.moveLeft = false;
        msg.moveRight = false;
        msg.moveUp = false;
        msg.moveDown = false;

        if (!goal || anchor) return;

        const toGoal = v2.sub(goal, player.pos);
        const dist = distToTarget ?? v2.length(toGoal);

        const dd = moveDeadzone;
        const strafe =
            allowStrafe &&
            hasTarget &&
            dist < BotTuning.combat.strafeEnableMaxDist &&
            !gasEmergency;
        if (strafe) {
            this._strafeTicker -= dt;
            if (strafeSign !== undefined) {
                this._strafeSign = strafeSign;
            } else if (this._strafeTicker <= 0) {
                this._strafeTicker = util.random(
                    BotTuning.combat.strafeFlipSecMin,
                    BotTuning.combat.strafeFlipSecMax,
                );
                this._strafeSign = Math.random() < 0.5 ? -1 : 1;
            }

            const perp = v2.perp(aimDir);
            const strafeGoal = v2.add(
                player.pos,
                v2.mul(perp, BotTuning.combat.strafePerpDist * this._strafeSign),
            );
            if (strafeGoal.x > player.pos.x + dd) msg.moveRight = true;
            else if (strafeGoal.x < player.pos.x - dd) msg.moveLeft = true;
            if (strafeGoal.y > player.pos.y + dd) msg.moveUp = true;
            else if (strafeGoal.y < player.pos.y - dd) msg.moveDown = true;
        } else {
            if (goal.x > player.pos.x + dd) msg.moveRight = true;
            else if (goal.x < player.pos.x - dd) msg.moveLeft = true;
            if (goal.y > player.pos.y + dd) msg.moveUp = true;
            else if (goal.y < player.pos.y - dd) msg.moveDown = true;
        }
    }

    private _pickWaypoint(game: Game, player?: Player): WaypointPick {
        if (player) {
            const interesting = this._pickLocalInterestWaypoint(game, player);
            if (interesting) {
                return interesting;
            }

            const regionalInterest = this._pickRegionalInterestWaypoint(game, player);
            if (regionalInterest) {
                return regionalInterest;
            }

            const localRoam = this._pickLocalRoamWaypoint(game, player);
            if (localRoam) {
                return localRoam;
            }
        }

        if (player) {
            const safeRoam = this._pickSafeRoamWaypoint(game, player);
            if (safeRoam) {
                return safeRoam;
            }
        }

        return {
            pos: v2.copy(game.gas.posNew),
            ttl: this._getRoamWaypointTtl(),
            meta: {
                macroGoal: "rotate_safe",
                targetZonePos: v2.copy(game.gas.posNew),
            },
        };
    }

    private _pickLocalInterestWaypoint(
        game: Game,
        player: Player,
    ): WaypointPick | undefined {
        const obstacleCandidates: InterestWaypointCandidate[] = [];
        const buildingCandidates: InterestWaypointCandidate[] = [];
        const nearby = game.grid.intersectCollider(
            collider.createCircle(player.pos, BotTuning.navigation.waypointBuildingSearchDist),
        );
        const currentBuildingId = this._getContainingBuildingId(game, player.pos, player.layer);

        for (const obj of nearby) {
            if (!obj || !("pos" in obj)) continue;
            if (!util.sameLayer(obj.layer, player.layer)) continue;

            if (obj.__type === ObjectType.Obstacle) {
                const obstacle = obj as Obstacle;
                if (
                    this._isInterestingRoamObstacle(
                        obstacle,
                        player,
                        BotTuning.navigation.waypointInterestSearchDist,
                    )
                ) {
                    obstacleCandidates.push({
                        pos: v2.copy(obstacle.pos),
                        score: this._scoreInterestingObstacleWaypoint(player, obstacle),
                        macroGoal: "loot_zone",
                        targetZoneId: obstacle.__id,
                        targetBuildingId: obstacle.parentBuilding?.__id,
                    });
                }
                continue;
            }

            if (obj.__type === ObjectType.Building) {
                const building = obj as Building;
                if (building.__id === currentBuildingId) continue;
                if (
                    v2.distance(player.pos, building.pos) <=
                    BotTuning.navigation.waypointBuildingSearchDist
                ) {
                    buildingCandidates.push({
                        pos: v2.copy(building.pos),
                        score: this._scoreInterestingBuildingWaypoint(game, player, building),
                        macroGoal: "loot_building",
                        targetZoneId: building.__id,
                        targetBuildingId: building.__id,
                    });
                }
            }
        }

        const obstacleChoice = this._pickBestInterestWaypoint(
            game,
            player,
            obstacleCandidates,
        );
        if (obstacleChoice) return obstacleChoice;

        return this._pickBestInterestWaypoint(game, player, buildingCandidates);
    }

    private _pickRegionalInterestWaypoint(
        game: Game,
        player: Player,
    ): WaypointPick | undefined {
        const obstacleCandidates: InterestWaypointCandidate[] = [];
        const buildingCandidates: InterestWaypointCandidate[] = [];
        const searchDist = Math.max(
            BotTuning.navigation.waypointRegionalSearchDist,
            BotTuning.navigation.waypointBuildingSearchDist,
        );
        const nearby = game.grid.intersectCollider(
            collider.createCircle(player.pos, searchDist),
        );
        const currentBuildingId = this._getContainingBuildingId(game, player.pos, player.layer);

        for (const obj of nearby) {
            if (!obj || !("pos" in obj)) continue;
            if (!util.sameLayer(obj.layer, player.layer)) continue;

            if (obj.__type === ObjectType.Obstacle) {
                const obstacle = obj as Obstacle;
                if (
                    this._isInterestingRoamObstacle(
                        obstacle,
                        player,
                        searchDist,
                    )
                ) {
                    obstacleCandidates.push({
                        pos: v2.copy(obstacle.pos),
                        score: this._scoreInterestingObstacleWaypoint(player, obstacle),
                        macroGoal: "loot_zone",
                        targetZoneId: obstacle.__id,
                        targetBuildingId: obstacle.parentBuilding?.__id,
                    });
                }
                continue;
            }

            if (obj.__type === ObjectType.Building) {
                const building = obj as Building;
                if (building.__id === currentBuildingId) continue;
                if (v2.distance(player.pos, building.pos) <= searchDist) {
                    buildingCandidates.push({
                        pos: v2.copy(building.pos),
                        score: this._scoreInterestingBuildingWaypoint(game, player, building),
                        macroGoal: "loot_building",
                        targetZoneId: building.__id,
                        targetBuildingId: building.__id,
                    });
                }
            }
        }

        const obstacleChoice = this._pickBestInterestWaypoint(
            game,
            player,
            obstacleCandidates,
        );
        if (obstacleChoice) return obstacleChoice;

        return this._pickBestInterestWaypoint(game, player, buildingCandidates);
    }

    private _pickLocalRoamWaypoint(game: Game, player: Player): WaypointPick | undefined {
        let best: Vec2 | undefined;
        let bestScore = Infinity;
        for (let attempts = 0; attempts < 10; attempts++) {
            const candidate = v2.add(
                player.pos,
                util.randomPointInCircle(BotTuning.navigation.waypointLocalRoamDist),
            );
            game.map.clampToMapBounds(candidate, player.rad);
            if (
                v2.distance(player.pos, candidate) <
                BotTuning.navigation.waypointLocalRoamMinStep
            ) {
                continue;
            }
            if (!this._isNavPointValid(game, player, candidate, false)) continue;
            const score = this._getWaypointCandidateScore(game, player, candidate);
            if (score < bestScore) {
                bestScore = score;
                best = v2.copy(candidate);
            }
        }
        return best
            ? {
                  pos: best,
                  ttl: this._getRoamWaypointTtl(),
                  meta: {
                      macroGoal: "rotate_safe",
                      targetZonePos: v2.copy(best),
                  },
              }
            : undefined;
    }

    private _pickBestInterestWaypoint(
        game: Game,
        player: Player,
        candidates: InterestWaypointCandidate[],
    ): WaypointPick | undefined {
        if (candidates.length === 0) return undefined;

        const shuffled = [...candidates];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        let best: Vec2 | undefined;
        let bestScore = -Infinity;
        let bestCandidate: InterestWaypointCandidate | undefined;

        for (const candidate of shuffled) {
            const pos = v2.copy(candidate.pos);
            game.map.clampToMapBounds(pos, player.rad);
            if (!this._isNavPointValid(game, player, pos, false)) continue;
            if (
                v2.distance(player.pos, pos) <
                BotTuning.navigation.waypointLocalRoamMinStep
            ) {
                continue;
            }
            const score =
                candidate.score -
                v2.distance(player.pos, pos) *
                    BotTuning.navigation.waypointInterestDistancePenalty -
                this._getWaypointCrowdScore(game, player, pos) *
                    BotTuning.navigation.waypointInterestCrowdPenalty;
            if (score > bestScore) {
                bestScore = score;
                best = pos;
                bestCandidate = candidate;
            }
        }

        return best
            ? {
                  pos: best,
                      ttl: this._getZoneWaypointTtl(),
                      meta: {
                          macroGoal: bestCandidate?.macroGoal ?? "loot_zone",
                          targetZoneId: bestCandidate?.targetZoneId,
                          targetBuildingId: bestCandidate?.targetBuildingId,
                          targetZonePos: v2.copy(best),
                          zoneScore: Number(bestScore.toFixed(2)),
                      },
                  }
            : undefined;
    }

    private _pickSafeRoamWaypoint(game: Game, player: Player): WaypointPick | undefined {
        let best: Vec2 | undefined;
        let bestScore = Infinity;

        for (let attempts = 0; attempts < 16; attempts++) {
            const candidate = v2.add(
                player.pos,
                util.randomPointInCircle(BotTuning.navigation.waypointRegionalSearchDist),
            );
            game.map.clampToMapBounds(candidate, player.rad);
            if (game.gas.isOutSideSafeZone(candidate)) continue;
            if (game.map.isOnWater(candidate, player.layer)) continue;
            if (
                v2.distance(player.pos, candidate) <
                BotTuning.navigation.waypointLocalRoamMinStep
            ) {
                continue;
            }
            if (!this._isNavPointValid(game, player, candidate, false)) continue;

            const score = this._getWaypointCandidateScore(game, player, candidate);
            if (score < bestScore) {
                bestScore = score;
                best = v2.copy(candidate);
            }
        }

        return best
            ? {
                  pos: best,
                  ttl: this._getRoamWaypointTtl(),
                  meta: {
                      macroGoal: "rotate_safe",
                      targetZonePos: v2.copy(best),
                  },
              }
            : undefined;
    }

    private _getWaypointCandidateScore(
        game: Game,
        player: Player,
        candidate: Vec2,
    ): number {
        return (
            v2.distance(player.pos, candidate) * 0.02 +
            this._getWaypointCrowdScore(game, player, candidate)
        );
    }

    private _getWaypointCrowdScore(
        game: Game,
        player: Player,
        candidate: Vec2,
    ): number {
        const radius = BotTuning.navigation.waypointCrowdRadius;
        const nearby = game.grid.intersectCollider(collider.createCircle(candidate, radius));
        let score = 0;

        for (const obj of nearby) {
            if (obj.__type !== ObjectType.Player) continue;
            const other = obj as Player;
            if (other.__id === player.__id || other.dead || other.downed || other.disconnected) {
                continue;
            }
            if (!util.sameLayer(other.layer, player.layer)) continue;

            const dist = v2.distance(candidate, other.pos);
            if (dist > radius) continue;
            const proximity = 1 - dist / radius;
            score += proximity * BotTuning.navigation.waypointCrowdPlayerWeight;
            if (!isBotUnarmed(other)) {
                score += proximity * BotTuning.navigation.waypointCrowdArmedWeight;
            }
        }

        return score;
    }

    private _getRoamWaypointTtl(): number {
        return util.random(
            BotTuning.navigation.waypointRoamTtlMinSec,
            BotTuning.navigation.waypointRoamTtlMaxSec,
        );
    }

    private _getZoneWaypointTtl(): number {
        return util.random(
            BotTuning.navigation.waypointZoneTtlMinSec,
            BotTuning.navigation.waypointZoneTtlMaxSec,
        );
    }

    private _scoreInterestingObstacleWaypoint(
        player: Player,
        obstacle: Obstacle,
    ): number {
        const def = MapObjectDefs[obstacle.type];
        if (def.type !== "obstacle") return 0;

        return (
            this._getObstacleInterestValue(def as ObstacleDef) -
            v2.distance(player.pos, obstacle.pos) * 0.2
        );
    }

    private _scoreInterestingBuildingWaypoint(
        game: Game,
        player: Player,
        building: Building,
    ): number {
        let score = BotTuning.navigation.waypointBuildingBaseScore;
        let lootScore = 0;

        for (const child of building.childObjects) {
            if (child.__type !== ObjectType.Obstacle) continue;
            const obstacle = child as Obstacle;
            if (obstacle.dead || !util.sameLayer(obstacle.layer, player.layer)) continue;

            const def = MapObjectDefs[obstacle.type];
            if (def.type !== "obstacle") continue;
            lootScore += this._getObstacleInterestValue(def as ObstacleDef);
        }

        score += lootScore * BotTuning.navigation.waypointBuildingLootScale;
        score -= v2.distance(player.pos, building.pos) * 0.16;
        score -= this._getWaypointCrowdScore(game, player, building.pos) * 12;
        return score;
    }

    private _getObstacleInterestValue(def: ObstacleDef): number {
        return (
            def.loot.length * BotTuning.navigation.waypointObstacleLootScore +
            (def.destroyType ? BotTuning.navigation.waypointObstacleDestroyScore : 0) +
            (def.airdropCrate ? BotTuning.navigation.waypointObstacleAirdropScore : 0)
        );
    }

    private _getDesiredGoal(
        game: Game,
        gasEmergency: boolean,
        targetPos?: Vec2,
        overrideGoal?: Vec2,
    ): Vec2 | undefined {
        if (overrideGoal) {
            return overrideGoal;
        }
        if (gasEmergency) {
            return game.gas.posNew;
        }
        if (targetPos) {
            return targetPos;
        }
        if (this.waypoint) {
            return this.waypoint;
        }
        return undefined;
    }

    private _getFallbackGoal(game: Game): Vec2 | undefined {
        if (this._fallbackMode === "center") {
            return game.gas.posNew;
        }
        if (this._fallbackMode === "waypoint") {
            this._fallbackGoal ??= this._pickWaypoint(game).pos;
            return this._fallbackGoal;
        }
        return undefined;
    }

    private _pickDetourWaypoint(
        game: Game,
        player: Player,
        goal: Vec2,
        directTrace: RouteTrace,
        gasEmergency: boolean,
    ): { pos: Vec2; blockerId?: number; sideSign?: -1 | 1 } | undefined {
        const buildingCornerWaypoint = this._pickBuildingCornerWaypoint(
            game,
            player,
            goal,
            directTrace,
            gasEmergency,
        );
        if (buildingCornerWaypoint) {
            return buildingCornerWaypoint;
        }

        const blockerOrbitWaypoint = this._pickBlockerOrbitWaypoint(
            game,
            player,
            goal,
            directTrace,
            gasEmergency,
        );
        if (blockerOrbitWaypoint) {
            return blockerOrbitWaypoint;
        }

        const wallSlideWaypoint = this._pickWallSlideWaypoint(
            game,
            player,
            goal,
            directTrace,
            gasEmergency,
        );
        if (wallSlideWaypoint) {
            return wallSlideWaypoint;
        }

        const len = directTrace.len;
        if (len <= 0.0001) return undefined;

        const toGoal = v2.sub(goal, player.pos);
        const dir = v2.normalizeSafe(toGoal, v2.create(1, 0));
        const perp = v2.perp(dir);
        const hitPoint = v2.add(
            player.pos,
            v2.mul(dir, Math.max(directTrace.hitDist - 0.5, 0.5)),
        );
        const directCoverage = directTrace.hitDist / Math.max(directTrace.len, 0.001);

        let bestPos: Vec2 | undefined;
        let bestScore = -Infinity;
        let bestSideSign: -1 | 1 | undefined;
        const preferCommittedSide =
            directTrace.hitObstacle &&
            this._detourBlockerId === directTrace.hitObstacle.__id &&
            this._time < this._detourCommitUntil
                ? this._detourSideSign
                : undefined;

        const sideDists = [
            BotTuning.navigation.detourSideShortDist,
            BotTuning.navigation.detourSideLongDist,
        ];
        const forwardOffsets = [0, BotTuning.navigation.detourForwardBiasDist];

        for (const sideSign of [-1, 1] as const) {
            for (const sideDist of sideDists) {
                for (const forwardOffset of forwardOffsets) {
                    const candidate = v2.add(
                        hitPoint,
                        v2.add(
                            v2.mul(perp, sideDist * sideSign),
                            v2.mul(dir, forwardOffset),
                        ),
                    );

                    game.map.clampToMapBounds(candidate, player.rad);
                    if (!this._isNavPointValid(game, player, candidate, gasEmergency)) continue;
                    if (this._isRecentlyFailed(candidate)) continue;

                    const firstLeg = this._traceRoute(
                        game,
                        player,
                        player.pos,
                        candidate,
                    );
                    if (firstLeg.blocked) continue;

                    const secondLeg = this._traceRoute(game, player, candidate, goal);
                    const secondCoverage = secondLeg.hitDist / Math.max(secondLeg.len, 0.001);
                    if (secondLeg.blocked && secondCoverage <= directCoverage + 0.08) {
                        continue;
                    }

                    const distFromBot = v2.distance(player.pos, candidate);
                    const distToGoal = v2.distance(candidate, goal);
                    const score =
                        (secondLeg.blocked ? 0 : 1000) +
                        secondCoverage * 180 +
                        (len - distToGoal) * 6 -
                        distFromBot * 1.5 -
                        distToGoal * 0.25;
                    const sideCommitBonus =
                        preferCommittedSide !== undefined &&
                        preferCommittedSide === sideSign
                            ? BotTuning.navigation.detourSameSideBonus
                            : 0;

                    if (score + sideCommitBonus > bestScore) {
                        bestScore = score + sideCommitBonus;
                        bestPos = v2.copy(candidate);
                        bestSideSign = sideSign;
                    }
                }
            }
        }

        return bestPos
            ? {
                  pos: bestPos,
                  blockerId: directTrace.hitObstacle?.__id,
                  sideSign: bestSideSign,
              }
            : undefined;
    }

    private _pickBuildingCornerWaypoint(
        game: Game,
        player: Player,
        goal: Vec2,
        directTrace: RouteTrace,
        gasEmergency: boolean,
    ): { pos: Vec2; blockerId?: number } | undefined {
        const blocker = directTrace.hitObstacle;
        const building = blocker?.parentBuilding;
        if (!blocker || !building) {
            return undefined;
        }
        if (
            this._isPointInsideBuilding(building, player.pos, player.layer) ||
            this._isPointInsideBuilding(building, goal, player.layer)
        ) {
            return undefined;
        }

        const bounds = this._getBuildingLocalSurfaceBounds(building);
        const cornerInset = BotTuning.navigation.buildingCornerOutsideDist;
        const localCandidates = [
            v2.create(bounds.min.x - cornerInset, bounds.min.y - cornerInset),
            v2.create(bounds.min.x - cornerInset, bounds.max.y + cornerInset),
            v2.create(bounds.max.x + cornerInset, bounds.min.y - cornerInset),
            v2.create(bounds.max.x + cornerInset, bounds.max.y + cornerInset),
        ];

        const directCoverage = directTrace.hitDist / Math.max(directTrace.len, 0.001);
        let bestPos: Vec2 | undefined;
        let bestScore = -Infinity;

        for (const local of localCandidates) {
            const candidate = this._toWorldPoint(building, local);
            game.map.clampToMapBounds(candidate, player.rad);

            if (!this._isNavPointValid(game, player, candidate, gasEmergency)) continue;
            if (this._isRecentlyFailed(candidate)) continue;

            const firstLeg = this._traceRoute(game, player, player.pos, candidate);
            if (firstLeg.blocked) continue;

            const secondLeg = this._traceRoute(game, player, candidate, goal);
            const secondCoverage = secondLeg.hitDist / Math.max(secondLeg.len, 0.001);
            if (secondLeg.blocked && secondCoverage <= directCoverage + 0.12) {
                continue;
            }

            const distFromBot = v2.distance(player.pos, candidate);
            const distToGoal = v2.distance(candidate, goal);
            const score =
                (secondLeg.blocked ? 0 : 1200) +
                secondCoverage * 220 -
                distFromBot * 1.2 -
                distToGoal * 0.2;

            if (score > bestScore) {
                bestScore = score;
                bestPos = v2.copy(candidate);
            }
        }

        return bestPos
            ? {
                  pos: bestPos,
                  blockerId: blocker.__id,
              }
            : undefined;
    }

    private _traceRoute(
        game: Game,
        player: Player,
        start: Vec2,
        goal: Vec2,
    ): RouteTrace {
        const cacheKey = this._getRouteTraceCacheKey(player.layer, start, goal);
        const cached = this._routeTraceCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const len = v2.distance(start, goal);
        if (len <= 0.0001) {
            const result = {
                blocked: false,
                hitDist: 0,
                len,
            };
            this._routeTraceCache.set(cacheKey, result);
            return result;
        }

        const dir = v2.normalizeSafe(v2.sub(goal, start), v2.create(1, 0));
        const aabb = coldet.lineSegmentToAabb(start, goal);
        const nearby = game.grid.intersectCollider(aabb);
        const obstacles = nearby.filter(
            (obj): obj is Obstacle =>
                obj.__type === ObjectType.Obstacle &&
                this._blocksMovement(player, obj),
        );

        const hit = collisionHelpers.intersectSegment(
            obstacles,
            start,
            dir,
            len,
            0.0,
            player.layer,
            false,
        );
        const hitDist = hit?.dist ?? len;
        const hitObstacle = hit
            ? obstacles.find((obstacle) => obstacle.__id === hit.id)
            : undefined;

        const result = {
            blocked: hitDist < len - 0.05,
            hitDist,
            len,
            hitObstacle,
        };
        this._routeTraceCache.set(cacheKey, result);
        return result;
    }

    private _resolveStructuredGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        return (
            this._getStairTransitionGoal(game, player, goal, gasEmergency) ??
            this._getContainerExitGoal(game, player, goal, gasEmergency) ??
            this._getWarehouseTransitionGoal(game, player, goal, gasEmergency) ??
            this._getBuildingInteriorGoal(game, player, goal, gasEmergency) ??
            this._getBuildingDoorTransitionGoal(game, player, goal, gasEmergency)
        );
    }

    private _getStairTransitionGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const committedTransition = this._getCommittedStairTransition(
            game,
            player,
            goal,
            gasEmergency,
        );
        if (committedTransition) {
            return committedTransition;
        }

        const currentBaseLayer = util.toGroundLayer(player.layer) as 0 | 1;
        const goalBaseLayer = this._getGoalBaseLayer(game, goal);
        if (player.layer < 2 && currentBaseLayer === goalBaseLayer) {
            this._clearStairTransition();
            return undefined;
        }

        const transition = this._pickStairTransition(
            game,
            player,
            goal,
            currentBaseLayer,
            goalBaseLayer,
            gasEmergency,
        );
        if (!transition) {
            this._clearStairTransition();
            return undefined;
        }

        this._stairTransition = transition;
        return this._resolveStairTransitionGoal(
            game,
            player,
            transition,
            gasEmergency,
        );
    }

    private _classifyStairTravelTacticalGoal(
        game: Game,
        player: Player,
        goal: Vec2,
    ): BotTacticalGoal | undefined {
        const currentBaseLayer = util.toGroundLayer(player.layer) as 0 | 1;
        const goalBaseLayer = this._getGoalBaseLayer(game, goal);
        if (player.layer < 2 && currentBaseLayer === goalBaseLayer) {
            return undefined;
        }
        return goalBaseLayer === 1 ? "enter_tunnel" : "exit_tunnel";
    }

    private _getContainerExitGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const building = this._getContainingContainer(game, player);
        if (!building || this._isPointInsideBuilding(building, goal, player.layer)) {
            return undefined;
        }

        const candidates = this._getContainerExitCandidates(game, player, building);
        let bestCandidate: Vec2 | undefined;
        let bestScore = Infinity;
        for (const candidate of candidates) {
            if (!this._isNavPointValid(game, player, candidate, gasEmergency)) continue;
            if (this._traceRoute(game, player, player.pos, candidate).blocked) continue;

            const score =
                v2.distance(candidate, goal) + v2.distance(player.pos, candidate) * 0.2;
            if (score < bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }

        return bestCandidate;
    }

    private _getContainingContainer(game: Game, player: Player): Building | undefined {
        return this._getContainingStructuredBuilding(
            game,
            player.pos,
            player.layer,
            (building) => this._isContainerBuilding(building),
        );
    }

    private _isContainerBuilding(building: Building): boolean {
        return building.type.startsWith("container_");
    }

    private _getWarehouseTransitionGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const committedTransition = this._getCommittedWarehouseTransition(
            player,
            goal,
        );
        if (committedTransition) {
            return committedTransition;
        }

        const currentWarehouse = this._getContainingWarehouse(
            game,
            player.pos,
            player.layer,
        );
        if (
            currentWarehouse &&
            !this._isPointInsideBuilding(currentWarehouse, goal, player.layer)
        ) {
            const opening = this._pickWarehouseOpeningGoal(
                game,
                player,
                currentWarehouse,
                goal,
                gasEmergency,
                "exit",
            );
            if (opening) {
                this._setWarehouseTransition(
                    currentWarehouse.__id,
                    "exit",
                    goal,
                    opening,
                );
            }
            return opening;
        }

        const goalWarehouse = this._getContainingWarehouse(game, goal, player.layer);
        if (!currentWarehouse && goalWarehouse) {
            const opening = this._pickWarehouseOpeningGoal(
                game,
                player,
                goalWarehouse,
                goal,
                gasEmergency,
                "enter",
            );
            if (opening) {
                this._setWarehouseTransition(
                    goalWarehouse.__id,
                    "enter",
                    goal,
                    opening,
                );
            }
            return opening;
        }

        this._clearWarehouseTransition();
        return undefined;
    }

    private _getCommittedWarehouseTransition(
        player: Player,
        goal: Vec2,
    ): Vec2 | undefined {
        const transition = this._warehouseTransition;
        if (!transition) return undefined;
        if (this._time >= transition.until) {
            this._clearWarehouseTransition();
            return undefined;
        }
        if (!this._sameGoal(goal, transition.goal)) {
            this._clearWarehouseTransition();
            return undefined;
        }
        if (
            this._reachedPoint(
                player.pos,
                transition.opening,
                BotTuning.navigation.arriveDist,
            )
        ) {
            this._clearWarehouseTransition();
            return undefined;
        }
        return transition.opening;
    }

    private _getContainingWarehouse(
        game: Game,
        point: Vec2,
        layer: number,
    ): Building | undefined {
        return this._getContainingStructuredBuilding(game, point, layer, (building) =>
            this._isWarehouseBuilding(building),
        );
    }

    private _getContainingStructuredBuilding(
        game: Game,
        point: Vec2,
        layer: number,
        predicate: (building: Building) => boolean,
    ): Building | undefined {
        const objs = game.grid.intersectPos(point);
        let best: Building | undefined;
        let bestZIdx = -Infinity;

        for (const obj of objs) {
            if (obj.__type !== ObjectType.Building) continue;
            const building = obj as Building;
            if (!predicate(building)) continue;
            if (building.zIdx < bestZIdx) continue;
            if (!this._isPointInsideBuilding(building, point, layer)) continue;
            best = building;
            bestZIdx = building.zIdx;
        }

        return best;
    }

    private _getContainingBuildingId(
        game: Game,
        point: Vec2,
        layer: number,
    ): number | undefined {
        return this._getContainingStructuredBuilding(game, point, layer, () => true)?.__id;
    }

    private _isInterestingRoamObstacle(
        obstacle: Obstacle,
        player: Player,
        maxDist: number,
    ): boolean {
        if (
            obstacle.dead ||
            obstacle.isWindow ||
            !obstacle.destructible ||
            obstacle.health <= 0 ||
            v2.distance(player.pos, obstacle.pos) > maxDist
        ) {
            return false;
        }

        const def = MapObjectDefs[obstacle.type];
        if (def.type !== "obstacle") return false;

        const obstacleDef = def as ObstacleDef;
        return (
            obstacleDef.loot.length > 0 ||
            !!obstacleDef.destroyType ||
            !!obstacleDef.airdropCrate
        );
    }

    private _isWarehouseBuilding(building: Building): boolean {
        return (
            building.type.startsWith("warehouse_01") ||
            building.type.startsWith("warehouse_02")
        );
    }

    private _isPointInsideBuilding(
        building: Building,
        point: Vec2,
        layer: number,
    ): boolean {
        if (!util.sameLayer(building.layer, layer)) return false;
        for (const surface of building.surfaces) {
            for (const collision of surface.colliders) {
                if (collider.intersectCircle(collision, point, 0.01)) {
                    return true;
                }
            }
        }
        return false;
    }

    private _getContainerExitCandidates(
        game: Game,
        player: Player,
        building: Building,
    ): Vec2[] {
        const exits: Vec2[] = [];
        const outsideDist = BotTuning.navigation.containerExitOutsideDist;
        const halfLen =
            building.type === "container_04"
                ? BotTuning.navigation.containerOpenHalfLen
                : BotTuning.navigation.containerClosedHalfLen;
        const localExitYs =
            building.type === "container_04"
                ? [-halfLen - outsideDist, halfLen + outsideDist]
                : [-halfLen - outsideDist];

        for (const localY of localExitYs) {
            const local = v2.create(0, localY);
            const world = v2.add(v2.rotate(local, building.rot), building.pos);
            game.map.clampToMapBounds(world, player.rad);
            exits.push(world);
        }

        return exits;
    }

    private _getCommittedStairTransition(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const transition = this._stairTransition;
        if (!transition) return undefined;
        if (this._time >= transition.until) {
            this._clearStairTransition();
            return undefined;
        }
        if (!this._sameGoal(goal, transition.goal)) {
            this._clearStairTransition();
            return undefined;
        }
        if (
            util.toGroundLayer(player.layer) === transition.targetLayer &&
            player.layer < 2
        ) {
            this._clearStairTransition();
            return undefined;
        }
        const transitionGoal = this._resolveStairTransitionGoal(
            game,
            player,
            transition,
            gasEmergency,
        );
        if (!transitionGoal) {
            this._clearStairTransition();
            return undefined;
        }
        return transitionGoal;
    }

    private _getGoalBaseLayer(game: Game, goal: Vec2): 0 | 1 {
        const stairSideLayer = this._getGoalStairSideLayer(game, goal);
        if (stairSideLayer !== undefined) {
            return stairSideLayer;
        }

        const objs = game.grid.intersectPos(goal);
        let bestBuilding: Building | undefined;
        let bestZIdx = -Infinity;
        for (const obj of objs) {
            if (obj.__type !== ObjectType.Building) continue;
            const building = obj as Building;
            if (building.zIdx < bestZIdx) continue;
            if (!this._isPointInsideBuildingLayerExact(building, goal, building.layer)) {
                continue;
            }
            bestBuilding = building;
            bestZIdx = building.zIdx;
        }

        return bestBuilding?.layer === 1 ? 1 : 0;
    }

    private _getGoalStairSideLayer(game: Game, goal: Vec2): 0 | 1 | undefined {
        const objs = game.grid.intersectPos(goal);
        for (const obj of objs) {
            if (obj.__type !== ObjectType.Structure) continue;
            const structure = obj as Structure;
            for (const stair of structure.stairs) {
                if (coldet.testCircleAabb(goal, 0.05, stair.downAabb.min, stair.downAabb.max)) {
                    return 1;
                }
                if (coldet.testCircleAabb(goal, 0.05, stair.upAabb.min, stair.upAabb.max)) {
                    return 0;
                }
            }
        }
        return undefined;
    }

    private _pickStairTransition(
        game: Game,
        player: Player,
        goal: Vec2,
        currentBaseLayer: 0 | 1,
        targetLayer: 0 | 1,
        gasEmergency: boolean,
    ): StairTransition | undefined {
        let bestTransition: StairTransition | undefined;
        let bestScore = Infinity;

        const structures = game.objectRegister.objects;
        for (const obj of structures) {
            if (!obj || obj.__type !== ObjectType.Structure) continue;
            const structure = obj as Structure;

            for (let stairIndex = 0; stairIndex < structure.stairs.length; stairIndex++) {
                const stair = structure.stairs[stairIndex];
                const entryCandidates = this._getStairSideCandidates(
                    stair,
                    currentBaseLayer,
                    "enter",
                );
                const exitCandidates = this._getStairSideCandidates(
                    stair,
                    targetLayer,
                    "exit",
                );

                let bestEntry: Vec2 | undefined;
                let bestEntryScore = Infinity;
                for (const candidate of entryCandidates) {
                    game.map.clampToMapBounds(candidate, player.rad);
                    if (!this._isNavPointValid(game, player, candidate, gasEmergency)) {
                        continue;
                    }

                    const trace = this._traceRoute(game, player, player.pos, candidate);
                    if (trace.blocked) continue;

                    const score = v2.distance(player.pos, candidate);
                    if (score < bestEntryScore) {
                        bestEntryScore = score;
                        bestEntry = v2.copy(candidate);
                    }
                }
                if (!bestEntry) continue;

                let bestExitDist = Infinity;
                for (const candidate of exitCandidates) {
                    bestExitDist = Math.min(bestExitDist, v2.distance(candidate, goal));
                }

                const score = bestEntryScore + bestExitDist * 0.35;
                if (score < bestScore) {
                    bestScore = score;
                    bestTransition = {
                        structureId: structure.__id,
                        stairIndex,
                        targetLayer,
                        goal: v2.copy(goal),
                        until: this._time + BotTuning.navigation.stairTransitionCommitSec,
                    };
                }
            }
        }

        return bestTransition;
    }

    private _resolveStairTransitionGoal(
        game: Game,
        player: Player,
        transition: StairTransition,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const structure = game.objectRegister.getById(transition.structureId);
        if (!structure || structure.__type !== ObjectType.Structure) {
            return undefined;
        }

        const stair = (structure as Structure).stairs[transition.stairIndex];
        if (!stair) {
            return undefined;
        }

        const onStair =
            player.layer >= 2 ||
            coldet.testCircleAabb(
                player.pos,
                Math.max(player.rad, 0.25),
                stair.collision.min,
                stair.collision.max,
            );
        const sideLayer = onStair
            ? transition.targetLayer
            : (util.toGroundLayer(player.layer) as 0 | 1);
        const candidates = this._getStairSideCandidates(
            stair,
            sideLayer,
            onStair ? "exit" : "enter",
        );

        let bestCandidate: Vec2 | undefined;
        let bestScore = Infinity;
        for (const candidate of candidates) {
            game.map.clampToMapBounds(candidate, player.rad);
            if (!this._isNavPointValid(game, player, candidate, gasEmergency)) continue;

            const trace = this._traceRoute(game, player, player.pos, candidate);
            if (trace.blocked) continue;

            const score = v2.distance(player.pos, candidate);
            if (score < bestScore) {
                bestScore = score;
                bestCandidate = v2.copy(candidate);
            }
        }

        return bestCandidate;
    }

    private _getStairSideCandidates(
        stair: Structure["stairs"][0],
        sideLayer: 0 | 1,
        mode: "enter" | "exit",
    ): Vec2[] {
        const sideAabb = sideLayer === 0 ? stair.upAabb : stair.downAabb;
        const sideCenter = this._getAabbCenter(sideAabb);
        const pushDir = v2.normalizeSafe(
            v2.sub(sideCenter, stair.center),
            sideLayer === 0 ? v2.create(0, 1) : v2.create(0, -1),
        );
        const tangent = v2.perp(pushDir);
        const forwardInset =
            mode === "exit" ? BotTuning.navigation.stairExitInset : 0;
        const base = v2.add(sideCenter, v2.mul(pushDir, forwardInset));
        const sideOffset = 1.2;

        return [
            base,
            v2.add(base, v2.mul(tangent, sideOffset)),
            v2.add(base, v2.mul(tangent, -sideOffset)),
        ];
    }

    private _getBuildingDoorTransitionGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const committedTransition = this._getCommittedBuildingDoorTransition(
            game,
            player,
            goal,
            gasEmergency,
            ["enter", "exit"],
        );
        if (committedTransition) {
            return committedTransition;
        }

        const currentBuilding = this._getContainingStructuredBuilding(
            game,
            player.pos,
            player.layer,
            () => true,
        );
        if (
            currentBuilding &&
            !this._isPointInsideBuilding(currentBuilding, goal, player.layer)
        ) {
            const transition = this._pickBuildingDoorTransition(
                game,
                player,
                currentBuilding,
                goal,
                gasEmergency,
                "exit",
            );
            if (transition) {
                this._buildingDoorTransition = transition;
                return this._resolveBuildingDoorTransitionGoal(
                    game,
                    player,
                    transition,
                    gasEmergency,
                );
            }
        }

        const goalBuilding = this._getContainingStructuredBuilding(
            game,
            goal,
            this._getGoalBaseLayer(game, goal),
            () => true,
        );
        if (!currentBuilding && goalBuilding) {
            const transition = this._pickBuildingDoorTransition(
                game,
                player,
                goalBuilding,
                goal,
                gasEmergency,
                "enter",
            );
            if (transition) {
                this._buildingDoorTransition = transition;
                return this._resolveBuildingDoorTransitionGoal(
                    game,
                    player,
                    transition,
                    gasEmergency,
                );
            }
        }

        this._clearBuildingDoorTransition();
        return undefined;
    }

    private _getBuildingInteriorGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const committedTransition = this._getCommittedBuildingDoorTransition(
            game,
            player,
            goal,
            gasEmergency,
            ["interior"],
        );
        if (committedTransition) {
            return committedTransition;
        }

        const currentBuilding = this._getContainingStructuredBuilding(
            game,
            player.pos,
            player.layer,
            () => true,
        );
        if (!currentBuilding) {
            return undefined;
        }

        const goalBuilding = this._getContainingStructuredBuilding(
            game,
            goal,
            this._getGoalBaseLayer(game, goal),
            () => true,
        );
        if (!goalBuilding) {
            return undefined;
        }

        const sameBuilding = currentBuilding.__id === goalBuilding.__id;
        const sameStructure =
            currentBuilding.parentStructure &&
            goalBuilding.parentStructure &&
            currentBuilding.parentStructure.__id === goalBuilding.parentStructure.__id;
        if (!sameBuilding && !sameStructure) {
            return undefined;
        }

        const directTrace = this._traceRoute(game, player, player.pos, goal);
        if (!directTrace.blocked) {
            return undefined;
        }

        const transition = this._pickBuildingInteriorTransition(
            game,
            player,
            currentBuilding,
            goal,
            gasEmergency,
        );
        if (!transition) {
            return undefined;
        }

        this._buildingDoorTransition = transition;
        return this._resolveBuildingDoorTransitionGoal(
            game,
            player,
            transition,
            gasEmergency,
        );
    }

    private _classifyBuildingTravelTacticalGoal(
        game: Game,
        player: Player,
        goal: Vec2,
    ): BotTacticalGoal | undefined {
        const currentBuilding = this._getContainingStructuredBuilding(
            game,
            player.pos,
            player.layer,
            () => true,
        );
        if (
            currentBuilding &&
            !this._isPointInsideBuilding(currentBuilding, goal, player.layer)
        ) {
            return "exit_building";
        }

        const goalBuilding = this._getContainingStructuredBuilding(
            game,
            goal,
            this._getGoalBaseLayer(game, goal),
            () => true,
        );
        if (!currentBuilding && goalBuilding) {
            return "enter_building";
        }

        return undefined;
    }

    private _getCommittedBuildingDoorTransition(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
        modes?: Array<BuildingDoorTransition["mode"]>,
    ): Vec2 | undefined {
        const transition = this._buildingDoorTransition;
        if (!transition) return undefined;
        if (modes && !modes.includes(transition.mode)) {
            return undefined;
        }
        if (this._time >= transition.until) {
            this._clearBuildingDoorTransition();
            return undefined;
        }
        if (!this._sameGoal(goal, transition.goal)) {
            this._clearBuildingDoorTransition();
            return undefined;
        }
        const transitionGoal = this._resolveBuildingDoorTransitionGoal(
            game,
            player,
            transition,
            gasEmergency,
        );
        if (!transitionGoal) {
            this._clearBuildingDoorTransition();
            return undefined;
        }
        return transitionGoal;
    }

    private _pickBuildingDoorTransition(
        game: Game,
        player: Player,
        building: Building,
        goal: Vec2,
        gasEmergency: boolean,
        mode: "enter" | "exit",
    ): BuildingDoorTransition | undefined {
        const candidates = this._getBuildingTransitionCandidates(
            game,
            player,
            building,
            mode,
        );
        let bestCandidate: BuildingDoorTransition | undefined;
        let bestScore = Infinity;

        for (const candidate of candidates) {
            if (!this._isNavPointValid(game, player, candidate.approachPos, gasEmergency)) {
                continue;
            }
            if (!this._isNavPointValid(game, player, candidate.crossPos, gasEmergency)) {
                continue;
            }
            if (this._traceRoute(game, player, player.pos, candidate.approachPos).blocked) {
                continue;
            }

            const score =
                v2.distance(player.pos, candidate.approachPos) * 0.35 +
                v2.distance(candidate.crossPos, goal);
            if (score < bestScore) {
                bestScore = score;
                bestCandidate = {
                    buildingId: building.__id,
                    doorId: candidate.doorId,
                    mode,
                    goal: v2.copy(goal),
                    until:
                        this._time + BotTuning.navigation.buildingDoorTransitionCommitSec,
                };
            }
        }

        return bestCandidate;
    }

    private _pickBuildingInteriorTransition(
        game: Game,
        player: Player,
        building: Building,
        goal: Vec2,
        gasEmergency: boolean,
    ): BuildingDoorTransition | undefined {
        const insideInset = BotTuning.navigation.buildingDoorInsideInset;
        const outsideInset = BotTuning.navigation.buildingDoorOutsideInset;
        const goalBuilding = this._getContainingStructuredBuilding(
            game,
            goal,
            this._getGoalBaseLayer(game, goal),
            () => true,
        );
        if (!goalBuilding) {
            return undefined;
        }

        type DoorGraphNode =
            | { kind: "start"; pos: Vec2 }
            | { kind: "goal"; pos: Vec2 }
            | {
                  kind: "door";
                  pos: Vec2;
                  doorId: number;
                  buildingId: number;
                  side: DoorSideSign;
              };

        const traversalBuildings = this._getInteriorTraversalBuildings(
            game,
            building,
            goalBuilding,
            player.layer,
        );
        const nodes: DoorGraphNode[] = [
            { kind: "start", pos: v2.copy(player.pos) },
            { kind: "goal", pos: v2.copy(goal) },
        ];

        for (const traversalBuilding of traversalBuildings) {
            for (const obj of traversalBuilding.childObjects) {
                if (obj.__type !== ObjectType.Obstacle) continue;
                const obstacle = obj as Obstacle;
                if (!util.sameLayer(obstacle.layer, player.layer)) continue;
                if (!obstacle.isDoor || !obstacle.door) continue;

                const sidePoints = this._getBuildingDoorSidePoints(
                    game,
                    player,
                    traversalBuilding,
                    obstacle,
                    insideInset,
                    outsideInset,
                );

                for (const side of [-1, 1] as const) {
                    const pos = sidePoints.bySide[side];
                    if (!this._isDoorTraversableWithoutBreaking(obstacle, pos)) {
                        continue;
                    }
                    if (!this._isNavPointValid(game, player, pos, gasEmergency)) continue;
                    nodes.push({
                        kind: "door",
                        pos: v2.copy(pos),
                        doorId: obstacle.__id,
                        buildingId: traversalBuilding.__id,
                        side,
                    });
                }
            }
        }

        if (nodes.length <= 2) {
            return undefined;
        }

        const nodeCount = nodes.length;
        const distances = new Array<number>(nodeCount).fill(Number.POSITIVE_INFINITY);
        const previous = new Array<number>(nodeCount).fill(-1);
        const visited = new Array<boolean>(nodeCount).fill(false);
        distances[0] = 0;

        const relax = (from: number, to: number, weight: number): void => {
            const nextDist = distances[from] + weight;
            if (nextDist < distances[to]) {
                distances[to] = nextDist;
                previous[to] = from;
            }
        };

        for (let iter = 0; iter < nodeCount; iter++) {
            let current = -1;
            let bestDist = Number.POSITIVE_INFINITY;
            for (let index = 0; index < nodeCount; index++) {
                if (visited[index]) continue;
                if (distances[index] < bestDist) {
                    bestDist = distances[index];
                    current = index;
                }
            }
            if (current === -1 || current === 1) break;
            visited[current] = true;

            const currentNode = nodes[current];
            for (let next = 0; next < nodeCount; next++) {
                if (next === current || visited[next]) continue;
                const nextNode = nodes[next];

                if (
                    currentNode.kind === "door" &&
                    nextNode.kind === "door" &&
                    currentNode.doorId === nextNode.doorId &&
                    currentNode.side !== nextNode.side
                ) {
                    relax(current, next, 0.25);
                    continue;
                }

                if (
                    this._traceRoute(game, player, currentNode.pos, nextNode.pos).blocked
                ) {
                    continue;
                }

                relax(
                    current,
                    next,
                    v2.distance(currentNode.pos, nextNode.pos),
                );
            }
        }

        if (!Number.isFinite(distances[1]) || previous[1] === -1) {
            return undefined;
        }

        const path: number[] = [];
        for (let cursor = 1; cursor !== -1; cursor = previous[cursor]) {
            path.push(cursor);
        }
        path.reverse();

        if (path.length < 2) {
            return undefined;
        }

        const firstDoorIndex = path.find((index) => nodes[index]?.kind === "door");
        if (firstDoorIndex === undefined) {
            return undefined;
        }

        const firstPathIndex = path.indexOf(firstDoorIndex);
        const firstDoorNode = nodes[firstDoorIndex];
        if (firstDoorNode.kind !== "door") {
            return undefined;
        }

        let targetSide = firstDoorNode.side;
        const nextPathNode = path[firstPathIndex + 1]
            ? nodes[path[firstPathIndex + 1]]
            : undefined;
        if (
            nextPathNode?.kind === "door" &&
            nextPathNode.doorId === firstDoorNode.doorId &&
            nextPathNode.side !== firstDoorNode.side
        ) {
            targetSide = nextPathNode.side;
        }

        return {
            buildingId: firstDoorNode.buildingId,
            doorId: firstDoorNode.doorId,
            mode: "interior",
            targetSide,
            goal: v2.copy(goal),
            until: this._time + BotTuning.navigation.buildingDoorTransitionCommitSec,
        };
    }

    private _getBuildingTransitionCandidates(
        game: Game,
        player: Player,
        building: Building,
        mode: "enter" | "exit",
    ): Array<{ doorId: number; approachPos: Vec2; crossPos: Vec2 }> {
        const candidates: Array<{ doorId: number; approachPos: Vec2; crossPos: Vec2 }> = [];
        const insideInset = BotTuning.navigation.buildingDoorInsideInset;
        const outsideInset = BotTuning.navigation.buildingDoorOutsideInset;

        for (const obj of building.childObjects) {
            if (obj.__type !== ObjectType.Obstacle) continue;
            const obstacle = obj as Obstacle;
            if (!util.sameLayer(obstacle.layer, player.layer)) continue;

            const sidePoints = this._getBuildingDoorSidePoints(
                game,
                player,
                building,
                obstacle,
                insideInset,
                outsideInset,
            );
            const approachPos =
                mode === "enter" ? sidePoints.outside : sidePoints.inside;
            const crossPos = mode === "enter" ? sidePoints.inside : sidePoints.outside;
            if (
                !this._isDoorTraversableWithoutBreaking(
                    obstacle,
                    approachPos,
                )
            ) {
                continue;
            }
            candidates.push({
                doorId: obstacle.__id,
                approachPos,
                crossPos,
            });
        }

        return candidates;
    }

    private _getInteriorTraversalBuildings(
        game: Game,
        currentBuilding: Building,
        goalBuilding: Building,
        layer: number,
    ): Building[] {
        const sameBuilding = currentBuilding.__id === goalBuilding.__id;
        if (sameBuilding) {
            return [currentBuilding];
        }

        const currentStructureId = currentBuilding.parentStructure?.__id;
        const goalStructureId = goalBuilding.parentStructure?.__id;
        if (!currentStructureId || currentStructureId !== goalStructureId) {
            return [currentBuilding];
        }

        const buildings: Building[] = [];
        for (const obj of game.objectRegister.objects) {
            if (!obj || obj.__type !== ObjectType.Building) continue;
            const building = obj as Building;
            if (building.parentStructure?.__id !== currentStructureId) continue;
            if (building.layer !== layer) continue;
            buildings.push(building);
        }
        return buildings.length > 0 ? buildings : [currentBuilding];
    }

    private _getBuildingDoorSidePoints(
        game: Game,
        player: Player,
        building: Building,
        obstacle: Obstacle,
        insideInset: number,
        outsideInset: number,
    ): { inside: Vec2; outside: Vec2; bySide: Record<DoorSideSign, Vec2> } {
        const pointForSide = (side: DoorSideSign, dist: number): Vec2 => {
            const doorDir = v2.rotate(v2.create(1, 0), obstacle.rot);
            const signMul = side === -1 ? 1 : -1;
            const point = v2.add(obstacle.pos, v2.mul(doorDir, dist * signMul));
            game.map.clampToMapBounds(point, player.rad);
            return point;
        };

        const probeDist = Math.max(0.45, Math.min(insideInset, outsideInset));
        const probeNeg = pointForSide(-1, probeDist);
        const probePos = pointForSide(1, probeDist);
        const negInside = this._isPointInsideBuilding(building, probeNeg, player.layer);
        const posInside = this._isPointInsideBuilding(building, probePos, player.layer);

        let insideSide: DoorSideSign;
        if (negInside !== posInside) {
            insideSide = negInside ? -1 : 1;
        } else {
            insideSide = this._getDoorSideForPoint(obstacle, building.pos) as DoorSideSign;
        }
        const outsideSide: DoorSideSign = insideSide === -1 ? 1 : -1;

        const bySide = {
            [-1]: pointForSide(-1, insideSide === -1 ? insideInset : outsideInset),
            [1]: pointForSide(1, insideSide === 1 ? insideInset : outsideInset),
        } as Record<DoorSideSign, Vec2>;

        return {
            inside: bySide[insideSide],
            outside: bySide[outsideSide],
            bySide,
        };
    }

    private _resolveBuildingDoorTransitionGoal(
        game: Game,
        player: Player,
        transition: BuildingDoorTransition,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const buildingObj = game.objectRegister.getById(transition.buildingId);
        const doorObj = game.objectRegister.getById(transition.doorId);
        if (
            !buildingObj ||
            buildingObj.__type !== ObjectType.Building ||
            !doorObj ||
            doorObj.__type !== ObjectType.Obstacle
        ) {
            return undefined;
        }

        const building = buildingObj as Building;
        const door = doorObj as Obstacle;
        if (!door.isDoor || !door.door || door.dead || door.destroyed) {
            return undefined;
        }

        const sidePoints = this._getBuildingDoorSidePoints(
            game,
            player,
            building,
            door,
            BotTuning.navigation.buildingDoorInsideInset,
            BotTuning.navigation.buildingDoorOutsideInset,
        );
        const inside = this._isPointInsideBuilding(building, player.pos, player.layer);
        const interiorTargetSide =
            transition.targetSide ?? (this._getDoorSideForPoint(door, transition.goal) as -1 | 1);
        const interiorTargetPos =
            interiorTargetSide < 0 ? sidePoints.inside : sidePoints.outside;
        const interiorCrossed =
            this._getDoorSideForPoint(door, player.pos) === interiorTargetSide &&
            v2.distance(player.pos, interiorTargetPos) <=
                Math.max(BotTuning.navigation.arriveDist, 0.75);
        const targetReached =
            transition.mode === "enter"
                ? inside
                : transition.mode === "exit"
                  ? !inside
                  : interiorCrossed ||
                    !this._traceRoute(game, player, player.pos, transition.goal).blocked;
        if (targetReached) {
            return undefined;
        }

        const currentGoal = this._getBuildingDoorCurrentGoal(
            door,
            player,
            transition,
            sidePoints,
        );
        if (!this._isDoorTraversableWithoutBreaking(door, currentGoal)) {
            return undefined;
        }

        if (!this._isNavPointValid(game, player, currentGoal, gasEmergency)) {
            return undefined;
        }
        if (this._traceRoute(game, player, player.pos, currentGoal).blocked) {
            return undefined;
        }
        return currentGoal;
    }

    private _getBuildingDoorCurrentGoal(
        door: Obstacle,
        player: Player,
        transition: BuildingDoorTransition,
        sidePoints: { inside: Vec2; outside: Vec2 },
    ): Vec2 {
        if (transition.mode === "interior") {
            const playerSide = this._getDoorSideForPoint(door, player.pos);
            const currentSidePos = playerSide < 0 ? sidePoints.inside : sidePoints.outside;
            const targetSide = transition.targetSide ?? ((playerSide < 0 ? 1 : -1) as -1 | 1);
            const targetSidePos =
                targetSide < 0 ? sidePoints.inside : sidePoints.outside;
            return door.door?.autoOpen || door.door?.open
                ? targetSidePos
                : currentSidePos;
        }

        return door.door?.autoOpen || door.door?.open
            ? transition.mode === "enter"
                ? sidePoints.inside
                : sidePoints.outside
            : transition.mode === "enter"
              ? sidePoints.outside
              : sidePoints.inside;
    }

    private _isDoorTraversableWithoutBreaking(
        obstacle: Obstacle,
        approachPos: Vec2,
    ): boolean {
        if (!obstacle.isDoor || !obstacle.door) return false;
        if (obstacle.dead || obstacle.destroyed) return false;
        if (obstacle.door.locked || !obstacle.door.canUse) return false;
        if (!obstacle.door.autoOpen) return true;
        if (
            obstacle.door.openOneWay &&
            this._getDoorSideForPoint(obstacle, approachPos) !== obstacle.door.openOneWay
        ) {
            return false;
        }
        return true;
    }

    private _getDoorSideForPoint(obstacle: Obstacle, point: Vec2): number {
        const toDoor = v2.sub(obstacle.pos, point);
        const doorDir = v2.rotate(v2.create(1, 0), obstacle.rot);
        return v2.dot(toDoor, doorDir) < 0 ? -1 : 1;
    }

    private _isPointInsideBuildingLayerExact(
        building: Building,
        point: Vec2,
        layer: number,
    ): boolean {
        if (building.layer !== layer) return false;
        for (const surface of building.surfaces) {
            for (const collision of surface.colliders) {
                if (collider.intersectCircle(collision, point, 0.01)) {
                    return true;
                }
            }
        }
        return false;
    }

    private _getAabbCenter(aabb: { min: Vec2; max: Vec2 }): Vec2 {
        return v2.mul(v2.add(aabb.min, aabb.max), 0.5);
    }

    private _pickWarehouseOpeningGoal(
        game: Game,
        player: Player,
        building: Building,
        goal: Vec2,
        gasEmergency: boolean,
        mode: "enter" | "exit",
    ): Vec2 | undefined {
        const candidates = this._getWarehouseOpeningCandidates(
            game,
            player,
            building,
            mode,
        );
        let bestCandidate: Vec2 | undefined;
        let bestScore = Infinity;

        for (const candidate of candidates) {
            if (!this._isNavPointValid(game, player, candidate, gasEmergency)) continue;
            if (this._traceRoute(game, player, player.pos, candidate).blocked) continue;

            const score =
                v2.distance(player.pos, candidate) * 0.35 + v2.distance(candidate, goal);
            if (score < bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }

        return bestCandidate;
    }

    private _getWarehouseOpeningCandidates(
        game: Game,
        player: Player,
        building: Building,
        mode: "enter" | "exit",
    ): Vec2[] {
        const bounds = this._getBuildingLocalSurfaceBounds(building);
        const openingOffset =
            mode === "enter"
                ? -BotTuning.navigation.warehouseEntryInsideInset
                : BotTuning.navigation.warehouseEntryExitOutsideDist;
        const localCandidates = [
            v2.create(bounds.min.x - openingOffset, 0),
            v2.create(bounds.max.x + openingOffset, 0),
        ];

        return localCandidates.map((local) => {
            const world = this._toWorldPoint(building, local);
            game.map.clampToMapBounds(world, player.rad);
            return world;
        });
    }

    private _getBuildingLocalSurfaceBounds(building: Building): {
        min: Vec2;
        max: Vec2;
    } {
        const min = v2.create(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
        const max = v2.create(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

        for (const surface of building.surfaces) {
            for (const collision of surface.colliders) {
                const worldAabb = collider.toAabb(collision);
                for (const point of collider.getPoints(worldAabb)) {
                    const local = this._toLocalPoint(building, point);
                    min.x = Math.min(min.x, local.x);
                    min.y = Math.min(min.y, local.y);
                    max.x = Math.max(max.x, local.x);
                    max.y = Math.max(max.y, local.y);
                }
            }
        }

        if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) {
            return {
                min: v2.create(-10, -10),
                max: v2.create(10, 10),
            };
        }

        return { min, max };
    }

    private _toLocalPoint(building: Building, point: Vec2): Vec2 {
        return v2.rotate(v2.sub(point, building.pos), -building.rot);
    }

    private _toWorldPoint(building: Building, local: Vec2): Vec2 {
        return v2.add(v2.rotate(local, building.rot), building.pos);
    }

    private _setWarehouseTransition(
        buildingId: number,
        mode: "enter" | "exit",
        goal: Vec2,
        opening: Vec2,
    ): void {
        this._warehouseTransition = {
            buildingId,
            mode,
            goal: v2.copy(goal),
            opening: v2.copy(opening),
            until: this._time + BotTuning.navigation.warehouseTransitionCommitSec,
        };
    }

    private _pickWallSlideWaypoint(
        game: Game,
        player: Player,
        goal: Vec2,
        directTrace: RouteTrace,
        gasEmergency: boolean,
    ): { pos: Vec2; blockerId?: number; sideSign?: -1 | 1 } | undefined {
        const blocker = directTrace.hitObstacle;
        if (!blocker || !this._isLargeIndestructibleWall(blocker)) {
            return undefined;
        }

        const wallAabb = collider.toAabb(blocker.collider);
        const wallCenter = v2.mul(v2.add(wallAabb.min, wallAabb.max), 0.5);
        const wallSize = v2.sub(wallAabb.max, wallAabb.min);
        const horizontal = wallSize.x >= wallSize.y;
        const tangent = horizontal ? v2.create(1, 0) : v2.create(0, 1);
        const normal = horizontal
            ? v2.create(0, player.pos.y >= wallCenter.y ? 1 : -1)
            : v2.create(player.pos.x >= wallCenter.x ? 1 : -1, 0);
        const hitPoint = v2.add(
            player.pos,
            v2.mul(
                v2.normalizeSafe(v2.sub(goal, player.pos), v2.create(1, 0)),
                Math.max(directTrace.hitDist - 0.25, 0),
            ),
        );
        const base = v2.add(
            hitPoint,
            v2.mul(normal, BotTuning.navigation.wallSlideClearanceDist),
        );

        const candidates = [
            {
                pos: v2.add(base, v2.mul(tangent, BotTuning.navigation.wallSlideSideDist)),
                sideSign: 1 as const,
            },
            {
                pos: v2.add(base, v2.mul(tangent, -BotTuning.navigation.wallSlideSideDist)),
                sideSign: -1 as const,
            },
            {
                pos: v2.add(player.pos, v2.mul(normal, BotTuning.navigation.wallEscapeDist)),
                sideSign: undefined,
            },
        ];

        let bestPos: Vec2 | undefined;
        let bestScore = -Infinity;
        let bestSideSign: -1 | 1 | undefined;
        const preferCommittedSide =
            this._detourBlockerId === blocker.__id &&
            this._time < this._detourCommitUntil
                ? this._detourSideSign
                : undefined;
        for (const candidate of candidates) {
            game.map.clampToMapBounds(candidate.pos, player.rad);
            if (!this._isNavPointValid(game, player, candidate.pos, gasEmergency)) continue;
            if (this._isRecentlyFailed(candidate.pos)) continue;

            const firstLeg = this._traceRoute(game, player, player.pos, candidate.pos);
            if (firstLeg.blocked) continue;

            const secondLeg = this._traceRoute(game, player, candidate.pos, goal);
            const progress = directTrace.len - v2.distance(candidate.pos, goal);
            const tangentGoalAlign = Math.abs(
                v2.dot(
                    v2.normalizeSafe(v2.sub(goal, player.pos), v2.create(1, 0)),
                    tangent,
                ),
            );
            const score =
                (secondLeg.blocked ? 0 : 850) +
                progress * 8 -
                v2.distance(player.pos, candidate.pos) * 1.25 +
                tangentGoalAlign * 80;
            const sideCommitBonus =
                preferCommittedSide !== undefined &&
                candidate.sideSign !== undefined &&
                preferCommittedSide === candidate.sideSign
                    ? BotTuning.navigation.detourSameSideBonus
                    : 0;

            if (score + sideCommitBonus > bestScore) {
                bestScore = score + sideCommitBonus;
                bestPos = v2.copy(candidate.pos);
                bestSideSign = candidate.sideSign;
            }
        }

        return bestPos
            ? {
                  pos: bestPos,
                  blockerId: blocker.__id,
                  sideSign: bestSideSign,
              }
            : undefined;
    }

    private _pickBlockerOrbitWaypoint(
        game: Game,
        player: Player,
        goal: Vec2,
        directTrace: RouteTrace,
        gasEmergency: boolean,
    ): { pos: Vec2; blockerId?: number; sideSign?: -1 | 1 } | undefined {
        const blocker = directTrace.hitObstacle;
        if (!blocker || blocker.parentBuilding || this._isLargeIndestructibleWall(blocker)) {
            return undefined;
        }

        const blockerAabb = collider.toAabb(blocker.collider);
        const halfSize = v2.mul(v2.sub(blockerAabb.max, blockerAabb.min), 0.5);
        const orbitRadius =
            Math.max(halfSize.x, halfSize.y) +
            player.rad +
            BotTuning.navigation.blockerOrbitClearanceDist;
        const fromCenterToPlayer = v2.normalizeSafe(
            v2.sub(player.pos, blocker.pos),
            v2.create(1, 0),
        );
        const tangent = v2.perp(fromCenterToPlayer);
        const towardGoal = v2.normalizeSafe(v2.sub(goal, blocker.pos), tangent);

        let bestPos: Vec2 | undefined;
        let bestScore = -Infinity;
        let bestSideSign: -1 | 1 | undefined;
        const directCoverage = directTrace.hitDist / Math.max(directTrace.len, 0.001);
        const preferCommittedSide =
            this._detourBlockerId === blocker.__id &&
            this._time < this._detourCommitUntil
                ? this._detourSideSign
                : undefined;

        for (const sideSign of [-1, 1] as const) {
            const nearDir = v2.normalizeSafe(
                v2.add(fromCenterToPlayer, v2.mul(tangent, sideSign * 1.1)),
                fromCenterToPlayer,
            );
            const farDir = v2.normalizeSafe(
                v2.add(towardGoal, v2.mul(tangent, sideSign * 0.9)),
                towardGoal,
            );
            const candidates = [
                v2.add(blocker.pos, v2.mul(nearDir, orbitRadius)),
                v2.add(
                    v2.add(blocker.pos, v2.mul(farDir, orbitRadius)),
                    v2.mul(towardGoal, BotTuning.navigation.blockerOrbitForwardBiasDist),
                ),
            ];

            for (const candidate of candidates) {
                game.map.clampToMapBounds(candidate, player.rad);
                if (!this._isNavPointValid(game, player, candidate, gasEmergency)) continue;
                if (this._isRecentlyFailed(candidate)) continue;

                const firstLeg = this._traceRoute(game, player, player.pos, candidate);
                if (firstLeg.blocked) continue;

                const secondLeg = this._traceRoute(game, player, candidate, goal);
                const secondCoverage = secondLeg.hitDist / Math.max(secondLeg.len, 0.001);
                if (secondLeg.blocked && secondCoverage <= directCoverage + 0.08) {
                    continue;
                }

                const candidateToGoal = v2.distance(candidate, goal);
                const progress = directTrace.len - candidateToGoal;
                const score =
                    (secondLeg.blocked ? 0 : 950) +
                    secondCoverage * 180 +
                    progress * 7 -
                    v2.distance(player.pos, candidate) * 1.2 -
                    candidateToGoal * 0.22;
                const sideCommitBonus =
                    preferCommittedSide !== undefined &&
                    preferCommittedSide === sideSign
                        ? BotTuning.navigation.detourSameSideBonus
                        : 0;

                if (score + sideCommitBonus > bestScore) {
                    bestScore = score + sideCommitBonus;
                    bestPos = v2.copy(candidate);
                    bestSideSign = sideSign;
                }
            }
        }

        return bestPos
            ? {
                  pos: bestPos,
                  blockerId: blocker.__id,
                  sideSign: bestSideSign,
              }
            : undefined;
    }

    private _isLargeIndestructibleWall(obstacle: Obstacle): boolean {
        if (obstacle.destructible || !obstacle.isWall) return false;
        const wallAabb = collider.toAabb(obstacle.collider);
        const wallSize = v2.sub(wallAabb.max, wallAabb.min);
        const longSide = Math.max(wallSize.x, wallSize.y);
        const shortSide = Math.min(wallSize.x, wallSize.y);
        return (
            longSide >= BotTuning.navigation.wallSlideMinLength &&
            shortSide <= BotTuning.navigation.wallSlideMaxThickness
        );
    }

    private _blocksMovement(player: Player, obstacle: Obstacle): boolean {
        if (obstacle.dead || !obstacle.collidable) return false;
        if (!util.sameLayer(obstacle.layer, player.layer)) return false;
        if (obstacle.isDoor && obstacle.door?.autoOpen && !obstacle.door.locked) {
            return false;
        }
        return true;
    }

    private _isNavPointValid(
        game: Game,
        player: Player,
        point: Vec2,
        gasEmergency: boolean,
    ): boolean {
        if (game.map.isOnWater(point, player.layer)) return false;
        if (!gasEmergency && game.gas.isOutSideSafeZone(point)) return false;
        return true;
    }

    private _isRecentlyFailed(point: Vec2): boolean {
        return this._failedWaypoints.some(
            (entry) =>
                entry.until > this._time &&
                v2.distance(entry.pos, point) <= BotTuning.navigation.failedWaypointDist,
        );
    }

    private _invalidateRoute(goal: Vec2): void {
        if (this._detourWaypoint) {
            this._rememberFailedWaypoint(this._detourWaypoint);
            this._clearDetour();
        } else {
            this._forceDetourGoal = v2.copy(goal);
            this._forceDetourUntil =
                this._time + BotTuning.navigation.forceDetourTtlSec;
        }
    }

    private _rememberFailedWaypoint(point: Vec2): void {
        this._failedWaypoints.push({
            pos: v2.copy(point),
            until: this._time + BotTuning.navigation.failedWaypointTtlSec,
        });
    }

    private _shouldForceDetour(goal: Vec2): boolean {
        return !!(
            this._forceDetourGoal &&
            this._forceDetourUntil > this._time &&
            this._sameGoal(goal, this._forceDetourGoal)
        );
    }

    private _sameGoal(a?: Vec2, b?: Vec2): boolean {
        if (!a || !b) return false;
        return v2.distance(a, b) <= BotTuning.navigation.sameGoalDist;
    }

    private _reachedPoint(
        pos: Vec2,
        point: Vec2,
        arriveDist: number = BotTuning.navigation.arriveDist,
    ): boolean {
        return v2.distance(pos, point) <= arriveDist;
    }

    private _clearDetour(): void {
        this._detourWaypoint = undefined;
        this._detourGoal = undefined;
        this._detourUntil = -Infinity;
        this._detourCommitUntil = -Infinity;
        this._detourBlockerId = undefined;
        this._detourSideSign = undefined;
    }

    private _clearForcedDetour(): void {
        this._forceDetourGoal = undefined;
        this._forceDetourUntil = -Infinity;
    }

    private _clearFallback(): void {
        this._fallbackGoal = undefined;
        this._fallbackMode = undefined;
    }

    private _clearStairTransition(): void {
        this._stairTransition = undefined;
    }

    private _clearBuildingDoorTransition(): void {
        this._buildingDoorTransition = undefined;
    }

    private _clearWarehouseTransition(): void {
        this._warehouseTransition = undefined;
    }

    private _getRouteTraceCacheKey(layer: number, start: Vec2, goal: Vec2): string {
        const prec = 100;
        return [
            layer,
            Math.round(start.x * prec),
            Math.round(start.y * prec),
            Math.round(goal.x * prec),
            Math.round(goal.y * prec),
        ].join(":");
    }
}
