import type { Vec2 } from "../../../../shared/utils/v2";

export type BotCombatState =
    | "wander"
    | "loot"
    | "interact_object"
    | "push"
    | "hold_range"
    | "hold_position"
    | "back_off"
    | "strafe"
    | "chase_last_seen"
    | "seek_cover"
    | "retreat_reload"
    | "retreat_heal";

export type BotMovementStyle = "direct" | "strafe" | "anchor";
export type BotObjectInteractionMode = "melee_break" | "use";
export type BotEmergencyState = "gas_escape" | "hard_unstuck" | "panic_survive";
export type BotMacroGoal =
    | "loot_zone"
    | "loot_building"
    | "rotate_safe"
    | "fight"
    | "disengage"
    | "heal";
export type BotTacticalGoal =
    | "move_to_zone"
    | "move_to_safe_zone"
    | "move_to_safe_position"
    | "enter_tunnel"
    | "exit_tunnel"
    | "enter_building"
    | "exit_building"
    | "pickup_loot"
    | "break_crate"
    | "use_door"
    | "push"
    | "back_off"
    | "seek_cover"
    | "hold_range"
    | "hold_position"
    | "strafe"
    | "chase_last_seen"
    | "retreat_reload"
    | "retreat_heal";
export type BotSubGoal = "pickup_loot" | "break_crate" | "use_door";

export function isZoneMacroGoal(
    macroGoal: BotMacroGoal | undefined,
): macroGoal is "loot_zone" | "loot_building" | "rotate_safe" {
    return (
        macroGoal === "loot_zone" ||
        macroGoal === "loot_building" ||
        macroGoal === "rotate_safe"
    );
}

export function isTravelTacticalGoal(
    tacticalGoal: BotTacticalGoal | undefined,
): tacticalGoal is
    | "move_to_zone"
    | "move_to_safe_zone"
    | "move_to_safe_position"
    | "enter_tunnel"
    | "exit_tunnel"
    | "enter_building"
    | "exit_building" {
    return (
        tacticalGoal === "move_to_zone" ||
        tacticalGoal === "move_to_safe_zone" ||
        tacticalGoal === "move_to_safe_position" ||
        tacticalGoal === "enter_tunnel" ||
        tacticalGoal === "exit_tunnel" ||
        tacticalGoal === "enter_building" ||
        tacticalGoal === "exit_building"
    );
}

export function compatibilityStateFromTacticalGoal(
    tacticalGoal: BotTacticalGoal | undefined,
): BotCombatState | undefined {
    switch (tacticalGoal) {
        case "move_to_zone":
        case "move_to_safe_zone":
        case "move_to_safe_position":
        case "enter_tunnel":
        case "exit_tunnel":
        case "enter_building":
        case "exit_building":
            return undefined;
        case "pickup_loot":
            return "loot";
        case "break_crate":
        case "use_door":
            return "interact_object";
        case "push":
        case "hold_range":
        case "hold_position":
        case "back_off":
        case "strafe":
        case "chase_last_seen":
        case "seek_cover":
        case "retreat_reload":
        case "retreat_heal":
            return tacticalGoal;
        default:
            return undefined;
    }
}

export const AllowedTacticalGoalsByMacroGoal: Record<
    BotMacroGoal,
    readonly BotTacticalGoal[]
> = {
    loot_zone: [
        "move_to_zone",
        "pickup_loot",
        "break_crate",
        "use_door",
        "enter_tunnel",
        "exit_tunnel",
        "enter_building",
        "exit_building",
    ],
    loot_building: [
        "move_to_zone",
        "enter_tunnel",
        "exit_tunnel",
        "enter_building",
        "exit_building",
        "pickup_loot",
        "break_crate",
        "use_door",
    ],
    rotate_safe: [
        "move_to_safe_zone",
        "enter_tunnel",
        "exit_tunnel",
        "enter_building",
        "exit_building",
        "pickup_loot",
        "use_door",
    ],
    fight: [
        "push",
        "back_off",
        "seek_cover",
        "hold_range",
        "hold_position",
        "strafe",
        "chase_last_seen",
        "retreat_reload",
        "retreat_heal",
        "enter_tunnel",
        "exit_tunnel",
        "pickup_loot",
        "break_crate",
        "use_door",
    ],
    disengage: [
        "back_off",
        "seek_cover",
        "move_to_safe_zone",
        "move_to_safe_position",
        "enter_tunnel",
        "exit_tunnel",
        "enter_building",
        "exit_building",
        "retreat_reload",
        "retreat_heal",
    ],
    heal: [
        "retreat_heal",
        "seek_cover",
        "back_off",
        "move_to_safe_zone",
        "move_to_safe_position",
        "enter_tunnel",
        "exit_tunnel",
    ],
} as const;

export function fallbackTacticalGoalForMacroGoal(
    macroGoal: BotMacroGoal | undefined,
): BotTacticalGoal {
    switch (macroGoal) {
        case "loot_zone":
        case "loot_building":
            return "move_to_zone";
        case "rotate_safe":
            return "move_to_safe_zone";
        case "disengage":
        case "heal":
            return "move_to_safe_position";
        case "fight":
        default:
            return "hold_range";
    }
}

export function isTacticalGoalAllowedForMacroGoal(
    macroGoal: BotMacroGoal | undefined,
    tacticalGoal: BotTacticalGoal | undefined,
): boolean {
    if (!macroGoal || !tacticalGoal) return true;
    return AllowedTacticalGoalsByMacroGoal[macroGoal].includes(tacticalGoal);
}

export class BotCombatMemory {
    state: BotCombatState = "wander";
    stateSince = 0;
    stateReason = "";
    stateLockUntil = -Infinity;
    emergencyState?: BotEmergencyState;
    emergencyReason = "";
    emergencySince = -Infinity;

    /**
     * Seconds timestamp of the last time this bot took health damage.
     */
    lastDamagedTime = -Infinity;

    /**
     * Short "damage dodge" reaction window after taking damage.
     * Used to briefly strafe without committing to a full retreat.
     */
    damageDodgeUntil = -Infinity;
    damageDodgeSign: -1 | 1 = 1;

    /**
     * Retreat movement sampling memory (stable for a short window).
     */
    evadePerpSign: -1 | 1 = 1;
    evadeAwayFrac = 0.7;
    evadeUntil = -Infinity;

    /**
     * Cached cover target used during retreat-like states.
     */
    coverPos?: Vec2;
    coverTargetId?: number;
    coverUntil = -Infinity;

    /**
     * Short unarmed pressure memory so bots do not instantly resume loot/object
     * farming the moment a hostile flickers out of sight.
     */
    unarmedPressureUntil = -Infinity;
    unarmedThreatPos?: Vec2;

    /**
     * Movement intent derived from the combat state machine.
     * These are consumed by navigation/movement only.
     */
    goalPos?: Vec2;
    movementStyle: BotMovementStyle = "direct";
    lootTargetId?: number;
    lootWeaponSlot?: number;
    objectTargetId?: number;
    objectInteractionMode?: BotObjectInteractionMode;
    macroGoal?: BotMacroGoal;
    macroReason = "";
    macroSince = -Infinity;
    macroLockUntil = -Infinity;
    tacticalGoal?: BotTacticalGoal;
    tacticalReason = "";
    tacticalSince = -Infinity;
    tacticalLockUntil = -Infinity;
    targetZoneId?: number;
    targetBuildingId?: number;
    targetZonePos?: Vec2;
    zoneScore?: number;
    subGoal?: BotSubGoal;
    resumeAfterSubGoal = false;

    setState(state: BotCombatState, timeNow: number, reason: string): void {
        if (this.state !== state) {
            this.state = state;
            this.stateSince = timeNow;
        }
        this.stateReason = reason;
    }

    setEmergencyState(
        emergencyState: BotEmergencyState | undefined,
        timeNow: number,
        reason: string,
    ): void {
        if (this.emergencyState !== emergencyState) {
            this.emergencyState = emergencyState;
            this.emergencySince = timeNow;
        }
        this.emergencyReason = reason;
    }

    setMacroGoal(
        macroGoal: BotMacroGoal | undefined,
        timeNow: number,
        reason: string,
    ): void {
        if (this.macroGoal !== macroGoal) {
            this.macroGoal = macroGoal;
            this.macroSince = timeNow;
        }
        this.macroReason = reason;
    }

    setTacticalGoal(
        tacticalGoal: BotTacticalGoal | undefined,
        timeNow: number,
        reason: string,
    ): void {
        if (this.tacticalGoal !== tacticalGoal) {
            this.tacticalGoal = tacticalGoal;
            this.tacticalSince = timeNow;
        }
        this.tacticalReason = reason;
    }
}
