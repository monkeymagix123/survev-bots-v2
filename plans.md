# Plans / Progress

Last updated: 2026-04-25

## Done
- Replaced the old `PlayerBarn.addPlayer()` bot-injection hack with a first-class internal bot system (`BotManager` + `BotController`).
- Added `Config.bots` (fill/retire + difficulty tiers) with overrides via `survev-config.json`.
- Added `Config.bots.brainMix` (practice/realistic/competitive) and per-bot brain sampling (Phase 1, behavior-preserving).
- Added `Player.isAi` + `Player.hasClient` and updated server loops to avoid sending/closing sockets for internal bots.
- Implemented lobby bot fill/retire that accounts for pending join tokens + avoids retiring bots in a way that would instantly end the match.
- Fixed mobile auto-pickup free-slot logic (helps bots/players pick up first gun correctly).
- Added bot-only starting loadout: internal bots spawn with random guns picked from the current map loot tiers.
- Added player starting loadout (when `Config.bots.enabled`): websocket players start with `mosin` + `spas12` equipped so they can fight immediately.
- Fixed bot over-spawning: internal bots no longer "respawn" endlessly when bots kill each other (fill now caps total internal bots for the match).
- Bots have weapon-specific shooting profiles; snipers pause; AR bursts; SMGs spray with bloom.
- Capped bot bloom + truncated per-shot aim noise to prevent rare “random spraying” (esp. visible in spectate on pistols like `ot38`).
- Fixed spectate edge case where a spectated player is retired/removed (`destroy()` without `dead`).
- Refactored bot AI into Phase 1 architecture (brains + perception/aim/weapon/navigation systems) without changing behavior.
- Implemented Wave map-driven wave mode (`mapDef.isWave`) as a 2-team faction match: humans on Team 1 (Red), bots on Team 2 (Blue).
- Removed `Config.bots.mode`; wave mode is now selected by the Wave map itself and force-enables internal bots on that map (still respects `Config.bots.minHumansToEnable` to prevent bot-only games).
- Wave map lifecycle: game starts with 1 connected human; match only ends when all humans are dead/disconnected (clearing a wave no longer ends the match).
- Wave map UI/data: bots are always visible on minimap/big map; bots don’t consume human join slots (join cutoff still uses `gas.stage < 2`).
- Added `GameMap.isFactionPvp` to keep faction teams without inheriting 50v50-only terrain + mechanics (special faction rivers/bridges, special airdrop, lone survivr).
- Fixed a strict TypeScript issue in client zoom radius handling (`Object.values` typing).

## In Progress
- Manual sanity testing: join/leave during lobby window, verify bots retire to make room, verify no match-end spam (incl Plan 3 gunplay).
- Phase 1 parity verification: enable `Config.bots.debugParity` and check for `[bots][parity]` mismatches (remove legacy comparator after).

## Next
- Phase 2: range-based movement + reload/heal retreat + better LOS reacquire/angle seeking.
- Explicit bot looting (waypointing toward nearby loot / weapon upgrades).
- Duo/squad bot pairing (spawn in pairs and avoid friendly fire); coordination/shared targets later.
- Players-vs-bots mode toggle + tuning of heal thresholds, strafing, and quickswitch behavior.
