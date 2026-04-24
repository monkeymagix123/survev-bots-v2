import type { GunDef } from "../../../../../shared/defs/gameObjects/gunDefs";
import type { BotDifficulty } from "../botDifficulty";

export type WeaponClass = "shotgun" | "smg" | "ar" | "lmg" | "precision" | "pistol";

export type WeaponProfile = {
    idealMin: number;
    idealMax: number;
    engageMax: number;

    aimGateDeg: number;
    bloomPerShotDeg: number;
    bloomDecayDegPerSec: number;

    minFocusTimeSec?: number; // precision-only
    stopToShoot?: boolean; // precision-only

    burstDistMin?: number;
    burstHoldSec?: number;
    burstPauseSec?: number;

    postShotNoFireSec?: number; // shotgun-only
    tapOnly?: boolean; // pistol-only
};

export function classifyWeapon(gunDef: GunDef): WeaponClass {
    if (gunDef.pistol === true) return "pistol";

    if (
        gunDef.ammo === "12gauge" ||
        gunDef.bulletCount >= 5 ||
        gunDef.shotSpread >= 8
    ) {
        return "shotgun";
    }

    if (gunDef.maxClip >= 45 || gunDef.extendedClip >= 75) {
        return "lmg";
    }

    if (gunDef.fireMode === "auto" && gunDef.ammo === "9mm") {
        return "smg";
    }

    if (
        gunDef.fireMode === "single" &&
        (gunDef.aimDelay === true || gunDef.fireDelay >= 1.2 || gunDef.maxClip <= 10)
    ) {
        return "precision";
    }

    if (gunDef.fireMode === "burst" || gunDef.fireMode === "auto") {
        return "ar";
    }

    return "ar";
}

export function getWeaponProfile(
    weaponClass: WeaponClass,
    difficulty: BotDifficulty,
): WeaponProfile {
    switch (weaponClass) {
        case "shotgun":
            return {
                idealMin: 0,
                idealMax: 10,
                engageMax: 13,
                aimGateDeg: difficulty === "pro" ? 3.5 : difficulty === "hard" ? 7 : 10,
                bloomPerShotDeg: 1.0,
                bloomDecayDegPerSec: 4.0,
                postShotNoFireSec: 0.25,
            };
        case "smg":
            return {
                idealMin: 0,
                idealMax: 18,
                engageMax: 26,
                aimGateDeg: difficulty === "pro" ? 2 : difficulty === "hard" ? 4 : 7,
                bloomPerShotDeg: 0.35,
                bloomDecayDegPerSec: 2.8,
                burstDistMin: 16,
                burstHoldSec: 0.18,
                burstPauseSec: 0.12,
            };
        case "ar": {
            const aimGateDeg = difficulty === "pro" ? 1.8 : difficulty === "hard" ? 3.5 : 6;
            const burstHoldSec =
                difficulty === "pro" ? 0.26 : difficulty === "hard" ? 0.22 : 0.18;
            const burstPauseSec =
                difficulty === "pro" ? 0.12 : difficulty === "hard" ? 0.16 : 0.18;
            return {
                idealMin: 6,
                idealMax: 24,
                engageMax: 32,
                aimGateDeg,
                bloomPerShotDeg: 0.25,
                bloomDecayDegPerSec: 2.4,
                burstDistMin: 20,
                burstHoldSec,
                burstPauseSec,
            };
        }
        case "lmg":
            return {
                idealMin: 10,
                idealMax: 28,
                engageMax: 36,
                aimGateDeg: difficulty === "pro" ? 2.2 : difficulty === "hard" ? 4 : 7,
                bloomPerShotDeg: 0.3,
                bloomDecayDegPerSec: 2.0,
            };
        case "precision": {
            const aimGateDeg = difficulty === "pro" ? 0.6 : difficulty === "hard" ? 1.2 : 2.5;
            const minFocusTimeSec =
                difficulty === "pro" ? 0.12 : difficulty === "hard" ? 0.25 : 0.45;
            return {
                idealMin: 18,
                idealMax: 60,
                engageMax: 70,
                aimGateDeg,
                bloomPerShotDeg: 0.8,
                bloomDecayDegPerSec: 3.5,
                minFocusTimeSec,
                stopToShoot: true,
            };
        }
        case "pistol":
            return {
                idealMin: 0,
                idealMax: 16,
                engageMax: 24,
                aimGateDeg: difficulty === "pro" ? 2 : difficulty === "hard" ? 4 : 7,
                bloomPerShotDeg: 0.25,
                bloomDecayDegPerSec: 3.0,
                tapOnly: true,
            };
    }
}

