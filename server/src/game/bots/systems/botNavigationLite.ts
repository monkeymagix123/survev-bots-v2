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
import type { BotMacroGoal } from "../botCombat";

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
    targetLayer: 0 | 1;
    goal: Vec2;
    opening: Vec2;
    until: number;
};

type BuildingDoorTransition = {
    buildingId: number;
    mode: "enter" | "exit";
    goal: Vec2;
    opening: Vec2;
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
            this._stairTransition &&
            this._reachedPoint(player.pos, this._stairTransition.opening, arriveDist)
        ) {
            this._clearStairTransition();
        }
        if (
            this._buildingDoorTransition &&
            this._reachedPoint(
                player.pos,
                this._buildingDoorTransition.opening,
                arriveDist,
            )
        ) {
            this._clearBuildingDoorTransition();
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
            this._progressPos = v2.copy(player.pos);
            this._progressGoal = goal ? v2.copy(goal) : undefined;
            this._stuckTimer = 0;
            this._nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;

            if (intentionalStationary) {
                this._clearFallback();
                this._clearForcedDetour();
            }
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
                      macroGoal: "loot_zone",
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
        if (gasEmergency) {
            return game.gas.posNew;
        }
        if (overrideGoal) {
            return overrideGoal;
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
            this._getBuildingDoorTransitionGoal(game, player, goal, gasEmergency)
        );
    }

    private _getStairTransitionGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const committedTransition = this._getCommittedStairTransition(player, goal);
        if (committedTransition) {
            return committedTransition;
        }

        const structure = this._getContainingStairStructure(game, player.pos, player.layer);
        if (!structure) {
            this._clearStairTransition();
            return undefined;
        }

        const currentBaseLayer = util.toGroundLayer(player.layer) as 0 | 1;
        const goalBaseLayer = this._getGoalBaseLayer(game, goal);
        if (player.layer < 2 && currentBaseLayer === goalBaseLayer) {
            this._clearStairTransition();
            return undefined;
        }

        const opening = this._pickStairTransitionGoal(
            game,
            player,
            structure,
            goalBaseLayer,
            gasEmergency,
        );
        if (!opening) {
            this._clearStairTransition();
            return undefined;
        }

        this._stairTransition = {
            structureId: structure.__id,
            targetLayer: goalBaseLayer,
            goal: v2.copy(goal),
            opening: v2.copy(opening),
            until: this._time + BotTuning.navigation.stairTransitionCommitSec,
        };
        return opening;
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
        player: Player,
        goal: Vec2,
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
            this._reachedPoint(
                player.pos,
                transition.opening,
                BotTuning.navigation.arriveDist,
            )
        ) {
            this._clearStairTransition();
            return undefined;
        }
        return transition.opening;
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

    private _getContainingStairStructure(
        game: Game,
        point: Vec2,
        layer: number,
    ): Structure | undefined {
        const objs = game.grid.intersectPos(point);
        for (const obj of objs) {
            if (obj.__type !== ObjectType.Structure) continue;
            const structure = obj as Structure;
            for (const stair of structure.stairs) {
                if (
                    coldet.testCircleAabb(
                        point,
                        0.25,
                        stair.collision.min,
                        stair.collision.max,
                    )
                ) {
                    return structure;
                }
            }
        }

        const building = this._getContainingStructuredBuilding(game, point, layer, () => true);
        return building?.parentStructure?.stairs.length ? building.parentStructure : undefined;
    }

    private _pickStairTransitionGoal(
        game: Game,
        player: Player,
        structure: Structure,
        targetLayer: 0 | 1,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        let bestCandidate: Vec2 | undefined;
        let bestScore = Infinity;

        for (const stair of structure.stairs) {
            const sideAabb = targetLayer === 0 ? stair.upAabb : stair.downAabb;
            const sideCenter = this._getAabbCenter(sideAabb);
            const pushDir = v2.normalizeSafe(
                v2.sub(sideCenter, stair.center),
                targetLayer === 0 ? v2.create(0, 1) : v2.create(0, -1),
            );
            const candidate = v2.add(
                sideCenter,
                v2.mul(pushDir, BotTuning.navigation.stairExitInset),
            );
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

    private _getBuildingDoorTransitionGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        const committedTransition = this._getCommittedBuildingDoorTransition(
            player,
            goal,
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
            const opening = this._pickBuildingDoorGoal(
                game,
                player,
                currentBuilding,
                goal,
                gasEmergency,
                "exit",
            );
            if (opening) {
                this._buildingDoorTransition = {
                    buildingId: currentBuilding.__id,
                    mode: "exit",
                    goal: v2.copy(goal),
                    opening: v2.copy(opening),
                    until:
                        this._time + BotTuning.navigation.buildingDoorTransitionCommitSec,
                };
            }
            return opening;
        }

        const goalBuilding = this._getContainingStructuredBuilding(
            game,
            goal,
            this._getGoalBaseLayer(game, goal),
            () => true,
        );
        if (!currentBuilding && goalBuilding) {
            const opening = this._pickBuildingDoorGoal(
                game,
                player,
                goalBuilding,
                goal,
                gasEmergency,
                "enter",
            );
            if (opening) {
                this._buildingDoorTransition = {
                    buildingId: goalBuilding.__id,
                    mode: "enter",
                    goal: v2.copy(goal),
                    opening: v2.copy(opening),
                    until:
                        this._time + BotTuning.navigation.buildingDoorTransitionCommitSec,
                };
            }
            return opening;
        }

        this._clearBuildingDoorTransition();
        return undefined;
    }

    private _getCommittedBuildingDoorTransition(
        player: Player,
        goal: Vec2,
    ): Vec2 | undefined {
        const transition = this._buildingDoorTransition;
        if (!transition) return undefined;
        if (this._time >= transition.until) {
            this._clearBuildingDoorTransition();
            return undefined;
        }
        if (!this._sameGoal(goal, transition.goal)) {
            this._clearBuildingDoorTransition();
            return undefined;
        }
        if (
            this._reachedPoint(
                player.pos,
                transition.opening,
                BotTuning.navigation.arriveDist,
            )
        ) {
            this._clearBuildingDoorTransition();
            return undefined;
        }
        return transition.opening;
    }

    private _pickBuildingDoorGoal(
        game: Game,
        player: Player,
        building: Building,
        goal: Vec2,
        gasEmergency: boolean,
        mode: "enter" | "exit",
    ): Vec2 | undefined {
        const candidates = this._getBuildingDoorCandidates(
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

    private _getBuildingDoorCandidates(
        game: Game,
        player: Player,
        building: Building,
        mode: "enter" | "exit",
    ): Vec2[] {
        const candidates: Vec2[] = [];
        const insideInset = BotTuning.navigation.buildingDoorInsideInset;
        const outsideInset = BotTuning.navigation.buildingDoorOutsideInset;

        for (const obj of building.childObjects) {
            if (obj.__type !== ObjectType.Obstacle) continue;
            const obstacle = obj as Obstacle;
            if (!obstacle.isDoor || !obstacle.door?.autoOpen || obstacle.door.locked) {
                continue;
            }
            if (!util.sameLayer(obstacle.layer, player.layer)) continue;

            const outward = v2.normalizeSafe(
                v2.sub(obstacle.pos, building.pos),
                v2.create(0, 1),
            );
            const candidate = v2.add(
                obstacle.pos,
                v2.mul(
                    outward,
                    mode === "enter" ? -insideInset : outsideInset,
                ),
            );
            game.map.clampToMapBounds(candidate, player.rad);
            candidates.push(candidate);
        }

        return candidates;
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
        if (obstacle.dead || !obstacle.collidable || obstacle.isWindow) return false;
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
