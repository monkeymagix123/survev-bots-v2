import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import type { Game } from "../game";
import type { Loot } from "../objects/loot";
import type { Obstacle } from "../objects/obstacle";
import type { Player } from "../objects/player";
import {
    chooseBotBoostItem,
    chooseBotHealItem,
    computeBotDanger,
    getBotThreatBands,
    isBotSafeToHeal,
} from "./botDecisionSupport";
import {
    applyLootInputs,
    clearObjectInteraction,
    getMeleeApproachGoal,
    getObjectTarget,
    isInMeleeRange,
    isObjectTargetStillValid,
    logIdleReason,
    resolveLootTarget,
    resolveValidTarget,
    tryUseInteractObject,
} from "./botControllerShared";
import type { BotBrainType } from "./botBrain";
import type { BotBrainProfile } from "./botBrainProfiles";
import { logBotStability } from "./botStabilityLogger";
import { type BotCombatMemory } from "./botCombat";
import { BotTuning } from "./botTuning";
import { BotAimController } from "./systems/botAimController";
import { BotNavigationLite } from "./systems/botNavigationLite";
import { BotPerception } from "./systems/botPerception";

type BuildInputParams = {
    dt: number;
    timeNow: number;
    seq: number;
};

export class UnarmedBotInputController {
    private _lastIdleReason?: string;

    constructor(
        private readonly game: Game,
        private readonly player: Player,
        private readonly brainType: BotBrainType,
        private readonly brainProfile: BotBrainProfile,
        private readonly perception: BotPerception,
        private readonly navigation: BotNavigationLite,
        private readonly combat: BotCombatMemory,
        private readonly aim: BotAimController,
    ) {}

    buildInput(params: BuildInputParams): net.InputMsg {
        const { dt, timeNow, seq } = params;
        const player = this.player;

        const msg = new net.InputMsg();
        msg.seq = seq;

        const validTarget = resolveValidTarget(this.game, player, this.perception);

        const gas = this.game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        let objectTarget = getObjectTarget(this.game, this.combat);
        if (
            objectTarget &&
            (!util.sameLayer(objectTarget.layer, player.layer) ||
                objectTarget.dead ||
                !isObjectTargetStillValid(this.combat, objectTarget))
        ) {
            clearObjectInteraction(this.combat);
            objectTarget = undefined;
        }

        const meleeBreakActive =
            this.combat.state === "interact_object" &&
            this.combat.objectInteractionMode === "melee_break" &&
            !!objectTarget;
        const meleeApproachGoal =
            meleeBreakActive && objectTarget
                ? getMeleeApproachGoal(this.game, player, objectTarget)
                : undefined;
        const goalArriveDist = meleeBreakActive
            ? BotTuning.objectInteract.meleeArriveDist
            : BotTuning.navigation.arriveDist;

        const goal = this.navigation.getGoal(
            this.game,
            player,
            gasEmergency,
            validTarget?.pos,
            meleeApproachGoal ?? this.combat.goalPos,
            goalArriveDist,
        );

        const lowHp = player.health < BotTuning.heal.lowHp;
        const veryLowHp = player.health < BotTuning.heal.veryLowHp;
        const wantsBoost = player.boost < BotTuning.boost.threshold;
        const veryLowBoost = player.boost < BotTuning.boost.veryLowBoost;
        const recentlyDamaged =
            timeNow - this.combat.lastDamagedTime < BotTuning.combat.recentlyDamagedWindowSec;
        const weakLosAnchor =
            !!validTarget &&
            this.combat.movementStyle === "anchor" &&
            !this.perception.targetVisible;

        const objectInteractionActive =
            this.combat.state === "interact_object" && !!objectTarget;
        const objectAimGoal = objectInteractionActive && objectTarget
            ? objectTarget.pos
            : undefined;

        const aimUpdate = this.aim.update(dt, {
            player,
            goal: objectAimGoal ?? goal,
            target: validTarget,
        });

        msg.toMouseLen = math.clamp(aimUpdate.aimLen, 0, net.Constants.MouseMaxDist);
        msg.toMouseDir = aimUpdate.aimDir;

        const strafeSign =
            this.combat.stateReason === "damage_dodge" &&
            timeNow < this.combat.damageDodgeUntil
                ? this.combat.damageDodgeSign
                : undefined;

        this.navigation.applyMovementInput({
            msg,
            player,
            goal,
            hasTarget: !!validTarget,
            gasEmergency,
            distToTarget: validTarget ? aimUpdate.distToTarget : undefined,
            allowStrafe:
                (this.combat.movementStyle === "strafe" || weakLosAnchor) && !gasEmergency,
            strafeSign,
            anchor:
                this.combat.movementStyle === "anchor" &&
                !gasEmergency &&
                !weakLosAnchor,
            aimDir: aimUpdate.aimDir,
            dt,
            moveDeadzone: meleeBreakActive
                ? BotTuning.objectInteract.meleeMoveDeadzone
                : undefined,
        });

        this.aim.focusTime = 0;

        this.navigation.observeMovement({
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

        const lootTarget = resolveLootTarget(this.game, this.combat, player);
        applyLootInputs(msg, this.combat, player, lootTarget);

        const danger = computeBotDanger({
            targetVisible: !!validTarget && this.perception.targetVisible,
            hasTarget: !!validTarget,
            distToTarget: aimUpdate.distToTarget,
            lowHp,
            needsReload: false,
            isReloading: false,
            recentlyDamaged,
            gasEmergency,
        });

        const threat = this.perception.threat;
        const enemyDist = threat.nearestNearbyHostileDist;
        const { enemyVeryClose, enemyClose } = getBotThreatBands(enemyDist);
        const visibleThreatShouldAbortObject =
            threat.anyHostileVisible &&
            (!this.perception.targetVisible ||
                (this.perception.targetHasShownGun && !this.perception.targetDistracted));
        const dangerShouldAbortObject =
            danger >= BotTuning.objectInteract.breakAbortDangerMin &&
            (!this.perception.targetVisible ||
                (this.perception.targetHasShownGun && !this.perception.targetDistracted) ||
                (!this.perception.targetAppearsUnarmed &&
                    !this.perception.targetDistracted));
        const shouldAbortObjectInteraction =
            this.combat.state === "interact_object" &&
            (visibleThreatShouldAbortObject || recentlyDamaged || dangerShouldAbortObject);
        if (shouldAbortObjectInteraction) {
            clearObjectInteraction(this.combat);
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
                        this.brainProfile.healCancelBandageFinishScale;
                    break;
                case "healthkit":
                default:
                    finishWindow =
                        BotTuning.itemCancel.healthkitFinishWindowSec *
                        this.brainProfile.healCancelHealthkitFinishScale;
                    break;
            }
            const almostDone = remaining <= finishWindow;
            const shouldCancelHeal =
                !almostDone &&
                (threat.anyHostileVisible ||
                    enemyVeryClose ||
                    (danger >=
                        BotTuning.danger.healCancelMin *
                            this.brainProfile.healCancelDangerScale &&
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

        if (objectInteractionActive) {
            tryUseInteractObject(msg, this.combat, player, objectTarget);
        }

        msg.useItem = "";

        if (!player.downed && player.actionType === GameConfig.Action.None) {
            const inRetreatState =
                this.combat.state === "retreat_heal" ||
                this.combat.state === "seek_cover";
            const safeToHeal = isBotSafeToHeal({
                anyHostileVisible: threat.anyHostileVisible,
                danger,
                recentlyDamaged,
                enemyClose,
                enemyVeryClose,
                inRetreatState,
                brainProfile: this.brainProfile,
            });

            if (lowHp) {
                if (safeToHeal) {
                    msg.useItem = chooseBotHealItem(player, veryLowHp);
                }
            } else if (wantsBoost) {
                const safeToBoostQuick =
                    !threat.anyHostileVisible &&
                    danger <
                        BotTuning.danger.boostQuickMax *
                            this.brainProfile.boostQuickDangerScale &&
                    !recentlyDamaged &&
                    !enemyVeryClose;

                const safeToBoostLong =
                    !threat.anyHostileVisible &&
                    danger <
                        BotTuning.danger.boostLongMax *
                            this.brainProfile.boostLongDangerScale &&
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
        const allowShooting =
            !usingItemThisTick &&
            objectInteractionActive &&
            this.combat.objectInteractionMode === "melee_break";

        this._lastIdleReason = logIdleReason({
            brainType: this.brainType,
            botId: player.__id,
            state: this.combat.state,
            stateReason: this.combat.stateReason,
            goal,
            allowShooting,
            weakLosAnchor,
            moveLeft: msg.moveLeft,
            moveRight: msg.moveRight,
            moveUp: msg.moveUp,
            moveDown: msg.moveDown,
            lastIdleReason: this._lastIdleReason,
        });
        msg.shootHold = false;
        msg.shootStart = false;

        if (
            objectInteractionActive &&
            objectTarget &&
            this.combat.objectInteractionMode === "melee_break"
        ) {
            if (player.curWeapIdx !== GameConfig.WeaponSlot.Melee) {
                msg.addInput(GameConfig.Input.EquipMelee);
            } else if (isInMeleeRange(player, objectTarget)) {
                msg.shootHold = false;
                msg.shootStart = true;
            }
        }

        msg.touchMoveActive = false;

        return msg;
    }
}
