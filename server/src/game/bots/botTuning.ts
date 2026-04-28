export const BotTuning = {
    heal: {
        lowHp: 60,
        veryLowHp: 35,
        safeDangerMax: 0.35,
    },
    boost: {
        threshold: 50,
        veryLow: 25,
        safeDangerQuickMax: 0.5,
        safeDangerLongMax: 0.3,
    },
    combat: {
        recentlyDamagedWindowSec: 0.45,
        damageDodgeDurationSec: 0.35,
        strafeFlipSecMin: 0.25,
        strafeFlipSecMax: 0.6,
        strafeEnableMaxDist: 18,
        strafePerpDist: 8,
    },
} as const;
