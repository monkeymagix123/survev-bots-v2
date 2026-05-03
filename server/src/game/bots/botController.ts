import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { collider } from "../../../../shared/utils/collider";
import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import { Config } from "../../config";
import type { Game } from "../game";
import type { Loot } from "../objects/loot";
import type { Player } from "../objects/player";
import type { BotBrainType } from "./botBrain";
import {
    chooseBotBoostItem,
    chooseBotHealItem,
    computeBotDanger,
    getBotReloadSnapshot,
    getBotThreatBands,
    isBotUnarmed,
    isBotSafeToHeal,
} from "./botDecisionSupport";
import {
    getBotBrainProfile,
    getDecisionDelaySec,
    type BotBrainProfile,
} from "./botBrainProfiles";
import { logBotStability } from "./botStabilityLogger";
import { BotCombatMemory } from "./botCombat";
import type { BotDifficulty } from "./botDifficulty";
import type { BotBrain } from "./brains/botBrainLogic";
import { CompetitiveBotBrain } from "./brains/competitiveBotBrain";
import { PracticeBotBrain } from "./brains/practiceBotBrain";
import { RealisticBotBrain } from "./brains/realisticBotBrain";
import { UnarmedBotBrain } from "./brains/unarmedBotBrain";
import { BotTuning } from "./botTuning";
import { LegacyBotController } from "./legacy/legacyBotController";
import { BotAimController } from "./systems/botAimController";
import { BotLootScorer } from "./systems/botLootScorer";
import { BotNavigationLite } from "./systems/botNavigationLite";
import { BotObjectInteractionScorer } from "./systems/botObjectInteractionScorer";
import { BotPerception } from "./systems/botPerception";
import { BotWeaponLogic } from "./systems/botWeaponLogic";
import type { Obstacle } from "../objects/obstacle";

export class BotController {
    private _time = 0;
    private _seq = 0;
    private _decisionTicker = 0;
    private _nextDecisionDelaySec = 0;

    private readonly _perception = new BotPerception();
    private readonly _navigation = new BotNavigationLite();
    private readonly _combat = new BotCombatMemory();
    private readonly _aim: BotAimController;
    private readonly _lootScorer = new BotLootScorer();
    private readonly _objectInteractionScorer = new BotObjectInteractionScorer();
    private readonly _weaponLogic: BotWeaponLogic;
    private readonly _brain: BotBrain;
    private readonly _unarmedBrain: BotBrain = new UnarmedBotBrain();
    private readonly _brainProfile: BotBrainProfile;

    // TEMP (Phase 1 parity verification)
    private readonly _legacy?: LegacyBotController;
    private _parityMismatchCount = 0;

    private _lastPos: Vec2;
    private _lastMovedTime = 0;
    private _lastHealth = 0;
    private _lastIdleReason?: string;

    constructor(
        readonly game: Game,
        readonly player: Player,
        readonly difficulty: BotDifficulty,
        readonly brainType: BotBrainType = "realistic",
    ) {
        this._lastPos = v2.copy(player.pos);
        this._lastHealth = player.health;
        this._brainProfile = getBotBrainProfile(brainType);
        this._aim = new BotAimController(player, difficulty, brainType);
        this._weaponLogic = new BotWeaponLogic(difficulty, brainType);
        this._brain = this._createBrain(brainType);
        this._nextDecisionDelaySec = getDecisionDelaySec(brainType);

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
        if (this._decisionTicker >= decisionInterval + this._nextDecisionDelaySec) {
            this._decisionTicker = 0;
            this._nextDecisionDelaySec = getDecisionDelaySec(this.brainType);
            const decisionBrain = isBotUnarmed(this.player)
                ? this._unarmedBrain
                : this._brain;
            decisionBrain.decide({
                brainType: this.brainType,
                brainProfile: this._brainProfile,
                game: this.game,
                player: this.player,
                difficulty: this.difficulty,
                timeNow: this._time,
                perception: this._perception,
                navigation: this._navigation,
                lootScorer: this._lootScorer,
                objectInteractionScorer: this._objectInteractionScorer,
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

        let objectTarget = this._getObjectTarget();
        if (
            objectTarget &&
            (!util.sameLayer(objectTarget.layer, player.layer) ||
                objectTarget.dead ||
                !this._isObjectTargetStillValid(objectTarget))
        ) {
            this._clearObjectInteraction();
            objectTarget = undefined;
        }

        const goal = this._navigation.getGoal(
            this.game,
            player,
            gasEmergency,
            validTarget?.pos,
            this._combat.goalPos,
        );

        const { gunDef, weaponClass, profile } = this._weaponLogic.getWeaponInfo(player);
        const { activeWeapon, spareAmmo, isReloading, needsReload } = getBotReloadSnapshot(
            player,
            gunDef,
        );
        const lowHp = player.health < BotTuning.heal.lowHp;
        const veryLowHp = player.health < BotTuning.heal.veryLowHp;
        const wantsBoost = player.boost < BotTuning.boost.threshold;
        const veryLowBoost = player.boost < BotTuning.boost.veryLowBoost;
        const recentlyDamaged =
            this._time - this._combat.lastDamagedTime <
            BotTuning.combat.recentlyDamagedWindowSec;
        const reactionReady = this._time >= this._weaponLogic.nextShootTime;
        const weakLosAnchor =
            !!validTarget &&
            this._combat.movementStyle === "anchor" &&
            (!this._perception.targetVisible || !reactionReady || needsReload);

        this._weaponLogic.decrementTimers(dt);

        const objectInteractionActive =
            this._combat.state === "interact_object" && !!objectTarget;
        const objectAimGoal = objectInteractionActive && objectTarget
            ? objectTarget.pos
            : undefined;

        const aimUpdate = this._aim.update(dt, {
            player,
            goal: objectAimGoal ?? goal,
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
            allowStrafe:
                (this._combat.movementStyle === "strafe" || weakLosAnchor) &&
                !gasEmergency,
            strafeSign,
            anchor:
                this._combat.movementStyle === "anchor" &&
                !gasEmergency &&
                !weakLosAnchor,
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
            let equipInput: number;
            switch (this._combat.lootWeaponSlot) {
                case GameConfig.WeaponSlot.Primary:
                    equipInput = GameConfig.Input.EquipPrimary;
                    break;
                case GameConfig.WeaponSlot.Secondary:
                default:
                    equipInput = GameConfig.Input.EquipSecondary;
                    break;
            }
            msg.addInput(equipInput);
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
        const danger = computeBotDanger({
            targetVisible: !!validTarget && this._perception.targetVisible,
            hasTarget: !!validTarget,
            distToTarget: aimUpdate.distToTarget,
            lowHp,
            needsReload,
            isReloading,
            recentlyDamaged,
            gasEmergency,
        });

        const threat = this._perception.threat;
        const enemyDist = threat.nearestNearbyHostileDist;
        const { enemyVeryClose, enemyClose } = getBotThreatBands(enemyDist);
        const visibleThreatShouldAbortObject =
            threat.anyHostileVisible &&
            (!isBotUnarmed(player) ||
                !this._perception.targetVisible ||
                (this._perception.targetHasShownGun &&
                    !this._perception.targetDistracted));
        const dangerShouldAbortObject =
            danger >= BotTuning.objectInteract.breakAbortDangerMin &&
            (!isBotUnarmed(player) ||
                !this._perception.targetVisible ||
                (this._perception.targetHasShownGun &&
                    !this._perception.targetDistracted) ||
                (!this._perception.targetAppearsUnarmed &&
                    !this._perception.targetDistracted));
        const shouldAbortObjectInteraction =
            this._combat.state === "interact_object" &&
            (visibleThreatShouldAbortObject ||
                recentlyDamaged ||
                dangerShouldAbortObject);
        if (shouldAbortObjectInteraction) {
            this._clearObjectInteraction();
            objectTarget = undefined;
        }

        if (
            player.actionType === GameConfig.Action.UseItem &&
            (player.actionItem === "bandage" || player.actionItem === "healthkit")
        ) {
            const remaining = Math.max(player.action.duration - player.action.time, 0);
            let finishWindow: number;
            switch (player.actionItem) {
                case "bandage":
                    finishWindow =
                        BotTuning.itemCancel.bandageFinishWindowSec *
                        this._brainProfile.healCancelBandageFinishScale;
                    break;
                case "healthkit":
                default:
                    finishWindow =
                        BotTuning.itemCancel.healthkitFinishWindowSec *
                        this._brainProfile.healCancelHealthkitFinishScale;
                    break;
            }
            const almostDone = remaining <= finishWindow;
            const shouldCancelHeal =
                !almostDone &&
                (threat.anyHostileVisible ||
                    enemyVeryClose ||
                    (danger >=
                        BotTuning.danger.healCancelMin *
                            this._brainProfile.healCancelDangerScale &&
                        enemyClose));

            if (shouldCancelHeal) {
                logBotStability("heal_cancel", {
                    brainType: this.brainType,
                    botId: player.__id,
                    item: player.actionItem,
                    hp: Math.round(player.health),
                    danger: Number(danger.toFixed(3)),
                    enemyClose,
                    enemyVeryClose,
                    hostileVisible: threat.anyHostileVisible,
                    remaining: Number(remaining.toFixed(3)),
                });
                msg.addInput(GameConfig.Input.Cancel);
            }
        }

        const wantsReload =
            !!gunDef &&
            player.actionType === GameConfig.Action.None &&
            activeWeapon.ammo === 0 &&
            spareAmmo > 0;
        if (wantsReload) {
            const outOfEngage = !!profile && aimUpdate.distToTarget > profile.engageMax;
            if (
                this._combat.state === "retreat_reload" ||
                ((!validTarget ||
                    this._perception.targetVisible === false ||
                    outOfEngage) &&
                    danger <= this._brainProfile.reloadDangerMax)
            ) {
                msg.addInput(GameConfig.Input.Reload);
            }
        }

        if (objectInteractionActive) {
            if (!objectTarget) {
                this._clearObjectInteraction();
            } else if (this._combat.objectInteractionMode === "use") {
                if (
                    player.actionType === GameConfig.Action.None &&
                    player
                        .getInteractableObstacles()
                        .some((obstacle) => obstacle.__id === objectTarget?.__id)
                ) {
                    msg.addInput(GameConfig.Input.Use);
                    this._clearObjectInteraction();
                }
            }
        }

        // Use items
        msg.useItem = "";

        if (!player.downed && player.actionType === GameConfig.Action.None) {
            const inRetreatState =
                this._combat.state === "retreat_heal" ||
                this._combat.state === "seek_cover";
            const safeToHeal = isBotSafeToHeal({
                anyHostileVisible: threat.anyHostileVisible,
                danger,
                recentlyDamaged,
                enemyClose,
                enemyVeryClose,
                inRetreatState,
                brainProfile: this._brainProfile,
            });

            // ── Healing logic ──
            if (lowHp) {
                if (safeToHeal) {
                    msg.useItem = chooseBotHealItem(player, veryLowHp);
                }
            }
            // ── Boost logic ──
            else if (wantsBoost) {
                const safeToBoostQuick =
                    !threat.anyHostileVisible &&
                    danger <
                        BotTuning.danger.boostQuickMax *
                            this._brainProfile.boostQuickDangerScale &&
                    !recentlyDamaged &&
                    !enemyVeryClose;

                const safeToBoostLong =
                    !threat.anyHostileVisible &&
                    danger <
                        BotTuning.danger.boostLongMax *
                            this._brainProfile.boostLongDangerScale &&
                    !recentlyDamaged &&
                    !enemyClose;

                msg.useItem = chooseBotBoostItem({
                    player,
                    veryLowBoost,
                    quickSafe: safeToBoostQuick,
                    longSafe: safeToBoostLong,
                });
            }
        }

        const usingItemThisTick =
            player.actionType === GameConfig.Action.UseItem || msg.useItem !== "";

        const burst = this._weaponLogic.updateBurstTimers({
            dt,
            hasTarget: !!validTarget,
            distToTarget: aimUpdate.distToTarget,
            profile,
        });

        const allowShooting =
            !usingItemThisTick &&
            !objectInteractionActive &&
            this._weaponLogic.allowShooting({
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

        this._logIdleReason({
            player,
            goal,
            allowShooting,
            weakLosAnchor,
            moveLeft: msg.moveLeft,
            moveRight: msg.moveRight,
            moveUp: msg.moveUp,
            moveDown: msg.moveDown,
        });

        this._weaponLogic.applyShootInputs({
            msg,
            allowShooting,
            gunDef,
            profile,
        });

        if (
            objectInteractionActive &&
            objectTarget &&
            this._combat.objectInteractionMode === "melee_break"
        ) {
            if (player.curWeapIdx !== GameConfig.WeaponSlot.Melee) {
                msg.addInput(GameConfig.Input.EquipMelee);
            } else if (this._isInMeleeRange(player, objectTarget)) {
                msg.shootHold = false;
                msg.shootStart = true;
            }
        }

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

        if (!objectInteractionActive) {
            this._weaponLogic.applyQuickswitch({
                msg,
                player,
                difficulty: this.difficulty,
                burstHoldT: this._weaponLogic.burstHoldT,
            });
        }

        // Ensure internal bots behave like mobile for auto doors/pickup
        msg.touchMoveActive = false;

        return msg;
    }

    private _getObjectTarget(): Obstacle | undefined {
        if (this._combat.objectTargetId === undefined) return undefined;
        const object = this.game.objectRegister.getById(this._combat.objectTargetId);
        if (
            object &&
            object.__type === ObjectType.Obstacle &&
            !object.destroyed
        ) {
            return object as Obstacle;
        }
        return undefined;
    }

    private _clearObjectInteraction(): void {
        this._combat.objectTargetId = undefined;
        this._combat.objectInteractionMode = undefined;
        if (this._combat.state === "interact_object") {
            this._combat.goalPos = undefined;
        }
    }

    private _isObjectTargetStillValid(obstacle: Obstacle): boolean {
        switch (this._combat.objectInteractionMode) {
            case "use":
                if (obstacle.isDoor && obstacle.door) {
                    return (
                        !obstacle.door.autoOpen &&
                        !obstacle.door.open &&
                        obstacle.door.canUse &&
                        !obstacle.door.locked
                    );
                }
                if (obstacle.isButton) {
                    return obstacle.button.canUse;
                }
                return false;
            case "melee_break":
                return obstacle.destructible && obstacle.health > 0;
            default:
                return false;
        }
    }

    private _isInMeleeRange(player: Player, obstacle: Obstacle): boolean {
        return !!collider.intersectCircle(
            obstacle.collider,
            player.pos,
            BotTuning.objectInteract.meleeReach,
        );
    }

    private _logIdleReason(params: {
        player: Player;
        goal?: Vec2;
        allowShooting: boolean;
        weakLosAnchor: boolean;
        moveLeft: boolean;
        moveRight: boolean;
        moveUp: boolean;
        moveDown: boolean;
    }): void {
        const {
            player,
            goal,
            allowShooting,
            weakLosAnchor,
            moveLeft,
            moveRight,
            moveUp,
            moveDown,
        } = params;

        let reason: string | undefined;
        if (!goal) {
            reason = "no_goal";
        } else if (!moveLeft && !moveRight && !moveUp && !moveDown && !allowShooting) {
            reason = weakLosAnchor ? "weak_los_anchor" : "idle_anchor";
        }

        if (reason === this._lastIdleReason) return;
        this._lastIdleReason = reason;

        if (!reason) return;

        logBotStability("idle_reason", {
            brainType: this.brainType,
            botId: player.__id,
            reason,
            state: this._combat.state,
            stateReason: this._combat.stateReason,
        });
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
