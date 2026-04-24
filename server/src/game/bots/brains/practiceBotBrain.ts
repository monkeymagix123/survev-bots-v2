import type { BotBrainType } from "../botBrain";
import { RealisticBotBrain } from "./realisticBotBrain";

/**
 * Phase 1: behavior-preserving (same as Realistic).
 * Phase 2+: will become simpler/weaker/more predictable.
 */
export class PracticeBotBrain extends RealisticBotBrain {
    override readonly type: BotBrainType = "practice";
}

