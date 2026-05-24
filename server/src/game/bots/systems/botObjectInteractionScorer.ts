import { MapObjectDefs } from "../../../../../shared/defs/mapObjectDefs";
import type { MeleeDef } from "../../../../../shared/defs/gameObjects/meleeDefs";
import type { ObstacleDef } from "../../../../../shared/defs/mapObjectsTyping";
import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { collider } from "../../../../../shared/utils/collider";
import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import type { Game } from "../../game";
import type { Obstacle } from "../../objects/obstacle";
import type { Player } from "../../objects/player";
import type { BotBrainType } from "../botBrain";
import type { BotUnarmedThreatContext } from "../botDecisionSupport";
import { getBotBrainProfile } from "../botBrainProfiles";
import type { BotCombatState, BotObjectInteractionMode } from "../botCombat";
import { BotTuning } from "../botTuning";
import { classifyWeapon } from "./botWeaponProfiles";
import { GameObjectDefs } from "../../../../../shared/defs/gameObjectDefs";
import type { GunDef } from "../../../../../shared/defs/gameObjects/gunDefs";

export type BotObjectInteractMode = "idle" | "opportunistic";

export type BotObjectInteractionChoice = {
    obstacleId: number;
    pos: Vec2;
    score: number;
    reason: string;
    mode: BotObjectInteractionMode;
};

type ObjectChoiceCacheEntry = {
    until: number;
    botId: number;
    brainType: BotBrainType;
    mode: BotObjectInteractMode;
    state: BotCombatState;
    layer: number;
    pos: Vec2;
    baseGoal?: Vec2;
    unarmedThreatKey: string;
    choice?: BotObjectInteractionChoice;
};

export class BotObjectInteractionScorer {
    private _cache?: ObjectChoiceCacheEntry;
    private readonly _failedObstacleIds = new Map<number, number>();
    private readonly _failedRedirectBlockerIds = new Map<number, number>();

    chooseObject(params: {
        game: Game;
        player: Player;
        timeNow: number;
        mode: BotObjectInteractMode;
        brainType: BotBrainType;
        state: BotCombatState;
        baseGoal?: Vec2;
        unarmedThreat?: BotUnarmedThreatContext;
    }): BotObjectInteractionChoice | undefined {
        const {
            game,
            player,
            timeNow,
            mode,
            brainType,
            state,
            baseGoal,
            unarmedThreat,
        } = params;
        const profile = getBotBrainProfile(brainType);
        const maxDist = this._getSearchDistance(mode, profile);
        this._pruneFailures(timeNow);

        const cached = this._getCachedChoice({
            game,
            player,
            timeNow,
            mode,
            brainType,
            state,
            baseGoal,
            unarmedThreat,
            maxDist,
        });
        if (cached !== undefined) {
            return cached;
        }

        const nearby = game.grid.intersectCollider(
            collider.createCircle(player.pos, maxDist + 1.5),
        );

        const choicesByObstacleId = new Map<number, BotObjectInteractionChoice>();

        for (const obj of nearby) {
            if (obj.__type !== ObjectType.Obstacle) continue;
            const obstacle = obj as Obstacle;
            if (obstacle.dead || !util.sameLayer(obstacle.layer, player.layer)) continue;
            if (this._failedObstacleIds.has(obstacle.__id)) continue;

            const dist = v2.distance(player.pos, obstacle.pos);
            if (dist > maxDist) continue;

            const score = this._scoreObstacle(
                mode,
                player,
                obstacle,
                dist,
                state,
                baseGoal,
                profile.objectLootWillingness,
                unarmedThreat,
            );
            if (!score) continue;

            const choice = this._resolveApproachChoice(
                game,
                player,
                obstacle,
                score,
                unarmedThreat,
            );
            if (!choice) continue;

            const existing = choicesByObstacleId.get(choice.obstacleId);
            if (!existing || choice.score > existing.score) {
                choicesByObstacleId.set(choice.obstacleId, choice);
            }
        }

        let best: BotObjectInteractionChoice | undefined;
        for (const choice of choicesByObstacleId.values()) {
            if (!best || choice.score > best.score) {
                best = choice;
            }
        }

        this._cacheChoice({
            timeNow,
            player,
            brainType,
            mode,
            state,
            baseGoal,
            unarmedThreat,
            choice: best,
        });

        return best;
    }

    markFailedObstacleTarget(
        obstacleId: number | undefined,
        timeNow: number,
        reason: "target" | "redirect_blocker" = "target",
    ): void {
        if (obstacleId === undefined) return;
        const targetMap =
            reason === "redirect_blocker"
                ? this._failedRedirectBlockerIds
                : this._failedObstacleIds;
        const ttl =
            reason === "redirect_blocker"
                ? BotTuning.optimization.failedBlockerCooldownSec
                : BotTuning.optimization.failedObjectCooldownSec;
        targetMap.set(obstacleId, timeNow + ttl);
        if (this._cache?.choice?.obstacleId === obstacleId) {
            this._cache = undefined;
        }
    }

    private _getSearchDistance(
        mode: BotObjectInteractMode,
        profile: ReturnType<typeof getBotBrainProfile>,
    ): number {
        switch (mode) {
            case "idle":
                return (
                    BotTuning.objectInteract.idleSearchDist *
                    profile.objectInteractDistScale
                );
            case "opportunistic":
                return (
                    BotTuning.objectInteract.opportunisticSearchDist *
                    profile.objectInteractDistScale
                );
        }
    }

    private _scoreObstacle(
        mode: BotObjectInteractMode,
        player: Player,
        obstacle: Obstacle,
        dist: number,
        state: BotCombatState,
        baseGoal: Vec2 | undefined,
        willingness: number,
        unarmedThreat?: BotUnarmedThreatContext,
    ): { score: number; reason: string; mode: BotObjectInteractionMode } | undefined {
        const def = MapObjectDefs[obstacle.type];
        if (def.type !== "obstacle") return undefined;

        const detour = this._getDetourDistance(player.pos, obstacle.pos, baseGoal);
        if (detour > BotTuning.objectInteract.maxDetourDist) return undefined;

        if (this._isManualDoor(obstacle)) {
            const score = this._scoreManualDoor(obstacle, dist, detour, baseGoal);
            return score
                ? {
                      score,
                      reason: "use_manual_door",
                      mode: "use",
                  }
                : undefined;
        }

        if (this._isUsefulButton(obstacle, baseGoal)) {
            const score = this._scoreButton(obstacle, dist, detour, baseGoal);
            return score
                ? {
                      score,
                      reason: "use_unlock_button",
                      mode: "use",
                  }
                : undefined;
        }

        if (!this._canBreakForLoot(player, obstacle, def)) return undefined;

        const statePenalty = this._getBreakStatePenalty(mode, state);
        if (statePenalty === undefined) return undefined;

        const loadoutValue = this._estimateLoadoutValue(player);
        const lootRichness = this._estimateObstacleLootValue(obstacle, def);
        let score =
            lootRichness * willingness -
            dist * 18 -
            detour * 22 -
            statePenalty -
            loadoutValue * BotTuning.objectInteract.loadoutValuePenalty;

        if (unarmedThreat) {
            score += BotTuning.unarmed.objectBaseBonus;
            score += this._scoreUnarmedThreatAdjustment(obstacle, unarmedThreat);
        }

        if (score <= 0) return undefined;

        return {
            score,
            reason: "break_loot_obstacle",
            mode: "melee_break",
        };
    }

    private _isManualDoor(obstacle: Obstacle): boolean {
        return !!(
            obstacle.isDoor &&
            obstacle.door &&
            !obstacle.door.autoOpen &&
            !obstacle.door.open &&
            obstacle.door.canUse &&
            !obstacle.door.locked
        );
    }

    private _scoreManualDoor(
        obstacle: Obstacle,
        dist: number,
        detour: number,
        baseGoal?: Vec2,
    ): number | undefined {
        if (!baseGoal) return undefined;

        const targetDist = v2.distance(obstacle.pos, baseGoal);
        return (
            BotTuning.objectInteract.manualDoorBaseScore -
            dist * 16 -
            detour * 28 -
            targetDist * 4
        );
    }

    private _isUsefulButton(obstacle: Obstacle, baseGoal?: Vec2): boolean {
        if (
            !obstacle.isButton ||
            !obstacle.button.canUse ||
            !obstacle.button.useType ||
            !obstacle.parentBuilding
        ) {
            return false;
        }

        for (const obj of obstacle.parentBuilding.childObjects) {
            if (
                obj.__type === ObjectType.Obstacle &&
                obj.type === obstacle.button.useType &&
                obj.isDoor &&
                obj.door &&
                !obj.door.open &&
                obj.door.canUse
            ) {
                if (!baseGoal) return true;
                if (v2.distance(obj.pos, baseGoal) <= BotTuning.objectInteract.maxDetourDist + 3) {
                    return true;
                }
            }
        }

        return false;
    }

    private _scoreButton(
        obstacle: Obstacle,
        dist: number,
        detour: number,
        baseGoal?: Vec2,
    ): number | undefined {
        if (!obstacle.parentBuilding || !obstacle.button.useType) return undefined;

        let bestDoorDist = Infinity;
        for (const obj of obstacle.parentBuilding.childObjects) {
            if (
                obj.__type === ObjectType.Obstacle &&
                obj.type === obstacle.button.useType &&
                obj.isDoor &&
                obj.door &&
                !obj.door.open
            ) {
                if (baseGoal) {
                    bestDoorDist = Math.min(bestDoorDist, v2.distance(obj.pos, baseGoal));
                } else {
                    bestDoorDist = Math.min(bestDoorDist, v2.distance(obj.pos, obstacle.pos));
                }
            }
        }

        if (!Number.isFinite(bestDoorDist)) return undefined;

        return (
            BotTuning.objectInteract.buttonBaseScore -
            dist * 18 -
            detour * 30 -
            bestDoorDist * 3
        );
    }

    private _canBreakForLoot(
        player: Player,
        obstacle: Obstacle,
        def: ObstacleDef,
    ): boolean {
        return (
            obstacle.destructible &&
            obstacle.health > 0 &&
            !obstacle.isWindow &&
            this._canBotMeleeDamageObstacle(player, def) &&
            (def.loot.length > 0 || !!def.destroyType || !!def.airdropCrate)
        );
    }

    private _resolveApproachChoice(
        game: Game,
        player: Player,
        obstacle: Obstacle,
        score: { score: number; reason: string; mode: BotObjectInteractionMode },
        unarmedThreat?: BotUnarmedThreatContext,
    ): BotObjectInteractionChoice | undefined {
        if (score.mode !== "melee_break") {
            return {
                obstacleId: obstacle.__id,
                pos: v2.copy(obstacle.pos),
                score: score.score,
                reason: score.reason,
                mode: score.mode,
            };
        }

        const blocker = this._getFirstMovementBlocker(game, player, obstacle.pos, obstacle.__id);
        if (!blocker) {
            return {
                obstacleId: obstacle.__id,
                pos: v2.copy(obstacle.pos),
                score: score.score,
                reason: score.reason,
                mode: score.mode,
            };
        }

        if (
            unarmedThreat &&
            blocker.destructible &&
            blocker.health > 0 &&
            !blocker.isWindow &&
            !this._isUnsafeExplosiveRouteBlocker(blocker) &&
            !this._failedRedirectBlockerIds.has(blocker.__id) &&
            this._canBotBreakObstacle(player, blocker)
        ) {
            return {
                obstacleId: blocker.__id,
                pos: v2.copy(blocker.pos),
                score: score.score - 35,
                reason: "break_route_blocker",
                mode: "melee_break",
            };
        }

        return undefined;
    }

    private _getFirstMovementBlocker(
        game: Game,
        player: Player,
        goal: Vec2,
        ignoreObstacleId?: number,
    ): Obstacle | undefined {
        const len = v2.distance(player.pos, goal);
        if (len <= 0.0001) return undefined;

        const dir = v2.normalizeSafe(v2.sub(goal, player.pos), v2.create(1, 0));
        const aabb = coldet.lineSegmentToAabb(player.pos, goal);
        const nearby = game.grid.intersectCollider(aabb);
        const obstacles = nearby.filter(
            (obj): obj is Obstacle =>
                obj.__type === ObjectType.Obstacle &&
                obj.__id !== ignoreObstacleId &&
                this._blocksMovement(player, obj),
        );

        const hit = collisionHelpers.intersectSegment(
            obstacles,
            player.pos,
            dir,
            len,
            0.0,
            player.layer,
            false,
        );
        if (!hit) return undefined;

        return obstacles.find((obstacle) => obstacle.__id === hit.id);
    }

    private _blocksMovement(player: Player, obstacle: Obstacle): boolean {
        if (obstacle.dead || !obstacle.collidable || obstacle.isWindow) return false;
        if (!util.sameLayer(obstacle.layer, player.layer)) return false;
        if (obstacle.isDoor && obstacle.door?.autoOpen && !obstacle.door.locked) {
            return false;
        }
        return true;
    }

    private _getBreakStatePenalty(
        mode: BotObjectInteractMode,
        state: BotCombatState,
    ): number | undefined {
        switch (state) {
            case "wander":
            case "loot":
            case "interact_object":
                return 0;
            case "hold_range":
            case "hold_position":
            case "strafe":
                return mode === "opportunistic" ? 220 : undefined;
            case "push":
            case "back_off":
            case "chase_last_seen":
                return mode === "opportunistic" ? 320 : undefined;
            case "seek_cover":
            case "retreat_reload":
            case "retreat_heal":
                return undefined;
        }
    }

    private _estimateObstacleLootValue(obstacle: Obstacle, def: ObstacleDef): number {
        return (
            BotTuning.objectInteract.lootBaselineScore +
            def.loot.length * BotTuning.objectInteract.lootEntryBonus +
            (def.destroyType ? BotTuning.objectInteract.destroyTypeBonus : 0) +
            (def.airdropCrate ? BotTuning.objectInteract.airdropBonus : 0) +
            (obstacle.maxHealth > 100 ? 40 : 0)
        );
    }

    private _canBotBreakObstacle(player: Player, obstacle: Obstacle): boolean {
        const def = MapObjectDefs[obstacle.type];
        return def.type === "obstacle" && this._canBotMeleeDamageObstacle(player, def);
    }

    private _isUnsafeExplosiveRouteBlocker(obstacle: Obstacle): boolean {
        const def = MapObjectDefs[obstacle.type];
        return def.type === "obstacle" && !!def.explosion;
    }

    private _canBotMeleeDamageObstacle(player: Player, def: ObstacleDef): boolean {
        if (!def.armorPlated && !def.stonePlated) return true;

        const meleeDef = this._getBotMeleeDef(player);
        if (def.armorPlated && !meleeDef.armorPiercing) return false;
        if (def.stonePlated && !meleeDef.stonePiercing) return false;
        return true;
    }

    private _getBotMeleeDef(player: Player): MeleeDef {
        const meleeType = player.weapons[GameConfig.WeaponSlot.Melee].type || "fists";
        return GameObjectDefs[meleeType] as MeleeDef;
    }

    private _estimateLoadoutValue(player: Player): number {
        let value = 0;

        for (const slot of [
            0,
            1,
        ] as const) {
            const weapon = player.weapons[slot];
            if (!weapon.type) continue;
            const def = GameObjectDefs[weapon.type];
            if (def?.type !== "gun") continue;

            const gunDef = def as GunDef;
            switch (classifyWeapon(gunDef)) {
                case "precision":
                    value += 8;
                    break;
                case "lmg":
                case "ar":
                    value += 7;
                    break;
                case "shotgun":
                    value += 6;
                    break;
                case "smg":
                    value += 5;
                    break;
                case "pistol":
                default:
                    value += 3;
                    break;
            }

            const ammoType = gunDef.ammo;
            const inventory = player.inventory as Record<string, number>;
            const reserveAmmo = ammoType ? (inventory[ammoType] ?? 0) : 0;
            value += Math.min(reserveAmmo / 30, 4);
        }

        value += player.getGearLevel(player.helmet) * 2.5;
        value += player.getGearLevel(player.chest) * 3;
        value += player.getGearLevel(player.backpack) * 2;
        value += Math.min(player.inventory.bandage ?? 0, 5) * 0.8;
        value += Math.min(player.inventory.healthkit ?? 0, 3) * 1.4;
        value += Math.min(player.inventory.soda ?? 0, 4) * 0.6;
        value += Math.min(player.inventory.painkiller ?? 0, 3) * 1;

        return value;
    }

    private _scoreUnarmedThreatAdjustment(
        obstacle: Obstacle,
        unarmedThreat: BotUnarmedThreatContext,
    ): number {
        if (!unarmedThreat.visibleHostile) {
            return 0;
        }

        const proximityFactor = unarmedThreat.hostilePos
            ? math.clamp(
                  1 -
                      v2.distance(obstacle.pos, unarmedThreat.hostilePos) /
                          BotTuning.unarmed.hostileProximityRef,
                  0,
                  1,
              )
            : 0;

        if (unarmedThreat.hostileHasShownGun) {
            let penalty = BotTuning.unarmed.shownGunObjectPenalty;
            if (unarmedThreat.hostileDistracted) {
                penalty -= BotTuning.unarmed.distractedShownGunObjectRelief;
            }
            return -penalty * (0.4 + proximityFactor * 0.6);
        }

        if (unarmedThreat.hostileAppearsUnarmed) {
            return (
                BotTuning.unarmed.unarmedHostileObjectBonus *
                (0.35 + proximityFactor * 0.65)
            );
        }

        return 0;
    }

    private _getCachedChoice(params: {
        game: Game;
        player: Player;
        timeNow: number;
        mode: BotObjectInteractMode;
        brainType: BotBrainType;
        state: BotCombatState;
        baseGoal?: Vec2;
        unarmedThreat?: BotUnarmedThreatContext;
        maxDist: number;
    }): BotObjectInteractionChoice | undefined {
        const {
            game,
            player,
            timeNow,
            mode,
            brainType,
            state,
            baseGoal,
            unarmedThreat,
            maxDist,
        } = params;
        const cached = this._cache;
        if (!cached || cached.until < timeNow) return undefined;
        if (
            cached.botId !== player.__id ||
            cached.brainType !== brainType ||
            cached.mode !== mode ||
            cached.state !== state ||
            cached.layer !== player.layer ||
            cached.unarmedThreatKey !== this._getUnarmedThreatKey(unarmedThreat)
        ) {
            return undefined;
        }
        if (
            v2.distance(player.pos, cached.pos) >
            BotTuning.optimization.selectionCacheMoveDist
        ) {
            return undefined;
        }
        if (!this._sameBaseGoal(cached.baseGoal, baseGoal)) return undefined;
        if (!cached.choice) return undefined;
        if (this._failedObstacleIds.has(cached.choice.obstacleId)) return undefined;

        const obj = game.objectRegister.getById(cached.choice.obstacleId);
        if (
            !obj ||
            obj.__type !== ObjectType.Obstacle ||
            obj.dead ||
            !util.sameLayer(obj.layer, player.layer)
        ) {
            return undefined;
        }
        if (v2.distance(player.pos, obj.pos) > maxDist) return undefined;

        return {
            ...cached.choice,
            pos: v2.copy(obj.pos),
        };
    }

    private _cacheChoice(params: {
        timeNow: number;
        player: Player;
        brainType: BotBrainType;
        mode: BotObjectInteractMode;
        state: BotCombatState;
        baseGoal?: Vec2;
        unarmedThreat?: BotUnarmedThreatContext;
        choice?: BotObjectInteractionChoice;
    }): void {
        const {
            timeNow,
            player,
            brainType,
            mode,
            state,
            baseGoal,
            unarmedThreat,
            choice,
        } = params;
        this._cache = {
            until: timeNow + BotTuning.optimization.selectionCacheTtlSec,
            botId: player.__id,
            brainType,
            mode,
            state,
            layer: player.layer,
            pos: v2.copy(player.pos),
            baseGoal: baseGoal ? v2.copy(baseGoal) : undefined,
            unarmedThreatKey: this._getUnarmedThreatKey(unarmedThreat),
            choice: choice
                ? {
                      ...choice,
                      pos: v2.copy(choice.pos),
                  }
                : undefined,
        };
    }

    private _sameBaseGoal(a?: Vec2, b?: Vec2): boolean {
        if (!a && !b) return true;
        if (!a || !b) return false;
        return (
            v2.distance(a, b) <= BotTuning.optimization.selectionCacheGoalDist
        );
    }

    private _getUnarmedThreatKey(unarmedThreat?: BotUnarmedThreatContext): string {
        if (!unarmedThreat) return "none";

        return [
            Number(unarmedThreat.visibleHostile),
            Number(unarmedThreat.hostileHasShownGun),
            Number(unarmedThreat.hostileAppearsUnarmed),
            Number(unarmedThreat.hostileRecentlyFired),
            Number(unarmedThreat.hostileDistracted),
        ].join(":");
    }

    private _pruneFailures(timeNow: number): void {
        for (const [obstacleId, until] of this._failedObstacleIds) {
            if (until <= timeNow) {
                this._failedObstacleIds.delete(obstacleId);
            }
        }

        for (const [obstacleId, until] of this._failedRedirectBlockerIds) {
            if (until <= timeNow) {
                this._failedRedirectBlockerIds.delete(obstacleId);
            }
        }
    }

    private _getDetourDistance(
        start: Vec2,
        target: Vec2,
        baseGoal?: Vec2,
    ): number {
        if (!baseGoal) return 0;
        return (
            v2.distance(start, target) +
            v2.distance(target, baseGoal) -
            v2.distance(start, baseGoal)
        );
    }
}
