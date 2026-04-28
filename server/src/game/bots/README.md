# Bots (Current Behavior)

This describes how the **internal bots** currently behave on the server (as of 2026-04-27).

Internal bots are normal `Player` objects with `player.isAi = true` and `player.hasClient = false`, driven by `BotController`.

## Modes

### Fill mode (normal maps)
- Runs while the lobby is open (`gas.stage < 2`).
- Spawns/retires internal bots to fill lobbies while keeping join slots available.

### Wave mode (Wave map)
- Enabled by the map itself (`mapDef.isWave === true`), not by config.
- Spawns internal bots in waves from `waves.json`, and continues after lobby close.
- Gas stops advancing at stage 2 (stable ring), and faction split spawns clamp into the current safe region.
- Internal bots are forced onto **Team 2 (Blue)**; humans onto **Team 1 (Red)**.

## Targeting / Perception
- On normal maps: scans nearby players within ~`player.zoom + 6`.
- On Wave map: scans **all players** (global), so bots will walk toward humans even when they’re not locally visible yet.
- Tracks nearby players as:
  - **hostile**: enemy team/group, can attack/target.
  - **friendly**: same `groupId` (duos/squads) or same `teamId` in faction mode.
  - **ignored**: when `Config.bots.allowBotVsBot` is `false`, bots are treated as non-hostile for targeting.
  - **recent/unknown**: enemy seen/heard/damaged recently (used as a “recent threat” signal, even if no hostile is currently nearby/visible).
- Ignores for targeting:
  - Self, dead, disconnected, different layers.
  - Same `groupId` (duos/squads).
  - Same `teamId` in faction mode (Wave counts as faction teams).
- Chooses the **nearest visible (LOS)** enemy if one exists; otherwise the nearest enemy even if currently not visible.
- Tracks `lastSeenPos/lastSeenTime` when a target is visible, used for short “chase last seen” behavior after LOS is lost.
- If `Config.bots.allowBotVsBot` is `false`, bots will not target other bots (`isAi` or external `joinMsg.bot`).

## Movement
- Uses a **movement-only combat state machine** (no direct changes to aiming/shooting logic).
- Gas emergency override:
  - If in gas / outside safe zone: move toward the safe-zone center (`gas.posNew`) and disable anchoring/strafe.
- State-driven movement (when a target exists):
  - `push`: target too far → close toward weapon `idealMax`.
    - For `ar`/`lmg`/`precision`, bots only `push` when the target is outside `engageMax` (no “walk closer” once already in a shootable range).
  - `back_off`: target too close → create distance toward `idealMin`.
  - `hold_range` / `hold_position` (anchor): minimal movement in the usable band.
  - `strafe`: lateral movement in the usable band (direction flips every ~0.25–0.6s).
  - `damage_dodge` (reason): after taking damage at high HP, bots briefly strafe/back off (~0.35s) instead of full-retreating.
  - `chase_last_seen`: briefly move to `lastSeenPos` after LOS loss.
  - `retreat_heal` / `retreat_reload`: retreat while healing/reloading under threat.
    - Tries a **cover-lite** point first (nearby sampled point that blocks enemy LOS; cached ~0.75–1.5s).
    - Falls back to a diagonal/evasive retreat vector when no cover point is found.
  - `seek_cover`: same cover-lite selection, but is intentionally rare (only considered at high danger when low HP or needing reload).
- When no target: roam to a random waypoint inside the safe zone (5–10s TTL), avoiding water.
- Movement inputs are currently “grid-like” (up/down/left/right), not pathfinding.

## Aim + Shooting
- Aim updates are smoothed (deg/sec depends on difficulty) and can include simple lead prediction based on bullet speed.
- Shooting is gated by:
  - Reaction time after target acquisition.
  - Aim error threshold (`aimGateDeg`) and distance thresholds (`engageMax` / `idealMin` / `idealMax`) by weapon class.
  - Line-of-sight, with a short grace window for automatic weapons when LOS is lost.
- Weapon handling:
  - SMGs/ARs use short burst/pause patterns at longer ranges.
  - “Precision” weapons will pause movement briefly (“stop to shoot”) to build focus before firing.
  - Pistols are tap-fired (`shootStart`) instead of held.
  - Optional quick-switching is enabled for higher difficulties when `Config.bots.enableQuickSwitch` is true.
- Spread/bloom is simulated and capped to prevent rare outlier “spray everywhere” behavior.

## Item usage
- If not busy with another action:
  - Heal when `health < 60` and it’s **safe to heal**:
    - no nearby hostiles
    - no hostile currently visible (LOS)
    - and `danger < 0.35`
    - (`healthkit` > `bandage`)
  - Boost when `boost < 40`: `painkiller` > `soda`.

## Brains / Difficulty
- `practice`, `realistic`, and `competitive` share the same perception + aim/shoot systems, but differ in **movement/state selection**:
  - Range slack (how tightly they hold `idealMin..idealMax`)
  - Danger thresholds (when to retreat for heal/reload)
  - Chase TTL after LOS loss
  - Random “mistakes” (practice/realistic only)
- Difficulty still affects aim/shoot tuning (reaction time, tracking speed, base aim error, prediction/LOS grace, burst tuning).

## Known limitations (intentional for now)
- No explicit looting/pathing toward items (bots only get a starting loadout).
- Cover is **cover-lite only** (nearby point sampling + LOS check); no peeking, no pathfinding, and no multi-enemy evaluation yet.
- Bots can press reload explicitly when empty and it’s safe/out-of-range, but still rely on standard weapon behavior for most reload timing.
- No squad coordination or shared targeting.
