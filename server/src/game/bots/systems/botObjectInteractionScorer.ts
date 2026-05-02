import { MapObjectDefs } from "../../../../../shared/defs/mapObjectDefs";
import type { ObstacleDef } from "../../../../../shared/defs/mapObjectsTyping";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { collider } from "../../../../../shared/utils/collider";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import type { Game } from "../../game";
import type { Obstacle } from "../../objects/obstacle";
import type { Player } from "../../objects/player";
import type { BotBrainType } from "../botBrain";
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

export class BotObjectInteractionScorer {
    chooseObject(params: {
        game: Game;
        player: Player;
        mode: BotObjectInteractMode;
        brainType: BotBrainType;
        state: BotCombatState;
        baseGoal?: Vec2;
    }): BotObjectInteractionChoice | undefined {
        const { game, player, mode, brainType, state, baseGoal } = params;
        const profile = getBotBrainProfile(brainType);
        const maxDist = this._getSearchDistance(mode, profile);
        const nearby = game.grid.intersectCollider(
            collider.createCircle(player.pos, maxDist + 1.5),
        );

        let best: BotObjectInteractionChoice | undefined;
        for (const obj of nearby) {
            if (obj.__type !== ObjectType.Obstacle) continue;
            const obstacle = obj as Obstacle;
            if (obstacle.dead || !util.sameLayer(obstacle.layer, player.layer)) continue;

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
            );
            if (!score) continue;

            const choice: BotObjectInteractionChoice = {
                obstacleId: obstacle.__id,
                pos: v2.copy(obstacle.pos),
                score: score.score,
                reason: score.reason,
                mode: score.mode,
            };

            if (!best || choice.score > best.score) {
                best = choice;
            }
        }

        return best;
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

        if (!this._canBreakForLoot(obstacle, def)) return undefined;

        const statePenalty = this._getBreakStatePenalty(mode, state);
        if (statePenalty === undefined) return undefined;

        const loadoutValue = this._estimateLoadoutValue(player);
        const lootRichness = this._estimateObstacleLootValue(obstacle, def);
        const score =
            lootRichness * willingness -
            dist * 18 -
            detour * 22 -
            statePenalty -
            loadoutValue * BotTuning.objectInteract.loadoutValuePenalty;

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

    private _canBreakForLoot(obstacle: Obstacle, def: ObstacleDef): boolean {
        return (
            obstacle.destructible &&
            obstacle.health > 0 &&
            (def.loot.length > 0 || !!def.destroyType || !!def.airdropCrate)
        );
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
            const reserveAmmo = ammoType ? player.inventory[ammoType] ?? 0 : 0;
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
