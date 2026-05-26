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
export type BotMacroGoal = "loot_zone" | "rotate_safe" | "fight" | "heal";
export type BotSubGoal = "pickup_loot" | "break_crate" | "use_door";

export class BotCombatMemory {
    state: BotCombatState = "wander";
    stateSince = 0;
    stateReason = "";
    stateLockUntil = -Infinity;

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
}
