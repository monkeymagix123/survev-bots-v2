import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import { Config } from "../../config";
import type { Game } from "../game";
import type { Loot } from "../objects/loot";
import type { Player } from "../objects/player";
import type { BotBrainType } from "./botBrain";
import {
    getBotTacticalSnapshot,
    getBotReloadSnapshot,
    isBotUnarmed,
} from "./botDecisionSupport";
import {
    getBotBrainProfile,
    getDecisionDelaySec,
    type BotBrainProfile,
} from "./botBrainProfiles";
import { BotCombatMemory } from "./botCombat";
import {
    applyLootInputs,
    applyHealCancelInput,
    clearObjectInteraction,
    chooseSupportUseItem,
    getMeleeApproachGoal,
    getObjectTarget,
    isInMeleeRange,
    isObjectTargetStillValid,
    logIdleReason,
    resolveLootTarget,
    resolveValidTarget,
    shouldAbortObjectInteraction,
    tryUseInteractObject,
} from "./botControllerShared";
import type { BotDifficulty } from "./botDifficulty";
import type { BotBrain } from "./brains/botBrainLogic";
import { CompetitiveBotBrain } from "./brains/competitiveBotBrain";
import { PracticeBotBrain } from "./brains/practiceBotBrain";
import { RealisticBotBrain } from "./brains/realisticBotBrain";
import { UnarmedBotBrain } from "./brains/unarmedBotBrain";
import { BotTuning } from "./botTuning";
import { BotAimController } from "./systems/botAimController";
import { BotLootScorer } from "./systems/botLootScorer";
import { BotNavigationLite } from "./systems/botNavigationLite";
import { BotObjectInteractionScorer } from "./systems/botObjectInteractionScorer";
import { BotPerception } from "./systems/botPerception";
import { BotWeaponLogic } from "./systems/botWeaponLogic";
import { UnarmedBotInputController } from "./unarmedBotInputController";

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
    private readonly _unarmedInputController: UnarmedBotInputController;
    private readonly _brainProfile: BotBrainProfile;

    private _lastPos: Vec2;
    private _lastMovedTime = 0;
    private _lastHealth = 0;
    private _lastIdleReason?: string;
    private _wasUnarmedLastUpdate: boolean;
    private _meleeSwingStopUntil = -Infinity;
    private _resumeGunSlot?:
        | typeof GameConfig.WeaponSlot.Primary
        | typeof GameConfig.WeaponSlot.Secondary;

    constructor(
        readonly game: Game,
        readonly player: Player,
        readonly difficulty: BotDifficulty,
        readonly brainType: BotBrainType = "realistic",
    ) {
        this._lastPos = v2.copy(player.pos);
        this._lastHealth = player.health;
        this._wasUnarmedLastUpdate = isBotUnarmed(player);
        this._brainProfile = getBotBrainProfile(brainType);
        this._aim = new BotAimController(player, difficulty, brainType);
        this._weaponLogic = new BotWeaponLogic(difficulty, brainType);
        this._brain = this._createBrain(brainType);
        this._unarmedInputController = new UnarmedBotInputController(
            game,
            player,
            brainType,
            this._brainProfile,
            this._perception,
            this._navigation,
            this._combat,
            this._aim,
            this._lootScorer,
            this._objectInteractionScorer,
        );
        this._nextDecisionDelaySec = getDecisionDelaySec(brainType);
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

        const isUnarmedNow = isBotUnarmed(player);
        if (!isUnarmedNow && this._wasUnarmedLastUpdate) {
            this._syncArmedStateAfterUnarmedTransition();
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
            const decisionBrain = isUnarmedNow ? this._unarmedBrain : this._brain;
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

        const msg = isUnarmedNow
            ? this._unarmedInputController.buildInput({
                  dt,
                  timeNow: this._time,
                  seq: this._seq++ % 256,
              })
            : this._buildInput(dt);

        player.handleInput(msg);
        this._wasUnarmedLastUpdate = isBotUnarmed(player);
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

    private _syncArmedStateAfterUnarmedTransition(): void {
        this._aim.resetFocus();
        if (this._perception.targetId !== undefined) {
            this._weaponLogic.onTargetChanged(this._time, this._perception.targetVisible);
        } else {
            this._weaponLogic.onTargetCleared();
        }
    }

    private _buildInput(dt: number): net.InputMsg {
        const player = this.player;

        const msg = new net.InputMsg();
        msg.seq = this._seq++ % 256;

        const validTarget = resolveValidTarget(this.game, player, this._perception);

        const gas = this.game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        const previousObjectTargetId = this._combat.objectTargetId;
        let objectTarget = getObjectTarget(this.game, this._combat);
        if (
            objectTarget &&
            (!util.sameLayer(objectTarget.layer, player.layer) ||
                objectTarget.dead ||
                !isObjectTargetStillValid(this._combat, objectTarget))
        ) {
            this._objectInteractionScorer.markFailedObstacleTarget(
                previousObjectTargetId,
                this._time,
            );
            clearObjectInteraction(this._combat);
            objectTarget = undefined;
        }

        const meleeBreakActive =
            this._combat.state === "interact_object" &&
            this._combat.objectInteractionMode === "melee_break" &&
            !!objectTarget;
        if (
            meleeBreakActive &&
            (player.curWeapIdx === GameConfig.WeaponSlot.Primary ||
                player.curWeapIdx === GameConfig.WeaponSlot.Secondary)
        ) {
            this._resumeGunSlot = player.curWeapIdx;
        }
        const meleeApproachGoal =
            meleeBreakActive && objectTarget
                ? getMeleeApproachGoal(this.game, player, objectTarget)
                : undefined;
        const goalArriveDist = meleeBreakActive
            ? BotTuning.objectInteract.meleeArriveDist
            : BotTuning.navigation.arriveDist;

        const goal = this._navigation.getGoal(
            this.game,
            player,
            gasEmergency,
            validTarget?.pos,
            meleeApproachGoal ?? this._combat.goalPos,
            goalArriveDist,
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

        const meleeBreakInRange =
            meleeBreakActive &&
            !!objectTarget &&
            player.curWeapIdx === GameConfig.WeaponSlot.Melee &&
            isInMeleeRange(player, objectTarget, aimUpdate.aimDir);
        const holdStillForMeleeBreak =
            BotTuning.objectInteract.meleeSwingStopSec > 0 &&
            (meleeBreakInRange || this._time < this._meleeSwingStopUntil);

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
                holdStillForMeleeBreak ||
                ((this._combat.movementStyle === "anchor" &&
                    !gasEmergency &&
                    !weakLosAnchor)),
            aimDir: aimUpdate.aimDir,
            dt,
            moveDeadzone: meleeBreakActive
                ? BotTuning.objectInteract.meleeMoveDeadzone
                : undefined,
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
            arriveDist: goalArriveDist,
            moveLeft: msg.moveLeft,
            moveRight: msg.moveRight,
            moveUp: msg.moveUp,
            moveDown: msg.moveDown,
        });

        const previousLootTargetId = this._combat.lootTargetId;
        const lootTarget = resolveLootTarget(this.game, this._combat, player);
        if (!lootTarget && previousLootTargetId !== undefined) {
            this._lootScorer.markFailedLootTarget(previousLootTargetId, this._time);
        }
        applyLootInputs(msg, this._combat, player, lootTarget);

        const threat = this._perception.threat;
        const tactical = getBotTacticalSnapshot({
            targetVisible: !!validTarget && this._perception.targetVisible,
            hasTarget: !!validTarget,
            distToTarget: aimUpdate.distToTarget,
            lowHp,
            needsReload,
            isReloading,
            recentlyDamaged,
            gasEmergency,
            nearestNearbyHostileDist: threat.nearestNearbyHostileDist,
            nearbyHostileCount: threat.nearbyHostileCount,
            targetHasShownGun: this._perception.targetHasShownGun,
            targetAppearsUnarmed: this._perception.targetAppearsUnarmed,
            targetRecentlyFired: this._perception.targetRecentlyFired,
        });
        const abortObjectInteraction = shouldAbortObjectInteraction({
            combatState: this._combat.state,
            anyHostileVisible: threat.anyHostileVisible,
            recentlyDamaged,
            danger: tactical.danger,
            unarmedThreatRules: false,
        });
        if (abortObjectInteraction) {
            this._objectInteractionScorer.markFailedObstacleTarget(
                this._combat.objectTargetId,
                this._time,
            );
            clearObjectInteraction(this._combat);
            objectTarget = undefined;
        }

        applyHealCancelInput({
            msg,
            player,
            brainType: this.brainType,
            brainProfile: this._brainProfile,
            botId: player.__id,
            combatState: this._combat.state,
            movingNow:
                msg.moveLeft || msg.moveRight || msg.moveUp || msg.moveDown,
            danger: tactical.danger,
            enemyClose: tactical.enemyClose,
            enemyVeryClose: tactical.enemyVeryClose,
            anyHostileVisible: threat.anyHostileVisible,
            visibleThreatSoftened: tactical.softenVisibleThreat,
        });

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
                    tactical.danger <= this._brainProfile.reloadDangerMax)
            ) {
                msg.addInput(GameConfig.Input.Reload);
            }
        }

        if (objectInteractionActive) {
            tryUseInteractObject(msg, this._combat, player, objectTarget);
        }

        // Use items
        msg.useItem = chooseSupportUseItem({
            player,
            brainProfile: this._brainProfile,
            combatState: this._combat.state,
            lowHp,
            veryLowHp,
            wantsBoost,
            veryLowBoost,
            danger: tactical.danger,
            recentlyDamaged,
            enemyClose: tactical.enemyClose,
            enemyVeryClose: tactical.enemyVeryClose,
            anyHostileVisible: threat.anyHostileVisible,
            visibleThreatSoftened: tactical.softenVisibleThreat,
        });

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

        this._lastIdleReason = logIdleReason({
            brainType: this.brainType,
            botId: player.__id,
            state: this._combat.state,
            stateReason: this._combat.stateReason,
            goal,
            allowShooting,
            weakLosAnchor,
            moveLeft: msg.moveLeft,
            moveRight: msg.moveRight,
            moveUp: msg.moveUp,
            moveDown: msg.moveDown,
            lastIdleReason: this._lastIdleReason,
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
            } else if (meleeBreakInRange) {
                if (BotTuning.objectInteract.meleeSwingStopSec > 0) {
                    this._meleeSwingStopUntil =
                        this._time + BotTuning.objectInteract.meleeSwingStopSec;
                }
                msg.shootHold = false;
                msg.shootStart = true;
            }
        }

        if (!meleeBreakActive && player.curWeapIdx === GameConfig.WeaponSlot.Melee) {
            const resumeGunSlot = this._getResumeGunSlot(player);
            if (resumeGunSlot !== undefined) {
                msg.addInput(
                    resumeGunSlot === GameConfig.WeaponSlot.Primary
                        ? GameConfig.Input.EquipPrimary
                        : GameConfig.Input.EquipSecondary,
                );
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
        const triggerActiveThisTick = msg.shootHold || msg.shootStart;
        const noiseDeg = this._weaponLogic.computeShotNoiseDeg({
            willShootThisTick: shot.willShootThisTick,
            triggerActiveThisTick,
            gunDef,
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

    private _getResumeGunSlot(
        player: Player,
    ):
        | typeof GameConfig.WeaponSlot.Primary
        | typeof GameConfig.WeaponSlot.Secondary
        | undefined {
        const rememberedSlot = this._resumeGunSlot;
        if (rememberedSlot !== undefined) {
            const rememberedType = player.weapons[rememberedSlot].type;
            if (rememberedType && GameObjectDefs[rememberedType]?.type === "gun") {
                return rememberedSlot;
            }
        }

        for (const slot of [
            GameConfig.WeaponSlot.Primary,
            GameConfig.WeaponSlot.Secondary,
        ] as const) {
            const type = player.weapons[slot].type;
            if (type && GameObjectDefs[type]?.type === "gun") {
                return slot;
            }
        }

        return undefined;
    }

}

export type { BotDifficulty } from "./botDifficulty";
