# Status

Short snapshot of current bot work.

Last updated: 2026-05-31

## Current State

- Core internal bot system is in place and actively usable.
- Armed bots use the main controller path.
- Unarmed bots now use a dedicated brain plus a dedicated input/controller path.
- Nearby looting, loot-object interaction, anti-stuck navigation, and cover-lite behavior are all implemented.
- Bots now better reject bad object targets and reposition more often on blocked LOS.
- Navigation has started getting environment-aware handling for container exits, warehouse openings, and large wall blockers.
- Simple warehouse entry has been manually sanity-checked and now crosses the opening threshold instead of stalling outside.
- The live bot path no longer carries the old parity-comparison overhead.

## Current Focus

- Stability / sanity testing
- Low-risk hot-path cleanup
- Unarmed behavior polish
- Navigation / movement correctness
- Keeping armed vs unarmed controller logic cleanly separated
- Practical object/LOS behavior polish
- Layered decision-model sanity testing

## Recent Changes

- Separated unarmed final input generation from `BotController`
- Improved `melee_break` approach and reach handling
- Stopped window-breaking and added blocked-object rejection / blocker redirection
- Gated armored / stone-plated break targets behind appropriate melee weapon capability
- Made heal cancellation less wasteful for committed medkits and moving retreat bandages
- Softened armed-bot danger/heal pressure against lone visibly unarmed hostiles
- Improved repositioning when combat LOS is blocked
- Added first-pass structured navigation for containers, simple warehouses, and large wall blockers
- Tightened warehouse entry so bots step through the opening rather than hovering outside it
- Added a short warehouse-transition commitment so bots are less likely to oscillate back and forth right on the entrance threshold
- Added a first exterior building-corner detour pass so pursuit around structure shells is less dependent on tiny left/right local detours
- Smoothed visible automatic-weapon spray so AR/SMG/LMG fire no longer snaps between fresh random angles every shot
- Fixed a melee-break edge case where bots could stand next to a crate without punching because the range check used stale facing
- Added a tiny configurable melee-break swing-plant window so crate punches read more cleanly, with tuning available if that pause feels too risky
- Tightened heal/boost start logic so bots are less likely to instantly med the moment LOS briefly breaks during an active fight
- Tightened armed blocked-LOS behavior so recent enemy pressure keeps bots in reposition/combat mode instead of letting nearby loot/object logic steal the turn
- Added stair-transition routing so tunnel/greenhouse-style surface-vs-underground movement is less likely to stall at the opening
- Added simple auto-door building entry/exit routing so practical buildings like greenhouses are less likely to cause outside-target oscillation
- Moved bot debug logging into per-game `server/logs/<game-create-time>_<game-id>/` folders instead of writing a single shared console/file stream
- Added chosen target/item ids plus final goal position to combat/stability bot logs
- Added short unarmed recent-pressure memory before bots resume loot/object farming
- Switched bot minimap debug positions over to the faction-style player-status path so large bot counts are no longer limited by the generic map-indicator cap
- Added a distinct blue bot debug marker so solo-mode minimap testing is easier to visually confirm
- Fixed solo-mode bot debug positions not appearing by enabling player-status ticking for that debug path
- Added unarmed crowd/armed-density scoring so retreat/wander/cover goals spread away from local clusters instead of all collapsing toward the same “safe” building/cover area
- Removed the remaining safe-zone center bias from general waypoint picking, so bots now prefer nearby/regional crates, buildings, and spread-out roam points while inside the safe zone
- Added regional waypoint crowd scoring so general roaming is less likely to collapse large groups into the same pocket of cover/buildings
- Added explicit zone-style building/region ranking plus longer zone waypoint TTLs, so bots can commit to a chosen area, take only small safe loot detours, and then resume the same broader destination
- Expanded combat/stability logs with macro-goal, zone/building, subgoal, resumability, and zone-position fields so it is easier to tell whether the chosen broader objective was good
- Added the first explicit layered decision pass:
  - emergency / macro / tactical context is now tracked separately
  - `gas_escape` now overrides first and forces tactical `move_to_safe_zone`
  - logs now split `macroReason` and `tacticalReason`
- Added a follow-up tightening pass for that layered model:
  - zone-style macro goals now keep a short commitment lock
  - travel / safe-zone tactical goals now keep short locks
  - `move_to_safe_zone` now refers to broader safe-zone progress, while `move_to_safe_position` covers safer local fallback movement
  - far visible melee-only pressure no longer interrupts unarmed loot-zone commitment as aggressively
  - tactical goals now always fall back to a defined value
- Added another practical navigation pass:
  - local orbit detours around stones/trees and similar blockers
  - stricter building entry/exit routing so walls/windows are less likely to be treated as openings
  - slightly more forgiving stair-opening candidate sampling
- Tightened structure navigation against actual server semantics:
  - tunnel/stair routing now explicitly follows the server’s `0 ↔ 1` connector model
  - building transitions now use real door objects
  - manual unlocked doors can now be approached and actively used during enter/exit routing
  - door candidates are filtered to doors the server would actually let a player traverse without breaking
  - tactical logs can now distinguish `enter_tunnel` / `exit_tunnel` / `enter_building` / `exit_building`
- Added a first real interior-building traversal pass so blocked same-building / same-structure routes can follow a lightweight unlocked-door graph toward another interior point instead of treating room-to-room travel as a dead end
- Manual interior-door travel now shows up as `use_door` in tactical logging when that is the practical next step
- Tightened manual-door approach movement so bots use a smaller door-use arrival/deadzone window and are less likely to stall just outside the doorway
- Late gas rotation now aims for a practical near-edge safe entry point instead of the exact next-circle center
- Hard-stuck bots now explicitly reset route state and pick a fresh zone/safe goal instead of grinding the same failed path forever
- Armed bots now force-equip a real gun under active threat if they are still on melee/fists after arming up
- Perception scans now reuse a real short TTL cache, and loot/object scorers now also cache short-lived “no target found” results
- Bot-manager hot paths now do less repeated work, and debug bot logs no longer use synchronous append writes
- Added short-lived loot/object selection caches plus failed-target cooldowns to reduce repeated retry loops
- Centralized armed tactical danger/threat derivation into a shared helper
- Added small perception/nav reuse so bots do less repeated target-scan and route-trace work
- Added a short navigation-side commitment so bots are less likely to hover while re-picking left/right around the same blocker
- Made unarmed bots react more reliably to very close melee pressure
- Stopped route-blocker redirects from choosing explosive props like oil barrels
- Made unarmed bots less likely to idle at short range from another visible unarmed hostile
- Made normal-mode idle roaming more local/interesting so bots spread less by all collapsing toward the same safe-zone area
- Fixed an idle-roam bug where bots could keep a completed waypoint until TTL expiry and stand still doing nothing
- Fixed an armed-bot bug where temporary crate-punching could leave them stuck on fists afterward
- Kept docs aligned with the new primary/details/status structure

## Next Likely Work

- Container/building-edge pursuit fixes for armed bots
- More practical stair/building entry-exit sanity testing
- Broader building navigation beyond doorway routing
- Better room preference / room choice inside larger buildings
- More anti-oscillation work for unarmed movement
- Manual sanity checks for the new layered decision model and `gas_escape` override path
- Replay-driven sanity checks for late gas rotation, hard-stuck recoveries, and weapon-ready-but-no-fire bots
- If wave-map CPU is still heavy after this, the next likely optimization is reducing full-player scans there — but that one can slightly change long-range awareness / wave behavior, so it deserves a deliberate follow-up pass
- Manual spectate tuning
- Duo/squad behavior
- Additional debug/stability events if needed
