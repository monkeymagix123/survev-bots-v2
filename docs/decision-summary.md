# Bot Decision-Making Summary

## Scope

This document describes the code under `server/src/game/bots`, with emphasis on
how a bot chooses actions. The system is not a single monolithic AI routine. It
is a layered controller:

1. `BotManager` creates and updates bots, assigning difficulty and brain type.
2. `BotController` maintains each bot's subsystems and schedules decisions.
3. A brain (`RealisticBotBrain` or `UnarmedBotBrain`) periodically selects a
   combat state, goal position, targets, and interaction intent.
4. Per-tick input generation executes that intent through navigation, aiming,
   looting, interaction, healing, reloading, and firing rules.

The normal armed behavior is implemented in `RealisticBotBrain`. The
`PracticeBotBrain` and `CompetitiveBotBrain` classes inherit that same
algorithm; their behavior differs through brain profiles and their overridden
brain type. A bot with no gun in either weapon slot is instead routed through
`UnarmedBotBrain` and `UnarmedBotInputController`.

## High-Level Update Loop

`BotManager` owns a `BotController` for each internal AI player and calls
`controller.update(dt)` while that bot is alive.

For each controller update:

1. Dead, downed, or disconnected players do nothing.
2. The controller detects whether the bot currently owns any gun. A transition
   from unarmed to armed clears stale aim focus and reinitializes weapon
   reaction timing against the current target.
3. Taking health damage updates `combat.lastDamagedTime` and informs
   perception.
4. Navigation timers and movement/stuck tracking are advanced.
5. A brain decision is made only when the configured decision interval plus a
   brain-specific randomized delay has elapsed.
6. Every update tick, including ticks between decisions, the current remembered
   state is converted to an input message and applied to the player.

This separation matters: decisions are intermittent, but movement, aim, and
fire inputs continue every tick using `BotCombatMemory`.

## Persistent Decision Memory

`BotCombatMemory` is the blackboard shared by brain decisions and input
execution. It records:

- Current state, reason, state start time, and a lock deadline that prevents
  some actions from being abandoned immediately.
- Recent damage and short damage-dodge direction/timing.
- Retreat direction sampling and cached cover target.
- Unarmed pressure memory, used to continue avoiding a threat after it is no
  longer immediately visible.
- The active goal position and movement style: `direct`, `strafe`, or
  `anchor`.
- Selected loot and object-interaction targets.
- Decision log context: macro goal, selected zone/building, zone score,
  subgoal, and whether to resume the larger route after a subgoal.

The possible combat states are:

| State | Meaning |
| --- | --- |
| `wander` | No immediate fight or local action; use navigation waypoints. |
| `loot` | Approach and pick up selected loot. |
| `interact_object` | Use a door/button or melee-break a loot obstacle. |
| `push` | Close distance to reach useful weapon range. |
| `hold_range` | Stay at the current point while engaging. |
| `hold_position` | Competitive hold behavior for some ranged weapons. |
| `back_off` | Increase separation from a nearby threat. |
| `strafe` | Move perpendicular to aim while fighting. |
| `chase_last_seen` | Move to the enemy's remembered or inferred position. |
| `seek_cover` | Choose blocked-line-of-sight cover, or retreat if none exists. |
| `retreat_reload` | Seek cover/retreat in order to reload. |
| `retreat_heal` | Seek cover/retreat while needing healing. |

Macro goals (`loot_zone`, `rotate_safe`, `fight`, and `heal`) and subgoals
(`pickup_loot`, `break_crate`, and `use_door`) mainly describe the selected
intent for logging and continuation of waypoint-based exploration.

## Brain Types and Difficulty

Brain type and difficulty influence different parts of behavior.

### Brain Profiles

`BotBrainProfiles` configures decision style:

| Property area | `practice` | `realistic` | `competitive` |
| --- | --- | --- | --- |
| Added decision delay | 0.08 to 0.22 s | 0.05 to 0.15 s | 0 to 0.03 s |
| Target choice | nearest | nearest | scored threat choice |
| Retreat danger threshold | 0.68 | 0.55 | 0.42 |
| High danger threshold | 0.86 | 0.75 | 0.62 |
| Lost-target chase TTL configured | 0.7 s | 1.6 s | 2.6 s |
| Random in-band weak choice | 12% | 7% | never |
| Cover sampling | least thorough and may intentionally fail/choose second-best | intermediate | most thorough; never intentionally falls back or chooses second-best |
| Loot/object willingness | comparatively casual | baseline | reduced during combat-oriented behavior |

Competitive target scoring prefers visible targets, a previously selected
target, low-health targets, and reloading targets, balanced against distance.
Practice and realistic profiles simply choose the closest visible hostile when
one is available, otherwise the closest eligible hostile.

### Difficulty and Shooting Skill

Difficulty (`normal`, `hard`, `pro`) establishes reaction delay, tracking turn
speed, aim error, movement prediction, and a short line-of-sight grace window.
The brain profile then modifies those values: practice becomes slower and less
accurate; competitive becomes faster and more accurate.

For example, difficulty selects a weapon's aim gate and skill baseline, while
brain type changes the bot's risk threshold and refines its skill. Thus a
competitive bot at a lower difficulty is still strategically more cautious
than a realistic bot, but it does not necessarily shoot like a `pro` bot.

## Perception and Target Selection

`BotPerception.scanForTarget` supplies both a selected target and a threat
snapshot.

### Eligibility and Visibility

A target is ignored if it is the bot itself, dead, disconnected, on another
layer, friendly by group/team, or another bot while `allowBotVsBot` is
disabled. Visibility is a line-of-sight trace at bullet height against
obstacles.

On ordinary maps the scan examines nearby grid objects inside approximately
`player.zoom + 6`. On wave maps it scans the entire player list, allowing an
eligible non-visible hostile outside local vision to become the fallback
target.

Target selection first prefers visible eligible hostiles. If none are visible,
it falls back to an eligible non-visible hostile:

- `practice` and `realistic` use nearest-target selection.
- `competitive` uses a score based on distance, visibility, being in local
  vision range, target stickiness, missing target health, and whether the
  target is reloading.

### Threat Snapshot

Each scan also records:

- Nearby hostile, friendly, and ignored counts.
- Whether any nearby hostile has line of sight.
- Distance to the nearest hostile and nearest nearby hostile.
- Whether an enemy was seen, heard, or damaged the bot recently.

Perception remembers whether a visible hostile has ever been observed holding
a gun. Against the chosen visible target it also reports whether that target
currently appears unarmed, has recently fired, or appears distracted by
fighting a nearby non-friendly player. Those observations substantially affect
the unarmed brain and slightly soften normal danger calculations.

## Danger Model

The armed brain and input controller build a tactical snapshot using a danger
score clamped to `0..1`. The additive contributions are:

| Condition | Added danger |
| --- | ---: |
| Selected target currently visible | 0.30 |
| Target proximity, scaling to zero by distance 20 | up to 0.22 |
| Bot health below 60 | 0.22 |
| Currently reloading | 0.18 |
| Empty active gun with reserve ammo | 0.14 |
| Damaged in the last 0.45 seconds | 0.12 |
| In gas or outside the safe zone | 0.25 |

If the visible target appears unarmed, has not shown a gun, has not recently
fired, is not close, and is the only nearby hostile, the visibility and
distance contributions are multiplied by `0.20`. This makes safe looting,
healing, and positioning more plausible around a low-evidence threat.

The unarmed brain starts from the same general danger computation but adjusts
it further:

- Seeing a hostile who has shown a gun adds `0.28`.
- If that armed hostile is distracted, danger is reduced by `0.16`.
- A visible hostile that appears unarmed reduces danger by `0.25`.

## Armed Brain Decision Tree

`RealisticBotBrain.decide` begins by scanning for a target and updating target
memory, aim focus, reaction timing, and last-seen position. Goals are sanitized
to remain inside the map and inside the future safe circle when possible; a
water destination is nudged toward the safe-zone center.

### When No Target Is Selected

Without a selected target, the bot ensures it has an exploration waypoint.
Only when it is outside gas danger and has no visible, recent, or close hostile
does it evaluate nearby idle loot and object actions.

The selection order is:

1. Choose an object action if it is a usable door/button, or if there is no
   selected loot. This makes route-opening interactions outrank loot, while a
   breakable container does not displace a selected loose item.
2. Otherwise choose loot and enter `loot`.
3. Otherwise enter `wander`; navigation continues toward a selected loot zone
   or a safe roaming route.

### When a Target Is Selected

The brain computes weapon class/range, health, reload status, visibility,
danger, damage-dodge timing, and any safe opportunistic loot or object action.
Opportunistic farming is considered only when the target is not visible, the
bot is not in gas, low on health, reloading, recently damaged, or under recent
enemy pressure, and danger is below the configured activity threshold.

The state priority is evaluated in this order:

| Priority | Condition | State and purpose |
| ---: | --- | --- |
| 1 | Low HP and danger at least `retreatDangerMin` | `retreat_heal`; escape toward cover/space and allow healing logic to act when safe. |
| 2 | Reload needed and danger at least `retreatDangerMin` | `retreat_reload`; move toward cover/space before or during reload. |
| 3 | Reload needed at lower danger | `back_off` if too close, otherwise `hold_range`. |
| 4 | In the short post-damage dodge window, healthy, loaded, and not in gas | `back_off` if too close, otherwise `strafe` with a remembered dodge side. |
| 5 | Low HP or reload plus high danger | `seek_cover`. |
| 6 | Safe opportunistic object selection | `interact_object`. |
| 7 | Safe opportunistic loot selection | `loot`. |
| 8 | Target not visible | `chase_last_seen`, using last seen position when available. |
| 9 | Too close for the weapon's useful band | `back_off`. |
| 10 | Too far for the useful band | `push`. |
| 11 | Within the desired band | Choose a weapon-specific hold/strafe style. |

For in-band fighting:

- Shotguns, SMGs, and pistols strafe.
- A realistic or practice AR strafes; a competitive AR holds position.
- Precision and LMG weapons hold range for realistic/practice and hold
  position for competitive.
- Practice and realistic profiles can randomly downgrade an in-band choice to
  `hold_range` via their `mistakeChance`.

Weapon range thresholds include brain-profile slack and hysteresis. Hysteresis
lets a bot already pushing or backing off continue slightly past a boundary
instead of flipping state at one exact distance.

### State Commitments and Goals

When state changes, several states receive a commitment period:

| State group | Lock duration |
| --- | ---: |
| Retreat states | 0.75 s |
| `chase_last_seen` | 0.45 s |
| `loot` | 0.85 s |
| `interact_object` | 0.75 s |

During a lock, the brain may preserve a retreat, chase, loot, or object action
if conditions have not become urgent. After state selection it converts state
to movement intent:

| State | Generated goal/style |
| --- | --- |
| `push` | A point at the weapon's desired outer range from the target; direct movement. |
| `back_off` | A point beyond the desired inner range; direct movement. |
| `chase_last_seen` | Last seen target position, or current inferred target position. |
| `seek_cover` | Selected cover, falling back to a sampled retreat point 14 units away. |
| `retreat_reload` | Selected cover, falling back to retreat by 16 units. |
| `retreat_heal` | Selected cover, falling back to retreat by 18 units. |
| `hold_position` / `hold_range` | Current position, anchored. |
| `strafe` | Current position, with perpendicular movement enabled. |
| `loot` / `interact_object` | The selected loot/obstacle position. |

Retreat directions are not purely straight backwards: for 0.5 to 1 second the
bot remembers a sampled direction that is 60% to 80% away from the enemy plus
a lateral component.

### Cover Selection

Cover is selected only outside a gas emergency. Candidate points are sampled
on an arc generally away from the target and at random nearby positions.
Candidates are accepted only if they are valid terrain and line of sight from
the target is blocked. They are scored to prefer:

- Shorter travel from the bot.
- Greater separation from the enemy.
- Avoiding unsafe gas-edge positions.
- Reachability without intersecting movement blockers.

A cover choice is cached briefly against the same target. Practice samples
fewer candidates and sometimes rejects valid cover or deliberately selects the
second-best candidate; competitive samples more candidates and makes neither
intentional concession.

## Unarmed Brain Decision Tree

The controller considers a bot unarmed when neither primary nor secondary slot
contains a gun. Unarmed behavior is not simply armed combat without shooting:
it changes what constitutes an actionable target and makes finding a gun the
main immediate resource goal.

### Actionable Threats

Although perception can identify a hostile, the unarmed brain retains a
selected actionable target only if that target is visible, extremely close, or
the bot was recently damaged. It also maintains pressure memory for 1.1
seconds after visible/very-close pressure and for 1.45 seconds after damage, so
brief loss of visibility does not immediately resume farming.

### Goal Crowding

The unarmed brain scores how crowded candidate destinations are. Nearby
non-friendly players add cost, armed players add further cost, and a visible
hostile can add still more cost. Loot, object, wandering, retreat, and cover
destinations may be rejected or sampled again to spread the unarmed bot away
from danger.

### Resource and Threat Priority

The unarmed state priority is:

| Priority | Condition | State and purpose |
| ---: | --- | --- |
| 1 | Low HP with sufficiently high danger | `seek_cover`. |
| 2 | Visible hostile known to have a gun and not distracted | `seek_cover` at high danger, otherwise `back_off`. |
| 3 | Recently damaged | `seek_cover` at high danger, otherwise `back_off`. |
| 4 | Hostile extremely close | `back_off`, including from melee pressure. |
| 5 | Any nearby chosen gun | `loot`, even while lesser farming options exist. |
| 6 | Allowed object action not rejected for crowding | `interact_object`. |
| 7 | Other allowed loot not rejected for crowding | `loot`. |
| 8 | Visible hostile apparently unarmed | `back_off`. |
| 9 | Remembered recent pressure | `seek_cover` if vulnerable/high danger, otherwise `back_off`. |
| 10 | Nothing urgent | `wander`, seeking useful areas while spreading out. |

Object farming and non-gun fallback looting are suppressed during gas danger
and recent pressure. They may remain allowed near a visible enemy who appears
unarmed, or near an armed enemy classified as distracted. Immediate gun
selection is evaluated more aggressively because acquiring a gun changes the
bot back to the armed controller path.

The unarmed input controller never attacks enemy players. It permits melee
attack input only while breaking a selected obstacle for loot or access.

## Loot Decisions

`BotLootScorer` searches a nearby radius determined by mode and brain profile:
idle searches are broader; opportunistic searches are shorter, especially for
competitive bots. It ignores destroyed, wrong-layer, reserved-for-someone-else,
or temporarily failed loot.

Candidates receive item-specific scores:

| Loot type | Decision rule |
| --- | --- |
| Helmet/chest/backpack | Pick only upgrades; high fixed value plus item level, reduced by distance. |
| Healing | Pick while inventory has useful room; value increases for shortages and missing health. |
| Boost | Pick while inventory has useful room; value increases for shortages and low boost. |
| Ammo | Pick only for held guns using that ammo; favor empty guns, active-weapon ammo, multiple matching guns, and low inventory ratio. |
| Gun | Fill an empty weapon slot or replace a droppable gun only when improvement exceeds the minimum threshold. |

Gun quality is estimated from weapon class, bullet damage, pellet count, fire
rate, clip size, reload penalty, dual-wield status, and aim-delay status.
Precision and LMG classes start with the highest base quality weights. An
unarmed bot receives a large additional gun score (`520`), causing gun pickup
to dominate ordinary equipment.

Against a visible armed threat, an unarmed bot further increases the value of
a gun and decreases the value of non-gun loot. A distracted armed threat
partially relaxes this penalty.

Selections are cached for 0.2 seconds when the bot has not moved materially.
A selected item that cannot be resolved is placed on a 1.4-second failed
cooldown before it can be selected again.

## Object Interaction Decisions

`BotObjectInteractionScorer` evaluates usable manual doors, useful unlock
buttons, and destructible loot-bearing obstacles:

- Manual doors and buttons are scored highly when they help reach the current
  base goal.
- A destructible object must be melee-damageable by the bot, not a window, and
  promise loot, a destruction result, or an airdrop reward.
- Breaking objects is penalized by distance, route detour, the bot's existing
  loadout value, and current combat state. It is disallowed in retreat states.
- In opportunistic combat modes, breaking receives an extra state penalty,
  making combat interruptions less attractive.

When an unarmed bot evaluates breakable objects, objects gain a general
incentive. An armed visible enemy strongly penalizes nearby object farming
unless that enemy is distracted; a visible apparently unarmed enemy instead
makes nearby breakable resources more attractive.

For melee breaking, the scorer rejects a target whose approach path is blocked.
The unarmed path may instead select a safe destructible route blocker first,
with a score penalty, so it can reach the intended object later. Failed
targets/blockers are avoided temporarily.

Input execution approaches a melee object at calculated weapon reach, equips
melee, holds still briefly when in range, and swings. After an armed bot is
done breaking, it re-equips a remembered or available gun. For `use` actions,
the controller presses use when the selected door/button is interactable.

## Navigation and Movement Execution

`BotNavigationLite` resolves a requested intent into a movable goal:

1. A gas emergency always directs the bot toward the gas safe-zone center.
2. Otherwise a brain override goal is preferred.
3. Otherwise a selected target position is used.
4. Otherwise navigation uses its current exploration waypoint.

Idle waypoints prefer interesting loot-bearing obstacles and buildings, first
locally and then regionally. Their score favors estimated loot richness and
penalizes distance and player crowding, particularly crowding by armed players.
If no interesting zone is available, the bot samples a low-crowding local or
safe regional roaming point, falling back to safe-zone center.

For a desired route, navigation can insert committed transitions for:

- Stairs needed to reach the target layer.
- Exiting shipping containers.
- Entering or leaving warehouse openings.
- Entering or leaving ordinary buildings through automatic unlocked doors.

If direct movement is blocked, the system tries building-corner routing, then
sliding around a large thin wall, then generic side/forward detour candidates.
It scores detours for route completion and progress, and briefly favors the
same side of a blocker to avoid oscillating.

Movement is observed for progress. When a bot repeatedly attempts movement
without advancing, the route is repathed after 1 second intervals; after 3
seconds it falls back to a fresh waypoint; after 4 seconds it falls back to
the safe-zone center. Recently failed detour points are temporarily avoided.

The final movement input is direct cardinal movement toward a goal unless the
brain requested anchoring or strafing. Strafing occurs only with a target,
within 18 units, and outside gas emergency; the lateral side changes at
sampled intervals unless a damage-dodge direction is forcing it.

## Aiming, Shooting, Reloading, and Support Items

### Aim and Fire

`BotAimController` turns gradually toward a target at the skill profile's
tracking rate. With a gun, it leads moving targets using bullet speed and a
difficulty/brain-scaled prediction amount capped at 0.35 seconds.

`BotWeaponLogic` classifies guns as shotgun, SMG, AR, LMG, precision, or
pistol. Each class defines ideal and maximum engagement ranges, angular aim
gate, firing bloom behavior, and optional burst/tap behavior:

- SMGs and ARs burst at longer ranges.
- Shotguns impose a post-shot pause.
- Pistols and single-fire guns press individual shots.
- Automatic weapons hold fire while permitted.

Shooting requires a target, a valid gun profile, no gas emergency, useful
range, completed reaction delay, aim inside the weapon's aim gate, no
post-shot lock, and line of sight. Automatic/burst non-precision classes may
continue firing for a brief skill-based line-of-sight grace period after losing
visibility. Shooting is suspended while using an item or performing an object
interaction.

Actual shot direction includes skill error, accumulated firing bloom, and a
movement penalty. Automatic and burst sprays smooth successive errors so
sustained firing does not randomly snap between extreme directions. Hard and
pro bots can optionally quickswitch to a second gun during an active weapon's
long post-shot delay when configured.

### Reloading

The armed input controller requests a reload only when the active gun is empty,
reserve ammunition exists, and the player is idle. It reloads during
`retreat_reload`, or when there is no valid visible/in-range threat and danger
is below the brain profile's reload tolerance. Competitive bots accept the
least danger while reloading.

### Healing and Boosting

Health is considered low below 60 and very low below 35. Boost is desired below
50 and considered very low below 25.

Healing starts only if no effective visible hostile exists, danger is low
enough for the brain type, the bot was not recently damaged, recent enemy
memory is clear, and no enemy is too close. Retreat cover states relax the
danger threshold slightly but still require a sufficiently safe opening. At
very low HP the bot prefers a healthkit and falls back to a bandage; otherwise
it prefers bandages.

Boosting follows similar safety rules. Soda is the quicker option; painkillers
require the safer long-action condition and are preferred first only at very
low boost.

If pressure appears during bandage or healthkit use, the bot can cancel. It
normally cancels for visible effective threats, extremely close enemies, or
high danger plus a close enemy, unless the item is almost finished. Once
committed far enough into a healthkit, or into a moving retreat bandage, it
cancels only for an extremely close enemy.

## Spawning, Modes, and Diagnostics

`BotManager` supports ordinary lobby fill and wave-map spawning.

- Default brain distribution is 15% practice, 80% realistic, and 5%
  competitive unless configuration forces or reweights it.
- Difficulty comes from configuration, with an optional probability of
  upgrading a non-`pro` bot to `pro`.
- A wave can specify exact brain counts and difficulty; the assigned queue is
  shuffled before spawning.
- Ordinary fill mode spawns and retires bots only while the lobby remains
  joinable, reserves human slots, and avoids retiring a bot that would end an
  active match. Bots in recent combat are strongly disfavored for retirement.
- Wave mode starts over when humans return after the no-humans pause and
  advances waves after all bots belonging to the current wave are dead.

When enabled, combat logs record state transitions and their danger, target,
goal, movement, and macro/subgoal context. Stability logs record state changes,
heal cancellations, and unexpectedly idle behavior. These logs expose the
reason labels used by the decision tree and are the most direct runtime view
of why a bot changed behavior.

## Noteworthy Consequences of the Current Code

The following points are observable effects of the implementation order rather
than inferred design goals:

- In the armed state selection, the `seek_cover` condition comes after
  `retreat_heal` and `retreat_reload`. Since every profile's high-danger
  threshold is greater than its retreat-danger threshold, a low-health or
  reload-needing armed bot meeting the later condition will already have
  selected a retreat state. Armed cover is still used inside both retreat
  states through `pickCoverPoint`; the standalone armed `seek_cover` branch is
  not reached with the current profile values.
- For an armed bot with a selected but invisible target, `!visible` selects
  `chase_last_seen` before the subsequent `lastSeenFresh` check. Therefore
  pursuit is not limited by that later TTL check while an invisible target
  remains selected; the remembered position is used when it exists.
- A precision-weapon stop-and-focus mechanism exists in the input and weapon
  logic, but the current precision weapon profile sets `stopToShoot` to
  `false` and minimum focus time to `0`, so it does not presently force a
  precision bot to stop before firing.
- Bots marked as mobile at spawn gain automatic door/pickup behavior, while
  explicit loot and manual door/button inputs still handle selected subgoals.
