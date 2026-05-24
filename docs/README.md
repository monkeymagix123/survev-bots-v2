# Bots

Concise overview of the current server-side bot behavior.

Last updated: 2026-05-24

Internal bots are normal `Player` objects with `player.isAi = true` and `player.hasClient = false`. They are spawned/managed by `BotManager` and driven by server-side bot controllers/brains.

## What Bots Try To Do

Bots follow a lightweight priority stack:

1. **Survive**
   - react to visible or very close danger
   - back off / seek cover / retreat to heal or reload
   - avoid bad heal/reload timing

2. **Fight**
   - use weapon-range-aware movement
   - chase short-term last seen positions
   - keep aiming/shooting separate from movement state choice

3. **Loot / Arm Up**
   - take nearby safe-ish loot only
   - unarmed bots strongly prioritize finding a gun
   - may break nearby loot objects or use simple interactables when practical

## Brain Types

- `practice` → slower, weaker, simpler
- `realistic` → baseline human-like behavior
- `competitive` → tighter range control, better discipline, better target choice

`difficulty` controls base mechanical skill; `brainType` overlays behavior/personality.

## High-Level Behavior

### Targeting
- Prefer visible hostiles when possible
- Keep short `lastSeen` memory for brief chase behavior
- Competitive bots score targets a bit better than the other brains
- When a target is obscured by terrain/objects, armed bots try to reposition instead of passively sitting on a blocked shot
- Armed bots treat lone visibly unarmed hostiles as less threatening unless they get close or show gun evidence

### Movement
- Use a lightweight movement state machine
- Use short detours and fallback recovery instead of full pathfinding
- Keep short detour-side commitment around blockers so bots are less likely to jitter between equivalent left/right micro-routes
- In normal idle roaming, prefer nearby loot-bearing destructible objects or nearby buildings before falling back to generic random wandering
- Refresh completed idle waypoints immediately so bots do not stand still waiting for roam TTL to expire
- Can route out through container exits instead of face-hugging the container walls
- Can route into and out of simple warehouses through the big side openings, including actually crossing the threshold on entry
- Keep a short committed warehouse opening target so bots are less likely to bounce in/out at the doorway threshold
- Can now choose exterior building-corner detours when a structure shell is the thing blocking a pursuit route, instead of only doing tiny local sidesteps
- Can bias detours to slide along or peel away from large indestructible walls
- Use local cover-lite sampling under pressure
- Respect gas/safe-zone pressure first

### Looting
- Nearby-only and conservative
- Main priorities:
  1. guns
  2. armor / helmet
  3. backpack
  4. meds / boosts
  5. ammo
  6. clear upgrades

### Object Interaction
- Can melee-break nearby loot obstacles
- Can use nearby manual doors/buttons when they clearly help
- `melee_break` uses an obstacle-edge approach instead of walking to object center
- `melee_break` punch checks now use the bot’s intended same-tick aim direction, so bots are less likely to stand next to a crate without actually swinging
- `melee_break` now has a tiny configurable swing-plant window (`BotTuning.objectInteract.meleeSwingStopSec`); set it to `0` if you want no stop-at-all behavior
- Armed bots now remember and re-equip their gun after temporary melee crate-breaking instead of getting stranded on fists
- Windows are not treated as loot-break targets
- Armored / stone-plated break targets are only chosen when the bot’s melee weapon can actually pierce them
- Loot objects that are blocked behind walls/building separation are rejected unless an unarmed bot can first clear a destructible blocker
- Explosive blockers like oil barrels are not chosen as melee route-clearing detours on the way to a better crate/object target

### Unarmed Bots
- Use a dedicated internal unarmed brain and unarmed input/controller path
- Switch back to the normal armed brain/controller path as soon as they acquire a primary or secondary gun
- Treat unseen enemies as background danger
- Prioritize arming up or farming nearby loot objects
- Become much more cautious around hostiles that have shown a gun
- Treat very close visible hostiles as melee pressure and back off instead of passively face-hugging
- If a visible hostile still appears unarmed, bots can keep taking nearby loot/object opportunities; otherwise they more deliberately disengage instead of idling
- Can redirect from a desired crate/object to a destructible route-blocker when that blocker is the only thing in the way

### Healing
- Bots can keep moving while healing, just more slowly
- Healthkits and retreating bandages now have stronger “commit” behavior so bots are less likely to throw away a mostly-good heal
- Armed bots also soften visible-pressure rules against lone clearly unarmed hostiles, so safe-ish heals are less likely to get blocked by pure visibility alone
- Heal/boost starts now also respect short recent-enemy pressure memory, so bots are less likely to instantly med or boost the moment LOS briefly breaks

### Shooting Feel
- Automatic weapons now keep a short persistent spray offset instead of re-rolling a completely fresh visible aim angle every shot, so AR/SMG/LMG fire looks less jittery in spectate

### Performance / Stability
- Legacy parity-comparison hooks have been removed from the live bot update path
- Loot/object selection now uses short-lived scorer caches instead of immediately rescanning the same local candidates every time
- Failed loot/object targets get brief cooldowns so bots are less likely to bounce straight back onto the same bad pick
- Perception and navigation now also reuse some same-tick/local work, especially repeated target scans and repeated route traces during one nav solve

## Config Notes

- `Config.bots.giveStartingWeapons`
  - `true` → bots spawn ready to fight
  - `false` → bots must arm up first

## Current Limits

- No full pathfinding
- No broad puzzle solving
- No squad tactics / coordination
- Cover is local only
- Looting is heuristic and nearby-only

## Where To Look Next

- `docs/README-details.md` → implementation/architecture notes
- `docs/plans.md` → authoritative progress log
- `docs/status.md` → short current snapshot
