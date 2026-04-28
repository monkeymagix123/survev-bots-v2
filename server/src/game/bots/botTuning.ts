export const BotTuning = {
    heal: {
        lowHp: 60,
        veryLowHp: 35,
    },
    boost: {
        threshold: 50,
        veryLowBoost: 25,
    },
    danger: {
        healMax: 0.35,
        boostQuickMax: 0.5,
        boostLongMax: 0.3,
    },
    combat: {
        recentlyDamagedWindowSec: 0.45,
        damageDodgeDurationSec: 0.35,
        strafeFlipSecMin: 0.25,
        strafeFlipSecMax: 0.6,
        strafeEnableMaxDist: 18,
        strafePerpDist: 8,
        enemyVeryCloseDist: 6,
        enemyCloseDist: 10,
    },
} as const;
