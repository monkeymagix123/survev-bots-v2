# Status

Short snapshot of current bot work.

Last updated: 2026-05-03

## Current State

- Core internal bot system is in place and actively usable.
- Armed bots use the main controller path.
- Unarmed bots now use a dedicated brain plus a dedicated input/controller path.
- Nearby looting, loot-object interaction, anti-stuck navigation, and cover-lite behavior are all implemented.
- Bots now better reject bad object targets and reposition more often on blocked LOS.
- Navigation has started getting environment-aware handling for container exits and large wall blockers.

## Current Focus

- Stability / sanity testing
- Unarmed behavior polish
- Keeping armed vs unarmed controller logic cleanly separated
- Practical object/LOS behavior polish

## Recent Changes

- Separated unarmed final input generation from `BotController`
- Improved `melee_break` approach and reach handling
- Stopped window-breaking and added blocked-object rejection / blocker redirection
- Improved repositioning when combat LOS is blocked
- Added first-pass structured navigation for containers and large wall blockers
- Kept docs aligned with the new primary/details/status structure

## Next Likely Work

- Manual spectate tuning
- Duo/squad behavior
- Additional debug/stability events if needed
