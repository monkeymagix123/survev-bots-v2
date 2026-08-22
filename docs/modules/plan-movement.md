A good way to do this is to avoid making “difficulty” simply mean better aim. Human-looking bots need imperfections in perception, decision-making, movement, and execution. Then your difficulty slider controls the distributions of those imperfections.

I’d structure each bot as a loop like:

**Perception → intent → path/movement → aiming → action**, with randomness and latency inserted at each stage.

### 1. Separate the bot into systems

A practical architecture is:

```text
World state
   ↓
Perception model
   ↓
Decision / utility model
   ↓
Movement controller ─── Aim controller
   ↓                     ↓
Movement inputs       Mouse/aim inputs
          \             /
           Action controller
```

Crucially, the AI shouldn't read perfect game state and immediately output perfect inputs.

Instead, give it a **subjective world state**.

For example:

```ts
interface BotMemory {
  enemies: {
    id: number;
    lastSeenPos: Vec2;
    lastSeenTime: number;
    estimatedVelocity: Vec2;
    confidence: number;
  }[];

  dangerZones: Vec2[];
  desiredPosition: Vec2;
  currentGoal: Goal;
}
```

If an enemy disappears behind an obstacle, the bot remembers where they were instead of continuing to track their exact server position.

That alone makes bots feel dramatically more human.

### 2. Make difficulty one parameter, but derive many traits from it

Have:

```ts
difficulty: 0.0 // beginner
difficulty: 0.5 // average player
difficulty: 1.0 // very strong player
```

Then generate a player profile from it.

For example:

```ts
function makeSkill(d: number) {
  return {
    reactionTime: lerp(550, 140, d),        // ms
    perceptionInterval: lerp(180, 35, d),  // ms

    aimError: lerp(12, 1.5, d),            // degrees/pixels/etc.
    aimSmoothing: lerp(0.07, 0.35, d),
    trackingError: lerp(0.30, 0.04, d),

    predictionSkill: lerp(0.05, 0.95, d),

    movementSkill: lerp(0.2, 0.95, d),
    dodgeSkill: lerp(0.05, 0.9, d),

    tacticalSkill: lerp(0.15, 0.95, d),

    mistakeRate: lerp(0.16, 0.01, d),
    hesitationChance: lerp(0.20, 0.015, d)
  };
}
```

Don't use strictly linear interpolation for everything, though. Something like aim may improve slowly at first and rapidly around intermediate skill:

```ts
const aimSkill = Math.pow(d, 1.5);
```

While reaction time might look more like:

```ts
const reactionSkill = Math.sqrt(d);
```

This gives you much more natural difficulty progression.

### 3. Movement should be goal-based, not random WASD

Don't write movement like:

```ts
if (enemy.x > bot.x)
    moveRight();
```

That produces very obvious bots.

Instead, have the bot continuously choose a **desired position**.

For example, score candidate positions around itself:

```text
score(position) =

+ cover
+ distance_from_danger
+ firing_angle
+ loot_value
+ escape_routes
+ preferred_combat_distance

- enemy_exposure
- grenade_danger
- zone_danger
- collision_risk
```

You might sample 16–40 candidate points around the player:

```text
       • • •
    •         •
  •      B      •
    •         •
       • • •
```

and evaluate them.

A strong bot may pick nearly the best position:

```ts
candidate = weightedChoice(candidates, temperature = 0.1);
```

An average player:

```ts
temperature = 0.6;
```

A bad player:

```ts
temperature = 1.5;
```

This technique is particularly useful because weaker bots aren't artificially stupid. They simply make **less optimal choices more frequently**.

### 4. Add movement habits

Players don't move optimally every frame.

Give bots states like:

```ts
enum MovementStyle {
  Hold,
  Strafe,
  Push,
  Retreat,
  Circle,
  Peek,
  Reposition,
  Loot
}
```

For example:

```text
Enemy appears
     │
     ├── weak bot → shoot + random strafe
     │
     ├── average → strafe / seek nearby cover
     │
     └── strong → evaluate weapon matchup
                   ├─ push
                   ├─ kite
                   ├─ peek
                   └─ disengage
```

Commit to decisions for short periods too.

Humans don't normally reconsider their strategy 60 times per second.

Maybe:

```ts
decisionInterval = random(150, 500);
```

depending on skill and circumstances.

### 5. Make aiming physically human-like

This is probably the most important part.

Don't calculate:

```ts
aim = enemy.position;
```

and then add random noise.

That gives you an aimbot with jitter.

Instead, model aiming as a dynamic system.

Have:

```text
target position
      ↓
prediction
      ↓
desired aim
      ↓
reaction delay
      ↓
aim velocity
      ↓
acceleration/smoothing
      ↓
actual cursor direction
```

For example:

```ts
desiredAim =
    enemy.pos +
    enemy.velocity * predictionAmount;
```

Then:

```ts
aimVelocity +=
    (desiredAim - currentAim)
    * trackingGain
    * dt;

aimVelocity *= damping;

currentAim += aimVelocity * dt;
```

Add **slowly varying error**, not frame-by-frame randomness.

Bad:

```ts
aim.x += random(-10, 10);
aim.y += random(-10, 10);
```

That creates robotic shaking.

Better:

```ts
aimNoise += randomAcceleration * dt;
aimNoise *= 0.95;

currentAim += aimNoise;
```

Or use smooth noise/Ornstein–Uhlenbeck noise.

This produces aim paths more like:

```text
           target
              ×
            ╱
         ╱
      ╱
   •──────
 initial aim
```

rather than instantly snapping onto the target.

### 6. Model reaction time separately from aim skill

A strong player might notice someone after ~150 ms.

A beginner might need ~400–700 ms.

But reaction time shouldn't always be identical.

For example:

```ts
reaction =
  normalDistribution(
      profile.reactionTime,
      profile.reactionTime * 0.18
  );
```

And context can modify it.

An enemy entering directly in front:

```text
180 ms
```

Enemy unexpectedly appearing behind:

```text
270 ms
```

Enemy already being tracked:

```text
80 ms
```

This is much more convincing than a fixed delay.

### 7. Give bots imperfect attention

One of the biggest giveaways in game bots is omniscience.

A human might:

* miss someone briefly;
* tunnel vision on a target;
* fail to notice someone behind them;
* react slower while looting;
* lose track of an enemy behind cover;
* misjudge where someone will reappear.

Represent attention explicitly.

For instance:

```ts
attentionScore(enemy) =
    proximity *
    visibility *
    threat *
    screenCentrality *
    recentDamage;
```

Then only actively track perhaps:

```ts
primaryTarget: Enemy
secondaryThreats: Enemy[]
```

instead of giving every visible player equal perfect processing.

Difficulty changes how quickly attention switches.

### 8. Create mistakes at the decision level

Rather than doing:

```ts
if (Math.random() < mistakeChance)
    aimWrong();
```

make believable mistakes.

Examples include:

```text
Beginner mistakes
• loots for too long
• pushes while low HP
• notices grenades late
• runs through exposed areas
• switches weapon unnecessarily
• shoots slightly too early
• doesn't lead moving targets
• retreats too late

Intermediate mistakes
• occasionally chooses bad cover
• overcommits to fights
• imperfect prediction
• loses track during chaotic fights

Expert mistakes
• rare positioning misjudgment
• small aim overshoot
• slightly late reaction
• occasionally predicts movement incorrectly
```

That creates much more convincing difficulty.

### 9. Give every bot personality variation

Don't have:

```ts
skill = difficulty
```

Use something more like:

```ts
const mechanical = clamp(d + normal(0, 0.08));
const tactical   = clamp(d + normal(0, 0.12));
const aggression = randomBeta(...);
const patience   = randomBeta(...);
```

Now two bots at difficulty 70% might be:

```text
Bot A
excellent aim
average positioning
aggressive

Bot B
average aim
excellent positioning
cautious
```

Both can have roughly the same overall strength.

This matters enormously for practice because otherwise players quickly learn “how the AI behaves.”

### 10. Consider making the slider correspond to player percentiles

Instead of arbitrary levels like:

```text
Easy / Medium / Hard
```

you could internally model:

```text
0.00 → first-time player
0.20 → weak casual
0.40 → average
0.60 → above average
0.80 → strong
0.95 → highly competitive
1.00 → near-human mechanical ceiling
```

I'd actually prevent the normal difficulty slider from ever reaching mathematically perfect play.

For example:

```ts
effectiveSkill = Math.min(slider, 0.97);
```

Then have a separate developer-only **perfect bot** setting for testing.

The top practice bot should behave like an exceptional human, not like software.

### The most important design principle

I would **not** implement five distinct AIs for five difficulties.

Implement **one human-player model** with perhaps 15–30 continuous parameters:

```text
reaction time
visual attention
tracking accuracy
flick accuracy
prediction
movement precision
strafe quality
cover awareness
danger awareness
weapon knowledge
aggression
decision speed
memory
mistake probability
risk tolerance
...
```

Then have your difficulty slider produce distributions over those values.

Conceptually:

```ts
function createBot(difficulty: number): Bot {
    return new Bot({
        perception: createPerceptionProfile(difficulty),
        mechanics: createMechanicalProfile(difficulty),
        strategy: createStrategicProfile(difficulty),
        personality: createRandomPersonality()
    });
}
```

Then the really useful part is **recording real Surviv.io-style player telemetry** if you control the game/server or are building this in your own recreation. Measure things like reaction-time distributions, aim corrections, direction-change frequency, engagement distance, strafe duration, and decision intervals.

Your bots can then sample those distributions rather than relying on hand-tuned guesses.

That produces the hierarchy you want:

```text
               Difficulty
                    │
           ┌────────┴────────┐
           ↓                 ↓
       Skill profile     Personality
           │
  ┌────────┼─────────┐
  ↓        ↓         ↓
Perception Mechanics Strategy
  │        │         │
  └────────┴────┬────┘
                ↓
          Human-like bot
```

If this is for a Surviv.io clone/private practice environment rather than automating clients on a live third-party service, I can also sketch a concrete implementation for the **movement + aim controller**, including pseudocode for strafing, leading shots, reaction latency, smooth aim error, and the difficulty curves.
