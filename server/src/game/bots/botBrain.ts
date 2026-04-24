export type BotBrainType = "practice" | "realistic" | "competitive";

export type BrainMixConfig = {
    /**
     * Optional distribution of bot brain types. Missing keys are treated as 0 and the
     * weights are auto-normalized to sum to 1.
     */
    weights?: Partial<Record<BotBrainType, number>>;
    /**
     * If set, forces all bots to use the given brain type and ignores weights.
     */
    force?: BotBrainType;
};

