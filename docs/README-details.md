# Bots — Details

Deeper implementation notes for the current internal bot system.

Last updated: 2026-05-24

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
  - shared update loop / timing for armed bots
- `server/src/game/bots/unarmedBotInputController.ts`
  - dedicated final input path for unarmed bots
  - keeps unarmed-specific object/loot/survival behavior from overcomplicating the armed controller
- `server/src/game/bots/brains/realisticBotBrain.ts`
  - main movement-state selector for armed baseline behavior
- `server/src/game/bots/brains/unarmedBotBrain.ts`
  - dedicated decision model for bots with no primary/secondary gun
- `server/src/game/bots/botControllerShared.ts`
  - shared low-level controller helpers used by both armed and unarmed paths
  - centralizes common target/object/loot/melee/support-item behavior without merging the two controller flows
- `server/src/game/bots/botDecisionSupport.ts`
  - shared tactical snapshot / danger helpers
  - keeps armed danger, threat-band, and softened-visible-threat logic in one place

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
- shared controller mechanics now live in `botControllerShared.ts`, so common helper behavior stays aligned between both paths
- once a bot acquires a primary or secondary gun again, it returns to the normal armed brain/controller path

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
- short side-commitment around a chosen detour/wall-follow side so bots do not re-flip as easily between near-equivalent routes
- normal idle roaming now first looks for nearby interesting local destinations (loot-bearing destructible obstacles, then nearby buildings), and only then falls back to a local random roam step
- idle waypoints are refreshed once reached, so bots do not stand on a completed roam goal waiting only for waypoint TTL to expire
- stuck detection
- forced re-path attempts
- safe fallback waypoint / gas-center recovery
- special-case container exit routing when a bot is inside a container but needs to leave it
- special-case warehouse entry/exit routing through the large side openings
- warehouse entry now uses an interior opening point so bots cross the threshold instead of stalling just outside
- warehouse transitions now keep a short committed opening target so bots do not flip between enter/exit while hovering on the doorway threshold
- stair-connected structures now get a short committed transition target, so bots can more reliably move through surface/underground stair openings instead of dithering at the threshold
- simple auto-door building entry/exit routing now helps practical buildings like greenhouses, so bots can leave for nearby outside loot or enter for an inside goal without treating the shell like a generic wall
- when a route is blocked by a building child obstacle and both bot/goal are outside the building, nav now tries exterior building-corner detours before falling back to tiny local sidesteps
- wall-aware slide/escape detours when a large indestructible wall is the first movement blocker

It is **not** full pathfinding.

Combat-side movement also now uses “reposition on blocked LOS” behavior:
- if an armed bot wants to fight but LOS is lost/blocked, it can prefer `chase_last_seen`-style repositioning over passively holding a useless angle
- recent-enemy pressure now also suppresses opportunistic loot/object branches immediately after LOS breaks, so armed bots are less likely to freeze near a tree because the fight briefly looked “safe enough” for a distraction

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

Recent guardrails:
- windows are excluded from loot-breaking
- armored / stone-plated obstacles are only considered if the bot’s melee slot can actually damage them
- loot objects blocked by obvious walls/building separation are rejected
- unarmed bots can redirect to a destructible blocker if that blocker is what stands between them and the desired object
- explosive props like oil barrels are not favored as route-clearing blockers on the way to a better target

Limits:
- no broad puzzle solving
- no multi-step sequence inference
- no general room-clearing behavior

### Melee break specifics
`melee_break` now:
- approaches the obstacle edge, not the center
- uses its own arrival threshold
- uses actual melee geometry from the melee def (`attack.offset` + `attack.rad`)
- checks punch reach against the bot’s intended same-tick aim direction instead of only last tick’s facing, so bots are less likely to stall beside a crate without swinging
- can briefly plant during the swing through `BotTuning.objectInteract.meleeSwingStopSec`; this is intentionally tiny and can be set to `0` if the stop makes bots too punishable
- can be used on a destructible route-blocker for unarmed bots when that blocker directly gates access to a better nearby object target

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
- very close hostiles still count as melee pressure, so unarmed bots back off instead of passively standing on top of each other
- if a visible hostile still appears unarmed and no immediate gun/object is available, bots now prefer nearby fallback loot or disengage instead of stalling in place

### Armed-vs-unarmed threat softening
Armed bots now also use that visible-hostile classification in a limited way:
- a lone visible hostile who appears truly unarmed contributes less danger than a visible armed hostile
- this only applies when the hostile has not shown a gun, is not firing, and is not already close
- that softened danger can make armed bots more willing to heal/boost instead of treating mere visibility as full pressure

### Why separate controller logic exists now
Unarmed bots needed different handling for:
- object-interaction abort rules
- loot/object willingness under visible threat
- melee object approach / punch flow
- “don’t behave like an armed combat bot with missing guns”

That logic had grown awkward inside the armed controller path, so it now has its own final input builder.

The unarmed controller path is intentionally lean:
- no armed reload behavior
- no gun burst/precision handling
- no quickswitch logic
- only movement, item use, loot/object interaction, and melee-break output

Shared helper layer:
- target resolution
- loot-target resolution and pickup inputs
- object-target validation / use handling
- melee-break edge approach and contact checks
- object-abort, heal-cancel, and heal/boost item-choice helpers
- blocked-object rejection and redirect-to-blocker helper behavior

## Optimization Notes

Recent optimization work stayed deliberately conservative:
- removed the old legacy parity-comparison path from live bot updates
- added short-lived local-selection caches inside `BotLootScorer` and `BotObjectInteractionScorer`
- added brief cooldown memory for failed loot/object/blocker picks so bots do not immediately retry the same bad choice
- centralized armed tactical danger/threat derivation through a shared snapshot helper instead of recomputing overlapping booleans in multiple places
- added strict same-tick/local reuse for `BotPerception` scans and repeated `BotNavigationLite` route traces

This was meant to reduce repeated hot-path scans and retry loops without materially changing bot personalities.

## Recent Fixes

- Armed bots now remember which gun slot they were using before temporary `melee_break`, and re-equip that gun afterward.
- Unarmed bots now treat very close hostiles as melee pressure and back off instead of face-hugging.
- If a visible hostile still appears unarmed, bots now keep pursuing nearby loot/object opportunities or deliberately disengage instead of idling.
- Route-blocker redirection no longer chooses explosive blockers like oil barrels for melee clearing.
- Normal-mode roaming now prefers nearby loot-bearing obstacles/buildings before generic local wander.
- Idle waypoints are now refreshed on arrival so unarmed bots do not stall on a completed roam goal until TTL expiry.
- Warehouse doorway routing now keeps a short committed opening target so bots do not oscillate between moving in and back out at the threshold.
- Stair-linked tunnel/structure routing now keeps a short committed transition target so bots can exit or descend more reliably instead of hovering at the stair opening.
- Simple auto-door building entry/exit routing now helps greenhouses and similar buildings stop oscillating between an outside target and the shell.
- Exterior pursuit now has a first-pass building-corner detour so bots can round structure shells more deliberately when a building wall/child obstacle is the real blocker.
- Melee-break range checks now use intended same-tick aim direction, which fixes a stall where bots could stand beside a crate without punching because the helper was still reading stale previous-tick facing.
- Melee-break now has a tiny configurable post-swing plant window so crate punches look cleaner without hard-coding a long immobile stall.
- Heal/boost start logic now respects short recent-enemy pressure memory, which helps stop bots from ducking behind cover and instantly starting a med/boost while the fight is still hot.
- Armed blocked-LOS fights now also keep recent-enemy pressure over opportunistic loot/object branches, which helps stop cases where a tree briefly breaks LOS and the bot stops repositioning.

## Aim / Shooting

Aim/shoot is still separate from movement-state logic.

### Aim
- smoothed aim
- optional simple lead
- difficulty-based mechanics
- brain-profile modifiers layered on top
- automatic-weapon spray now keeps a short persistent visible offset, so AR/SMG/LMG aim drifts more smoothly across a burst instead of snapping to a brand-new random angle every shot

### Shooting
- armed bots use weapon-profile-gated shooting behavior
- unarmed bots do not run the armed shooting/reload/quickswitch path
- unarmed output only attacks during `melee_break`, after switching to melee and reaching actual melee contact
- bots still do not request gunfire while starting/channeling item use

## Item Usage

### Healing / boosting
- requires safety checks
- retreat states are only a relaxed gate, not automatic safety
- bots cancel heals when danger spikes, except when almost done
- healthkits become “committed” after enough progress, so bots usually keep them unless danger gets very close
- bandages also get a moving-retreat commitment rule, so bots can keep circling toward cover while finishing a bandage instead of canceling too eagerly
- heal/boost starts now also respect `threat.hasRecentEnemy`, not just current visibility and direct recent damage, so bots are less likely to start support items the instant LOS briefly breaks during an active exchange

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

### Console combat log
- `debugCombat`
- prints armed and unarmed brain combat state transitions to console for quick live inspection

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
