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
import { BotTuning } from "../botTuning";

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

export class BotNavigationLite {
    waypoint?: Vec2;
    waypointTtl = 0;

    private _time = 0;
    private _strafeTicker = 0;
    private _strafeSign = 1;
    private _detourWaypoint?: Vec2;
    private _detourGoal?: Vec2;
    private _detourUntil = -Infinity;
    private _failedWaypoints: FailedWaypoint[] = [];
    private _forceDetourGoal?: Vec2;
    private _forceDetourUntil = -Infinity;
    private _progressPos?: Vec2;
    private _progressGoal?: Vec2;
    private _stuckTimer = 0;
    private _nextRepathAt = BotTuning.navigation.stuckRepathAfterSec;
    private _fallbackGoal?: Vec2;
    private _fallbackMode?: "waypoint" | "center";

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

        this._failedWaypoints = this._failedWaypoints.filter(
            (entry) => entry.until > this._time,
        );
    }

    ensureWaypoint(game: Game, _player: Player): void {
        if (!this.waypoint || this.waypointTtl <= 0) {
            this.waypoint = this._pickWaypoint(game);
            this.waypointTtl = util.random(5, 10);
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

        if (
            this._detourWaypoint &&
            this._detourGoal &&
            this._sameGoal(activeGoal, this._detourGoal) &&
            this._isNavPointValid(game, player, this._detourWaypoint, gasEmergency) &&
            !this._isRecentlyFailed(this._detourWaypoint) &&
            !this._traceRoute(game, player, player.pos, this._detourWaypoint).blocked &&
            (directTrace.blocked || forceDetour)
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
            this._detourWaypoint = detour;
            this._detourGoal = v2.copy(activeGoal);
            this._detourUntil = this._time + BotTuning.navigation.detourTtlSec;
            return detour;
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
            this._fallbackGoal = this._pickWaypoint(game);
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

    private _pickWaypoint(game: Game): Vec2 {
        const map = game.map;
        const gas = game.gas;

        const center = gas.posNew;
        const baseRad = math.max(gas.radNew * 0.75, 10);

        for (let attempts = 0; attempts < 12; attempts++) {
            const candidate = v2.add(center, util.randomPointInCircle(baseRad));

            candidate.x = math.clamp(candidate.x, 0, map.width);
            candidate.y = math.clamp(candidate.y, 0, map.height);

            if (gas.isOutSideSafeZone(candidate)) continue;
            if (map.isOnWater(candidate, 0)) continue;

            return candidate;
        }

        return v2.copy(center);
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
            this._fallbackGoal ??= this._pickWaypoint(game);
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
    ): Vec2 | undefined {
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

                    if (score > bestScore) {
                        bestScore = score;
                        bestPos = v2.copy(candidate);
                    }
                }
            }
        }

        return bestPos;
    }

    private _traceRoute(
        game: Game,
        player: Player,
        start: Vec2,
        goal: Vec2,
    ): RouteTrace {
        const len = v2.distance(start, goal);
        if (len <= 0.0001) {
            return {
                blocked: false,
                hitDist: 0,
                len,
            };
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

        return {
            blocked: hitDist < len - 0.05,
            hitDist,
            len,
            hitObstacle,
        };
    }

    private _resolveStructuredGoal(
        game: Game,
        player: Player,
        goal: Vec2,
        gasEmergency: boolean,
    ): Vec2 | undefined {
        return (
            this._getContainerExitGoal(game, player, goal, gasEmergency) ??
            this._getWarehouseTransitionGoal(game, player, goal, gasEmergency)
        );
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
        const currentWarehouse = this._getContainingWarehouse(
            game,
            player.pos,
            player.layer,
        );
        if (
            currentWarehouse &&
            !this._isPointInsideBuilding(currentWarehouse, goal, player.layer)
        ) {
            return this._pickWarehouseOpeningGoal(
                game,
                player,
                currentWarehouse,
                goal,
                gasEmergency,
                "exit",
            );
        }

        const goalWarehouse = this._getContainingWarehouse(game, goal, player.layer);
        if (!currentWarehouse && goalWarehouse) {
            return this._pickWarehouseOpeningGoal(
                game,
                player,
                goalWarehouse,
                goal,
                gasEmergency,
                "enter",
            );
        }

        return undefined;
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

    private _pickWallSlideWaypoint(
        game: Game,
        player: Player,
        goal: Vec2,
        directTrace: RouteTrace,
        gasEmergency: boolean,
    ): Vec2 | undefined {
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
            v2.add(base, v2.mul(tangent, BotTuning.navigation.wallSlideSideDist)),
            v2.add(base, v2.mul(tangent, -BotTuning.navigation.wallSlideSideDist)),
            v2.add(player.pos, v2.mul(normal, BotTuning.navigation.wallEscapeDist)),
        ];

        let bestPos: Vec2 | undefined;
        let bestScore = -Infinity;
        for (const candidate of candidates) {
            game.map.clampToMapBounds(candidate, player.rad);
            if (!this._isNavPointValid(game, player, candidate, gasEmergency)) continue;
            if (this._isRecentlyFailed(candidate)) continue;

            const firstLeg = this._traceRoute(game, player, player.pos, candidate);
            if (firstLeg.blocked) continue;

            const secondLeg = this._traceRoute(game, player, candidate, goal);
            const progress = directTrace.len - v2.distance(candidate, goal);
            const tangentGoalAlign = Math.abs(
                v2.dot(
                    v2.normalizeSafe(v2.sub(goal, player.pos), v2.create(1, 0)),
                    tangent,
                ),
            );
            const score =
                (secondLeg.blocked ? 0 : 850) +
                progress * 8 -
                v2.distance(player.pos, candidate) * 1.25 +
                tangentGoalAlign * 80;

            if (score > bestScore) {
                bestScore = score;
                bestPos = v2.copy(candidate);
            }
        }

        return bestPos;
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
    }

    private _clearForcedDetour(): void {
        this._forceDetourGoal = undefined;
        this._forceDetourUntil = -Infinity;
    }

    private _clearFallback(): void {
        this._fallbackGoal = undefined;
        this._fallbackMode = undefined;
    }
}
