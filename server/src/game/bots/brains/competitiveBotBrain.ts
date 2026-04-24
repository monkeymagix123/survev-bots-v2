import type { BotBrainType } from "../botBrain";
import { RealisticBotBrain } from "./realisticBotBrain";

/**
 * Phase 1: behavior-preserving (same as Realistic).
 * Phase 2+: will become stronger/cover-aware/range-disciplined.
 */
export class CompetitiveBotBrain extends RealisticBotBrain {
    override readonly type: BotBrainType = "competitive";
}

