import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import type { GunDef } from "../../../../shared/defs/gameObjects/gunDefs";
import { math } from "../../../../shared/utils/math";
import type { Vec2 } from "../../../../shared/utils/v2";
import type { Player } from "../objects/player";
import type { BotBrainProfile } from "./botBrainProfiles";
import { BotTuning } from "./botTuning";

export type BotReloadSnapshot = {
    activeWeapon: Player["weapons"][number];
    ammoType?: string;
    spareAmmo: number;
    isReloading: boolean;
    needsReload: boolean;
};

export type BotUnarmedThreatContext = {
    visibleHostile: boolean;
    hostileHasShownGun: boolean;
    hostileAppearsUnarmed: boolean;
    hostileRecentlyFired: boolean;
    hostileDistracted: boolean;
    hostilePos?: Vec2;
};

export function getBotReloadSnapshot(
    player: Player,
    gunDef?: GunDef,
): BotReloadSnapshot {
    const activeWeapon = player.weapons[player.curWeapIdx];
    const ammoType = gunDef?.ammo;
    const spareAmmo = ammoType ? player.inventory[ammoType] : 0;
    const isReloading = player.isReloading();
    const needsReload =
        isReloading || (!!gunDef && activeWeapon.ammo === 0 && spareAmmo > 0);

    return {
        activeWeapon,
        ammoType,
        spareAmmo,
        isReloading,
        needsReload,
    };
}

export function isBotUnarmed(player: Player): boolean {
    for (const slot of [
        GameConfig.WeaponSlot.Primary,
        GameConfig.WeaponSlot.Secondary,
    ] as const) {
        const type = player.weapons[slot].type;
        if (!type) continue;

        const def = GameObjectDefs[type];
        if (def?.type === "gun") {
            return false;
        }
    }

    return true;
}

export function computeBotDanger(params: {
    targetVisible: boolean;
    hasTarget: boolean;
    distToTarget: number;
    lowHp: boolean;
    needsReload: boolean;
    isReloading: boolean;
    recentlyDamaged: boolean;
    gasEmergency: boolean;
    visibleThreatSoftened?: boolean;
}): number {
    const {
        targetVisible,
        hasTarget,
        distToTarget,
        lowHp,
        needsReload,
        isReloading,
        recentlyDamaged,
        gasEmergency,
        visibleThreatSoftened = false,
    } = params;
    const visibleThreatScale = visibleThreatSoftened
        ? BotTuning.danger.visibleUnarmedThreatScale
        : 1;

    let danger = 0;
    if (targetVisible) {
        danger += BotTuning.danger.visibleTargetAdd * visibleThreatScale;
    }
    if (hasTarget) {
        danger +=
            math.clamp(1 - distToTarget / BotTuning.danger.distanceRef, 0, 1) *
            BotTuning.danger.distanceAdd *
            visibleThreatScale;
    }
    if (lowHp) danger += BotTuning.danger.lowHpAdd;
    if (needsReload) {
        danger += isReloading
            ? BotTuning.danger.activeReloadAdd
            : BotTuning.danger.emptyReloadAdd;
    }
    if (recentlyDamaged) danger += BotTuning.danger.recentDamageAdd;
    if (gasEmergency) danger += BotTuning.danger.gasEmergencyAdd;
    return math.clamp(danger, 0, 1);
}

export function getBotThreatBands(nearestNearbyHostileDist: number): {
    enemyVeryClose: boolean;
    enemyClose: boolean;
} {
    return {
        enemyVeryClose:
            nearestNearbyHostileDist < BotTuning.combat.enemyVeryCloseDist,
        enemyClose: nearestNearbyHostileDist < BotTuning.combat.enemyCloseDist,
    };
}

export function shouldSoftenVisibleUnarmedThreat(params: {
    targetVisible: boolean;
    targetHasShownGun: boolean;
    targetAppearsUnarmed: boolean;
    targetRecentlyFired: boolean;
    nearbyHostileCount: number;
    enemyClose: boolean;
    enemyVeryClose: boolean;
}): boolean {
    const {
        targetVisible,
        targetHasShownGun,
        targetAppearsUnarmed,
        targetRecentlyFired,
        nearbyHostileCount,
        enemyClose,
        enemyVeryClose,
    } = params;

    return (
        targetVisible &&
        targetAppearsUnarmed &&
        !targetHasShownGun &&
        !targetRecentlyFired &&
        nearbyHostileCount <= 1 &&
        !enemyClose &&
        !enemyVeryClose
    );
}

export function isBotSafeToHeal(params: {
    anyHostileVisible: boolean;
    danger: number;
    recentlyDamaged: boolean;
    enemyClose: boolean;
    enemyVeryClose: boolean;
    inRetreatState: boolean;
    brainProfile: BotBrainProfile;
}): boolean {
    const {
        anyHostileVisible,
        danger,
        recentlyDamaged,
        enemyClose,
        enemyVeryClose,
        inRetreatState,
        brainProfile,
    } = params;

    const safeToHealNormally =
        !anyHostileVisible &&
        danger < BotTuning.danger.healMax * brainProfile.healDangerScale &&
        !recentlyDamaged &&
        !enemyClose;

    const safeToHealWhileRetreating =
        inRetreatState &&
        !anyHostileVisible &&
        danger < BotTuning.danger.retreatHealMax * brainProfile.retreatHealDangerScale &&
        !recentlyDamaged &&
        !enemyVeryClose;

    return safeToHealNormally || safeToHealWhileRetreating;
}

export function chooseBotHealItem(player: Player, veryLowHp: boolean): string {
    if (veryLowHp) {
        if (player.inventory.healthkit > 0) return "healthkit";
        if (player.inventory.bandage > 0) return "bandage";
        return "";
    }

    if (player.inventory.bandage > 0) return "bandage";
    if (player.inventory.healthkit > 0) return "healthkit";
    return "";
}

export function chooseBotBoostItem(params: {
    player: Player;
    veryLowBoost: boolean;
    quickSafe: boolean;
    longSafe: boolean;
}): string {
    const { player, veryLowBoost, quickSafe, longSafe } = params;

    if (veryLowBoost && player.inventory.painkiller > 0 && longSafe) {
        return "painkiller";
    }
    if (player.inventory.soda > 0 && quickSafe) {
        return "soda";
    }
    if (player.inventory.painkiller > 0 && longSafe) {
        return "painkiller";
    }
    return "";
}
