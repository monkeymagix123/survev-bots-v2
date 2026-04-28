import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import type { Game } from "../../game";
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

        if (v2.distance(player.pos, desiredGoal) <= BotTuning.navigation.arriveDist) {
            this._clearDetour();
            this._clearFallback();
            this._clearForcedDetour();
        }

        if (this._detourWaypoint && this._reachedPoint(player.pos, this._detourWaypoint)) {
            this._clearDetour();
        }
        if (this._fallbackGoal && this._reachedPoint(player.pos, this._fallbackGoal)) {
            this._clearFallback();
        }

        const routeGoal = this._fallbackMode
            ? this._getFallbackGoal(game)
            : desiredGoal;
        if (!routeGoal) {
            return undefined;
        }

        const directTrace = this._traceRoute(game, player, player.pos, routeGoal);
        const forceDetour = this._shouldForceDetour(routeGoal);

        if (
            this._detourWaypoint &&
            this._detourGoal &&
            this._sameGoal(routeGoal, this._detourGoal) &&
            this._isNavPointValid(game, player, this._detourWaypoint, gasEmergency) &&
            !this._isRecentlyFailed(this._detourWaypoint) &&
            !this._traceRoute(game, player, player.pos, this._detourWaypoint).blocked &&
            (directTrace.blocked || forceDetour)
        ) {
            return this._detourWaypoint;
        }

        if (!directTrace.blocked && !forceDetour) {
            this._clearDetour();
            return routeGoal;
        }

        const detour = this._pickDetourWaypoint(
            game,
            player,
            routeGoal,
            directTrace,
            gasEmergency,
        );
        if (detour) {
            this._detourWaypoint = detour;
            this._detourGoal = v2.copy(routeGoal);
            this._detourUntil = this._time + BotTuning.navigation.detourTtlSec;
            return detour;
        }

        return routeGoal;
    }

    observeMovement(params: {
        dt: number;
        game: Game;
        player: Player;
        goal?: Vec2;
        moveLeft: boolean;
        moveRight: boolean;
        moveUp: boolean;
        moveDown: boolean;
    }): void {
        const { dt, game, player, goal, moveLeft, moveRight, moveUp, moveDown } = params;
        const attemptedMove = moveLeft || moveRight || moveUp || moveDown;
        const intentionalStationary =
            !goal || v2.distance(player.pos, goal) <= BotTuning.navigation.arriveDist;

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
        } = params;

        msg.moveLeft = false;
        msg.moveRight = false;
        msg.moveUp = false;
        msg.moveDown = false;

        if (!goal || anchor) return;

        const toGoal = v2.sub(goal, player.pos);
        const dist = distToTarget ?? v2.length(toGoal);

        const dd = 1;
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

        const hitDist = collisionHelpers.intersectSegmentDist(
            obstacles,
            start,
            dir,
            len,
            0.0,
            player.layer,
            false,
        );

        return {
            blocked: hitDist < len - 0.05,
            hitDist,
            len,
        };
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

    private _reachedPoint(pos: Vec2, point: Vec2): boolean {
        return v2.distance(pos, point) <= BotTuning.navigation.arriveDist;
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
