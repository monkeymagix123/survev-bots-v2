import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import { Config } from "../../../config";
import type { Game } from "../../game";
import type { Player } from "../../objects/player";

export type BotThreatSnapshot = {
    /**
     * Count of nearby enemies that are valid hostiles under current rules.
     */
    nearbyHostileCount: number;
    /**
     * True when at least one nearby hostile currently has line-of-sight (LOS).
     */
    anyHostileVisible: boolean;
    /**
     * Nearby players that are friendly (same group/team).
     */
    nearbyFriendlyCount: number;
    /**
     * Nearby players that are ignored (e.g. bot-vs-bot disabled).
     */
    nearbyIgnoredCount: number;
    /**
     * Distance to nearest hostile (any distance; can be > vision on Wave maps).
     */
    nearestHostileDist: number;
    /**
     * Distance to nearest hostile within the scan radius (~`player.zoom + 6`).
     * `Infinity` when no nearby hostile exists.
     */
    nearestNearbyHostileDist: number;
    /**
     * Most recent time we saw/heard/were damaged by an enemy (seconds timestamp).
     */
    recentEnemyTime: number;
    /**
     * True when we have seen/heard/been damaged by an enemy recently.
     */
    hasRecentEnemy: boolean;
};

export class BotPerception {
    targetId?: number;
    targetVisible = false;
    targetSeenTime = -Infinity;
    lastSeenPos?: Vec2;
    lastSeenTime = -Infinity;

    threat: BotThreatSnapshot = {
        nearbyHostileCount: 0,
        anyHostileVisible: false,
        nearbyFriendlyCount: 0,
        nearbyIgnoredCount: 0,
        nearestHostileDist: Infinity,
        nearestNearbyHostileDist: Infinity,
        recentEnemyTime: -Infinity,
        hasRecentEnemy: false,
    };

    private _lastDamagedTime = -Infinity;
    private _lastHeardEnemyTime = -Infinity;

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

    markDamaged(timeNow: number): void {
        this._lastDamagedTime = timeNow;
    }

    markHeardEnemy(timeNow: number): void {
        this._lastHeardEnemyTime = timeNow;
    }

    /**
     * Finds the best target under the current rules.
     * Returns the chosen player + whether they are currently visible (LOS).
     */
    scanForTarget(
        game: Game,
        player: Player,
        timeNow: number,
    ): { target?: Player; visible: boolean } {
        const vision = player.zoom + 6;
        const visionSqr = vision * vision;
        const rect = coldet.circleToAabb(player.pos, vision);
        const objects = game.map.isWaveMap
            ? game.playerBarn.players
            : game.grid.intersectCollider(rect);

        let bestVisible: Player | undefined;
        let bestVisibleDist = Number.MAX_VALUE;

        let bestAny: Player | undefined;
        let bestAnyDist = Number.MAX_VALUE;

        let nearbyHostileCount = 0;
        let anyHostileVisible = false;
        let nearbyFriendlyCount = 0;
        let nearbyIgnoredCount = 0;
        let nearestHostileDistSqr = Infinity;
        let nearestNearbyHostileDistSqr = Infinity;

        for (let i = 0; i < objects.length; i++) {
            const obj = objects[i];
            if (obj.__type !== ObjectType.Player) continue;
            const other = obj as Player;
            if (other === player) continue;
            if (other.dead || other.disconnected) continue;
            if (!util.sameLayer(other.layer, player.layer)) continue;

            const distSqr = v2.lengthSqr(v2.sub(other.pos, player.pos));
            const nearby = distSqr <= visionSqr;

            const friendly =
                other.groupId === player.groupId ||
                (game.map.factionMode && other.teamId === player.teamId);

            // Optional bot-vs-bot suppression (internal + external websocket bots)
            const ignoredByBotVsBot =
                !friendly && !Config.bots.allowBotVsBot && (other.isAi || other.bot);

            if (nearby) {
                if (friendly) nearbyFriendlyCount++;
                else if (ignoredByBotVsBot) nearbyIgnoredCount++;
                else nearbyHostileCount++;
            }

            // Ignore friendlies / ignored entities for targeting
            if (friendly) continue;
            if (ignoredByBotVsBot) continue;

            if (distSqr < nearestHostileDistSqr) {
                nearestHostileDistSqr = distSqr;
            }
            if (nearby && distSqr < nearestNearbyHostileDistSqr) {
                nearestNearbyHostileDistSqr = distSqr;
            }

            if (distSqr < bestAnyDist) {
                bestAnyDist = distSqr;
                bestAny = other;
            }

            if (distSqr >= bestVisibleDist) continue;
            const hasLos = this._hasLineOfSight(game, player, other);
            if (!hasLos) continue;
            bestVisibleDist = distSqr;
            bestVisible = other;
            if (nearby) anyHostileVisible = true;
        }

        const chosen = bestVisible ?? bestAny;

        const recentEnemyTime = Math.max(
            this.targetSeenTime,
            this._lastDamagedTime,
            this._lastHeardEnemyTime,
        );
        const hasRecentEnemy = timeNow - recentEnemyTime < 1.25;

        this.threat = {
            nearbyHostileCount,
            anyHostileVisible,
            nearbyFriendlyCount,
            nearbyIgnoredCount,
            nearestHostileDist: Math.sqrt(nearestHostileDistSqr),
            nearestNearbyHostileDist: Math.sqrt(nearestNearbyHostileDistSqr),
            recentEnemyTime,
            hasRecentEnemy,
        };

        return {
            target: chosen,
            visible: chosen !== undefined && chosen === bestVisible,
        };
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
