import { GameObjectDefs } from "../../../../../shared/defs/gameObjectDefs";
import type { BulletDef } from "../../../../../shared/defs/gameObjects/bulletDefs";
import type {
    BackpackDef,
    BoostDef,
    ChestDef,
    HealDef,
    HelmetDef,
} from "../../../../../shared/defs/gameObjects/gearDefs";
import type { GunDef } from "../../../../../shared/defs/gameObjects/gunDefs";
import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { collider } from "../../../../../shared/utils/collider";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import type { Game } from "../../game";
import type { Loot } from "../../objects/loot";
import type { Player } from "../../objects/player";
import type { BotBrainType } from "../botBrain";
import { getBotBrainProfile } from "../botBrainProfiles";
import { BotTuning } from "../botTuning";
import { classifyWeapon } from "./botWeaponProfiles";

export type BotLootMode = "idle" | "opportunistic";

export type BotLootChoice = {
    lootId: number;
    pos: Vec2;
    score: number;
    reason: string;
    weaponSlot?: number;
};

type LootScore = {
    score: number;
    reason: string;
    weaponSlot?: number;
};

export class BotLootScorer {
    chooseLoot(params: {
        game: Game;
        player: Player;
        mode: BotLootMode;
        brainType: BotBrainType;
    }): BotLootChoice | undefined {
        const { game, player, mode, brainType } = params;
        const profile = getBotBrainProfile(brainType);
        const maxDist = this._getSearchDistance(mode, profile);
        const nearby = game.grid.intersectCollider(
            collider.createCircle(player.pos, maxDist + 1.5),
        );

        let best: BotLootChoice | undefined;

        for (const obj of nearby) {
            if (obj.__type !== ObjectType.Loot) continue;

            const loot = obj as Loot;
            if (loot.destroyed) continue;
            if (!util.sameLayer(loot.layer, player.layer)) continue;
            if (loot.ownerId !== 0 && loot.ownerId !== player.__id) continue;

            const dist = v2.distance(player.pos, loot.pos);
            if (dist > maxDist) continue;

            const score = this._scoreLoot(player, loot, dist);
            if (!score) continue;

            const choice: BotLootChoice = {
                lootId: loot.__id,
                pos: v2.copy(loot.pos),
                score: score.score,
                reason: score.reason,
                weaponSlot: score.weaponSlot,
            };

            if (!best || choice.score > best.score) {
                best = choice;
            }
        }

        return best;
    }

    private _getSearchDistance(
        mode: BotLootMode,
        profile: ReturnType<typeof getBotBrainProfile>,
    ): number {
        switch (mode) {
            case "idle":
                return BotTuning.loot.idleSearchDist * profile.lootIdleDistScale;
            case "opportunistic":
                return (
                    BotTuning.loot.opportunisticSearchDist *
                    profile.lootOpportunisticDistScale
                );
        }
    }

    private _scoreLoot(player: Player, loot: Loot, dist: number): LootScore | undefined {
        const def = GameObjectDefs[loot.type];
        if (!def || !("lootImg" in def)) return undefined;

        switch (def.type) {
            case "helmet":
                return this._scoreHelmet(player, loot, def as HelmetDef, dist);
            case "chest":
                return this._scoreChest(player, loot, def as ChestDef, dist);
            case "backpack":
                return this._scoreBackpack(player, loot, def as BackpackDef, dist);
            case "heal":
                return this._scoreHeal(player, loot, def as HealDef, dist);
            case "boost":
                return this._scoreBoost(player, loot, def as BoostDef, dist);
            case "ammo":
                return this._scoreAmmo(player, loot, dist);
            case "gun":
                return this._scoreGun(player, loot, def as GunDef, dist);
            default:
                return undefined;
        }
    }

    private _scoreHelmet(
        player: Player,
        loot: Loot,
        def: HelmetDef,
        dist: number,
    ): LootScore | undefined {
        const currentType = player.helmet;
        const currentDef = currentType ? (GameObjectDefs[currentType] as HelmetDef) : undefined;

        if (player.hasRoleHelmet || currentDef?.perk) return undefined;

        const currentLevel = player.getGearLevel(currentType);
        if (def.level <= currentLevel) return undefined;

        return {
            score: 1000 + def.level * 40 - dist * 6,
            reason: "loot_helmet_upgrade",
        };
    }

    private _scoreChest(
        player: Player,
        loot: Loot,
        def: ChestDef,
        dist: number,
    ): LootScore | undefined {
        const currentLevel = player.getGearLevel(player.chest);
        if (def.level <= currentLevel) return undefined;

        return {
            score: 980 + def.level * 40 - dist * 6,
            reason: "loot_armor_upgrade",
        };
    }

    private _scoreBackpack(
        player: Player,
        loot: Loot,
        def: BackpackDef,
        dist: number,
    ): LootScore | undefined {
        const currentLevel = player.getGearLevel(player.backpack);
        if (def.level <= currentLevel) return undefined;

        return {
            score: 900 + def.level * 35 - dist * 6,
            reason: "loot_backpack_upgrade",
        };
    }

    private _scoreHeal(
        player: Player,
        loot: Loot,
        def: HealDef,
        dist: number,
    ): LootScore | undefined {
        const bagSpace = this._getBagSpace(player, loot.type);
        const held = player.inventory[loot.type] ?? 0;
        if (bagSpace <= held) return undefined;

        const desired = this._getDesiredHealCount(player, loot.type);
        const shortage = Math.max(desired - held, 0);
        const capacityLeft = bagSpace - held;
        if (shortage <= 0 && capacityLeft < Math.min(loot.count, 2)) return undefined;

        return {
            score:
                800 +
                shortage * 45 +
                Math.min(capacityLeft, loot.count) * 8 +
                Math.max(0, 70 - player.health) * 1.5 -
                dist * 5,
            reason: def.type === "heal" ? "loot_heal" : "loot_meds",
        };
    }

    private _scoreBoost(
        player: Player,
        loot: Loot,
        _def: BoostDef,
        dist: number,
    ): LootScore | undefined {
        const bagSpace = this._getBagSpace(player, loot.type);
        const held = player.inventory[loot.type] ?? 0;
        if (bagSpace <= held) return undefined;

        const desired = this._getDesiredBoostCount(player, loot.type);
        const shortage = Math.max(desired - held, 0);
        const capacityLeft = bagSpace - held;
        if (shortage <= 0 && capacityLeft < Math.min(loot.count, 2)) return undefined;

        return {
            score:
                760 +
                shortage * 35 +
                Math.min(capacityLeft, loot.count) * 8 +
                Math.max(0, 50 - player.boost) * 1.2 -
                dist * 5,
            reason: "loot_boost",
        };
    }

    private _scoreAmmo(player: Player, loot: Loot, dist: number): LootScore | undefined {
        const bagSpace = this._getBagSpace(player, loot.type);
        const held = player.inventory[loot.type] ?? 0;
        if (bagSpace <= 0 || held >= bagSpace) return undefined;

        let matchingGuns = 0;
        let activeMatch = false;
        let anyEmptyMatch = false;

        for (const slot of [
            GameConfig.WeaponSlot.Primary,
            GameConfig.WeaponSlot.Secondary,
        ] as const) {
            const type = player.weapons[slot].type;
            if (!type) continue;
            const def = GameObjectDefs[type];
            if (def?.type !== "gun") continue;
            const gunDef = def as GunDef;
            if (gunDef.ammo !== loot.type) continue;

            matchingGuns++;
            if (slot === player.curWeapIdx) activeMatch = true;
            if (player.weapons[slot].ammo === 0) anyEmptyMatch = true;
        }

        if (matchingGuns === 0) return undefined;

        const fillRatio = held / bagSpace;
        if (!anyEmptyMatch && fillRatio >= 0.75) return undefined;

        return {
            score:
                700 +
                (1 - fillRatio) * 140 +
                matchingGuns * 20 +
                (activeMatch ? 20 : 0) +
                (anyEmptyMatch ? 25 : 0) -
                dist * 5,
            reason: "loot_ammo",
        };
    }

    private _scoreGun(
        player: Player,
        loot: Loot,
        def: GunDef,
        dist: number,
    ): LootScore | undefined {
        const candidateBaseScore = this._scoreGunDef(def);
        let bestSlot: number | undefined;
        let bestImprovement = -Infinity;
        let bestCandidateScore = candidateBaseScore;
        let hasEmptySlot = false;

        for (const slot of [
            GameConfig.WeaponSlot.Primary,
            GameConfig.WeaponSlot.Secondary,
        ] as const) {
            const currentType = player.weapons[slot].type;
            if (!currentType) {
                hasEmptySlot = true;
                if (candidateBaseScore > bestImprovement) {
                    bestImprovement = candidateBaseScore;
                    bestCandidateScore = candidateBaseScore;
                    bestSlot = slot;
                }
                continue;
            }

            const currentDef = GameObjectDefs[currentType];
            if (currentDef?.type !== "gun") continue;
            if ((currentDef as GunDef).noDrop) continue;

            let candidateType = loot.type;
            if (currentType === loot.type && def.dualWieldType) {
                candidateType = def.dualWieldType;
            }

            const candidateDef = GameObjectDefs[candidateType];
            if (candidateDef?.type !== "gun") continue;

            const currentScore = this._scoreGunDef(currentDef as GunDef);
            const candidateScore = this._scoreGunDef(candidateDef as GunDef);
            const improvement = candidateScore - currentScore;

            if (improvement > bestImprovement) {
                bestImprovement = improvement;
                bestCandidateScore = candidateScore;
                bestSlot = slot;
            }
        }

        if (bestSlot === undefined) return undefined;
        if (!hasEmptySlot && bestImprovement < BotTuning.loot.weaponUpgradeMinScore) {
            return undefined;
        }

        return {
            score:
                (hasEmptySlot ? 650 : 600) +
                bestCandidateScore * 2 +
                (hasEmptySlot ? 0 : bestImprovement * 18) -
                dist * 6,
            reason: hasEmptySlot ? "loot_gun_fill" : "loot_gun_upgrade",
            weaponSlot: bestSlot,
        };
    }

    private _scoreGunDef(gunDef: GunDef): number {
        const weaponClass = classifyWeapon(gunDef);
        const bulletDef = GameObjectDefs[gunDef.bulletType] as BulletDef | undefined;
        const bulletDamage = bulletDef?.damage ?? 0;
        const shotFactor = Math.min(Math.max(gunDef.bulletCount, 1), 2.5);
        const fireRate = 1 / Math.max(gunDef.fireDelay, 0.05);
        const clipFactor = Math.min(gunDef.maxClip, 60) * 0.18;
        const reloadPenalty = gunDef.reloadTime * 1.5;
        const classBase = this._getWeaponClassBaseScore(weaponClass);
        const dualBonus = gunDef.isDual ? 5 : 0;
        const aimDelayBonus = gunDef.aimDelay ? 2 : 0;

        return (
            classBase +
            bulletDamage * shotFactor * fireRate * 0.18 +
            clipFactor +
            dualBonus +
            aimDelayBonus -
            reloadPenalty
        );
    }

    private _getBagSpace(player: Player, itemType: string): number {
        const bag = player.bagSizes[itemType];
        if (!bag) return 0;
        return bag[player.getGearLevel(player.backpack)] ?? 0;
    }

    private _getDesiredHealCount(player: Player, lootType: string): number {
        switch (lootType) {
            case "healthkit":
                return player.health < 40 ? 2 : 1;
            default:
                return 5;
        }
    }

    private _getDesiredBoostCount(player: Player, lootType: string): number {
        switch (lootType) {
            case "painkiller":
                return player.boost < 25 ? 2 : 1;
            default:
                return 4;
        }
    }

    private _getWeaponClassBaseScore(weaponClass: ReturnType<typeof classifyWeapon>): number {
        switch (weaponClass) {
            case "precision":
                return 34;
            case "lmg":
                return 30;
            case "ar":
                return 26;
            case "shotgun":
                return 24;
            case "smg":
                return 20;
            default:
                return 14;
        }
    }
}
