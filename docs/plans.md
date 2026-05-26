# Plans / Progress

Authoritative progress log for the bot work.

Last updated: 2026-05-26

## Done

- Replaced the old ad hoc bot injection with a first-class internal bot system built around `BotManager` and `BotController`.
- Added `Config.bots` plus `survev-config.hjson` overrides.
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
- Added a small nav anti-oscillation pass:
  - detours now keep a short blocker-side commitment
  - large-wall slide choices now prefer staying on the same chosen side briefly
- Tightened two practical edge cases:
  - unarmed bots now back off under very close melee pressure instead of face-hugging
  - route-blocker redirection now ignores explosive props like oil barrels
- Refined unarmed visible-melee behavior so bots keep moving toward nearby loot or disengage instead of idling at a short distance
- Improved normal-mode idle spread:
  - roaming now prefers nearby loot-bearing destructible objects
  - otherwise it biases toward nearby buildings before generic random local roam
- Fixed a real idle-roam stall:
  - completed waypoints are now refreshed immediately instead of being kept until TTL expiry
- Fixed armed melee-break recovery:
  - bots now remember and restore a gun slot after temporarily equipping fists for crate breaking
- Reduced warehouse doorway oscillation:
  - warehouse enter/exit routing now keeps a short committed opening target so bots do not immediately flip direction at the threshold
- Added the next practical exterior-nav step:
  - when a pursuit route is blocked by a building child obstacle and both bot/goal are outside, nav now tries exterior building-corner detours before tiny generic sidesteps
- Smoothed automatic-weapon visible aim:
  - AR/SMG/LMG spray now keeps a short persistent offset instead of snapping to a fresh random visible angle every shot
- Fixed a melee-break stall:
  - crate/object punch checks now use intended same-tick aim direction instead of stale previous-tick facing
- Added configurable melee-break swing planting:
  - crate punches can briefly plant via `BotTuning.objectInteract.meleeSwingStopSec`, with `0` available as a no-stop option
- Tightened support-item start discipline:
  - heal/boost starts now also respect short recent-enemy pressure memory instead of only current visibility plus direct recent damage
- Tightened blocked-LOS combat discipline:
  - recent-enemy pressure now also suppresses opportunistic loot/object branches right after LOS breaks, so armed bots keep repositioning more reliably around blockers like trees
- Extended structured navigation again:
  - stair-linked structures now get explicit surface/underground transition routing
  - simple auto-door buildings now get practical enter/exit routing for nearby outside/inside goals
- Moved bot debug logs into per-game folders under `server/logs/<game-create-time>_<game-id>/`, with `bot-combat.log` and `bot-stability.log` written beside each other
- Expanded bot debug logs so combat/stability entries now include the selected target/item ids and final goal position
- Added short unarmed recent-pressure memory before resuming loot/object farming, to reduce immediate bounce-back onto the same goal after visible pressure
- Added unarmed crowd/armed-density goal scoring so visible enemies behave more like repulsors and unarmed retreat/wander/cover goals spread away from local clusters unless nearby gun loot is worth contesting
- Removed the remaining safe-zone center-magnet roaming bias and added regional waypoint crowd scoring, so general bot wandering now prefers nearby/regional crates and buildings over collapsing toward the exact safe-zone center
- Added zone-style regional waypoint ranking and longer waypoint commitment, so bots can head toward a chosen building/area, grab only small safe loot detours on the way, and then resume the broader zone goal
- Expanded bot debug logs with broader decision context (`macroGoal`, zone/building ids, zone score, subgoal, resumability, and zone positions) so it is easier to judge whether a chosen goal was actually sensible
- Added the first explicit layered decision pass:
  - emergency / macro / tactical context is now tracked separately
  - `gas_escape` now overrides first and forces tactical `move_to_safe_zone`
  - tactical-goal legality is now checked against the current macro goal
  - logs now split `macroReason` and `tacticalReason`
- Tightened that layered pass further:
  - zone-style macro goals now keep a short explicit lock
  - travel / safe-zone tactical goals now keep short explicit locks
  - `move_to_safe_zone` is now reserved for broader safe-zone routing, while `move_to_safe_position` covers safer local fallback routes during disengage/heal behavior
  - unarmed recent-pressure memory now ignores weak far-visible melee-only pressure more often, so committed loot-zone travel is less likely to be interrupted for bad reasons
  - tactical goals now always fall back to a defined value
- Added `Config.bots.debugMapIndicators` so bot positions can be shown through the faction-style player-status/minimap-position path during debugging, with a distinct blue bot marker

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
- Continued practical structure navigation:
  - greenhouse/tunnel-style stair openings now have explicit transition routing
  - practical auto-door buildings now have lightweight entry/exit routing
- Ongoing cleanup of shared vs specialized controller logic now that unarmed input has been split out.
- Manual sanity-checking of the new layered decision model is still useful:
  - emergency / macro / tactical logs
  - `gas_escape` behavior
  - `move_to_safe_zone` routing

## Next

- Duo/squad bot pairing and friend-aware coordination.
- Players-vs-bots mode / tuning pass.
- More stability telemetry if spectate debugging still needs it:
  - stuck re-path
  - fallback activation
  - loot commit
  - object commit
- Continued cleanup of remaining shared bot-controller code into clearer common helpers where useful.
- Keep the layered macro/tactical refactor incremental:
  - preserve current feel first
  - then tighten commitment/interruption rules once the logs confirm the structure is behaving sensibly

## Guardrails

- Prefer simple local decisions over global planning.
- Do not use tuning to hide logic bugs.
- Keep behavior predictable and debuggable.
- Expand scope gradually:
  - nearby
  - local
  - then broader planning only if needed
