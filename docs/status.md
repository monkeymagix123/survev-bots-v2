# Status

Short snapshot of current bot work.

Last updated: 2026-05-05

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
- Added short-lived loot/object selection caches plus failed-target cooldowns to reduce repeated retry loops
- Centralized armed tactical danger/threat derivation into a shared helper
- Added small perception/nav reuse so bots do less repeated target-scan and route-trace work
- Kept docs aligned with the new primary/details/status structure

## Next Likely Work

- Manual spectate tuning
- Duo/squad behavior
- Additional debug/stability events if needed
