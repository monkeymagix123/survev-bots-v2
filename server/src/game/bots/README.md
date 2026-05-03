# Bots (Current Behavior)

This describes how the **internal bots** currently behave on the server (as of 2026-05-02).

Internal bots are normal `Player` objects with `player.isAi = true` and `player.hasClient = false`, driven by `BotController`.

## Config Notes
- `Config.bots.giveStartingWeapons` / `survev-config.json -> bots.giveStartingWeapons` controls whether internal bots spawn with the current random starting gun loadout.
- When `true`, bots can fight immediately after spawning.
- When `false`, bots start with normal empty gun slots and must loot/find weapons first.

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
  - **recent/unknown**: enemy seen/damaged recently (used as a short “recent threat” signal even if no hostile is currently nearby/visible).
- Ignores for targeting:
  - Self, dead, disconnected, different layers.
  - Same `groupId` (duos/squads).
  - Same `teamId` in faction mode (Wave counts as faction teams).
- Chooses the **nearest visible (LOS)** enemy if one exists; otherwise the nearest enemy even if currently not visible.
- `competitive` bots upgrade this slightly: they still prefer visible nearby enemies, but also bias toward low-health / reloading targets and keep a bit more target stickiness.
- Bots keep a small hostile-weapon memory:
  - if a visible hostile ever shows a gun, bots remember that hostile as gun-capable for the rest of that life,
  - if a visible hostile appears truly unarmed, unarmed bots treat them as much less threatening,
  - if a visible armed hostile is actively shooting near another non-friendly player, bots may treat them as temporarily distracted.
- Tracks `lastSeenPos/lastSeenTime` when a target is visible, used for short “chase last seen” behavior after LOS is lost.
- If `Config.bots.allowBotVsBot` is `false`, bots will not target other bots (`isAi` or external `joinMsg.bot`).

## Movement
- Uses a **movement-only combat state machine** (no direct changes to aiming/shooting logic).
- Gas emergency override:
  - If in gas / outside safe zone: move toward the safe-zone center (`gas.posNew`) and disable anchoring/strafe.
- Navigation is still **lightweight** (not full pathfinding), but bots now:
  - raycast movement goals for simple blockers,
  - treat closed auto-open doors as passable,
  - explicitly use nearby manual doors/buttons when they directly unblock the current route or immediate loot access,
  - pick short-lived detour waypoints around rocks/walls,
  - and fall back to a safe waypoint / `gas.posNew` if they stay stuck too long.
- State-driven movement (when a target exists):
  - `interact_object`: short nearby object-interaction goal for either:
    - melee-breaking a worthwhile loot obstacle, or
    - using a manual door/button that directly helps route or immediate loot access.
  - `push`: target too far → close toward weapon `idealMax`.
    - For `ar`/`lmg`/`precision`, bots only `push` when the target is outside `engageMax` (no “walk closer” once already in a shootable range).
  - `back_off`: target too close → create distance toward `idealMin`.
  - `hold_range` / `hold_position` (anchor): minimal movement in the usable band.
    - If LOS is weak or the bot is not ready to fire yet, anchor can soften into light strafe instead of pure standing still.
  - `strafe`: lateral movement in the usable band (direction flips every ~0.25–0.6s; see `BotTuning`).
  - `damage_dodge` (reason): after taking damage at high HP, bots briefly strafe/back off (~0.35s; see `BotTuning`) instead of full-retreating.
  - `chase_last_seen`: briefly move to `lastSeenPos` after LOS loss.
  - `retreat_heal` / `retreat_reload`: retreat while healing/reloading under threat.
    - Tries a **cover-lite** point first (nearby sampled point that blocks enemy LOS; cached ~0.75–1.5s).
    - Falls back to a diagonal/evasive retreat vector when no cover point is found.
  - `seek_cover`: same cover-lite selection, but is intentionally rare (only considered at high danger when low HP or needing reload).
- Phase 9 stability pass:
  - small range hysteresis reduces `push`/`back_off` oscillation near distance thresholds,
  - retreat / chase-last-seen / loot states now briefly commit so bots do not thrash between states every re-decision,
  - cover-lite stays cached during that short commitment window, which makes retreat behavior look more deliberate,
  - and passive anchor states can soften into light strafe when LOS is weak or the bot is not yet ready to fire.
- When no target: roam to a random waypoint inside the safe zone (5–10s TTL), avoiding water.
- Movement inputs are still “grid-like” (up/down/left/right), with one-hop detours only (no A* / interior solver).
- Cover quality now varies by brain type: `practice` samples less and falls back more often, `realistic` is imperfect on purpose, and `competitive` gets the strongest cover-lite scoring.

## Aim + Shooting
- Aim updates are smoothed and can include simple lead prediction based on bullet speed.
- Mechanical aim still starts from `difficulty`, but `brainType` now layers on modifiers too:
  - `practice`: slower reaction/tracking, more error, weaker lead
  - `realistic`: close to the base difficulty, with a little human-like delay/imprecision
  - `competitive`: slightly faster/tighter than the same base difficulty alone
- Shooting is gated by:
  - Reaction time after target acquisition.
  - Aim error threshold (`aimGateDeg`) and distance thresholds (`engageMax` / `idealMin` / `idealMax`) by weapon class.
  - Line-of-sight, with a short grace window for automatic weapons when LOS is lost.
- Weapon handling:
  - SMGs/ARs use short burst/pause patterns at longer ranges.
  - “Precision” weapons no longer stop in place to build focus; bots keep moving while taking the shot opportunity.
  - Pistols are tap-fired (`shootStart`) instead of held.
  - Optional quick-switching is enabled for higher difficulties when `Config.bots.enableQuickSwitch` is true.
- Spread/bloom is simulated and capped to prevent rare outlier “spray everywhere” behavior.

## Debugging
- Optional bot stability logging can be enabled in config `debugBotStability=true`.
- Log output in `server/logs/bot-stability.log`.
- Each log line stays structured JSON, but now also includes a short `summary` field for easier tailing.
- Current events include combat `state_change`, mid-heal `heal_cancel`, and passive `idle_reason` entries such as `no_goal`, `idle_anchor`, and `weak_los_anchor`.

## Item usage
- If not busy with another action:
  - Heal when `health < 60` and it’s **safe to heal**:
    - normal heal gate: no hostile currently visible (LOS), not recently damaged, no nearby hostile within ~10 units, and `danger < 0.35` (see `BotTuning`)
    - retreat-like states (`retreat_heal` / `seek_cover`) are only a relaxed gate, not automatic safety: still requires no hostile currently visible, not recently damaged, no very close hostile within ~6 units, and `danger < 0.45`
    - if healing has already started and a hostile becomes visible / very close, bots will usually cancel the heal; if the item is almost finished, they try to keep moving toward safety and let it complete
    - bots no longer send gunfire inputs while starting or channeling heal/boost item use
    - player gunfire still cancels item actions through the normal weapon fire path; the bot-specific fix is that bots no longer request gunfire while using items
    - item preference:
      - `health < 35`: `healthkit` > `bandage`
      - `35 ≤ health < 60`: `bandage` > `healthkit` (faster)
  - Boost when `boost < 50` and it’s safe to boost (no hostile currently visible + not recently damaged):
    - “quick” boost (usually `soda`) requires `danger < 0.5` and no nearby hostile within ~6 units
    - “long” boost (`painkiller`) requires `danger < 0.3` and no nearby hostile within ~10 units
    - if `boost < 25`, prefers `painkiller` when “long” boost is safe
    - otherwise prefers `soda` when “quick” boost is safe

## Looting
- Bots still rely on mobile auto-pickup once they reach loot; Phase 7 adds **explicit nearby loot pathing**.
- Loot detours are conservative:
  - when no enemy is active: bots may path to nearby useful loot
  - when LOS is lost: bots may take a **short** detour if danger is low
  - bots do **not** abandon visible / close combat to chase loot
- Bots can also opportunistically interact with nearby **loot-bearing obstacles**:
  - break nearby destructible crates/loot props with melee when safe-ish and worthwhile,
  - use nearby manual doors/buttons when they directly unblock movement or immediate loot access,
  - and drop that behavior quickly if danger rises, a target becomes visible, or the bot is damaged.
- When bots are **unarmed** (no gun in primary/secondary), they use a dedicated internal unarmed brain:
  - loose guns get first priority,
  - otherwise they prefer nearby loot-dropping obstacles / practical interactions over passive wandering,
  - visible armed hostiles make them cautious, but visible unarmed hostiles or distracted armed hostiles still allow more crate-breaking than the normal armed brain would.
- Practical limits for this phase:
  - manual doors only when they are actually closed/usable,
  - buttons only when they appear to unlock a nearby relevant door,
  - no general puzzle solving, no sequence inference, and no room-clearing behavior yet.
- Brain type now affects loot willingness too: `practice` takes the shortest/simplest loot detours, `realistic` uses the baseline behavior, and `competitive` is a bit less willing to drift for loot during combat-adjacent situations.
- Priority order for explicit detours:
  - if unarmed, nearby loose guns get a strong temporary priority boost so bots arm up before over-valuing armor/meds
  - armor / helmet upgrades
  - backpack upgrades
  - meds / boosts when reserves are low
  - ammo for currently held guns
  - clearly better guns (including safe fill of an empty gun slot)
- Breakable-object looting is intentionally weaker than loose-loot looting, and it scales down as the bot already has stronger weapons, better armor/backpack, and healthier reserves.
- Gun upgrades are intentionally coarse: bots only chase guns that are meaningfully better than what they already have, and will pre-equip the intended slot before pickup if they plan to replace a weapon.

## Brains / Difficulty
- `difficulty` is still the **base mechanical skill** layer: reaction time, tracking speed, base aim error, prediction/LOS grace, and burst tuning.
- `brainType` is now a second-layer **behavior/personality overlay**:
  - decision delay / responsiveness,
  - target selection style,
  - range control / aggression,
  - cover-lite quality,
  - heal/reload/boost discipline,
  - loot willingness,
  - and small aim-skill modifiers on top of the base difficulty.
- Practical feel:
  - `practice`: slower, weaker, simpler, and less disciplined
  - `realistic`: lobby-sim baseline with small delays and occasional state-choice mistakes
  - `competitive`: fastest and most disciplined within the current lightweight systems

## Known limitations (intentional for now)
- Cover is **cover-lite only** (nearby point sampling + LOS check); no peeking, no multi-enemy evaluation, and no full pathfinding yet.
- Looting is still nearby-only and heuristic-driven; bots do not clear buildings, plan multi-step routes, or manage a full inventory strategy yet.
- Object interaction is still local and heuristic-driven; bots do not solve multi-step puzzles or broadly explore interactables yet.
- Bots can press reload explicitly when empty and it’s safe/out-of-range, but still rely on standard weapon behavior for most reload timing.
- No squad coordination or shared targeting.
