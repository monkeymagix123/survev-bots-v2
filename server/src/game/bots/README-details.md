# Bots — Details

Deeper implementation notes for the current internal bot system.

Last updated: 2026-05-03

## Core Model

Internal bots are server-side `Player` objects with:
- `player.isAi = true`
- `player.hasClient = false`

They are managed by `BotManager` and driven by:
- brains for decision/state selection
- perception for target/threat gathering
- navigation for lightweight routing
- aim/weapon logic for firing behavior
- controller paths for final input generation

## Architecture

### Main pieces
- `server/src/game/bots/botController.ts`
  - main armed-bot controller path
  - shared update loop / timing / parity hooks
- `server/src/game/bots/unarmedBotInputController.ts`
  - dedicated final input path for unarmed bots
  - keeps unarmed-specific object/loot/survival behavior from overcomplicating the armed controller
- `server/src/game/bots/brains/realisticBotBrain.ts`
  - main movement-state selector for armed baseline behavior
- `server/src/game/bots/brains/unarmedBotBrain.ts`
  - dedicated decision model for bots with no primary/secondary gun

### Supporting systems
- `BotPerception`
- `BotNavigationLite`
- `BotAimController`
- `BotWeaponLogic`
- `BotLootScorer`
- `BotObjectInteractionScorer`
- `BotBrainProfiles`
- `BotTuning`

## Brain / Controller Split

Current split:
- **Brains** decide state + high-level movement goals
- **Controllers** convert that into final inputs

Important distinction:
- armed bots and unarmed bots now share some systems,
- but unarmed bots have their own **brain** and their own **input/controller path**
- this keeps unarmed-specific caution, loot-object farming, and object-abort behavior separate from the armed path

## Modes

### Fill mode
- Active while lobby is open on normal maps
- Bots fill seats dynamically and retire to make room for real joins

### Wave mode
- Selected by map (`mapDef.isWave`)
- Humans are Team 1, bots are Team 2
- Waves come from map-driven wave data

## Perception / Targeting

### Hostile selection
- Prefer nearest visible hostile
- Fall back to nearest hostile when appropriate
- Keep `lastSeenPos` / `lastSeenTime` for short chase behavior

### Threat bookkeeping
- Tracks:
  - nearby hostile/friendly counts
  - nearest hostile distance
  - recent damage / recent combat pressure
  - visible target state

### Hostile weapon memory
- If a visible hostile ever shows a gun, bots remember that hostile as gun-capable for that life
- This especially matters for unarmed bots
- Unarmed bots also classify:
  - truly unarmed visible hostile
  - distracted armed hostile

“Distracted” is still heuristic, not a full tactical model.

## Movement System

Movement is state-driven and separate from shooting.

### Common states
- `push`
- `back_off`
- `hold_range`
- `hold_position`
- `strafe`
- `chase_last_seen`
- `seek_cover`
- `retreat_heal`
- `retreat_reload`
- `loot`
- `interact_object`

### Navigation
`BotNavigationLite` intentionally stays simple:
- direct goals when possible
- short detour waypoints around blockers
- stuck detection
- forced re-path attempts
- safe fallback waypoint / gas-center recovery

It is **not** full pathfinding.

### Cover-lite
- samples nearby local points
- prefers LOS-blocking points
- caches briefly so retreat behavior does not thrash

### Stability
Recent stabilization work added:
- small range hysteresis
- short state commitment windows
- reduced push/back_off oscillation
- softer anchor behavior when LOS is weak

## Looting

### Loose loot
Bots still rely on normal pickup behavior once near loot; explicit bot logic mainly chooses **what to walk toward**.

Priority remains conservative:
1. guns
2. armor / helmet
3. backpack
4. meds / boosts
5. ammo
6. meaningful upgrades

### Object interaction
Bots can:
- break nearby loot-bearing obstacles with melee
- use nearby manual doors
- use nearby practical buttons that seem to unlock immediate local progress

Limits:
- no broad puzzle solving
- no multi-step sequence inference
- no general room-clearing behavior

### Melee break specifics
`melee_break` now:
- approaches the obstacle edge, not the center
- uses its own arrival threshold
- uses actual melee geometry from the melee def (`attack.offset` + `attack.rad`)

## Unarmed Behavior

Unarmed means:
- no usable gun in primary
- no usable gun in secondary

### Decision model
Unarmed bots default to:
1. survive immediate pressure
2. grab nearby loose guns
3. farm nearby loot objects / useful interactions
4. wander only when no worthwhile local option exists

### Threat model
- unseen enemies matter less than for armed bots
- visible armed hostiles matter much more
- visible unarmed hostiles are treated as less threatening
- distracted armed hostiles allow more opportunistic crate/object behavior

### Why separate controller logic exists now
Unarmed bots needed different handling for:
- object-interaction abort rules
- loot/object willingness under visible threat
- melee object approach / punch flow
- “don’t behave like an armed combat bot with missing guns”

That logic had grown awkward inside the armed controller path, so it now has its own final input builder.

## Aim / Shooting

Aim/shoot is still separate from movement-state logic.

### Aim
- smoothed aim
- optional simple lead
- difficulty-based mechanics
- brain-profile modifiers layered on top

### Shooting
- weapon-profile gated
- LOS-aware
- burst/tap behavior by weapon class
- no bot-requested gunfire while starting/channeling item use

Precision bots no longer do the old hard stop-to-focus behavior.

## Item Usage

### Healing / boosting
- requires safety checks
- retreat states are only a relaxed gate, not automatic safety
- bots cancel heals when danger spikes, except when almost done

### Reload
- explicit reload input is used when empty and timing is acceptable
- discipline varies by brain type

## Tuning / Profiles

### `BotTuning`
Holds shared thresholds and timings such as:
- danger thresholds
- state commitment windows
- navigation tolerances
- object interaction distances
- item-cancel timing

### `BotBrainProfiles`
Holds brain-type behavior overlays such as:
- reaction delay
- aggression/range slack
- cover quality
- loot willingness
- heal/reload discipline
- aim imperfection modifiers

## Debugging / Observability

### Console / parity
- optional parity comparison vs legacy controller

### Stability log
- `debugBotStability`
- writes structured JSON lines
- includes readable summaries for easier tailing

Current useful events include:
- `state_change`
- `heal_cancel`
- `idle_reason`

## Known Constraints

- No full A*
- No building-clearing planner
- No squad coordination
- No full inventory planner
- No multi-enemy tactical solver

The design goal is still:
- predictable
- debuggable
- incrementally expandable
