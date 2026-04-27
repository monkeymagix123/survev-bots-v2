import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import type { Game } from "../../game";
import type { Player } from "../../objects/player";

export class BotNavigationLite {
    waypoint?: Vec2;
    waypointTtl = 0;

    private _strafeTicker = 0;
    private _strafeSign = 1;

    tick(dt: number, hasTarget: boolean): void {
        if (!hasTarget) {
            this.waypointTtl -= dt;
        }
    }

    ensureWaypoint(game: Game, _player: Player): void {
        if (!this.waypoint || this.waypointTtl <= 0) {
            this.waypoint = this._pickWaypoint(game);
            this.waypointTtl = util.random(5, 10);
        }
    }

    getGoal(
        game: Game,
        _player: Player,
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
        const strafe = allowStrafe && hasTarget && dist < 18 && !gasEmergency;
        if (strafe) {
            this._strafeTicker -= dt;
            if (strafeSign !== undefined) {
                this._strafeSign = strafeSign;
            } else if (this._strafeTicker <= 0) {
                this._strafeTicker = util.random(0.25, 0.6);
                this._strafeSign = Math.random() < 0.5 ? -1 : 1;
            }

            const perp = v2.perp(aimDir);
            const strafeGoal = v2.add(player.pos, v2.mul(perp, 8 * this._strafeSign));
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

            // Clamp to bounds
            candidate.x = math.clamp(candidate.x, 0, map.width);
            candidate.y = math.clamp(candidate.y, 0, map.height);

            if (gas.isOutSideSafeZone(candidate)) continue;
            if (map.isOnWater(candidate, 0)) continue;

            return candidate;
        }

        // Fallback: just move toward gas center
        return v2.copy(center);
    }
}
