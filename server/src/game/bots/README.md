# Bots (Current Behavior)

This describes how the **internal bots** currently behave on the server (as of 2026-04-25).

Internal bots are normal `Player` objects with `player.isAi = true` and `player.hasClient = false`, driven by `BotController`.

## Modes

### Fill mode (normal maps)
- Runs while the lobby is open (`gas.stage < 2`).
- Spawns/retires internal bots to fill lobbies while keeping join slots available.

### Wave mode (Wave map)
- Enabled by the map itself (`mapDef.isWave === true`), not by config.
- Spawns internal bots in waves from `waves.json`, and continues after lobby close.
- Internal bots are forced onto **Team 2 (Blue)**; humans onto **Team 1 (Red)**.

## Targeting / Perception
- Scans nearby players within ~`player.zoom + 6`.
- Ignores:
  - Self, dead, disconnected, different layers.
  - Same `groupId` (duos/squads).
  - Same `teamId` in faction mode (Wave counts as faction teams).
- Chooses the **nearest visible (LOS)** enemy if one exists; otherwise the nearest enemy even if currently not visible.
- If `Config.bots.allowBotVsBot` is `false`, bots will not target other bots (`isAi` or external `joinMsg.bot`).

## Movement
- Goal selection:
  - If in gas / outside safe zone: move toward the safe-zone center (`gas.posNew`).
  - If a target exists: move toward the target’s position.
  - Otherwise: roam to a random waypoint inside the safe zone (5–10s TTL), avoiding water.
- Strafing:
  - If a target exists and is close (< ~18 units) and it’s not a gas emergency, bots strafe perpendicular to their aim direction.
  - Strafe direction flips every ~0.25–0.6s.
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
  - Heal when `health < 60`: `healthkit` > `bandage`.
  - Boost when `boost < 40`: `painkiller` > `soda`.

## Brains / Difficulty
- `practice`, `realistic`, and `competitive` brains are currently behavior-preserving (same decision logic) — the main differences today come from difficulty tuning.
- Difficulty affects reaction time, tracking speed, base aim error, and prediction/LOS grace tuning.

## Known limitations (intentional for now)
- No explicit looting/pathing toward items (bots only get a starting loadout).
- No cover seeking / retreat logic / reload discipline beyond basic weapon gating.
- No squad coordination or shared targeting.

