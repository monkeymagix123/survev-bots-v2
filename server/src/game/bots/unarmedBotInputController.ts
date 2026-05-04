import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import type { MeleeDef } from "../../../../shared/defs/gameObjects/meleeDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../shared/utils/coldet";
import { collider } from "../../../../shared/utils/collider";
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

        const targetObj = this.perception.targetId
            ? this.game.objectRegister.getById(this.perception.targetId)
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
            this.perception.targetId = undefined;
            this.perception.targetVisible = false;
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

        const meleeBreakActive =
            this.combat.state === "interact_object" &&
            this.combat.objectInteractionMode === "melee_break" &&
            !!objectTarget;
        const meleeApproachGoal =
            meleeBreakActive && objectTarget
                ? this._getMeleeApproachGoal(player, objectTarget)
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

        const lootObj = this.combat.lootTargetId
            ? this.game.objectRegister.getById(this.combat.lootTargetId)
            : undefined;
        const lootTarget =
            lootObj &&
            lootObj.__type === ObjectType.Loot &&
            !lootObj.destroyed &&
            util.sameLayer(lootObj.layer, player.layer)
                ? (lootObj as Loot)
                : undefined;

        if (!lootTarget) {
            this.combat.lootTargetId = undefined;
            this.combat.lootWeaponSlot = undefined;
        } else if (
            this.combat.state === "loot" &&
            this.combat.lootWeaponSlot !== undefined &&
            player.curWeapIdx !== this.combat.lootWeaponSlot
        ) {
            let equipInput: number;
            switch (this.combat.lootWeaponSlot) {
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
            this.combat.state === "loot" &&
            lootTarget &&
            player.actionType === GameConfig.Action.None &&
            player.getClosestLoot()?.__id === lootTarget.__id
        ) {
            msg.addInput(GameConfig.Input.Loot);
        }

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
            if (!objectTarget) {
                this._clearObjectInteraction();
            } else if (this.combat.objectInteractionMode === "use") {
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
        msg.shootHold = false;
        msg.shootStart = false;

        if (
            objectInteractionActive &&
            objectTarget &&
            this.combat.objectInteractionMode === "melee_break"
        ) {
            if (player.curWeapIdx !== GameConfig.WeaponSlot.Melee) {
                msg.addInput(GameConfig.Input.EquipMelee);
            } else if (this._isInMeleeRange(player, objectTarget)) {
                msg.shootHold = false;
                msg.shootStart = true;
            }
        }

        msg.touchMoveActive = false;

        return msg;
    }

    private _getObjectTarget(): Obstacle | undefined {
        if (this.combat.objectTargetId === undefined) return undefined;
        const object = this.game.objectRegister.getById(this.combat.objectTargetId);
        if (object && object.__type === ObjectType.Obstacle && !object.destroyed) {
            return object as Obstacle;
        }
        return undefined;
    }

    private _clearObjectInteraction(): void {
        this.combat.objectTargetId = undefined;
        this.combat.objectInteractionMode = undefined;
        if (this.combat.state === "interact_object") {
            this.combat.goalPos = undefined;
        }
    }

    private _isObjectTargetStillValid(obstacle: Obstacle): boolean {
        switch (this.combat.objectInteractionMode) {
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
        const meleeCollider = this._getBotMeleeCollider(player);
        return !!collider.intersectCircle(
            obstacle.collider,
            meleeCollider.pos,
            meleeCollider.rad,
        );
    }

    private _getMeleeApproachGoal(player: Player, obstacle: Obstacle): Vec2 {
        const boundaryPoint = this._getObstacleBoundaryPointTowardPlayer(player, obstacle);
        let awayDir = v2.sub(player.pos, boundaryPoint);
        if (v2.lengthSqr(awayDir) <= 0.0001) {
            awayDir = v2.sub(player.pos, obstacle.pos);
        }
        if (v2.lengthSqr(awayDir) <= 0.0001) {
            awayDir = v2.copy(player.dir);
        }
        const outward = v2.normalizeSafe(awayDir, v2.create(1, 0));
        const standOff = Math.max(
            this._getBotMeleeReach(player) - BotTuning.objectInteract.meleeApproachInset,
            0.2,
        );
        const approach = v2.add(boundaryPoint, v2.mul(outward, standOff));
        this.game.map.clampToMapBounds(approach, player.rad);
        return approach;
    }

    private _getBotMeleeCollider(player: Player): { pos: Vec2; rad: number } {
        const meleeDef = this._getBotMeleeDef(player);
        const rot = Math.atan2(player.dir.y, player.dir.x);
        const offset = v2.add(
            meleeDef.attack.offset,
            v2.mul(v2.create(1, 0), player.scale - 1),
        );
        return {
            pos: v2.add(player.pos, v2.rotate(offset, rot)),
            rad: meleeDef.attack.rad,
        };
    }

    private _getBotMeleeReach(player: Player): number {
        const meleeDef = this._getBotMeleeDef(player);
        const offset = v2.add(
            meleeDef.attack.offset,
            v2.mul(v2.create(1, 0), player.scale - 1),
        );
        return v2.length(offset) + meleeDef.attack.rad;
    }

    private _getBotMeleeDef(player: Player): MeleeDef {
        const meleeType = player.weapons[GameConfig.WeaponSlot.Melee].type || "fists";
        return GameObjectDefs[meleeType] as MeleeDef;
    }

    private _getObstacleBoundaryPointTowardPlayer(
        player: Player,
        obstacle: Obstacle,
    ): Vec2 {
        if (obstacle.collider.type === collider.Type.Circle) {
            let towardPlayer = v2.sub(player.pos, obstacle.collider.pos);
            if (v2.lengthSqr(towardPlayer) <= 0.0001) {
                towardPlayer = v2.copy(player.dir);
            }
            const dir = v2.normalizeSafe(towardPlayer, v2.create(1, 0));
            return v2.add(obstacle.collider.pos, v2.mul(dir, obstacle.collider.rad));
        }

        const point = coldet.clampPosToAabb(player.pos, obstacle.collider);
        const insideAabb = coldet.testPointAabb(
            player.pos,
            obstacle.collider.min,
            obstacle.collider.max,
        );
        if (!insideAabb) {
            return point;
        }

        const center = v2.mul(
            v2.add(obstacle.collider.min, obstacle.collider.max),
            0.5,
        );
        let away = v2.sub(player.pos, center);
        if (v2.lengthSqr(away) <= 0.0001) {
            away = v2.copy(player.dir);
        }

        const dir = v2.normalizeSafe(away, v2.create(1, 0));
        const dxMin = Math.abs(player.pos.x - obstacle.collider.min.x);
        const dxMax = Math.abs(obstacle.collider.max.x - player.pos.x);
        const dyMin = Math.abs(player.pos.y - obstacle.collider.min.y);
        const dyMax = Math.abs(obstacle.collider.max.y - player.pos.y);

        if (Math.abs(dir.x) >= Math.abs(dir.y)) {
            return v2.create(
                dir.x >= 0 ? obstacle.collider.max.x : obstacle.collider.min.x,
                math.clamp(player.pos.y, obstacle.collider.min.y, obstacle.collider.max.y),
            );
        }

        if (Math.min(dyMin, dyMax) <= Math.min(dxMin, dxMax)) {
            return v2.create(
                math.clamp(player.pos.x, obstacle.collider.min.x, obstacle.collider.max.x),
                dir.y >= 0 ? obstacle.collider.max.y : obstacle.collider.min.y,
            );
        }

        return v2.create(
            dir.x >= 0 ? obstacle.collider.max.x : obstacle.collider.min.x,
            math.clamp(player.pos.y, obstacle.collider.min.y, obstacle.collider.max.y),
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
            state: this.combat.state,
            stateReason: this.combat.stateReason,
        });
    }
}
