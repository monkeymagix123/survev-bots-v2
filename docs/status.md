# Status

Short snapshot of current bot work.

Last updated: 2026-05-25

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
- Added unarmed crowd/armed-density scoring so retreat/wander/cover goals spread away from local clusters instead of all collapsing toward the same “safe” building/cover area
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
- More anti-oscillation work for unarmed movement
- Manual spectate tuning
- Duo/squad behavior
- Additional debug/stability events if needed
