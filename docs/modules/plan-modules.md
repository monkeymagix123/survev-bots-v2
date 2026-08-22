For a human-like Surviv.io practice bot, I’d split it into these modules:

1. **Perception module**

   * Detect visible enemies, loot, obstacles, projectiles, zone boundaries.
   * Apply vision limits, reaction delay, and imperfect awareness.
   * Maintain “last seen” information rather than omniscience.

2. **World model / memory**

   * Store known enemy positions and estimated movement.
   * Track nearby cover, loot, dangerous areas, and safe routes.
   * Forget or reduce confidence in stale information.

3. **Threat assessment**

   * Decide which enemy is most dangerous.
   * Estimate:

     * distance
     * weapon threat
     * health advantage
     * exposure
     * number of enemies
     * incoming projectiles

4. **Goal / behavior selection**

   * Pick the bot’s current high-level objective:

   ```text
   Loot
   Explore
   Rotate to zone
   Attack
   Chase
   Hold cover
   Retreat
   Heal
   Revive
   Avoid grenade/projectile
   ```

   A utility system works particularly well here.

5. **Positioning module**

   * Decide *where* the bot wants to stand next.
   * Score positions based on cover, firing angle, distance, zone safety, escape routes, etc.

6. **Pathfinding / navigation**

   * Get from the current position to the desired position.
   * Avoid walls, trees, buildings, water, obstacles, and dangerous zones.
   * Doesn't necessarily need heavyweight A* for every tiny movement; local steering plus occasional pathfinding is often enough.

7. **Movement controller**

   * Convert the desired movement into actual input.
   * Handle:

     * strafing
     * circling
     * peeking
     * retreating
     * dodging
     * stopping
     * direction changes

8. **Aim controller**

   * Track a target smoothly.
   * Include reaction time, aim acceleration, overshoot, correction, and noise.
   * Avoid simply setting the aim directly to the target.

9. **Target prediction module**

   * Estimate where a moving target will be when the projectile arrives.
   * Account for target velocity and projectile speed.
   * Difficulty can strongly affect prediction accuracy.

10. **Weapon/combat module**

    * Decide:
    * whether to shoot
    * which weapon to use
    * when to reload
    * whether to switch weapons
    * preferred engagement distance
    * burst vs sustained fire
    * whether the fight is worth taking

11. **Inventory / loot module**

    * Evaluate weapons, armor, healing, ammo, scopes, and consumables.
    * Decide whether loot is worth exposing itself for.
    * Drop or replace inferior equipment.

12. **Healing / resource management**

    * Decide when healing is safe.
    * Estimate whether there is enough time to heal before an enemy reaches the bot.
    * Manage medkits, bandages, boosts, ammo, and throwable usage.

13. **Projectile / dodge module**

    * Detect incoming grenades, bullets, or other threats.
    * Estimate danger zones.
    * Choose an escape vector instead of merely moving randomly.

14. **Zone / rotation module**

    * Understand the shrinking safe zone.
    * Decide when to rotate.
    * Prefer safer paths and avoid getting trapped outside the zone.

15. **Humanization module**
    This should modify the other systems rather than control gameplay itself.

    It could introduce:

    ```text
    reaction delay
    attention limits
    hesitation
    imperfect aim
    imperfect prediction
    inconsistent strafing
    occasional bad decisions
    target fixation
    delayed threat recognition
    ```

    This module is extremely important if the bots are meant for realistic practice.

16. **Skill / difficulty profile**

    * Converts your difficulty slider into parameters for all the other modules.

For example:

```ts
interface SkillProfile {
  reactionTime: number;
  aimAccuracy: number;
  trackingSkill: number;
  predictionSkill: number;

  movementSkill: number;
  dodgeSkill: number;

  awareness: number;
  memoryAccuracy: number;

  positioningSkill: number;
  tacticalSkill: number;

  lootKnowledge: number;
  weaponKnowledge: number;

  riskJudgment: number;
  mistakeRate: number;
}
```

Then the dependency structure would roughly be:

```text
                     ┌──────────────┐
                     │  Difficulty  │
                     └──────┬───────┘
                            ↓
                     Skill Profile
                            │
           ┌────────────────┼────────────────┐
           ↓                ↓                ↓
      Perception       Humanization      Knowledge
           │
           ↓
     World Model
           │
       ┌───┴────┐
       ↓        ↓
    Threat    Zone
   Analysis   Analysis
       │        │
       └───┬────┘
           ↓
    Goal Selection
           │
     ┌─────┼─────────┐
     ↓     ↓         ↓
 Position Loot     Combat
 Planning Logic    Logic
     │              │
     ↓          ┌───┴────┐
 Navigation     ↓        ↓
     │         Aim    Weapon
     ↓          │      Logic
 Movement       │
 Controller     │
     └──────┬───┘
            ↓
         Inputs
```

I would **not** make “easy bot,” “medium bot,” and “hard bot” separate implementations. Keep the same modules for every bot and vary their parameters. A weak bot should still understand cover and leading shots; it should just do those things less reliably.

For an initial version, you can simplify this down to **7 core modules**:

```text
1. Perception + memory
2. Goal selection
3. Positioning/navigation
4. Movement
5. Aim + prediction
6. Combat/inventory logic
7. Skill/humanization
```

That is enough to get a surprisingly capable bot before adding more specialized systems.
