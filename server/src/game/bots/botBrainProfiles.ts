import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import type { BotBrainType } from "./botBrain";
import type { BotDifficulty } from "./botDifficulty";
import { SkillProfiles, type SkillProfile } from "./systems/botSkillProfiles";

export type BotBrainProfile = {
    decisionDelayMinSec: number;
    decisionDelayMaxSec: number;
    rangeSlack: number;
    pushExtraDist: number;
    backOffExtraDist: number;
    retreatDangerMin: number;
    highDangerMin: number;
    chaseTtlSec: number;
    mistakeChance: number;
    lootIdleDistScale: number;
    lootOpportunisticDistScale: number;
    objectInteractDistScale: number;
    objectLootWillingness: number;
    healDangerScale: number;
    retreatHealDangerScale: number;
    healCancelDangerScale: number;
    reloadDangerMax: number;
    boostQuickDangerScale: number;
    boostLongDangerScale: number;
    healCancelBandageFinishScale: number;
    healCancelHealthkitFinishScale: number;
    targetSelection: "nearest" | "threat_score";
    targetStickinessBonus: number;
    targetLowHealthWeight: number;
    targetReloadBonus: number;
    targetVisibleBonus: number;
    coverRingSamplesMin: number;
    coverRingSamplesMax: number;
    coverRandomSamplesMin: number;
    coverRandomSamplesMax: number;
    coverFallbackChance: number;
    coverImperfectChoiceChance: number;
    coverReachPenalty: number;
    coverEnemyDistWeight: number;
    coverBotDistWeight: number;
    coverGasPenalty: number;
    skill: {
        reactionMinAddSec: number;
        reactionMaxAddSec: number;
        trackingScale: number;
        baseAimErrorScale: number;
        predictionLeadScale: number;
        losGraceScale: number;
        movingAimPenaltyScale: number;
    };
};

export const BotBrainProfiles: Record<BotBrainType, BotBrainProfile> = {
    practice: {
        decisionDelayMinSec: 0.08,
        decisionDelayMaxSec: 0.22,
        rangeSlack: 3.5,
        pushExtraDist: 3,
        backOffExtraDist: 1.5,
        retreatDangerMin: 0.68,
        highDangerMin: 0.86,
        chaseTtlSec: 0.7,
        mistakeChance: 0.12,
        lootIdleDistScale: 0.8,
        lootOpportunisticDistScale: 0.65,
        objectInteractDistScale: 0.85,
        objectLootWillingness: 0.95,
        healDangerScale: 1.12,
        retreatHealDangerScale: 1.08,
        healCancelDangerScale: 1.08,
        reloadDangerMax: 0.48,
        boostQuickDangerScale: 1.1,
        boostLongDangerScale: 1.1,
        healCancelBandageFinishScale: 0.8,
        healCancelHealthkitFinishScale: 0.8,
        targetSelection: "nearest",
        targetStickinessBonus: 0,
        targetLowHealthWeight: 0,
        targetReloadBonus: 0,
        targetVisibleBonus: 0,
        coverRingSamplesMin: 2,
        coverRingSamplesMax: 3,
        coverRandomSamplesMin: 3,
        coverRandomSamplesMax: 5,
        coverFallbackChance: 0.45,
        coverImperfectChoiceChance: 0.22,
        coverReachPenalty: 260,
        coverEnemyDistWeight: 0.25,
        coverBotDistWeight: 2.6,
        coverGasPenalty: 12,
        skill: {
            reactionMinAddSec: 0.08,
            reactionMaxAddSec: 0.14,
            trackingScale: 0.74,
            baseAimErrorScale: 1.35,
            predictionLeadScale: 0.8,
            losGraceScale: 0.9,
            movingAimPenaltyScale: 1.2,
        },
    },
    realistic: {
        decisionDelayMinSec: 0.05,
        decisionDelayMaxSec: 0.15,
        rangeSlack: 2,
        pushExtraDist: 0,
        backOffExtraDist: 0,
        retreatDangerMin: 0.55,
        highDangerMin: 0.75,
        chaseTtlSec: 1.6,
        mistakeChance: 0.07,
        lootIdleDistScale: 1,
        lootOpportunisticDistScale: 1,
        objectInteractDistScale: 1,
        objectLootWillingness: 1,
        healDangerScale: 1,
        retreatHealDangerScale: 1,
        healCancelDangerScale: 1,
        reloadDangerMax: 0.36,
        boostQuickDangerScale: 1,
        boostLongDangerScale: 1,
        healCancelBandageFinishScale: 1,
        healCancelHealthkitFinishScale: 1,
        targetSelection: "nearest",
        targetStickinessBonus: 0,
        targetLowHealthWeight: 0,
        targetReloadBonus: 0,
        targetVisibleBonus: 0,
        coverRingSamplesMin: 4,
        coverRingSamplesMax: 6,
        coverRandomSamplesMin: 7,
        coverRandomSamplesMax: 10,
        coverFallbackChance: 0.12,
        coverImperfectChoiceChance: 0.08,
        coverReachPenalty: 200,
        coverEnemyDistWeight: 0.5,
        coverBotDistWeight: 2,
        coverGasPenalty: 10,
        skill: {
            reactionMinAddSec: 0.02,
            reactionMaxAddSec: 0.05,
            trackingScale: 0.94,
            baseAimErrorScale: 1.08,
            predictionLeadScale: 0.95,
            losGraceScale: 1,
            movingAimPenaltyScale: 1,
        },
    },
    competitive: {
        decisionDelayMinSec: 0,
        decisionDelayMaxSec: 0.03,
        rangeSlack: 1,
        pushExtraDist: -0.75,
        backOffExtraDist: -0.4,
        retreatDangerMin: 0.42,
        highDangerMin: 0.62,
        chaseTtlSec: 2.6,
        mistakeChance: 0,
        lootIdleDistScale: 0.9,
        lootOpportunisticDistScale: 0.75,
        objectInteractDistScale: 0.9,
        objectLootWillingness: 0.8,
        healDangerScale: 0.82,
        retreatHealDangerScale: 0.88,
        healCancelDangerScale: 0.85,
        reloadDangerMax: 0.28,
        boostQuickDangerScale: 0.9,
        boostLongDangerScale: 0.85,
        healCancelBandageFinishScale: 1.15,
        healCancelHealthkitFinishScale: 1.15,
        targetSelection: "threat_score",
        targetStickinessBonus: 14,
        targetLowHealthWeight: 0.35,
        targetReloadBonus: 18,
        targetVisibleBonus: 28,
        coverRingSamplesMin: 6,
        coverRingSamplesMax: 8,
        coverRandomSamplesMin: 9,
        coverRandomSamplesMax: 12,
        coverFallbackChance: 0,
        coverImperfectChoiceChance: 0,
        coverReachPenalty: 140,
        coverEnemyDistWeight: 0.7,
        coverBotDistWeight: 1.6,
        coverGasPenalty: 8,
        skill: {
            reactionMinAddSec: -0.015,
            reactionMaxAddSec: -0.01,
            trackingScale: 1.08,
            baseAimErrorScale: 0.82,
            predictionLeadScale: 1.05,
            losGraceScale: 1.05,
            movingAimPenaltyScale: 0.85,
        },
    },
};

export function getBotBrainProfile(brainType: BotBrainType): BotBrainProfile {
    return BotBrainProfiles[brainType];
}

export function getBotSkillProfile(
    difficulty: BotDifficulty,
    brainType: BotBrainType,
): SkillProfile {
    const base = SkillProfiles[difficulty];
    const mod = BotBrainProfiles[brainType].skill;

    return {
        reactionMinSec: math.clamp(base.reactionMinSec + mod.reactionMinAddSec, 0.03, 2),
        reactionMaxSec: math.clamp(base.reactionMaxSec + mod.reactionMaxAddSec, 0.05, 2.5),
        trackingDegPerSec: math.clamp(base.trackingDegPerSec * mod.trackingScale, 90, 900),
        baseAimErrorDeg: math.clamp(base.baseAimErrorDeg * mod.baseAimErrorScale, 0.4, 12),
        predictionLeadScale: math.clamp(
            base.predictionLeadScale * mod.predictionLeadScale,
            0,
            1.1,
        ),
        losGraceSec: math.clamp(base.losGraceSec * mod.losGraceScale, 0, 0.4),
    };
}

export function getDecisionDelaySec(brainType: BotBrainType): number {
    const profile = BotBrainProfiles[brainType];
    return util.random(profile.decisionDelayMinSec, profile.decisionDelayMaxSec);
}
