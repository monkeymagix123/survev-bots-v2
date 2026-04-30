import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import { Config } from "../../config";
import type { Game } from "../game";
import type { Loot } from "../objects/loot";
import type { Player } from "../objects/player";
import type { BotBrainType } from "./botBrain";
import { BotCombatMemory } from "./botCombat";
import type { BotDifficulty } from "./botDifficulty";
import type { BotBrain } from "./brains/botBrainLogic";
import { CompetitiveBotBrain } from "./brains/competitiveBotBrain";
import { PracticeBotBrain } from "./brains/practiceBotBrain";
import { RealisticBotBrain } from "./brains/realisticBotBrain";
import { BotTuning } from "./botTuning";
import { LegacyBotController } from "./legacy/legacyBotController";
import { BotAimController } from "./systems/botAimController";
import { BotLootScorer } from "./systems/botLootScorer";
import { BotNavigationLite } from "./systems/botNavigationLite";
import { BotPerception } from "./systems/botPerception";
import { BotWeaponLogic } from "./systems/botWeaponLogic";

export class BotController {
    private _time = 0;
    private _seq = 0;
    private _decisionTicker = 0;

    private readonly _perception = new BotPerception();
    private readonly _navigation = new BotNavigationLite();
    private readonly _combat = new BotCombatMemory();
    private readonly _aim: BotAimController;
    private readonly _lootScorer = new BotLootScorer();
    private readonly _weaponLogic: BotWeaponLogic;
    private readonly _brain: BotBrain;

    // TEMP (Phase 1 parity verification)
    private readonly _legacy?: LegacyBotController;
    private _parityMismatchCount = 0;

    private _lastPos: Vec2;
    private _lastMovedTime = 0;
    private _lastHealth = 0;

    constructor(
        readonly game: Game,
        readonly player: Player,
        readonly difficulty: BotDifficulty,
        readonly brainType: BotBrainType = "realistic",
    ) {
        this._lastPos = v2.copy(player.pos);
        this._lastHealth = player.health;
        this._aim = new BotAimController(player, difficulty);
        this._weaponLogic = new BotWeaponLogic(difficulty);
        this._brain = this._createBrain(brainType);

        if (Config.bots.debugParity) {
            this._legacy = new LegacyBotController(game, player, difficulty);
        }
    }

    /**
     * True when bot has seen an enemy recently (used for retire priority).
     */
    get inCombat(): boolean {
        return this._perception.inCombat(this._time);
    }

    /**
     * Seconds since bot last moved significantly (used for retire priority).
     */
    get secondsSinceMove(): number {
        return this._time - this._lastMovedTime;
    }

    update(dt: number): void {
        this._time += dt;

        const player = this.player;
        if (player.dead || player.downed || player.disconnected) {
            return;
        }

        if (player.health < this._lastHealth - 0.001) {
            this._combat.lastDamagedTime = this._time;
            this._perception.markDamaged(this._time);
        }
        this._lastHealth = player.health;

        this._navigation.tick(dt, this._perception.targetId !== undefined);

        const movedDist = v2.distance(player.pos, this._lastPos);
        if (movedDist > 0.5) {
            this._lastPos = v2.copy(player.pos);
            this._lastMovedTime = this._time;
        }

        const decisionInterval = 1 / math.max(Config.bots.decisionTps, 1);
        this._decisionTicker += dt;
        if (this._decisionTicker >= decisionInterval) {
            this._decisionTicker %= decisionInterval;
            this._brain.decide({
                game: this.game,
                player: this.player,
                difficulty: this.difficulty,
                timeNow: this._time,
                perception: this._perception,
                navigation: this._navigation,
                lootScorer: this._lootScorer,
                combat: this._combat,
                aim: this._aim,
                weaponLogic: this._weaponLogic,
            });
        }

        const msg = this._buildInput(dt);

        // TEMP (Phase 1 parity verification): compare outputs vs legacy controller
        if (this._legacy && this._parityMismatchCount < 30) {
            const legacyStep = this._legacy.step(dt);
            if (legacyStep) {
                this._compareParity(msg, legacyStep.msg, legacyStep.aimAngleRad);
            }
        }

        player.handleInput(msg);
    }

    private _createBrain(type: BotBrainType): BotBrain {
        switch (type) {
            case "practice":
                return new PracticeBotBrain();
            case "competitive":
                return new CompetitiveBotBrain();
            case "realistic":
            default:
                return new RealisticBotBrain();
        }
    }

    private _buildInput(dt: number): net.InputMsg {
        const player = this.player;

        const msg = new net.InputMsg();
        msg.seq = this._seq++ % 256;

        const targetObj = this._perception.targetId
            ? this.game.objectRegister.getById(this._perception.targetId)
            : undefined;
        const target =
            targetObj && targetObj.__type === ObjectType.Player
                ? (targetObj as Player)
                : undefined;
        const validTarget =
            target &&
            !target.dead &&
            !target.disconnected &&
            util.sameLayer(target.layer, player.layer)
                ? target
                : undefined;

        if (!validTarget) {
            this._perception.targetId = undefined;
            this._perception.targetVisible = false;
        }

        const gas = this.game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        const goal = this._navigation.getGoal(
            this.game,
            player,
            gasEmergency,
            validTarget?.pos,
            this._combat.goalPos,
        );

        const { gunDef, weaponClass, profile } = this._weaponLogic.getWeaponInfo(player);

        this._weaponLogic.decrementTimers(dt);

        const aimUpdate = this._aim.update(dt, {
            player,
            goal,
            target: validTarget,
            gunDef,
        });

        msg.toMouseLen = math.clamp(aimUpdate.aimLen, 0, net.Constants.MouseMaxDist);

        const strafeSign =
            this._combat.stateReason === "damage_dodge" &&
            this._time < this._combat.damageDodgeUntil
                ? this._combat.damageDodgeSign
                : undefined;

        this._navigation.applyMovementInput({
            msg,
            player,
            goal,
            hasTarget: !!validTarget,
            gasEmergency,
            distToTarget: validTarget ? aimUpdate.distToTarget : undefined,
            allowStrafe: this._combat.movementStyle === "strafe" && !gasEmergency,
            strafeSign,
            anchor: this._combat.movementStyle === "anchor" && !gasEmergency,
            aimDir: aimUpdate.aimDir,
            dt,
        });

        // Precision "stop to shoot" focus time
        const standStillForPrecision =
            !!validTarget &&
            !!profile?.stopToShoot &&
            weaponClass === "precision" &&
            this._perception.targetVisible &&
            aimUpdate.distToTarget >= profile.idealMin &&
            aimUpdate.distToTarget <= profile.idealMax &&
            this._time >= this._weaponLogic.nextShootTime &&
            aimUpdate.angleDeltaDeg <= profile.aimGateDeg * 2;

        if (standStillForPrecision) {
            msg.moveLeft = false;
            msg.moveRight = false;
            msg.moveUp = false;
            msg.moveDown = false;
            this._aim.focusTime += dt;
        } else {
            this._aim.focusTime = 0;
        }

        this._navigation.observeMovement({
            dt,
            game: this.game,
            player,
            goal,
            moveLeft: msg.moveLeft,
            moveRight: msg.moveRight,
            moveUp: msg.moveUp,
            moveDown: msg.moveDown,
        });

        const lootObj = this._combat.lootTargetId
            ? this.game.objectRegister.getById(this._combat.lootTargetId)
            : undefined;
        const lootTarget =
            lootObj &&
            lootObj.__type === ObjectType.Loot &&
            !lootObj.destroyed &&
            util.sameLayer(lootObj.layer, player.layer)
                ? (lootObj as Loot)
                : undefined;

        if (!lootTarget) {
            this._combat.lootTargetId = undefined;
            this._combat.lootWeaponSlot = undefined;
        } else if (
            this._combat.state === "loot" &&
            this._combat.lootWeaponSlot !== undefined &&
            player.curWeapIdx !== this._combat.lootWeaponSlot
        ) {
            msg.addInput(
                this._combat.lootWeaponSlot === GameConfig.WeaponSlot.Primary
                    ? GameConfig.Input.EquipPrimary
                    : GameConfig.Input.EquipSecondary,
            );
        }

        if (
            this._combat.state === "loot" &&
            lootTarget &&
            player.actionType === GameConfig.Action.None &&
            player.getClosestLoot()?.__id === lootTarget.__id
        ) {
            msg.addInput(GameConfig.Input.Loot);
        }

        // Explicit reload discipline: press reload when empty and it's safe/out-of-range.
        const activeWeapon = player.weapons[player.curWeapIdx];
        const ammoType = gunDef?.ammo;
        const spareAmmo = ammoType ? player.inventory[ammoType] : 0;
        const wantsReload =
            !!gunDef &&
            player.actionType === GameConfig.Action.None &&
            activeWeapon.ammo === 0 &&
            spareAmmo > 0;
        if (wantsReload) {
            const outOfEngage = !!profile && aimUpdate.distToTarget > profile.engageMax;
            if (
                this._combat.state === "retreat_reload" ||
                !validTarget ||
                this._perception.targetVisible === false ||
                outOfEngage
            ) {
                msg.addInput(GameConfig.Input.Reload);
            }
        }

        // Use items
        msg.useItem = "";

        if (!player.downed && player.actionType === GameConfig.Action.None) {
            const lowHp = player.health < BotTuning.heal.lowHp;
            const veryLowHp = player.health < BotTuning.heal.veryLowHp;
            const wantsBoost = player.boost < BotTuning.boost.threshold;
            const veryLowBoost = player.boost < BotTuning.boost.veryLowBoost;

            const recentlyDamaged =
                this._time - this._combat.lastDamagedTime <
                BotTuning.combat.recentlyDamagedWindowSec;

            const isReloading = player.isReloading();
            const needsReload =
                isReloading || (!!gunDef && activeWeapon.ammo === 0 && spareAmmo > 0);

            // ── Danger (same as before, OK) ──
            let danger = 0;
            if (validTarget && this._perception.targetVisible) danger += 0.38;
            if (validTarget) {
                danger += math.clamp(1 - aimUpdate.distToTarget / 20, 0, 1) * 0.22;
            }
            if (lowHp) danger += 0.22;
            if (needsReload) danger += isReloading ? 0.18 : 0.14;
            if (recentlyDamaged) danger += 0.12;
            if (gasEmergency) danger += 0.25;
            danger = math.clamp(danger, 0, 1);

            const threat = this._perception.threat;

            const enemyDist = threat.nearestNearbyHostileDist;
            const enemyVeryClose = enemyDist < BotTuning.combat.enemyVeryCloseDist;
            const enemyClose = enemyDist < BotTuning.combat.enemyCloseDist;

            const inRetreatState =
                this._combat.state === "retreat_heal" ||
                this._combat.state === "seek_cover";

            // ── Healing safety (less strict than before) ──
            const safeToHeal =
                inRetreatState ||
                (!threat.anyHostileVisible &&
                    danger < BotTuning.danger.healMax &&
                    !recentlyDamaged &&
                    !enemyClose);

            // ── Healing logic ──
            if (lowHp) {
                if (safeToHeal) {
                    if (veryLowHp) {
                        // Prefer healthkit if very low
                        if (player.inventory["healthkit"] > 0) {
                            msg.useItem = "healthkit";
                        } else if (player.inventory["bandage"] > 0) {
                            msg.useItem = "bandage";
                        }
                    } else {
                        // Prefer bandage for mid HP (faster)
                        if (player.inventory["bandage"] > 0) {
                            msg.useItem = "bandage";
                        } else if (player.inventory["healthkit"] > 0) {
                            msg.useItem = "healthkit";
                        }
                    }
                }
            }
            // ── Boost logic ──
            else if (wantsBoost) {
                const safeToBoostQuick =
                    !threat.anyHostileVisible &&
                    danger < BotTuning.danger.boostQuickMax &&
                    !recentlyDamaged &&
                    !enemyVeryClose;

                const safeToBoostLong =
                    !threat.anyHostileVisible &&
                    danger < BotTuning.danger.boostLongMax &&
                    !recentlyDamaged &&
                    !enemyClose;

                if (veryLowBoost && player.inventory["painkiller"] > 0 && safeToBoostLong) {
                    msg.useItem = "painkiller";
                } else if (player.inventory["soda"] > 0 && safeToBoostQuick) {
                    msg.useItem = "soda";
                } else if (player.inventory["painkiller"] > 0 && safeToBoostLong) {
                    msg.useItem = "painkiller";
                }
            }
        }

        const burst = this._weaponLogic.updateBurstTimers({
            dt,
            hasTarget: !!validTarget,
            distToTarget: aimUpdate.distToTarget,
            profile,
        });

        const allowShooting = this._weaponLogic.allowShooting({
            timeNow: this._time,
            hasTarget: !!validTarget,
            targetVisible: this._perception.targetVisible,
            gasEmergency,
            distToTarget: aimUpdate.distToTarget,
            angleDeltaDeg: aimUpdate.angleDeltaDeg,
            focusTime: this._aim.focusTime,
            weaponClass,
            profile,
            burstGateOk: burst.burstGateOk,
        });

        this._weaponLogic.applyShootInputs({
            msg,
            allowShooting,
            gunDef,
            profile,
        });

        const shot = this._weaponLogic.computeWillShootThisTick({
            dt,
            msg,
            player,
            gunDef,
        });

        this._weaponLogic.updateBloomAndPostShot({
            dt,
            willShootThisTick: shot.willShootThisTick,
            startingBurstThisTick: shot.startingBurstThisTick,
            gunDef,
            weaponClass,
            profile,
        });

        const movingThisTick =
            msg.moveLeft || msg.moveRight || msg.moveUp || msg.moveDown;
        const noiseDeg = this._weaponLogic.computeShotNoiseDeg({
            willShootThisTick: shot.willShootThisTick,
            profile,
            weaponClass,
            movingThisTick,
        });

        msg.toMouseDir = this._aim.getDirWithNoiseDeg(noiseDeg);

        this._weaponLogic.applyQuickswitch({
            msg,
            player,
            difficulty: this.difficulty,
            burstHoldT: this._weaponLogic.burstHoldT,
        });

        // Ensure internal bots behave like mobile for auto doors/pickup
        msg.touchMoveActive = false;

        return msg;
    }

    private _compareParity(
        msgNew: net.InputMsg,
        msgLegacy: net.InputMsg,
        legacyAimAngleRad: number,
    ): void {
        const epsLen = 1e-4;
        const epsAngleRad = 1e-4;

        const angleNew = Math.atan2(msgNew.toMouseDir.y, msgNew.toMouseDir.x);
        const angleLegacy = Math.atan2(msgLegacy.toMouseDir.y, msgLegacy.toMouseDir.x);
        const angleDiff = Math.atan2(
            Math.sin(angleLegacy - angleNew),
            Math.cos(angleLegacy - angleNew),
        );

        const inputsNew = msgNew.inputs;
        const inputsLegacy = msgLegacy.inputs;

        const mismatch =
            msgNew.moveLeft !== msgLegacy.moveLeft ||
            msgNew.moveRight !== msgLegacy.moveRight ||
            msgNew.moveUp !== msgLegacy.moveUp ||
            msgNew.moveDown !== msgLegacy.moveDown ||
            msgNew.shootHold !== msgLegacy.shootHold ||
            msgNew.shootStart !== msgLegacy.shootStart ||
            msgNew.useItem !== msgLegacy.useItem ||
            Math.abs(msgNew.toMouseLen - msgLegacy.toMouseLen) > epsLen ||
            Math.abs(angleDiff) > epsAngleRad ||
            inputsNew.length !== inputsLegacy.length ||
            inputsNew.some((v, i) => v !== inputsLegacy[i]);

        if (!mismatch) return;

        this._parityMismatchCount++;
        const aimAngleDiff = Math.atan2(
            Math.sin(legacyAimAngleRad - this._aim.aimAngleRad),
            Math.cos(legacyAimAngleRad - this._aim.aimAngleRad),
        );

        // eslint-disable-next-line no-console
        console.warn(
            `[bots][parity] mismatch#${this._parityMismatchCount} ` +
                `id=${this.player.__id} name=${this.player.name} ` +
                `t=${this._time.toFixed(3)} ` +
                `move=${Number(msgNew.moveLeft)}${Number(msgNew.moveRight)}${Number(
                    msgNew.moveUp,
                )}${Number(msgNew.moveDown)} vs ${Number(msgLegacy.moveLeft)}${Number(
                    msgLegacy.moveRight,
                )}${Number(msgLegacy.moveUp)}${Number(msgLegacy.moveDown)} ` +
                `shoot=${Number(msgNew.shootHold)}${Number(msgNew.shootStart)} vs ${Number(
                    msgLegacy.shootHold,
                )}${Number(msgLegacy.shootStart)} ` +
                `mouseLen=${msgNew.toMouseLen.toFixed(2)} vs ${msgLegacy.toMouseLen.toFixed(2)} ` +
                `mouseAngDeg=${(math.rad2deg(angleDiff)).toFixed(3)} ` +
                `aimAngDeg=${(math.rad2deg(aimAngleDiff)).toFixed(3)} ` +
                `inputs=${inputsNew.join(",")} vs ${inputsLegacy.join(",")}`,
        );
    }
}

export type { BotDifficulty } from "./botDifficulty";
