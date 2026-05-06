# Plans / Progress

Authoritative progress log for the bot work.

Last updated: 2026-05-05

## Done

- Replaced the old ad hoc bot injection with a first-class internal bot system built around `BotManager` and `BotController`.
- Added `Config.bots` plus `survev-config.json` overrides.
- Added bot brain mix (`practice` / `realistic` / `competitive`) and kept `difficulty` as the base mechanical layer.
- Added `Config.bots.giveStartingWeapons` so bots can optionally start unarmed.
- Added Wave-map bot support with faction split behavior and map-driven wave lifecycle.
- Refactored bot AI into systems:
  - brains
  - perception
  - aim
  - weapon logic
  - navigation
  - scoring/helpers
- Added movement-state combat behavior:
  - push / back off / hold / strafe
  - chase last seen
  - retreat heal / retreat reload
  - seek cover
- Added danger scoring, damage-dodge, and safer heal/boost/reload gating.
- Added `BotTuning` centralization for important shared thresholds/timers.
- Added cover-lite local sampling for retreat-like behavior.
- Added lightweight anti-stuck navigation:
  - blocked-goal raycasts
  - detour waypoints
  - failed-waypoint memory
  - fallback recovery
- Added conservative nearby looting with explicit loot scoring.
- Added bot-type differentiation across:
  - decision timing
  - target choice
  - range discipline
  - cover quality
  - item discipline
  - loot willingness
  - aim modifiers
- Added stability improvements:
  - range hysteresis
  - short state commitment windows
  - weaker passive anchoring
  - better heal cancel timing
- Added practical object interaction:
  - melee-break nearby loot obstacles
  - use nearby manual doors/buttons when clearly helpful
- Added hostile weapon memory and distracted-hostile heuristics for unarmed decision-making.
- Added a dedicated internal `UnarmedBotBrain`.
- Added a dedicated `UnarmedBotInputController`, so unarmed final input generation is now separated from the main armed controller path.
- Added a shared `botControllerShared` helper layer so common target/object/loot/melee/support-item behavior stays aligned between armed and unarmed controller paths.
- Updated melee-break behavior so bots:
  - approach obstacle edges instead of centers
  - use object-specific arrival thresholds
  - use actual melee-def geometry (`attack.offset` + `attack.rad`) for break reach
- Tightened practical object behavior:
  - bots no longer break windows for loot
  - bots now respect melee armor/stone-piercing when choosing plated break targets
  - bots reject loot objects that are blocked behind obvious walls/building separation
  - unarmed bots can redirect to a destructible route-blocker when it directly gates access to the desired object
- Refined healing/item-discipline behavior:
  - healthkits are less likely to be canceled late and downgraded into bandages
  - moving retreat bandages are less likely to be canceled if the bot is still working around cover
- Refined armed-vs-unarmed danger handling:
  - armed bots now treat lone visibly unarmed hostiles as less dangerous for danger/heal calculations unless they get close or show gun evidence
- Improved blocked-LOS combat behavior so armed bots reposition instead of passively holding some obscured shots.
- Added bot stability logging.
- Finished a low-behavior-shift optimization pass:
  - removed the legacy parity-comparison path from live bot updates
  - added short-lived loot/object selection caches
  - added brief failed-target cooldowns to reduce loot/object retry loops
  - centralized shared armed tactical snapshot logic for danger/threat derivation
  - added light same-tick/local reuse in perception and navigation for repeated scans/traces

## In Progress

- Manual sanity testing:
  - lobby fill/retire
  - wave behavior
  - loot/object interaction
  - unarmed bot behavior with `giveStartingWeapons=false`
- Started a more structured navigation pass:
  - bots inside containers can now route toward an exit instead of driving straight into the container shell
  - bots can now route into and out of simple warehouses through their large side openings, with entry targeting pushed inside the threshold
  - large indestructible wall blockers now bias navigation toward sliding/peeling off the wall instead of sitting on it
- Ongoing cleanup of shared vs specialized controller logic now that unarmed input has been split out.

## Next

- Duo/squad bot pairing and friend-aware coordination.
- Players-vs-bots mode / tuning pass.
- More stability telemetry if spectate debugging still needs it:
  - stuck re-path
  - fallback activation
  - loot commit
  - object commit
- Continued cleanup of remaining shared bot-controller code into clearer common helpers where useful.

## Guardrails

- Prefer simple local decisions over global planning.
- Do not use tuning to hide logic bugs.
- Keep behavior predictable and debuggable.
- Expand scope gradually:
  - nearby
  - local
  - then broader planning only if needed
