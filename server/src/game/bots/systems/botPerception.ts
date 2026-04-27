import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import { Config } from "../../../config";
import type { Game } from "../../game";
import type { Player } from "../../objects/player";

export class BotPerception {
    targetId?: number;
    targetVisible = false;
    targetSeenTime = -Infinity;
    lastSeenPos?: Vec2;
    lastSeenTime = -Infinity;

    /**
     * True when bot has seen an enemy recently (used for retire priority).
     */
    inCombat(timeNow: number): boolean {
        return timeNow - this.targetSeenTime < 1.0;
    }

    markTargetSeen(timeNow: number): void {
        this.targetSeenTime = timeNow;
    }

    markTargetVisible(timeNow: number, pos: Vec2): void {
        this.targetSeenTime = timeNow;
        this.lastSeenTime = timeNow;
        this.lastSeenPos = v2.copy(pos);
    }

    /**
     * Finds the best target under the current rules.
     * Returns the chosen player + whether they are currently visible (LOS).
     */
    scanForTarget(game: Game, player: Player): { target?: Player; visible: boolean } {
        const vision = player.zoom + 6;
        const rect = coldet.circleToAabb(player.pos, vision);
        const objects = game.map.isWaveMap ? game.playerBarn.players : game.grid.intersectCollider(rect);

        let bestVisible: Player | undefined;
        let bestVisibleDist = Number.MAX_VALUE;

        let bestAny: Player | undefined;
        let bestAnyDist = Number.MAX_VALUE;

        for (let i = 0; i < objects.length; i++) {
            const obj = objects[i];
            if (obj.__type !== ObjectType.Player) continue;
            const other = obj as Player;
            if (other === player) continue;
            if (other.dead || other.disconnected) continue;
            if (!util.sameLayer(other.layer, player.layer)) continue;

            // Ignore friendlies
            if (other.groupId === player.groupId) continue;
            if (game.map.factionMode && other.teamId === player.teamId) continue;

            // Optional bot-vs-bot suppression (internal + external websocket bots)
            if (!Config.bots.allowBotVsBot && (other.isAi || other.bot)) continue;

            const dist = v2.lengthSqr(v2.sub(other.pos, player.pos));
            if (dist < bestAnyDist) {
                bestAnyDist = dist;
                bestAny = other;
            }

            if (dist >= bestVisibleDist) continue;
            if (!this._hasLineOfSight(game, player, other)) continue;
            bestVisibleDist = dist;
            bestVisible = other;
        }

        const chosen = bestVisible ?? bestAny;
        return { target: chosen, visible: chosen !== undefined && chosen === bestVisible };
    }

    private _hasLineOfSight(game: Game, player: Player, target: Player): boolean {
        const a = player.pos;
        const b = target.pos;
        const len = v2.distance(a, b);
        if (len <= 0.0001) return true;

        const dir = v2.normalizeSafe(v2.sub(b, a), v2.create(1, 0));
        const aabb = coldet.lineSegmentToAabb(a, b);
        const nearby = game.grid.intersectCollider(aabb);
        const obstacles = nearby.filter((o) => o.__type === ObjectType.Obstacle) as any[];

        const dist = collisionHelpers.intersectSegmentDist(
            obstacles,
            a,
            dir,
            len,
            GameConfig.bullet.height,
            player.layer,
            true,
        );

        return dist >= len - 0.05;
    }
}
