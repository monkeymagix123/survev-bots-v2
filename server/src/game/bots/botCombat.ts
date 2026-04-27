import type { Vec2 } from "../../../../shared/utils/v2";

export type BotCombatState =
    | "wander"
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

export class BotCombatMemory {
    state: BotCombatState = "wander";
    stateSince = 0;
    stateReason = "";

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
     * Movement intent derived from the combat state machine.
     * These are consumed by navigation/movement only.
     */
    goalPos?: Vec2;
    movementStyle: BotMovementStyle = "direct";

    setState(state: BotCombatState, timeNow: number, reason: string): void {
        if (this.state !== state) {
            this.state = state;
            this.stateSince = timeNow;
        }
        this.stateReason = reason;
    }
}
