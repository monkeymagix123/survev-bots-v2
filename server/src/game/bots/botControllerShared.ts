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
import type { BotBrainType } from "./botBrain";
import type { BotBrainProfile } from "./botBrainProfiles";
import type {
    BotCombatMemory,
    BotEmergencyState,
    BotMacroGoal,
    BotSubGoal,
    BotTacticalGoal,
} from "./botCombat";
import {
    compatibilityStateFromTacticalGoal,
    fallbackTacticalGoalForMacroGoal,
    isTacticalGoalAllowedForMacroGoal,
    isTravelTacticalGoal,
    isZoneMacroGoal,
} from "./botCombat";
import {
    chooseBotBoostItem,
    chooseBotHealItem,
    isBotSafeToHeal,
} from "./botDecisionSupport";
import { logBotStability } from "./botStabilityLogger";
import { BotTuning } from "./botTuning";
import type { BotPerception } from "./systems/botPerception";

type DecisionSnapshot = {
    state: string;
    stateReason: string;
    emergencyState?: string;
    emergencyReason: string;
    macroGoal?: string;
    macroReason: string;
    tacticalGoal?: string;
    tacticalReason: string;
    targetZoneId?: number;
    targetBuildingId?: number;
    zoneScore?: number;
    goalX?: number;
    goalY?: number;
    movementStyle: string;
    lootTargetId?: number;
    objectTargetId?: number;
    objectInteractionMode?: string;
    subGoal?: string;
    resumeAfterSubGoal: boolean;
};

function roundedCoord(value: number | undefined): number | undefined {
    return value !== undefined ? Number(value.toFixed(2)) : undefined;
}

export function captureDecisionSnapshot(combat: BotCombatMemory): DecisionSnapshot {
    return {
        state: combat.state,
        stateReason: combat.stateReason,
        emergencyState: combat.emergencyState,
        emergencyReason: combat.emergencyReason,
        macroGoal: combat.macroGoal,
        macroReason: combat.macroReason,
        tacticalGoal: combat.tacticalGoal,
        tacticalReason: combat.tacticalReason,
        targetZoneId: combat.targetZoneId,
        targetBuildingId: combat.targetBuildingId,
        zoneScore:
            combat.zoneScore !== undefined ? Number(combat.zoneScore.toFixed(2)) : undefined,
        goalX: roundedCoord(combat.goalPos?.x),
        goalY: roundedCoord(combat.goalPos?.y),
        movementStyle: combat.movementStyle,
        lootTargetId: combat.lootTargetId,
        objectTargetId: combat.objectTargetId,
        objectInteractionMode: combat.objectInteractionMode,
        subGoal: combat.subGoal,
        resumeAfterSubGoal: combat.resumeAfterSubGoal,
    };
}

export function hasDecisionSnapshotChanged(
    before: DecisionSnapshot,
    after: DecisionSnapshot,
): boolean {
    const keys = Object.keys(before) as Array<keyof DecisionSnapshot>;
    return keys.some((key) => before[key] !== after[key]);
}

export function resolveValidTarget(
    game: Game,
    player: Player,
    perception: BotPerception,
): Player | undefined {
    const targetObj = perception.targetId
        ? game.objectRegister.getById(perception.targetId)
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
        perception.targetId = undefined;
        perception.targetVisible = false;
    }

    return validTarget;
}

export function getObjectTarget(
    game: Game,
    combat: BotCombatMemory,
): Obstacle | undefined {
    if (combat.objectTargetId === undefined) return undefined;
    const object = game.objectRegister.getById(combat.objectTargetId);
    if (object && object.__type === ObjectType.Obstacle && !object.destroyed) {
        return object as Obstacle;
    }
    return undefined;
}

export function clearObjectInteraction(combat: BotCombatMemory): void {
    combat.objectTargetId = undefined;
    combat.objectInteractionMode = undefined;
    if (combat.state === "interact_object") {
        combat.goalPos = undefined;
    }
}

export function isObjectTargetStillValid(
    combat: BotCombatMemory,
    obstacle: Obstacle,
): boolean {
    switch (combat.objectInteractionMode) {
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

export function resolveLootTarget(
    game: Game,
    combat: BotCombatMemory,
    player: Player,
): Loot | undefined {
    const lootObj = combat.lootTargetId
        ? game.objectRegister.getById(combat.lootTargetId)
        : undefined;
    const lootTarget =
        lootObj &&
        lootObj.__type === ObjectType.Loot &&
        !lootObj.destroyed &&
        util.sameLayer(lootObj.layer, player.layer)
            ? (lootObj as Loot)
            : undefined;

    if (!lootTarget) {
        combat.lootTargetId = undefined;
        combat.lootWeaponSlot = undefined;
    }

    return lootTarget;
}

export function applyLootInputs(
    msg: net.InputMsg,
    combat: BotCombatMemory,
    player: Player,
    lootTarget?: Loot,
): void {
    if (!lootTarget) {
        return;
    }

    if (
        combat.state === "loot" &&
        combat.lootWeaponSlot !== undefined &&
        player.curWeapIdx !== combat.lootWeaponSlot
    ) {
        let equipInput: number;
        switch (combat.lootWeaponSlot) {
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
        combat.state === "loot" &&
        player.actionType === GameConfig.Action.None &&
        player.getClosestLoot()?.__id === lootTarget.__id
    ) {
        msg.addInput(GameConfig.Input.Loot);
    }
}

export function tryUseInteractObject(
    msg: net.InputMsg,
    combat: BotCombatMemory,
    player: Player,
    objectTarget: Obstacle | undefined,
): boolean {
    if (combat.state !== "interact_object") return false;
    if (!objectTarget) {
        clearObjectInteraction(combat);
        return false;
    }
    if (combat.objectInteractionMode !== "use") return false;

    if (
        player.actionType === GameConfig.Action.None &&
        player
            .getInteractableObstacles()
            .some((obstacle) => obstacle.__id === objectTarget.__id)
    ) {
        msg.addInput(GameConfig.Input.Use);
        clearObjectInteraction(combat);
        return true;
    }

    return false;
}

export function tryUseTravelDoor(
    msg: net.InputMsg,
    _combat: BotCombatMemory,
    player: Player,
    doorTarget: Obstacle | undefined,
): boolean {
    if (
        !doorTarget ||
        !doorTarget.isDoor ||
        !doorTarget.door ||
        doorTarget.door.locked ||
        !doorTarget.door.canUse ||
        doorTarget.door.autoOpen ||
        doorTarget.door.open
    ) {
        return false;
    }

    if (
        player.actionType === GameConfig.Action.None &&
        player
            .getInteractableObstacles()
            .some((obstacle) => obstacle.__id === doorTarget.__id)
    ) {
        msg.addInput(GameConfig.Input.Use);
        return true;
    }

    return false;
}

export function isInMeleeRange(
    player: Player,
    obstacle: Obstacle,
    aimDir?: Vec2,
): boolean {
    const meleeCollider = getBotMeleeCollider(player, aimDir);
    return !!collider.intersectCircle(
        obstacle.collider,
        meleeCollider.pos,
        meleeCollider.rad,
    );
}

export function getMeleeApproachGoal(
    game: Game,
    player: Player,
    obstacle: Obstacle,
): Vec2 {
    const boundaryPoint = getObstacleBoundaryPointTowardPlayer(player, obstacle);
    let awayDir = v2.sub(player.pos, boundaryPoint);
    if (v2.lengthSqr(awayDir) <= 0.0001) {
        awayDir = v2.sub(player.pos, obstacle.pos);
    }
    if (v2.lengthSqr(awayDir) <= 0.0001) {
        awayDir = v2.copy(player.dir);
    }
    const outward = v2.normalizeSafe(awayDir, v2.create(1, 0));
    const standOff = Math.max(
        getBotMeleeReach(player) - BotTuning.objectInteract.meleeApproachInset,
        0.2,
    );
    const approach = v2.add(boundaryPoint, v2.mul(outward, standOff));
    game.map.clampToMapBounds(approach, player.rad);
    return approach;
}

export function logIdleReason(params: {
    game: Game;
    brainType: BotBrainType;
    botId: number;
    combat: BotCombatMemory;
    state: string;
    stateReason: string;
    goal?: Vec2;
    targetId?: number;
    lootTargetId?: number;
    objectTargetId?: number;
    allowShooting: boolean;
    weakLosAnchor: boolean;
    moveLeft: boolean;
    moveRight: boolean;
    moveUp: boolean;
    moveDown: boolean;
    lastIdleReason?: string;
}): string | undefined {
    const {
        game,
        brainType,
        botId,
        combat,
        state,
        stateReason,
        goal,
        targetId,
        lootTargetId,
        objectTargetId,
        allowShooting,
        weakLosAnchor,
        moveLeft,
        moveRight,
        moveUp,
        moveDown,
        lastIdleReason,
    } = params;

    let reason: string | undefined;
    if (!goal) {
        reason = "no_goal";
    } else if (!moveLeft && !moveRight && !moveUp && !moveDown && !allowShooting) {
        reason = weakLosAnchor ? "weak_los_anchor" : "idle_anchor";
    }

    if (reason === lastIdleReason) return lastIdleReason;
    if (!reason) return undefined;

    logBotStability(game, "idle_reason", {
        brainType,
        botId,
        reason,
        state,
        stateReason,
        goalX: goal ? Number(goal.x.toFixed(2)) : undefined,
        goalY: goal ? Number(goal.y.toFixed(2)) : undefined,
        targetId,
        lootTargetId,
        objectTargetId,
        ...getDecisionLogFields(combat),
    });

    return reason;
}

export function setDecisionContext(
    combat: BotCombatMemory,
    params: {
        timeNow?: number;
        emergencyState?: BotEmergencyState;
        emergencyReason?: string;
        macroGoal?: BotMacroGoal;
        macroReason?: string;
        tacticalGoal?: BotTacticalGoal;
        tacticalReason?: string;
        targetZoneId?: number;
        targetBuildingId?: number;
        targetZonePos?: Vec2;
        zoneScore?: number;
        subGoal?: BotSubGoal;
        resumeAfterSubGoal?: boolean;
    },
): {
    macroGoal?: BotMacroGoal;
    macroReason?: string;
    tacticalGoal?: BotTacticalGoal;
    tacticalReason?: string;
    state?: string;
    stateReason?: string;
    macroLocked: boolean;
    tacticalLocked: boolean;
} {
    const timeNow =
        params.timeNow ??
        Math.max(combat.stateSince, combat.tacticalSince, combat.macroSince, 0);

    const emergencyState = params.emergencyState;
    const emergencyReason = params.emergencyReason ?? "";

    let macroGoal = params.macroGoal;
    let macroReason = params.macroReason ?? "";
    let targetZoneId = params.targetZoneId;
    let targetBuildingId = params.targetBuildingId;
    let targetZonePos = params.targetZonePos;
    let zoneScore = params.zoneScore;
    let macroLocked = false;

    if (
        emergencyState === undefined &&
        timeNow < combat.macroLockUntil &&
        combat.macroGoal !== undefined &&
        isZoneMacroGoal(combat.macroGoal) &&
        isZoneMacroGoal(macroGoal)
    ) {
        macroGoal = combat.macroGoal;
        macroReason = combat.macroReason || macroReason;
        targetZoneId = combat.targetZoneId;
        targetBuildingId = combat.targetBuildingId;
        targetZonePos = combat.targetZonePos;
        zoneScore = combat.zoneScore;
        macroLocked = true;
    }

    let tacticalGoal = params.tacticalGoal;
    let tacticalReason = params.tacticalReason ?? "";
    let tacticalLocked = false;

    if (
        emergencyState === undefined &&
        timeNow < combat.tacticalLockUntil &&
        combat.tacticalGoal !== undefined &&
        isTravelTacticalGoal(combat.tacticalGoal) &&
        isTravelTacticalGoal(tacticalGoal) &&
        combat.macroGoal === macroGoal
    ) {
        tacticalGoal = combat.tacticalGoal;
        tacticalReason = combat.tacticalReason || tacticalReason;
        tacticalLocked = true;
    }

    combat.setEmergencyState(emergencyState, timeNow, emergencyReason);
    combat.setMacroGoal(macroGoal, timeNow, macroReason);
    tacticalGoal = isTacticalGoalAllowedForMacroGoal(
        macroGoal,
        tacticalGoal,
    )
        ? tacticalGoal
        : fallbackTacticalGoalForMacroGoal(macroGoal);
    combat.setTacticalGoal(tacticalGoal, timeNow, tacticalReason);
    combat.targetZoneId = targetZoneId;
    combat.targetBuildingId = targetBuildingId;
    combat.targetZonePos = targetZonePos ? v2.copy(targetZonePos) : undefined;
    combat.zoneScore = zoneScore;
    const derivedSubGoal =
        tacticalGoal === "pickup_loot" ||
        tacticalGoal === "break_crate" ||
        tacticalGoal === "use_door"
            ? tacticalGoal
            : undefined;
    combat.subGoal = params.subGoal ?? derivedSubGoal;
    combat.resumeAfterSubGoal = !!params.resumeAfterSubGoal;

    if (macroGoal && isZoneMacroGoal(macroGoal)) {
        combat.macroLockUntil = Math.max(
            combat.macroLockUntil,
            timeNow + BotTuning.combat.macroZoneCommitSec,
        );
    } else {
        combat.macroLockUntil = timeNow;
    }

    if (tacticalGoal === "move_to_safe_zone") {
        combat.tacticalLockUntil = Math.max(
            combat.tacticalLockUntil,
            timeNow + BotTuning.combat.tacticalSafeZoneCommitSec,
        );
    } else if (isTravelTacticalGoal(tacticalGoal)) {
        combat.tacticalLockUntil = Math.max(
            combat.tacticalLockUntil,
            timeNow + BotTuning.combat.tacticalTravelCommitSec,
        );
    } else {
        combat.tacticalLockUntil = timeNow;
    }

    const compatibilityState = compatibilityStateFromTacticalGoal(tacticalGoal);
    return {
        macroGoal,
        macroReason,
        tacticalGoal,
        tacticalReason,
        state: compatibilityState,
        stateReason: compatibilityState ? tacticalReason : undefined,
        macroLocked,
        tacticalLocked,
    };
}

export function getDecisionLogFields(combat: BotCombatMemory): Record<string, unknown> {
    return {
        emergencyState: combat.emergencyState,
        emergencyReason: combat.emergencyReason || undefined,
        macroGoal: combat.macroGoal,
        macroReason: combat.macroReason || undefined,
        tacticalGoal: combat.tacticalGoal,
        tacticalReason: combat.tacticalReason || undefined,
        targetZoneId: combat.targetZoneId,
        targetBuildingId: combat.targetBuildingId,
        zoneScore:
            combat.zoneScore !== undefined
                ? Number(combat.zoneScore.toFixed(2))
                : undefined,
        subGoal: combat.subGoal,
        resumeAfterSubGoal: combat.resumeAfterSubGoal || undefined,
        targetZoneX:
            combat.targetZonePos !== undefined
                ? Number(combat.targetZonePos.x.toFixed(2))
                : undefined,
        targetZoneY:
            combat.targetZonePos !== undefined
                ? Number(combat.targetZonePos.y.toFixed(2))
                : undefined,
    };
}

export function tacticalGoalFromCombatState(
    state: string,
): BotTacticalGoal | undefined {
    switch (state) {
        case "push":
        case "back_off":
        case "seek_cover":
        case "hold_range":
        case "hold_position":
        case "strafe":
        case "chase_last_seen":
        case "retreat_reload":
        case "retreat_heal":
            return state;
        default:
            return undefined;
    }
}

export function shouldAbortObjectInteraction(params: {
    combatState: string;
    anyHostileVisible: boolean;
    recentlyDamaged: boolean;
    danger: number;
    unarmedThreatRules: boolean;
    targetVisible?: boolean;
    targetHasShownGun?: boolean;
    targetDistracted?: boolean;
    targetAppearsUnarmed?: boolean;
}): boolean {
    const {
        combatState,
        anyHostileVisible,
        recentlyDamaged,
        danger,
        unarmedThreatRules,
        targetVisible = false,
        targetHasShownGun = false,
        targetDistracted = false,
        targetAppearsUnarmed = false,
    } = params;

    if (combatState !== "interact_object") return false;
    if (recentlyDamaged) return true;

    if (!unarmedThreatRules) {
        return (
            anyHostileVisible ||
            danger >= BotTuning.objectInteract.breakAbortDangerMin
        );
    }

    const visibleThreatShouldAbortObject =
        anyHostileVisible &&
        (!targetVisible || (targetHasShownGun && !targetDistracted));
    const dangerShouldAbortObject =
        danger >= BotTuning.objectInteract.breakAbortDangerMin &&
        (!targetVisible ||
            (targetHasShownGun && !targetDistracted) ||
            (!targetAppearsUnarmed && !targetDistracted));

    return visibleThreatShouldAbortObject || dangerShouldAbortObject;
}

export function applyHealCancelInput(params: {
    game: Game;
    msg: net.InputMsg;
    player: Player;
    brainType: BotBrainType;
    brainProfile: BotBrainProfile;
    botId: number;
    combatState: string;
    movingNow: boolean;
    danger: number;
    enemyClose: boolean;
    enemyVeryClose: boolean;
    anyHostileVisible: boolean;
    visibleThreatSoftened?: boolean;
}): void {
    const {
        game,
        msg,
        player,
        brainType,
        brainProfile,
        botId,
        combatState,
        movingNow,
        danger,
        enemyClose,
        enemyVeryClose,
        anyHostileVisible,
        visibleThreatSoftened = false,
    } = params;

    if (
        player.actionType !== GameConfig.Action.UseItem ||
        (player.actionItem !== "bandage" && player.actionItem !== "healthkit")
    ) {
        return;
    }

    const remaining = Math.max(player.action.duration - player.action.time, 0);
    const progress =
        player.action.duration > 0
            ? math.clamp(player.action.time / player.action.duration, 0, 1)
            : 0;
    let finishWindow: number;
    switch (player.actionItem) {
        case "bandage":
            finishWindow =
                BotTuning.itemCancel.bandageFinishWindowSec *
                brainProfile.healCancelBandageFinishScale;
            break;
        case "healthkit":
        default:
            finishWindow =
                BotTuning.itemCancel.healthkitFinishWindowSec *
                brainProfile.healCancelHealthkitFinishScale;
            break;
    }
    const almostDone = remaining <= finishWindow;
    const retreatMovingBandageCommitted =
        player.actionItem === "bandage" &&
        movingNow &&
        progress >= BotTuning.itemCancel.bandageMovingCommitProgress &&
        (combatState === "retreat_heal" ||
            combatState === "seek_cover" ||
            combatState === "back_off");
    const healthkitCommitted =
        player.actionItem === "healthkit" &&
        progress >= BotTuning.itemCancel.healthkitCommitProgress;
    const effectiveHostileVisible =
        anyHostileVisible && !visibleThreatSoftened;
    const normalCancelPressure =
        effectiveHostileVisible ||
        enemyVeryClose ||
        (danger >=
            BotTuning.danger.healCancelMin *
                brainProfile.healCancelDangerScale &&
            enemyClose);
    const shouldCancelHeal =
        !almostDone &&
        (healthkitCommitted || retreatMovingBandageCommitted
            ? enemyVeryClose
            : normalCancelPressure);

    if (!shouldCancelHeal) return;

    logBotStability(game, "heal_cancel", {
        brainType,
        botId,
        item: player.actionItem,
        hp: Math.round(player.health),
        danger: Number(danger.toFixed(3)),
        enemyClose,
        enemyVeryClose,
        hostileVisible: effectiveHostileVisible,
        remaining: Number(remaining.toFixed(3)),
    });
    msg.addInput(GameConfig.Input.Cancel);
}

export function chooseSupportUseItem(params: {
    player: Player;
    brainProfile: BotBrainProfile;
    combatState: string;
    lowHp: boolean;
    veryLowHp: boolean;
    wantsBoost: boolean;
    veryLowBoost: boolean;
    danger: number;
    recentlyDamaged: boolean;
    recentEnemy: boolean;
    enemyClose: boolean;
    enemyVeryClose: boolean;
    anyHostileVisible: boolean;
    visibleThreatSoftened?: boolean;
}): string {
    const {
        player,
        brainProfile,
        combatState,
        lowHp,
        veryLowHp,
        wantsBoost,
        veryLowBoost,
        danger,
        recentlyDamaged,
        recentEnemy,
        enemyClose,
        enemyVeryClose,
        anyHostileVisible,
        visibleThreatSoftened = false,
    } = params;

    if (player.downed || player.actionType !== GameConfig.Action.None) {
        return "";
    }

    const effectiveHostileVisible =
        anyHostileVisible && !visibleThreatSoftened;

    const inRetreatState =
        combatState === "retreat_heal" || combatState === "seek_cover";
    const safeToHeal = isBotSafeToHeal({
        anyHostileVisible: effectiveHostileVisible,
        danger,
        recentlyDamaged,
        recentEnemy,
        enemyClose,
        enemyVeryClose,
        inRetreatState,
        brainProfile,
    });

    if (lowHp) {
        return safeToHeal ? chooseBotHealItem(player, veryLowHp) : "";
    }

    if (!wantsBoost) return "";

    const safeToBoostQuick =
        !effectiveHostileVisible &&
        danger <
            BotTuning.danger.boostQuickMax *
                brainProfile.boostQuickDangerScale &&
        !recentlyDamaged &&
        !recentEnemy &&
        !enemyVeryClose;

    const safeToBoostLong =
        !effectiveHostileVisible &&
        danger <
            BotTuning.danger.boostLongMax *
                brainProfile.boostLongDangerScale &&
        !recentlyDamaged &&
        !recentEnemy &&
        !enemyClose;

    return chooseBotBoostItem({
        player,
        veryLowBoost,
        quickSafe: safeToBoostQuick,
        longSafe: safeToBoostLong,
    });
}

function getBotMeleeCollider(
    player: Player,
    aimDir?: Vec2,
): { pos: Vec2; rad: number } {
    const meleeDef = getBotMeleeDef(player);
    const facing = aimDir && v2.lengthSqr(aimDir) > 0.0001 ? aimDir : player.dir;
    const rot = Math.atan2(facing.y, facing.x);
    const offset = v2.add(
        meleeDef.attack.offset,
        v2.mul(v2.create(1, 0), player.scale - 1),
    );
    return {
        pos: v2.add(player.pos, v2.rotate(offset, rot)),
        rad: meleeDef.attack.rad,
    };
}

function getBotMeleeReach(player: Player): number {
    const meleeDef = getBotMeleeDef(player);
    const offset = v2.add(
        meleeDef.attack.offset,
        v2.mul(v2.create(1, 0), player.scale - 1),
    );
    return v2.length(offset) + meleeDef.attack.rad;
}

function getBotMeleeDef(player: Player): MeleeDef {
    const meleeType = player.weapons[GameConfig.WeaponSlot.Melee].type || "fists";
    return GameObjectDefs[meleeType] as MeleeDef;
}

function getObstacleBoundaryPointTowardPlayer(
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
