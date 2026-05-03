# Bots (Current Behavior)

This describes how the **internal bots** currently behave on the server (as of 2026-05-02).

Internal bots are normal `Player` objects with `player.isAi = true` and `player.hasClient = false`, driven by `BotController`.

---

## Behavior Summary (Short)

Bots follow a lightweight, state-driven system with three main priorities:

1. **Survive**
   - react to visible or very close threats
   - retreat, strafe, or seek cover under pressure
   - avoid healing/reloading in exposed LOS

2. **Fight**
   - engage enemies within weapon range using push/back_off/hold/strafe states
   - prefer visible targets and maintain short target stickiness
   - use weapon-specific range and firing behavior

3. **Loot / Arm Up**
   - when safe or no active threat, move toward nearby valuable loot
   - unarmed bots strongly prioritize getting a gun
   - may break nearby loot objects or use simple interactables if safe

General principles:
- Bots do not abandon visible combat for loot
- Bots treat recent damage as temporary danger even without LOS
- Bots prefer nearby, low-risk actions over long detours
- Behavior varies by brain type (practice / realistic / competitive)

---

## Config Notes
- `Config.bots.giveStartingWeapons` controls whether bots spawn with guns
- `true` → bots fight immediately
- `false` → bots must loot and arm up

---

## Modes

### Fill mode
- Active while lobby is open (`gas.stage < 2`)
- Bots fill empty slots dynamically

### Wave mode
- Enabled via map (`mapDef.isWave`)
- Bots spawn in waves
- Bots are always Team 2 (Blue), humans Team 1 (Red)

---

## Targeting / Perception

- Chooses nearest **visible (LOS)** hostile if available, otherwise nearest hostile
- Tracks:
  - visible enemies
  - nearby hostiles/friendlies
  - recent enemies (damage/seen/heard)
- Keeps **lastSeenPos/time** for short chase behavior
- Keeps small hostile weapon memory:
  - if a visible hostile ever shows a gun, bots remember that hostile as gun-capable for the rest of that life
  - if a visible hostile appears truly unarmed, unarmed bots treat them as much less threatening
  - if a visible armed hostile is actively shooting near another non-friendly player, bots may treat them as temporarily distracted
- Slight improvements for competitive bots:
  - better target selection
  - more stickiness

---

## Looting / Unarmed

- Bots rely on auto-pickup once near loot
- Explicit logic decides **what to move toward**

### Loot behavior
- Safe/no target → loot nearby
- LOS lost → small detours allowed
- Visible threat → no loot chasing

Priority:
1. guns (especially when unarmed)
2. armor / helmet
3. backpack
4. meds / boosts
5. ammo
6. upgrades

### Object interaction
- Break nearby loot objects (melee)
- Use nearby doors/buttons if useful
- Interaction is **short-lived and interruptible**

### Unarmed behavior
- Treat unseen enemies as background danger
- Prioritize arming up
- Use a dedicated internal unarmed brain
- Visible armed enemies strongly reduce loot/object willingness
- Visible unarmed enemies, or distracted armed enemies, still allow more crate-breaking than the normal armed brain would
- Passive `hold_range` / anchor behavior is avoided while unarmed
- Recent damage triggers brief retreat even without LOS

---

## Movement

State selection is **movement-only**; aim/shoot is separate.

States include:
- push
- back_off
- hold_range / hold_position
- strafe
- chase_last_seen
- retreat_heal / retreat_reload
- seek_cover
- interact_object

Behavior:
- gas override → move to safe zone
- lightweight navigation:
  - simple detours
  - fallback if stuck
- cover-lite:
  - local LOS-based sampling
  - cached briefly

Mental model:
- bots decide **where to move first**, then **how to shoot**

---

## Aim + Shooting

- Aim smoothing + optional prediction
- Controlled by difficulty + brain modifiers

Gated by:
- reaction time
- aim error threshold
- LOS
- weapon profile

Weapon behavior:
- SMG/AR → bursts
- precision → mobile shooting (no hard stop)
- pistols → tap fire

---

## Item Usage

### Healing
- heal if:
  - health < 60
  - safe (no LOS, low danger, no nearby enemies)

### Boosting
- boost if:
  - boost < 50
  - safe

Quick vs long boost thresholds differ.

---

## Brains / Difficulty

- **difficulty** = mechanical skill
- **brainType** = behavior/personality

### Brain types
- practice → simple, weak
- realistic → human-like baseline
- competitive → disciplined, efficient

---

## Known Limitations

- no full pathfinding
- no building clearing
- no puzzle solving
- no squad coordination
- cover = local only (no peeking/multi-enemy logic)

---

## Implementation Notes

- Movement = state machine
- Aim/shoot = separate system
- Navigation = lightweight (no A*)
- Cover = local sampling only
- Loot = heuristic, nearby only

Controlled by:
- `BotTuning`
- `BotBrainProfile`
- `SkillProfiles`

Design goals:
- predictable behavior
- easy debugging
- gradual system expansion
