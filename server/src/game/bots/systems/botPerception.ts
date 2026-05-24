import { GameObjectDefs } from "../../../../../shared/defs/gameObjectDefs";
import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import { Config } from "../../../config";
import type { Game } from "../../game";
import type { Player } from "../../objects/player";
import type { BotBrainType } from "../botBrain";
import { getBotBrainProfile } from "../botBrainProfiles";
import { BotTuning } from "../botTuning";

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

type ScanCacheEntry = {
    timeNow: number;
    botId: number;
    brainType: BotBrainType;
    layer: number;
    pos: Vec2;
    targetId?: number;
    visible: boolean;
    targetHasShownGun: boolean;
    targetAppearsUnarmed: boolean;
    targetRecentlyFired: boolean;
    targetDistracted: boolean;
    threat: BotThreatSnapshot;
};

export class BotPerception {
    targetId?: number;
    targetVisible = false;
    targetSeenTime = -Infinity;
    lastSeenPos?: Vec2;
    lastSeenTime = -Infinity;
    targetHasShownGun = false;
    targetAppearsUnarmed = false;
    targetRecentlyFired = false;
    targetDistracted = false;

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
    private readonly _shownGunHostiles = new Set<number>();
    private _scanCache?: ScanCacheEntry;

    /**
     * True when bot has seen an enemy recently (used for retire priority).
     */
    inCombat(timeNow: number): boolean {
        return timeNow - this.targetSeenTime < 1.0;
    }

    markTargetSeen(timeNow: number): void {
        this.targetSeenTime = timeNow;
        this._scanCache = undefined;
    }

    markTargetVisible(timeNow: number, pos: Vec2): void {
        this.targetSeenTime = timeNow;
        this.lastSeenTime = timeNow;
        this.lastSeenPos = v2.copy(pos);
        this._scanCache = undefined;
    }

    markDamaged(timeNow: number): void {
        this._lastDamagedTime = timeNow;
        this._scanCache = undefined;
    }

    markHeardEnemy(timeNow: number): void {
        this._lastHeardEnemyTime = timeNow;
        this._scanCache = undefined;
    }

    /**
     * Finds the best target under the current rules.
     * Returns the chosen player + whether they are currently visible (LOS).
     */
    scanForTarget(
        game: Game,
        player: Player,
        timeNow: number,
        brainType: BotBrainType,
    ): { target?: Player; visible: boolean } {
        const cached = this._getCachedScan(game, player, timeNow, brainType);
        if (cached) {
            return cached;
        }

        const profile = getBotBrainProfile(brainType);
        const vision = player.zoom + 6;
        const visionSqr = vision * vision;
        const rect = coldet.circleToAabb(player.pos, vision);
        const objects = game.map.isWaveMap
            ? game.playerBarn.players
            : game.grid.intersectCollider(rect);

        let bestVisible: Player | undefined;
        let bestVisibleDist = Number.MAX_VALUE;
        let bestVisibleScore = -Infinity;

        let bestAny: Player | undefined;
        let bestAnyDist = Number.MAX_VALUE;
        let bestAnyScore = -Infinity;

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

            if (profile.targetSelection === "threat_score") {
                const anyScore = this._scoreTargetChoice(
                    player,
                    other,
                    false,
                    distSqr,
                    profile,
                );
                if (anyScore > bestAnyScore) {
                    bestAnyScore = anyScore;
                    bestAnyDist = distSqr;
                    bestAny = other;
                }
            }

            if (profile.targetSelection !== "threat_score" && distSqr >= bestVisibleDist) {
                continue;
            }
            const hasLos = this._hasLineOfSight(game, player, other);
            if (!hasLos) continue;
            if (this._hasVisibleGunEvidence(other)) {
                this._shownGunHostiles.add(other.__id);
            }
            if (profile.targetSelection === "threat_score") {
                const visibleScore = this._scoreTargetChoice(
                    player,
                    other,
                    true,
                    distSqr,
                    profile,
                );
                if (
                    visibleScore > bestVisibleScore ||
                    (visibleScore === bestVisibleScore && distSqr < bestVisibleDist)
                ) {
                    bestVisibleScore = visibleScore;
                    bestVisibleDist = distSqr;
                    bestVisible = other;
                }
            } else {
                bestVisibleDist = distSqr;
                bestVisible = other;
            }
            if (nearby) anyHostileVisible = true;
        }

        const chosen = bestVisible ?? bestAny;
        this._pruneShownGunMemory(game);

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

        const targetVisible = chosen !== undefined && chosen === bestVisible;
        const targetHasShownGun =
            chosen !== undefined && this._shownGunHostiles.has(chosen.__id);
        const targetRecentlyFired =
            targetVisible &&
            chosen !== undefined &&
            this._hasVisibleGun(chosen) &&
            chosen.shotSlowdownTimer > 0;
        const targetAppearsUnarmed =
            targetVisible &&
            chosen !== undefined &&
            !targetHasShownGun &&
            !this._hasVisibleGun(chosen) &&
            !targetRecentlyFired;

        let targetDistracted = false;
        if (
            targetVisible &&
            chosen !== undefined &&
            targetHasShownGun &&
            targetRecentlyFired &&
            timeNow - this._lastDamagedTime >
                BotTuning.combat.recentlyDamagedWindowSec
        ) {
            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                if (obj.__type !== ObjectType.Player) continue;
                const other = obj as Player;
                if (other === chosen || other === player) continue;
                if (other.dead || other.disconnected) continue;
                if (!util.sameLayer(other.layer, chosen.layer)) continue;
                if (!this._isNonFriendly(chosen, other, game)) continue;

                if (
                    v2.distance(other.pos, chosen.pos) <=
                    BotTuning.unarmed.distractedFightRadius
                ) {
                    targetDistracted = true;
                    break;
                }
            }
        }

        this.targetHasShownGun = targetHasShownGun;
        this.targetAppearsUnarmed = targetAppearsUnarmed;
        this.targetRecentlyFired = targetRecentlyFired;
        this.targetDistracted = targetDistracted;

        this._cacheScan({
            game,
            player,
            timeNow,
            brainType,
            target: chosen,
            visible: targetVisible,
            threat: this.threat,
        });

        return {
            target: chosen,
            visible: targetVisible,
        };
    }

    private _hasVisibleGunEvidence(player: Player): boolean {
        return this._hasVisibleGun(player);
    }

    private _hasVisibleGun(player: Player): boolean {
        const activeDef = GameObjectDefs[player.activeWeapon];
        return activeDef?.type === "gun";
    }

    private _isNonFriendly(a: Player, b: Player, game: Game): boolean {
        return !(
            a.groupId === b.groupId ||
            (game.map.factionMode && a.teamId === b.teamId)
        );
    }

    private _pruneShownGunMemory(game: Game): void {
        for (const id of this._shownGunHostiles) {
            const obj = game.objectRegister.getById(id);
            if (
                !obj ||
                obj.__type !== ObjectType.Player ||
                (obj as Player).dead ||
                (obj as Player).disconnected
            ) {
                this._shownGunHostiles.delete(id);
            }
        }
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

    private _scoreTargetChoice(
        player: Player,
        target: Player,
        visible: boolean,
        distSqr: number,
        profile: ReturnType<typeof getBotBrainProfile>,
    ): number {
        const dist = Math.sqrt(distSqr);
        let score = -dist * 1.6;

        if (visible) score += profile.targetVisibleBonus;
        if (dist <= player.zoom + 6) score += 10;
        if (target.__id === this.targetId) score += profile.targetStickinessBonus;
        score += Math.max(0, 100 - target.health) * profile.targetLowHealthWeight;
        if (target.isReloading()) score += profile.targetReloadBonus;

        return score;
    }

    private _getCachedScan(
        game: Game,
        player: Player,
        timeNow: number,
        brainType: BotBrainType,
    ): { target?: Player; visible: boolean } | undefined {
        const cached = this._scanCache;
        if (!cached) return undefined;
        if (
            cached.timeNow !== timeNow ||
            cached.botId !== player.__id ||
            cached.brainType !== brainType ||
            cached.layer !== player.layer
        ) {
            return undefined;
        }
        if (
            v2.distance(cached.pos, player.pos) >
            BotTuning.optimization.selectionCacheMoveDist
        ) {
            return undefined;
        }

        const target = cached.targetId
            ? game.objectRegister.getById(cached.targetId)
            : undefined;
        if (
            cached.targetId !== undefined &&
            (!target ||
                target.__type !== ObjectType.Player ||
                (target as Player).dead ||
                (target as Player).disconnected ||
                !util.sameLayer((target as Player).layer, player.layer))
        ) {
            return undefined;
        }

        this.threat = { ...cached.threat };
        this.targetHasShownGun = cached.targetHasShownGun;
        this.targetAppearsUnarmed = cached.targetAppearsUnarmed;
        this.targetRecentlyFired = cached.targetRecentlyFired;
        this.targetDistracted = cached.targetDistracted;

        return {
            target: target && target.__type === ObjectType.Player ? (target as Player) : undefined,
            visible: cached.visible,
        };
    }

    private _cacheScan(params: {
        game: Game;
        player: Player;
        timeNow: number;
        brainType: BotBrainType;
        target?: Player;
        visible: boolean;
        threat: BotThreatSnapshot;
    }): void {
        const { player, timeNow, brainType, target, visible, threat } = params;
        this._scanCache = {
            timeNow,
            botId: player.__id,
            brainType,
            layer: player.layer,
            pos: v2.copy(player.pos),
            targetId: target?.__id,
            visible,
            targetHasShownGun: this.targetHasShownGun,
            targetAppearsUnarmed: this.targetAppearsUnarmed,
            targetRecentlyFired: this.targetRecentlyFired,
            targetDistracted: this.targetDistracted,
            threat: { ...threat },
        };
    }
}
