import { GameObjectDefs } from "../../../../../shared/defs/gameObjectDefs";
import type { GunDef } from "../../../../../shared/defs/gameObjects/gunDefs";
import { GameConfig } from "../../../../../shared/gameConfig";
import type * as net from "../../../../../shared/net/net";
import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { Config } from "../../../config";
import type { Player } from "../../objects/player";
import type { BotBrainType } from "../botBrain";
import type { BotDifficulty } from "../botDifficulty";
import { getBotBrainProfile, getBotSkillProfile } from "../botBrainProfiles";
import {
    type WeaponClass,
    type WeaponProfile,
    classifyWeapon,
    getWeaponProfile,
} from "./botWeaponProfiles";

function randomNormal(mean: number, stdDev: number): number {
    if (stdDev <= 0) return mean;

    // Box–Muller transform
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + z * stdDev;
}

function movingAimPenaltyDeg(difficulty: BotDifficulty, brainType: BotBrainType): number {
    const profile = getBotBrainProfile(brainType);
    let penalty: number;
    switch (difficulty) {
        case "normal":
            penalty = 1.5;
            break;
        case "hard":
            penalty = 0.9;
            break;
        case "pro":
            penalty = 0.4;
            break;
    }

    return penalty * profile.skill.movingAimPenaltyScale;
}

export class BotWeaponLogic {
    nextShootTime = -Infinity;
    bloomDeg = 0;
    burstHoldT = 0;
    burstPauseT = 0;
    postShotNoFireT = 0;
    lostLosTime = -Infinity;
    private _lastVisible = false;

    constructor(
        readonly difficulty: BotDifficulty,
        readonly brainType: BotBrainType,
    ) {}

    getWeaponInfo(player: Player): {
        gunDef?: GunDef;
        weaponClass?: WeaponClass;
        profile?: WeaponProfile;
    } {
        const activeDef = GameObjectDefs[player.activeWeapon];
        const gunDef = activeDef?.type === "gun" ? (activeDef as GunDef) : undefined;
        const weaponClass = gunDef ? classifyWeapon(gunDef) : undefined;
        const profile = weaponClass ? getWeaponProfile(weaponClass, this.difficulty) : undefined;
        return { gunDef, weaponClass, profile };
    }

    onTargetChanged(timeNow: number, visibleNow: boolean): void {
        const skill = getBotSkillProfile(this.difficulty, this.brainType);
        this.nextShootTime = timeNow + util.random(skill.reactionMinSec, skill.reactionMaxSec);
        this.burstHoldT = 0;
        this.burstPauseT = 0;
        this.postShotNoFireT = 0;
        this._lastVisible = visibleNow;
        this.lostLosTime = -Infinity;
    }

    onTargetCleared(): void {
        this.nextShootTime = -Infinity;
        this.burstHoldT = 0;
        this.burstPauseT = 0;
        this.postShotNoFireT = 0;
        this._lastVisible = false;
        this.lostLosTime = -Infinity;
    }

    onVisibilityUpdate(prevVisible: boolean, visibleNow: boolean, timeNow: number): void {
        if (prevVisible && !visibleNow && this._lastVisible) {
            this.lostLosTime = timeNow;
        }
        this._lastVisible = visibleNow;
    }

    decrementTimers(dt: number): void {
        this.postShotNoFireT = Math.max(this.postShotNoFireT - dt, 0);
    }

    updateBurstTimers(params: {
        dt: number;
        hasTarget: boolean;
        distToTarget: number;
        profile?: WeaponProfile;
    }): { burstGateOk: boolean; burstEnabled: boolean } {
        const { dt, hasTarget, distToTarget, profile } = params;
        const burstEnabled =
            hasTarget &&
            !!profile?.burstDistMin &&
            !!profile.burstHoldSec &&
            !!profile.burstPauseSec &&
            distToTarget > profile.burstDistMin;

        if (!burstEnabled) {
            this.burstHoldT = 0;
            this.burstPauseT = 0;
        } else {
            const burstHoldSec = profile.burstHoldSec!;
            const burstPauseSec = profile.burstPauseSec!;

            if (this.burstPauseT > 0) {
                this.burstPauseT = Math.max(this.burstPauseT - dt, 0);
            } else if (this.burstHoldT > 0) {
                const prevHold = this.burstHoldT;
                this.burstHoldT = Math.max(this.burstHoldT - dt, 0);
                if (prevHold > 0 && this.burstHoldT === 0) {
                    this.burstPauseT = burstPauseSec;
                }
            }

            if (this.burstPauseT <= 0 && this.burstHoldT <= 0) {
                this.burstHoldT = burstHoldSec;
            }
        }

        return { burstGateOk: !burstEnabled || this.burstPauseT <= 0, burstEnabled };
    }

    allowShooting(params: {
        timeNow: number;
        hasTarget: boolean;
        targetVisible: boolean;
        gasEmergency: boolean;
        distToTarget: number;
        angleDeltaDeg: number;
        focusTime: number;
        weaponClass?: WeaponClass;
        profile?: WeaponProfile;
        burstGateOk: boolean;
    }): boolean {
        const {
            timeNow,
            hasTarget,
            targetVisible,
            gasEmergency,
            distToTarget,
            angleDeltaDeg,
            focusTime,
            weaponClass,
            profile,
            burstGateOk,
        } = params;

        if (!hasTarget || !profile || gasEmergency) {
            return false;
        }

        const skill = getBotSkillProfile(this.difficulty, this.brainType);

        const inRange = distToTarget <= profile.engageMax;
        const reactionReady = timeNow >= this.nextShootTime;
        const aimReady = angleDeltaDeg <= profile.aimGateDeg;
        const postShotReady = this.postShotNoFireT <= 0;

        const graceAllowed =
            (weaponClass === "smg" ||
                weaponClass === "ar" ||
                weaponClass === "lmg" ||
                weaponClass === "pistol") &&
            timeNow - this.lostLosTime <= skill.losGraceSec;
        const losOk = targetVisible || graceAllowed;

        let allow =
            inRange && reactionReady && aimReady && postShotReady && losOk && burstGateOk;

        if (allow && weaponClass === "precision") {
            const minFocus = profile.minFocusTimeSec ?? 0;
            if (!targetVisible || focusTime < minFocus) {
                allow = false;
            }
        }

        return allow;
    }

    applyShootInputs(params: {
        msg: net.InputMsg;
        allowShooting: boolean;
        gunDef?: GunDef;
        profile?: WeaponProfile;
    }): void {
        const { msg, allowShooting, gunDef, profile } = params;

        msg.shootHold = false;
        msg.shootStart = false;

        if (!allowShooting) return;

        if (profile?.tapOnly || gunDef?.fireMode === "single") {
            msg.shootStart = true;
        } else {
            msg.shootHold = true;
        }
    }

    computeWillShootThisTick(params: {
        dt: number;
        msg: net.InputMsg;
        player: Player;
        gunDef?: GunDef;
    }): { willShootThisTick: boolean; startingBurstThisTick: boolean } {
        const { dt, msg, player, gunDef } = params;

        const weapon = player.weapons[player.curWeapIdx];
        const cooldownAfter = weapon.cooldown - dt;

        let willShootThisTick = false;
        let startingBurstThisTick = false;

        if (gunDef) {
            if (gunDef.fireMode === "auto") {
                willShootThisTick = msg.shootHold && cooldownAfter <= 0;
            } else if (gunDef.fireMode === "single") {
                willShootThisTick = msg.shootStart && cooldownAfter < 0;
            } else if (gunDef.fireMode === "burst") {
                const scheduled =
                    player.weaponManager.bursts.length > 0 &&
                    player.weaponManager.bursts.some((t) => t <= dt);
                startingBurstThisTick = msg.shootHold && cooldownAfter < 0;
                willShootThisTick = scheduled || startingBurstThisTick;
            }
        } else {
            willShootThisTick = msg.shootHold;
        }

        return { willShootThisTick, startingBurstThisTick };
    }

    updateBloomAndPostShot(params: {
        dt: number;
        willShootThisTick: boolean;
        startingBurstThisTick: boolean;
        gunDef?: GunDef;
        weaponClass?: WeaponClass;
        profile?: WeaponProfile;
    }): void {
        const { dt, willShootThisTick, startingBurstThisTick, gunDef, weaponClass, profile } =
            params;

        if (!profile) return;

        this.bloomDeg = Math.max(0, this.bloomDeg - profile.bloomDecayDegPerSec * dt);

        if (willShootThisTick) {
            if (gunDef?.fireMode === "burst" && startingBurstThisTick) {
                const burstCount = gunDef.burstCount ?? 1;
                this.bloomDeg += profile.bloomPerShotDeg * burstCount;
            } else if (gunDef?.fireMode !== "burst") {
                this.bloomDeg += profile.bloomPerShotDeg;
            }

            if (weaponClass === "shotgun" && profile.postShotNoFireSec) {
                this.postShotNoFireT = profile.postShotNoFireSec;
            }
        }

        // Prevent rare outlier behavior where bloom grows without bound (e.g. extended fights).
        const bloomMaxDeg =
            weaponClass === "precision" ? 8 : weaponClass === "shotgun" ? 15 : 12;
        this.bloomDeg = Math.min(this.bloomDeg, bloomMaxDeg);
    }

    computeShotNoiseDeg(params: {
        willShootThisTick: boolean;
        profile?: WeaponProfile;
        weaponClass?: WeaponClass;
        movingThisTick: boolean;
    }): number {
        const { willShootThisTick, profile, weaponClass, movingThisTick } = params;
        if (!willShootThisTick || !profile) return 0;

        const skill = getBotSkillProfile(this.difficulty, this.brainType);
        let spreadDeg = skill.baseAimErrorDeg + this.bloomDeg;

        if (movingThisTick) {
            let movePenalty = movingAimPenaltyDeg(this.difficulty, this.brainType);
            if (weaponClass === "precision") {
                movePenalty *= 0.5;
            }
            spreadDeg += movePenalty;
        }

        let noiseDeg = randomNormal(0, spreadDeg);

        // Truncate normal tails so rare samples don't look like 360° sprays in spectate.
        const cap = Math.min(25, spreadDeg * 3);
        noiseDeg = math.clamp(noiseDeg, -cap, cap);

        return noiseDeg;
    }

    applyQuickswitch(params: {
        msg: net.InputMsg;
        player: Player;
        difficulty: BotDifficulty;
        burstHoldT: number;
    }): void {
        const { msg, player, difficulty, burstHoldT } = params;

        if (!Config.bots.enableQuickSwitch) return;
        if (difficulty !== "hard" && difficulty !== "pro") return;
        if (burstHoldT > 0) return;

        const curIdx = player.curWeapIdx;
        if (
            curIdx !== GameConfig.WeaponSlot.Primary &&
            curIdx !== GameConfig.WeaponSlot.Secondary
        ) {
            return;
        }

        const activeDef = GameObjectDefs[player.activeWeapon];
        if (activeDef?.type !== "gun" || player.shotSlowdownTimer <= 0) return;

        const gunDef = activeDef as GunDef;
        if (gunDef.fireDelay - player.shotSlowdownTimer <= 0.25) return;

        const otherIdx = curIdx ^ 1;
        const otherType = player.weapons[otherIdx].type;
        const otherDef = otherType ? GameObjectDefs[otherType] : undefined;
        if (otherDef?.type !== "gun") return;

        msg.addInput(
            otherIdx === GameConfig.WeaponSlot.Primary
                ? GameConfig.Input.EquipPrimary
                : GameConfig.Input.EquipSecondary,
        );
    }
}
