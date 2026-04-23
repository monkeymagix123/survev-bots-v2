# Plans / Progress

Last updated: 2026-04-23

## Done
- Replaced the old `PlayerBarn.addPlayer()` bot-injection hack with a first-class internal bot system (`BotManager` + `BotController`).
- Added `Config.bots` (fill/retire + difficulty tiers) with overrides via `survev-config.json`.
- Added `Player.isAi` + `Player.hasClient` and updated server loops to avoid sending/closing sockets for internal bots.
- Implemented lobby bot fill/retire that accounts for pending join tokens + avoids retiring bots in a way that would instantly end the match.
- Fixed mobile auto-pickup free-slot logic (helps bots/players pick up first gun correctly).
- Added bot-only starting loadout: internal bots spawn with random guns picked from the current map loot tiers.
- Added player starting loadout (when `Config.bots.enabled`): websocket players start with `mosin` + `spas12` equipped so they can fight immediately.
- Fixed bot over-spawning: internal bots no longer "respawn" endlessly when bots kill each other (fill now caps total internal bots for the match).

## In Progress
- Manual sanity testing: join/leave during lobby window, verify bots retire to make room, verify no match-end spam.

## Next
- Explicit bot looting (waypointing toward nearby loot / weapon upgrades).
- Duo/squad bot pairing (spawn in pairs and avoid friendly fire); coordination/shared targets later.
- Players-vs-bots mode toggle + tuning of heal thresholds, strafing, and quickswitch behavior.
