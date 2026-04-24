import type { BotDifficulty } from "../botDifficulty";

export type SkillProfile = {
    reactionMinSec: number;
    reactionMaxSec: number;
    trackingDegPerSec: number;
    baseAimErrorDeg: number;
    predictionLeadScale: number;
    losGraceSec: number;
};

export const SkillProfiles: Record<BotDifficulty, SkillProfile> = {
    normal: {
        reactionMinSec: 0.25,
        reactionMaxSec: 0.45,
        trackingDegPerSec: 280,
        baseAimErrorDeg: 3.5,
        predictionLeadScale: 0.45,
        losGraceSec: 0.25,
    },
    hard: {
        reactionMinSec: 0.15,
        reactionMaxSec: 0.25,
        trackingDegPerSec: 420,
        baseAimErrorDeg: 1.8,
        predictionLeadScale: 0.75,
        losGraceSec: 0.12,
    },
    pro: {
        reactionMinSec: 0.06,
        reactionMaxSec: 0.1,
        trackingDegPerSec: 650,
        baseAimErrorDeg: 0.8,
        predictionLeadScale: 0.95,
        losGraceSec: 0.05,
    },
};

