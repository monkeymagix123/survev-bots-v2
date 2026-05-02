# Plans / Progress

Last updated: 2026-05-01

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
- Wave map: gas stops advancing at stage 2, and faction split spawns are clamped into the current safe region (prevents late-wave bots spawning/dying in red zone).
- Phase 2: added a movement-only combat state machine (push/hold/back off/strafe/anchor) with chase-last-seen + retreat-to-heal/reload behavior (no aim/shoot tuning changes).
- Phase 3: refined danger scoring + reduced panic retreat (short recent-damage panic, added brief damage-dodge strafe, diagonal/evasive retreat points).
- Phase 4: cover-lite point selection for retreat-like states (sample nearby points, prefer enemy LOS-blocked, cache briefly; fallback to diagonal retreat).
- Phase 5: improved movement discipline (AR/LMG/precision stop auto-closing within `engageMax`; safer healing + explicit reload when safe/out-of-range).
- Phase 5: added a `BotThreatSnapshot` (nearby hostile/friendly/ignored counts + nearest hostile distance + “recent enemy” flag) and refined healing/boosting safety gates (safe-to-heal/boost requires no hostile visible + danger below thresholds + no nearby hostiles, with thresholds centralized in `BotTuning`).
- Phase 5: extracted common bot thresholds/durations into `BotTuning` (`server/src/game/bots/botTuning.ts`).
- Phase 6: added lightweight anti-stuck navigation (blocked-goal raycasts, short detour waypoints, failed-waypoint memory, and safe fallback recovery that still respects auto-open doors).
- Phase 7: added conservative explicit looting (nearby safe-ish detours for armor/backpack/meds/ammo/clear gun upgrades, while keeping combat priority and relying on mobile auto-pickup once in range).
- Phase 8: made `practice` / `realistic` / `competitive` meaningfully distinct across decision timing, target choice, cover-lite quality, range control, loot willingness, item discipline, and aim-skill modifiers layered on top of base difficulty.
- Phase 9: added a stability pass for bot state selection (brief retreat/chase/loot commitment windows plus range hysteresis) so bots thrash less and retreat/cover behavior is more consistent before any future tuning/search work.
- Follow-up polish after Phase 9: removed bot precision stop-to-focus, added structured bot stability file logging (`debugBotStability`), blocked bot gunfire inputs while starting/channeling heal or boost items, and softened passive anchor into light strafe when LOS is weak or the bot is not yet ready to fire.
- Added practical loot-object interaction: bots can now melee-break nearby worthwhile loot obstacles, explicitly use nearby manual doors/buttons that unblock route or local loot access, and back off that behavior quickly when danger rises.
- Fixed a strict TypeScript issue in client zoom radius handling (`Object.values` typing).

## In Progress
- Manual sanity testing: join/leave during lobby window, verify bots retire to make room, verify no match-end spam (incl Plan 3 gunplay).
- Phase 1 parity verification: enable `Config.bots.debugParity` and check for `[bots][parity]` mismatches (remove legacy comparator after).

## Next
- Duo/squad bot pairing (spawn in pairs and avoid friendly fire); coordination/shared targets later.
- Players-vs-bots mode toggle + tuning of heal thresholds, strafing, and quickswitch behavior.
- Additional bot stability instrumentation / events as needed (`stuck_repath`, fallback, loot commit) if manual spectate debugging still feels too opaque.
