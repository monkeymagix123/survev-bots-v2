import type { BotBrainType } from "../botBrain";
import type { BotBrain, BotBrainContext } from "./botBrainLogic";

/**
 * Phase 1: behavior-preserving brain that matches the current bot logic.
 * Phase 2+: will diverge into more human-like decision-making.
 */
export class RealisticBotBrain implements BotBrain {
    readonly type: BotBrainType = "realistic";

    decide(ctx: BotBrainContext): void {
        const { game, player, timeNow, perception, navigation, aim, weaponLogic } = ctx;

        const scan = perception.scanForTarget(game, player);

        const prevTargetId = perception.targetId;
        const prevVisible = perception.targetVisible;

        const chosen = scan.target;
        if (chosen) {
            const newTargetId = chosen.__id;
            const newVisible = scan.visible;

            perception.targetId = newTargetId;
            perception.targetVisible = newVisible;

            if (prevTargetId !== newTargetId) {
                aim.resetFocus();
                weaponLogic.onTargetChanged(timeNow, newVisible);
            } else {
                weaponLogic.onVisibilityUpdate(prevVisible, newVisible, timeNow);
            }

            if (newVisible) {
                perception.markTargetSeen(timeNow);
            }
        } else {
            perception.targetId = undefined;
            perception.targetVisible = false;
            aim.resetFocus();
            weaponLogic.onTargetCleared();
        }

        if (!perception.targetId) {
            navigation.ensureWaypoint(game, player);
        }
    }
}

