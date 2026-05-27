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
    computeBotDanger,
    getBotThreatBands,
} from "./botDecisionSupport";
import {
    applyLootInputs,
    applyHealCancelInput,
    clearObjectInteraction,
    chooseSupportUseItem,
    getDoorUseApproachGoal,
    getMeleeApproachGoal,
    getObjectTarget,
    isInMeleeRange,
    isObjectTargetStillValid,
    logIdleReason,
    resolveLootTarget,
    resolveValidTarget,
    shouldAbortObjectInteraction,
    tryUseInteractObject,
    tryUseTravelDoor,
} from "./botControllerShared";
import type { BotBrainType } from "./botBrain";
import type { BotBrainProfile } from "./botBrainProfiles";
import { type BotCombatMemory } from "./botCombat";
import { BotTuning } from "./botTuning";
import { BotAimController } from "./systems/botAimController";
import type { BotLootScorer } from "./systems/botLootScorer";
import { BotNavigationLite } from "./systems/botNavigationLite";
import type { BotObjectInteractionScorer } from "./systems/botObjectInteractionScorer";
import { BotPerception } from "./systems/botPerception";

type BuildInputParams = {
    dt: number;
    timeNow: number;
    seq: number;
};

export class UnarmedBotInputController {
    private _lastIdleReason?: string;
    private _meleeSwingStopUntil = -Infinity;

    constructor(
        private readonly game: Game,
        private readonly player: Player,
        private readonly brainType: BotBrainType,
        private readonly brainProfile: BotBrainProfile,
        private readonly perception: BotPerception,
        private readonly navigation: BotNavigationLite,
        private readonly combat: BotCombatMemory,
        private readonly aim: BotAimController,
        private readonly lootScorer: BotLootScorer,
        private readonly objectInteractionScorer: BotObjectInteractionScorer,
    ) {}

    buildInput(params: BuildInputParams): net.InputMsg {
        const { dt, timeNow, seq } = params;
        const player = this.player;

        const msg = new net.InputMsg();
        msg.seq = seq;

        const validTarget = resolveValidTarget(this.game, player, this.perception);

        const gas = this.game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        const previousObjectTargetId = this.combat.objectTargetId;
        let objectTarget = getObjectTarget(this.game, this.combat);
        if (
            objectTarget &&
            (!util.sameLayer(objectTarget.layer, player.layer) ||
                objectTarget.dead ||
                !isObjectTargetStillValid(this.combat, objectTarget))
        ) {
            this.objectInteractionScorer.markFailedObstacleTarget(
                previousObjectTargetId,
                timeNow,
            );
            clearObjectInteraction(this.combat);
            objectTarget = undefined;
        }

        const meleeBreakActive =
            this.combat.state === "interact_object" &&
            this.combat.objectInteractionMode === "melee_break" &&
            !!objectTarget;
        const manualUseObjectActive =
            this.combat.state === "interact_object" &&
            this.combat.objectInteractionMode === "use" &&
            !!objectTarget;
        const preTravelDoorTarget = this.navigation.getTravelUseDoorTarget(
            this.game,
            player,
            this.combat.goalPos,
        );
        const meleeApproachGoal =
            meleeBreakActive && objectTarget
                ? getMeleeApproachGoal(this.game, player, objectTarget)
                : undefined;
        const useDoorApproachGoal =
            manualUseObjectActive && objectTarget
                ? getDoorUseApproachGoal(this.game, player, objectTarget)
                : preTravelDoorTarget
                  ? getDoorUseApproachGoal(this.game, player, preTravelDoorTarget)
                  : undefined;
        const doorUseActive = !!useDoorApproachGoal;
        const goalArriveDist = meleeBreakActive
            ? BotTuning.objectInteract.meleeArriveDist
            : doorUseActive
              ? 0.2
              : BotTuning.navigation.arriveDist;

        const goal = this.navigation.getGoal(
            this.game,
            player,
            gasEmergency,
            validTarget?.pos,
            meleeApproachGoal ?? useDoorApproachGoal ?? this.combat.goalPos,
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

        const meleeBreakInRange =
            meleeBreakActive &&
            !!objectTarget &&
            player.curWeapIdx === GameConfig.WeaponSlot.Melee &&
            isInMeleeRange(player, objectTarget, aimUpdate.aimDir);
        const holdStillForMeleeBreak =
            BotTuning.objectInteract.meleeSwingStopSec > 0 &&
            (meleeBreakInRange || timeNow < this._meleeSwingStopUntil);

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
                holdStillForMeleeBreak ||
                ((this.combat.movementStyle === "anchor" &&
                    !gasEmergency &&
                    !weakLosAnchor)),
            aimDir: aimUpdate.aimDir,
            dt,
            moveDeadzone: meleeBreakActive
                ? BotTuning.objectInteract.meleeMoveDeadzone
                : doorUseActive
                  ? 0.2
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

        const previousLootTargetId = this.combat.lootTargetId;
        const lootTarget = resolveLootTarget(this.game, this.combat, player);
        if (!lootTarget && previousLootTargetId !== undefined) {
            this.lootScorer.markFailedLootTarget(previousLootTargetId, timeNow);
        }
        applyLootInputs(msg, this.combat, player, lootTarget);
        const travelDoorTarget =
            preTravelDoorTarget ??
            this.navigation.getTravelUseDoorTarget(
                this.game,
                player,
                this.combat.goalPos,
            );
        tryUseTravelDoor(msg, this.combat, player, travelDoorTarget);

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
        const abortObjectInteraction = shouldAbortObjectInteraction({
            combatState: this.combat.state,
            anyHostileVisible: threat.anyHostileVisible,
            recentlyDamaged,
            danger,
            unarmedThreatRules: true,
            targetVisible: this.perception.targetVisible,
            targetHasShownGun: this.perception.targetHasShownGun,
            targetDistracted: this.perception.targetDistracted,
            targetAppearsUnarmed: this.perception.targetAppearsUnarmed,
        });
        if (abortObjectInteraction) {
            this.objectInteractionScorer.markFailedObstacleTarget(
                this.combat.objectTargetId,
                timeNow,
            );
            clearObjectInteraction(this.combat);
            objectTarget = undefined;
        }

        applyHealCancelInput({
            game: this.game,
            msg,
            player,
            brainType: this.brainType,
            brainProfile: this.brainProfile,
            botId: player.__id,
            combatState: this.combat.state,
            movingNow:
                msg.moveLeft || msg.moveRight || msg.moveUp || msg.moveDown,
            danger,
            enemyClose,
            enemyVeryClose,
            anyHostileVisible: threat.anyHostileVisible,
        });

        if (objectInteractionActive) {
            tryUseInteractObject(msg, this.combat, player, objectTarget);
        }

        msg.useItem = "";
        msg.useItem = chooseSupportUseItem({
            player,
            brainProfile: this.brainProfile,
            combatState: this.combat.state,
            lowHp,
            veryLowHp,
            wantsBoost,
            veryLowBoost,
            danger,
            recentlyDamaged,
            recentEnemy: threat.hasRecentEnemy,
            enemyClose,
            enemyVeryClose,
            anyHostileVisible: threat.anyHostileVisible,
        });

        const usingItemThisTick =
            player.actionType === GameConfig.Action.UseItem || msg.useItem !== "";
        const allowShooting =
            !usingItemThisTick &&
            objectInteractionActive &&
            this.combat.objectInteractionMode === "melee_break";

        this._lastIdleReason = logIdleReason({
            game: this.game,
            brainType: this.brainType,
            botId: player.__id,
            combat: this.combat,
            state: this.combat.state,
            stateReason: this.combat.stateReason,
            goal,
            targetId: validTarget?.__id,
            lootTargetId: this.combat.lootTargetId,
            objectTargetId: this.combat.objectTargetId,
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
            } else if (meleeBreakInRange) {
                if (BotTuning.objectInteract.meleeSwingStopSec > 0) {
                    this._meleeSwingStopUntil =
                        timeNow + BotTuning.objectInteract.meleeSwingStopSec;
                }
                msg.shootHold = false;
                msg.shootStart = true;
            }
        }

        msg.touchMoveActive = false;

        return msg;
    }
}
