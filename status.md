# Plans / Progress

Last updated: 2026-05-02

---

## Current Focus

Stabilization and realism improvements:
- unarmed behavior
- loot-object interaction
- reduced state thrash
- clearer combat vs loot separation

---

## Done (Core Systems)

- Internal bot system (`BotManager`, `BotController`)
- Config system (`Config.bots`)
- Brain system (practice / realistic / competitive)
- Difficulty system
- Wave mode
- Bot fill/retire system
- Threat snapshot system
- Navigation system (detours + fallback)

---

## Done (Behavior / Tuning)

- Movement state machine
- Cover-lite system
- Loot system (nearby + opportunistic)
- Item usage system
- Aim + weapon handling
- Brain differentiation
- Stability improvements (state commit + hysteresis)

---

## Done (Recent Additions)

- Loot-object interaction (crates, doors, buttons)
- Unarmed bot behavior:
  - dedicated internal unarmed brain
  - gun-first arming logic
  - loot-object farming by default when safe
  - weapon memory for visible hostiles
  - distracted-armed vs truly-unarmed threat handling
- Stability logging
- Improved healing/boost discipline
- Reduced anchor rigidity (more strafe fallback)

---

## In Progress

- Manual testing (join/leave, lobby behavior)
- Parity/debug cleanup

---

## Next

- Duo/squad bot pairing
- Players-vs-bots mode
- Additional telemetry (stuck, loot commit, fallback)

---

## Guiding Principles

- Prefer simple local decisions over global planning
- Do not add systems before stabilizing current ones
- Do not use tuning to hide logic bugs
- Keep behavior predictable and debuggable
- Expand scope gradually:
  - nearby → local → global
