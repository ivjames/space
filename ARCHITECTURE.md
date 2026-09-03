# Architecture — phase 0

The contract between modules. DESIGN.md says what the game is; this file
says how the code is shaped so that pieces built separately fit. Anything
not specified here is the implementer's call, but a change to a signature
below is a change to this file first.

## Constraints

- Vanilla JS, ES modules, no bundler, no framework, no npm runtime deps.
- `js/core/*` is **pure**: no DOM, no `window`, no `Date.now()`, no
  `Math.random()`. Everything it needs comes in as arguments. This is what
  makes it testable under `node --test` and reusable by the Capacitor build.
- `js/ui/*` is browser-only and imports from `js/core/*`, never the reverse.
- `js/data/*` is content: plain objects exported from JS modules (JSON can't
  be imported without a bundler in every target we care about).
- Tests: `node --test test/` on Node 22. No test framework.
- Units: SI throughout. Metres, kilograms, seconds, newtons, m/s. Money is
  an integer in "funds" (no decimals).
- Randomness: a seeded PRNG passed explicitly. Same seed, same outcome.

## Layout

```
index.html                 app shell, portrait, loads js/main.js as a module
manifest.webmanifest       PWA manifest
sw.js                      service worker: cache-first for the app shell
css/style.css
js/main.js                 boot: load save -> build state -> mount UI
js/core/rng.js             seeded PRNG
js/core/vehicle.js         stat model + delta-v
js/core/resolver.js        launch simulation -> outcome + timeline
js/core/tree.js            tech tree: load, validate, canBuy, buy, effects
js/core/economy.js         ledger: funds, reputation, resources
js/core/contracts.js       contract generation, floor contract
js/core/state.js           new game state, derived vehicle, tier progress
js/core/save.js            versioned save/load, migrations, storage adapter
js/data/components.js      base vehicle stats before tree effects
js/data/tree.js            tier 1 tree nodes
js/data/missions.js        mission templates + tier goals
js/ui/ascent.js            side-view canvas renderer, plays a timeline
js/ui/shop.js              tree UI: tiered lists, one column per branch
js/ui/hud.js               funds / reputation / launch count
js/ui/screens.js           contract pick -> loadout -> launch -> result -> tree
test/*.test.js
package.json               {"type":"module","scripts":{"test":"node --test test/"}}
```

## js/core/rng.js

```js
export function makeRng(seed)      // seed: uint32 -> { next(): float in [0,1), int(n): 0..n-1, seed }
export function deriveSeed(seed, n)  // stable child seed for the nth draw
```

mulberry32 or equivalent. `rng.next()` advances state. The save stores the
seed and a draw count so a reload replays identically.

## js/core/vehicle.js

A vehicle is a **stat block derived from the tree**, never assembled by the
player.

```js
// Stage, bottom stage first.
// { dryMass, propMass, thrust, isp, reliability }   kg, kg, N, s, 0..1

// Vehicle
// { stages: Stage[], payloadMass, dragArea, dragCoeff }

export function buildVehicle(baseComponents, effects)
  // baseComponents: from js/data/components.js
  // effects: array from tree.collectEffects(state)  (see tree.js)
  // returns Vehicle after applying effects in order

export function stageDeltaV(vehicle, i, fuelFraction = 1)
  // Tsiolkovsky for stage i carrying every stage above it plus payload

export function totalDeltaV(vehicle, fuelFraction = 1)

export function stackMassAbove(vehicle, i, fuelFraction = 1)   // helper, exported for tests
```

`fuelFraction` loads every stage to that fraction, so stage i only lifts that
much of the upper stages' propellant; `totalDeltaV(v, ff)` then agrees with
the simulated mass history.

Effects (from tree.js) are applied here. Shapes:

```js
{ stat: 'stages.0.thrust', op: 'add' | 'mul' | 'set', value: number }
{ stat: 'payloadMass',     op: 'set', value: number }
{ addStage: { dryMass, propMass, thrust, isp, reliability } }   // appends a stage
```

`stat` paths are resolved against the Vehicle object. Unknown paths throw.

## js/core/resolver.js

The simulation. Takes a vehicle, a mission, a loadout, and an rng. Returns an
outcome and a timeline the renderer plays. **The resolver never renders.**

```js
// Loadout (phase 0)
// { fuelFraction: 0.5..1.0 }

// Mission: see missions.js. Phase 0 requirement is { altitude: metres }.

export function resolveLaunch(vehicle, mission, loadout, rng, opts = {})
  // returns Outcome
```

Outcome:

```js
{
  success: boolean,
  maxAltitude: m,
  maxSpeed: m/s,
  deltaVAchieved: m/s,      // sum of stage burns actually completed
  deltaVRequired: m/s,      // mission's requirement expressed as delta-v
  shortBy: m/s,             // 0 on success; on a miss, at least the ideal
                            //   delta-v gap sqrt(2 g0 h_req) - sqrt(2 g0 maxAlt)
  failure: null | { t, stage, kind: 'ignition' | 'burn' | 'separation' },
                            // stage is 1-BASED everywhere in an Outcome
                            //   (events, samples, failure), matching readouts
  readout: string,          // one line the result screen shows,
                            //   e.g. "Reached 62 km. Short by 410 m/s."
                            //   e.g. "Stage 2 ignition failure at T+142s."
  timeline: Event[],        // sorted by t
  samples: Sample[]         // for the renderer: { t, alt, vel, mass, stage }
}
// Event: { t, kind, stage?, alt?, text }
//   kinds: 'liftoff' | 'burnout' | 'separation' | 'ignition' | 'failure'
//          | 'apogee' | 'goal' | 'end'
```

Physics, phase 0: 2D point mass from day one (position, velocity vectors),
even though tier 1 flies straight up. Gravity falls off with altitude,
exponential atmosphere for drag, thrust along the pitch program. Phase 0 pitch
program is fixed vertical. Integrator: fixed-step RK2 or better at `opts.dt`
(default 0.1 s). Stage `i` ignites when stage `i-1` burns out; a reliability
roll (`rng.next() < reliability`) happens at each ignition and, per stage,
once at a random point during the burn. Samples are decimated to
`opts.sampleEvery` (default 0.5 s) for the renderer.

Why 2D now: tier 2 is a data change (a pitch program and a velocity
requirement), not a rewrite. See DESIGN.md §14.

`deltaVRequired` for an altitude requirement: the ideal vertical delta-v to
coast to that altitude from rest, plus a fixed 15% loss allowance
(`LOSS_ALLOWANCE`, exported). A vertical ascent loses more than that, so
`required - achieved` can be negative on a miss; `shortBy` is therefore
floored by the ideal delta-v gap between the required and reached altitude,
which is positive exactly when the altitude was missed. Raising the constant
or making it per-profile is the tuning lever.

Determinism: the mid-burn reliability roll resolves at the first integrator
boundary at or after its random time, so a reliability-1 vehicle flies
bit-identically under any seed. Draw order per ignition: ignition roll, then
(only if it passed) burn-roll fraction, then the burn roll. `makeRng(seed,
draws)` fast-forwards for save replay.

## js/core/tree.js

```js
export function loadTree(nodes)            // validates; throws on cycle, missing prereq, dup id
export function canBuy(tree, state, id)    // prereqs owned && funds >= cost && !owned
export function buy(tree, state, id)       // returns new state (does not mutate)
export function collectEffects(tree, state) // effects of owned nodes, in tree order
export function branches(tree)             // [{ id, name, nodes: [ordered by level] }]
```

Node shape (js/data/tree.js):

```js
{
  id: 'eng-2', branch: 'propulsion', level: 2,
  name: 'Regenerative nozzle', desc: 'One line the shop shows.',
  cost: { funds: 1200 },              // resources keys allowed later
  requires: ['eng-1'],
  effects: [ /* see vehicle.js */ ],
}
```

Tier 1 has three branches: `propulsion`, `structure`, `reliability`. Roughly
three or four levels each. Siblings must trade off (DESIGN.md §10), so
propulsion raises thrust at an Isp cost at some levels, structure adds
propellant at a dry-mass cost, reliability raises the roll and costs funds
with no performance gain.

## js/core/economy.js

```js
export function credit(state, { funds = 0, reputation = 0, resources = {} })
export function debit(state, cost)      // throws if unaffordable
export function canAfford(state, cost)
export function applyOutcome(state, mission, outcome) // payout or rep loss
```

All return a new state. Reputation is clamped to `[0, 100]`.

## js/core/contracts.js

```js
export function generateContracts(state, missions, rng, count = 3)
  // picks from missions.js templates the state qualifies for,
  // ALWAYS includes the floor contract as the first entry
export function floorContract(missions)
export function lockReasons(state, m)   // -> [{ kind, ... }], [] = offerable
export function isEligible(state, m)    // !m.floor && lockReasons(...) is empty
```

The floor contract is always affordable and always offered. It exists so the
player can never be stuck (DESIGN.md §7). The other slots draw from the
current tier's templates first and reach back to earlier tiers only when
the current tier cannot fill them, so a tier 3 board is a tier 3 board.

`isEligible` is the one predicate `generateContracts` filters on, and
`lockReasons` is why a template fails it, so the pool and the explanation
can never disagree. `lockReasons` ignores `m.floor` (the floor is slot 0 by
construction, never drawn) and returns every unmet gate, in this order:

| shape | when |
| --- | --- |
| `{ kind: 'tier', tier }` | `m.tier > state.tier` |
| `{ kind: 'reputation', need, have }` | `state.reputation < m.minReputation` |
| `{ kind: 'node', id }` | one per node in `m.requiresNode` not in `state.owned`, template order |
| `{ kind: 'object', objectKind }` | `m.requiresObject`, and no object of that kind exists |
| `{ kind: 'unique', objectKind }` | `m.unique`, and an undocked object of `m.deploys.kind` exists |

**Hardware gating rule.** `requiresNode` is a node id or an array of them,
and every listed node must be owned. It started as the station-module gate
(`dock` needs `struct-module`, hardware the flight carries up) and is also
the gate for hardware a mission is *unflyable* without: if the resolver
cannot meet a template's requirement without a node — a downrange or orbit
flight without `guide-1` flies straight up; a rendezvous without the
restarts to burn twice stops at the match step — the template lists that
node, so the random draw never offers a contract the player has no way to
complete. Which node each template needs, and the resolver line that
decides it, is documented per tier in `js/data/missions.js`. List the
nodes the resolver checks; nodes those imply through their prerequisite
chain need not be repeated.

## js/core/state.js

```js
export function newGame(seed)      // -> State
export async function deriveVehicle(state, tree, components)  // buildVehicle(...); async (dynamic import)
export function recordLaunch(state, mission, outcome, draws = 0) // launches[state.tier], best, history (cap 20), draws
export function tierGoalMet(state, tierGoals)           // accepts the tierGoals map or a module exposing .tierGoals
```

History entries: `{ tier, missionId, success, maxAltitude, readout }`.

State (this is also the save schema, version 1):

```js
{
  version: 1,
  seed, draws,                 // rng replay
  funds, reputation,
  resources: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
  owned: [],                   // node ids
  tier: 1,
  launches: { 1: 0 },          // per tier
  best: { maxAltitude: 0 },
  contracts: [],               // current offers (mission ids)
  history: [],                 // last N outcomes, capped (N = 20)
}
```

Reputation and resources are in the schema now even though phase 0 barely
uses them (DESIGN.md §14, foundation item 6).

## js/core/save.js

```js
export const SCHEMA_VERSION = 1
export function serialize(state)          // -> string
export function deserialize(str)          // -> State at SCHEMA_VERSION, migrated
export const migrations = { /* 1: s => s */ }
export function makeStorage(backend)      // { load(), save(state), clear() }
  // backend: anything with getItem/setItem/removeItem (localStorage, or a Map shim in tests)
```

A save older than `SCHEMA_VERSION` is migrated step by step. A save newer
than it is rejected with a clear error. A corrupt save is reported, not
silently replaced.

## js/data/missions.js

```js
export const missions = [
  { id: 'sound-1', tier: 1, name: 'Sounding test', profile: 'sounding',
    requirement: { altitude: 20000 }, payout: 400, repGain: 1, repLoss: 0,
    floor: true },
  // ...
]
export const tierGoals = { 1: { requirement: { altitude: 100000 }, name: 'Reach 100 km' } }
```

## js/ui

- `screens.js` owns the flow: contracts → loadout → launch → result → (tree
  | contracts). One screen visible at a time. Portrait, one thumb: primary
  action is a full-width button at the bottom.
- `ascent.js` plays `outcome.samples` and `outcome.timeline` on a canvas
  with a **follow camera**: world space is metres, the vertical scale is
  one constant for the whole game (`VIEW_SPAN_M`, 15 km per canvas height;
  labelled ticks every 5 km, faint minor ticks every 1 km), and the rocket rests 58% up the screen
  once it has climbed that far — below it the pad is in view, above it the
  world scrolls down past the rocket. Altitude reads off the world, not a
  gauge: km tick lines and a dashed `TARGET n km` line drawn in world space,
  plus a T+ clock, altitude and speed in the top-left corner. Failure is
  shown at the moment it happens. The sprite is stage-accurate: it takes
  `opts.vehicle` and draws one segment per stage (sized by mass via the
  exported `stackGeometry`, each with its own nozzle), and at separation the
  segment that actually dropped is what tumbles away. Skippable by tap.
  **No-leak contract** (stated at the top of the file): nothing on the
  screen may reveal the outcome before the flight shows it, so during
  playback the module reads only the sample at the current sim time, the
  timeline events at or before it, and `outcome.failure` once `failure.t`
  is reached — never `maxAltitude`, `success`, `shortBy`, `readout`,
  `samples.length` or a future event. Both the scale and the playback rate
  are therefore outcome-independent: the scale is a game-wide constant (not
  the apogee, and not the target either, which would still show how a flight
  compares to what is asked before it ends), and the rate is a constant 8x real time while a stage burns, 24x
  after the last burnout or a failure (never flight-length / fixed duration,
  which would play a short flight fast). The only look-ahead is the time of
  the timeline's last event, used solely to know when to stop.
- `shop.js` renders `tree.branches()` as columns of rows. A row is
  owned / buyable / locked. Tapping a buyable row buys it and re-renders.
  Never a pan/zoom graph.
- `hud.js` is a persistent strip: funds, reputation, launches this tier.
- Result screen shows `outcome.readout` and, when applicable, which branch
  the readout points at ("short by" → propulsion/structure; a failure kind →
  reliability).
- Tier 1 win: `tierGoalMet` after a launch → win screen with the launch
  count. Phase 0 stops there; the button says "Continue" and returns to
  contracts.

## UI hooks

Stable selectors so an end-to-end smoke test does not depend on copy:

- `#hud [data-hud="funds"|"reputation"|"launches"]`
- `#screen [data-screen="contracts"|"loadout"|"launch"|"result"|"tree"|"win"]`
  — exactly one present at a time
- `.tabs [data-tab="contracts"|"tree"]` in the hud or top of screen
- contracts: `.row[data-contract="<missionId>"]`, tapping selects it
- loadout: `input[type=range][data-loadout="fuelFraction"]`
- launch: `canvas#ascent`; tapping it skips playback
- result: `.readout[data-readout]`, and `[data-points-at="propulsion"|"structure"|"reliability"|"guidance"|"loadout"]` when applicable
- tree: `.row[data-node="<id>"]` with classes owned / buyable / locked
- primary button: `#actions .btn-primary[data-action="select"|"launch"|"continue"|"back"]`
- `window.__space` exposes `{ state, tree, missions }` getters for tests only

## Testing

Every `js/core` module has a test file. Minimum:

- rng: same seed → same sequence; deriveSeed is stable.
- vehicle: Tsiolkovsky against a hand-computed case; effects add/mul/set;
  addStage; unknown stat throws.
- resolver: deterministic for a seed; a vehicle with more delta-v goes
  higher; reliability 0 always fails at ignition; success iff maxAltitude ≥
  requirement; `shortBy` is 0 on success and > 0 otherwise; samples
  monotonic in t.
- tree: cycle detection; missing prereq rejected; canBuy/buy; effects order.
- economy: debit throws when unaffordable; reputation clamps.
- contracts: floor contract always first; only qualifying templates.
- save: round trip; migration from a fabricated v0; newer version rejected;
  corrupt input reported.
- data: every node's `requires` exist; tree loads; every mission has a
  requirement; at least one mission is `floor: true`.

---

# Phase 1 — tier 2, orbit

Additions to the phase 0 contract. Everything above still holds; where a
shape is extended, the phase 0 form stays valid (tier 1 keeps working
unchanged, and `npm test` from phase 0 keeps passing).

## What tier 2 is

Altitude stops being the answer. The rocket has to turn and gain horizontal
velocity, and the mission is judged on the orbit it ends up in. DESIGN.md
§6: "More thrust stops working; the player must buy something different."
The something different is guidance (a gravity turn) and staging.

The planet is Earth-like and unnamed (fictional setting, real physics):
R = 6.371e6 m, mu = g0·R². Orbital velocity at 100 km is about 7.8 km/s;
a real ascent pays 9 km/s or more. The tier 2 tree has to take the player
from the ~3 km/s ideal of the full tier 1 tree to that.

## js/core/resolver.js — central gravity, pitch program, orbit

**Gravity becomes central.** The planet's centre is at world (0, −R). Altitude
is |r| − R. Gravity is −mu/|r|² along r. Atmosphere is a function of altitude
as before. Thrust is along the pitch program's direction, measured from local
vertical (the r direction), turning toward the prograde horizontal. Tier 1
flights are vertical, so their results must not change beyond floating-point
noise (a test asserts the tier 1 fixture's max altitude within 0.5%).

**Pitch program is a loadout choice.** Loadout gains `turn`:

```js
// Loadout
// { fuelFraction: 0.5..1.0, turn: 0..1, vertical?: boolean }
//   turn is ignored (flies vertical) unless vehicle.guidance >= 1;
//   vertical: true flies straight up whatever the guidance (sounding
//   contracts; note turn 0 is the laziest gravity turn, not vertical)
```

```js
export function pitchProgram(vehicle, loadout)
  // -> (t, alt) => angle from vertical in radians, pure, exported for tests
```

Shape: vertical until `turnStart`, then pitch increases with altitude to 90°
at `turnEnd`, where `turnStart = lerp(8 km, 1 km, turn)` and
`turnEnd = lerp(160 km, 60 km, turn)`. `turn` near 0 is a lazy turn (gravity
losses); near 1 an early hard turn (drag, and a low apogee if the vehicle is
weak). The right value depends on the vehicle, which is what makes it a
decision. Constants exported so data and balance tooling can read them.

**Vehicle gains a stat.** `vehicle.guidance` (integer, default 0). The tree
sets it with `{ stat: 'guidance', op: 'set', value: 1 }`. `buildVehicle`
must accept unknown top-level numeric stats from the base components so
this is a data change; `components.js` adds `guidance: 0` to the starter.

**Requirements** (a mission has exactly one):

```js
{ altitude: m }                  // tier 1: max altitude >= m
{ downrange: m }                 // surface arc from the pad >= m at impact
                                 //   (or at orbit, which trivially satisfies it)
{ orbit: { periapsis: m } }      // after final burnout, periapsis >= m
```

**Orbit elements** from the state vector: ε = v²/2 − mu/r, h = |r × v|,
a = −mu/2ε, e = √(1 + 2εh²/mu²), periapsis = a(1−e) − R, apoapsis =
a(1+e) − R (apoapsis is +Infinity when ε ≥ 0). Exported as
`orbitElements(r, v)` for tests.

**Outcome** gains fields; existing ones keep their meaning:

```js
{
  ...phase 0 fields,
  maxDownrange: m,
  periapsis: m | null,          // at end of flight; null if it never left the pad
  apoapsis: m | null,           // +Infinity allowed
  orbit: boolean,               // periapsis >= ORBIT_MIN_ALT (80 km, exported)
                                //   at any point after the final burnout
}
```

`deltaVRequired` per requirement: altitude as in phase 0; downrange: the
ideal ballistic delta-v for that range on a flat-ish planet plus the same
loss allowance (document the formula); orbit: circular velocity at the
required periapsis plus a loss allowance of 25% (`ORBIT_LOSS_ALLOWANCE`).
`shortBy` on a miss: altitude as in phase 0; downrange: floored by the ideal
delta-v gap between the required and achieved range; orbit: the delta-v to
raise periapsis from the achieved value to the required one at apoapsis by
vis-viva, or, if the flight never reached the required altitude at all, the
altitude gap as in phase 0, whichever is larger. Always > 0 on a miss.

**Flight end.** Tier 1 behaviour is unchanged: an altitude requirement ends
the flight at apogee. Downrange ends at impact (altitude < 0) or at orbit.
Orbit ends once orbit is confirmed after the final burnout plus a short
coast (30 s, so the player sees it), or at impact, or at `opts.maxTime`.

**Events** gain: `'turn'` (pitch program leaves vertical), `'orbit'` (orbit
confirmed, text like "Orbit: 112 × 340 km."), `'impact'`. Readouts:
- orbit success: "Orbit: 112 × 340 km."
- orbit miss with an ellipse: "Apoapsis 240 km, periapsis −1 800 km. Short by 1 240 m/s."
- downrange: "Impact 640 km downrange." / "Impact 310 km downrange. Short by 420 m/s."
- failure readouts as in phase 0.

**Samples** gain `x` and `y` (world position, m) and `downrange` (m), so the
renderer can follow horizontally and draw a trajectory.

## js/core/tree.js, js/data/tree.js — tiers in the tree

Node gains `tier` (integer, default 1). `branches(tree, maxTier = Infinity)`
returns only nodes with `tier <= maxTier`; `canBuy` refuses a node whose
tier is above `state.tier`. A new branch `guidance` appears in tier 2.
Tier 2 nodes require tier 1 nodes as prerequisites where that makes sense
(the second stage before a third, the top engine before the vacuum engine).

Tier 2 branches, roughly: propulsion (vacuum-optimised upper-stage engines,
higher Isp), structure (a third stage, lighter tanks: dry-mass reductions),
guidance (the gravity turn itself, then refinements that widen the good
`turn` window or reduce losses), reliability (upper-stage and restart
reliability). Twelve to sixteen nodes. The balance tool proves the ladder.

## js/core/state.js, js/core/save.js — tier progression, schema v2

```js
export function advanceTier(state)   // tier + 1, launches[tier] = 0, contracts cleared
export function tierGoalMet(state, tierGoals)   // unchanged signature; checks
                                                // the goal for state.tier
```

`best` becomes per-tier and per-metric:

```js
best: {
  maxAltitude: 0,            // kept for tier 1 and old saves
  maxDownrange: 0,
  bestPeriapsis: null,
  wins: { 1: true }          // which tier win screens have been shown
}
```

`SCHEMA_VERSION = 2`; `migrations[1]` maps `best.winShown` → `best.wins[1]`
and fills the new fields. Tier goals are evaluated against `best`:
tier 1 on `maxAltitude`, tier 2 on `bestPeriapsis`.

`recordLaunch` updates `maxDownrange` and `bestPeriapsis` (max) from the
outcome. History entries gain `periapsis` and `downrange`.

## js/data/missions.js — tier 2 ladder

Tier 2 templates, all `tier: 2`, with `minReputation` gates so the tier is
where reputation starts to matter: a downrange rung or two (the turn matters
before orbit is reachable), a high-apogee rung, a low-orbit rung, and the
goal. `tierGoals[2] = { requirement: { orbit: { periapsis: 100000 } }, name:
'Reach orbit' }`. Contracts already filter by `tier <= state.tier`; tier 1
templates stay in the pool as cheap fillers.

Every template with a `downrange` or `orbit` requirement carries
`requiresNode: 'guide-1'`: `pitchProgram` flies straight up unless
`vehicle.guidance >= 1`, and guide-1 is the only node that sets it, so those
shapes are unflyable without it and must not be drawn until it is owned
(the hardware gating rule under "js/core/contracts.js"). The two
altitude-shaped templates are deliberately ungated — an altitude
requirement is the one shape guidance does not gate: the sounding filler
`orbit-entry` so a tier 2 board has something on it before the first
purchase, and `orbit-apogee`, which a strong enough vehicle clears straight
up (the gate is for the impossible, not the merely hard).

## js/ui — what tier 2 adds

- **Loadout** gains a `turn` slider (`input[type=range][data-loadout="turn"]`,
  0..1, step 0.05, default 0.5) shown only when `vehicle.guidance >= 1` AND
  the mission is not an altitude (sounding) contract; a sounding flight goes
  straight up whatever guidance the vehicle carries, and the loadout says
  so. With no guidance the hint reads "No guidance: flies vertical."
  Loadout values persist in `view` between launches.
- **Ascent view** follows the rocket horizontally as well as vertically (same
  fixed scale in both axes), draws the flown trajectory as a faint trail
  behind the rocket, shows downrange next to altitude and speed, and prints
  the `turn`, `orbit` and `impact` events in the ticker. The planet stays
  drawn flat; curvature is not shown at this scale. No-leak contract holds:
  nothing read ahead of sim time.
- **Result** readouts per requirement as above; points-at: with
  `vehicle.guidance === 0` on anything but an altitude contract, guidance
  alone ("No guidance: a vertical flight cannot orbit") — no delta-v and no
  loadout orbits a vehicle that cannot turn. Otherwise any shortfall
  (altitude, orbit, downrange, or an ascent that never inserted) →
  propulsion/structure; a branch that is fully owned at this tier
  (`branchExhausted`, tree.js) is not pointed at, and when both are the
  shortfall points at `loadout` — "fuel load and turn are the levers", or
  "fuel load is the lever" on an altitude contract, which flies vertical —
  naming the levers, never the setting.
- **Tree** shows nodes with `tier <= state.tier`, grouped by branch; a tier 2
  node lists its tier 1 prerequisites by name when locked.
- **Win, tier 1** → Continue → `advanceTier`, contracts regenerate, a short
  "Tier 2: Orbit" interstitial (`[data-screen="tier"]`) with the goal, then
  contracts. **Win, tier 2** → "Reached orbit in N launches" and phase 1 stops
  there (Continue returns to contracts, tier stays 2).
- HUD shows the tier ("T2") next to launches.

## UI hooks, additions

- `[data-loadout="turn"]`
- `[data-screen="tier"]`, its continue is `[data-action="continue"]`
- `#hud [data-hud="tier"]`
- `window.__space.cheat({ funds, reputation })` credits funds and reputation, tests only

## Balance, phase 1

`tools/balance.mjs` gains tier 2: the cheapest prereq-valid set (over tier 1
and tier 2 nodes) reaching each tier 2 mission, searched over `turn` in
steps of 0.05 and fuelFraction 1; the full-tree orbit (periapsis with the
best turn); and a greedy player who starts from the tier 1 greedy end state
and reaches the tier 2 goal, reported in launches. Target 15 to 60 launches (dry streak 4 or under)
for tier 2. `data.test.js` asserts: some set reaches the orbit goal; every
tier 2 mission is reachable; greedy tier 2 launches ≤ 80; no purchase
order strands liftoff TWR below 1.05.

---

# Phase 2 — tier 3, orbital maneuvering

Additions to the phase 0 and 1 contracts. Tiers 1 and 2 keep working
unchanged; every existing test keeps passing.

## What tier 3 is

A capability tier with no destination of its own (DESIGN.md §6). The player
learns to put something in orbit and leave it there, then to fly a second
launch to it: match orbits, phase, approach, dock. The goal is to assemble a
two-part station: a core launched and left in orbit, then a module docked
to it. What the tier really buys is restartable upper stages, rendezvous
navigation and docking, which tiers 4 to 6 all need.

Nothing is piloted. After insertion the **orbital phase** is resolved
analytically as a sequence of burns the vehicle can or cannot perform, and
the map view plays that sequence back.

## Persistent objects in orbit — js/core/state.js

```js
state.objects = [
  { id: 'core-1', kind: 'core' | 'module' | 'satellite', name,
    periapsis: m, apoapsis: m,
    phase: 0..1,          // where it is on its orbit at epoch; fixed from a
                          //   hash of id (js/core/orbit.js: phaseFor(id))
    dockedTo: id | null,
    launchedAt: { tier, launch } },
]
```

A mission with `deploys: { kind, name }` adds an object on success, in a
circular orbit at the mission's required periapsis when it has an orbit
requirement (the object settles at its design altitude), else at the
achieved periapsis. Objects are always circular: an elliptical or
arbitrarily high deploy would be unmatchable by a later launch. `unique: true` on a template means it is offered
only while no undocked object of that kind exists. A template with
`requiresObject: 'core'` is offered only while one exists. Contracts get
`state` as they already do; `generateContracts` applies both rules.

```js
export function findTarget(state, kind)   // newest undocked object of that kind, or null
export function addObject(state, obj)     // returns new state
export function dockObject(state, id, toId)
```

## js/core/orbit.js — new, pure

Kepler helpers shared by the resolver and the map view.

```js
export const MU, R                          // same planet as resolver.js
export function elementsFrom(rp, ra)        // { a, e, period }
export function velocityAt(a, r)            // vis-viva
export function hohmann(r1, r2)             // { dv1, dv2, tof }  circular to circular
export function transferDeltaV(rp1, ra1, rp2, ra2)
  // total delta-v to go from orbit 1 to orbit 2: Hohmann between the two
  // semi-major axes, plus an eccentricity-mismatch term
  //   |e1 - e2| * velocityAt(a2, a2) * 0.5. Document the approximation.
export function phasingDeltaV(angleDeg)     // PHASING_DV_PER_DEG * angleDeg, exported constant 4 m/s per degree
export function positionAt(rp, ra, argPeriapsis, phase0, t)
  // { x, y, r, trueAnomaly } in planet-centred coordinates at time t, from a
  // Kepler solve (mean anomaly -> eccentric -> true). phase0 is the orbit
  // fraction at t = 0.
export function phaseFor(id)                // 0..1, stable hash of the id string
```

## js/core/resolver.js — the orbital phase

**New requirement shapes** (a mission has exactly one):

```js
{ rendezvous: { target: 'core', within: m } }   // closest approach <= within
{ dock: { target: 'core' } }                     // docked
```

Both need the target object. `resolveLaunch(vehicle, mission, loadout, rng,
opts)` gains `opts.target` (the object, from `findTarget`); absent target on
a rendezvous/dock mission throws.

**Loadout gains `window`** (0..1): the launch window relative to the target's
phase. `phaseErrorDeg = wrap(loadout.window - target.phase) * 360`, in
(−180, 180]. Shown only for rendezvous/dock missions.

**Vehicle gains stats** (all integers, default 0, set by the tree):
`restarts` (upper-stage relights available), `nav` (0..3 rendezvous
navigation quality), `docking` (0/1), `rcs` (0/1 fine approach thrusters).

**The sequence**, resolved after insertion only if the vehicle reached
orbit (periapsis ≥ ORBIT_MIN_ALT); otherwise the outcome is the tier 2 miss
with `closestApproach = null`:

1. **Budget.** `dvAvailable` = ideal delta-v left in the final stage from
   the propellant remaining at final burnout (Tsiolkovsky on the remaining
   mass). Report it.
2. **Match.** `dvMatch = transferDeltaV(achieved, target orbit)`. Needs 2
   restarts (one per burn). Burns at insertion + P/2 and + P, where P is the
   achieved orbit's period.
3. **Phase.** `dvPhase = phasingDeltaV(|phaseErrorDeg|)`, needs 1 restart if
   `|phaseErrorDeg| > 5`, else 0. Two burns at + 1.5P and + 2.5P (one
   restart covers the pair: the second is the same relight window).
4. **Approach.** `closestApproach = NAV_APPROACH[nav] * (1 + |phaseErrorDeg| / 30)`
   where `NAV_APPROACH = [50000, 5000, 500, 50]` m; halved if `rcs`. Needs
   1 restart (or 0 if `rcs`). At + 3P.
5. **Dock** (dock missions only): needs `docking >= 1` and
   `closestApproach <= DOCK_RANGE` (100 m). Roll `rng.next() < DOCK_RELIABILITY`
   (0.90, or 0.98 with `rcs`). At + 3P + 600 s.

Each restart consumes a reliability roll against the final stage's
reliability (`kind: 'restart'` failure; draw order documented). The
sequence stops at the first step it cannot afford (delta-v or restarts) or
that fails; `closestApproach` is then the separation at that point:
before match, the difference in mean altitude plus the phasing arc
(`|phaseErrorDeg| / 360 * 2π * a`); after match but before approach, the
phasing arc alone; after approach, the computed value.

**Outcome** gains:

```js
{
  ...phase 0 and 1 fields,
  insertion: { t, periapsis, apoapsis } | null,
  orbital: null | {
    target: { id, periapsis, apoapsis, phase },
    dvAvailable, dvUsed, phaseErrorDeg,
    burns: [{ t, kind: 'match' | 'phase' | 'approach' | 'dock', dv, ok }],
    closestApproach: m,
    docked: boolean,
    stoppedAt: null | 'restarts' | 'deltaV' | 'restart-failure' | 'dock-failure',
  },
  closestApproach: m | null,
  docked: boolean,
}
```

Success: rendezvous iff `closestApproach <= within`; dock iff `docked`.
`shortBy`: on a delta-v stop, the delta-v the sequence still needed; on a
restarts stop, 0 and the readout says restarts; on approach-too-wide, 0 and
the readout says navigation. `deltaVRequired` for these shapes: the tier 2
orbit requirement to the target's periapsis plus `dvMatch + dvPhase(0) +
approach allowance (50 m/s)`.

**Events**: `'insertion'` ("Orbit insertion: 182 × 240 km."), `'burn'`
("Orbit match burn 1: 140 m/s."), `'restart-failure'`, `'approach'`
("Closest approach 3.2 km."), `'dock'` ("Docked."), `'dock-failure'`
("Docking aborted: 0.9 m/s closing rate."). Times as above, so the map view
can play them at a fixed rate.

**Readouts**: "Docked to Station core." / "Closest approach 14 km." /
"Closest approach 3.2 km. Short by 210 m/s." / "No restart available for
the phasing burn." / "Stage 3 restart failure at T+5400s." / "Docking
aborted." Ascent failures as before.

**Samples** are unchanged (ascent only). The map view computes orbital
positions from `insertion`, `orbital.burns` and `js/core/orbit.js`.

## js/core/tree.js, js/data/tree.js — tier 3

Tier 3 nodes (`tier: 3`), 12 to 14, four branches:
- propulsion: restartable upper stage (`restarts` set 1), multi-restart
  (`restarts` add 2), reaction control (`rcs` set 1), a propellant reserve
  on the top stage (propMass add, dryMass add).
- guidance: rendezvous radar (`nav` set 1), star tracker (`nav` set 2),
  docking sensors (`nav` set 3). Also give `guide-2` from tier 2 an honest
  effect now if the resolver reads `guidance >= 2` for anything; if not,
  leave it.
- structure: docking adapter (`docking` set 1), lighter payload fairing
  (payloadMass or dryMass reduction), station module (a prerequisite of the
  dock mission's template via `requiresNode`, see missions).
- reliability: restart qualification (top stage reliability mul), docking
  rehearsal (raises DOCK_RELIABILITY via a `dockBonus` stat the resolver
  adds to the roll threshold, capped at 0.99).

## js/core/state.js, js/core/save.js — schema v3

`SCHEMA_VERSION = 3`; `migrations[2]` adds `objects: []`,
`best.bestClosestApproach: null`, `best.docked: false`. `recordLaunch`
updates those from the outcome and applies `deploys` (adds the object) and
docking (`dockObject`). History entries gain `closestApproach` and `docked`.
`tierGoalMet` handles `{ dock }` (any object with `dockedTo` set) and
`{ rendezvous }` (bestClosestApproach ≤ within).

## js/data/missions.js — tier 3 ladder

All `tier: 3`. `satellite` (orbit ≥ 150 km, `deploys: { kind: 'satellite' }`,
repeatable, the tier's income filler), `core` (orbit ≥ 200 km, `deploys:
{ kind: 'core', name: 'Station core' }`, `unique: true`), `rdv-1`
(rendezvous within 5 km, `requiresObject: 'core'`), `rdv-2` (within 500 m),
`dock` (the goal: `{ dock: { target: 'core' } }`, `deploys: { kind:
'module', name: 'Lab module' }` docked on success, `requiresNode`
including `'struct-module'`). `tierGoals[3] = { requirement: { dock: {
target: 'core' } }, name: 'Assemble a station' }`. Reputation gates rise
again.

`generateContracts`: templates with `requiresNode` (a node id or an array
of them) are offered only when every listed node is owned. The floor
contract stays tier 1's. Under the hardware gating rule ("js/core/
contracts.js"), the tier's gates follow the orbital sequence's own checks:
`satellite` and `core` need `guide-1` (an orbit needs a turn); `rdv-1`
needs `['prop-11', 'guide-3', 'prop-12']` and `rdv-2` `['prop-11',
'guide-4', 'prop-12']` — the match step stops at `restarts < 2`, which
only prop-11 lifts (rcs waives the approach restart, never the match's);
`NAV_APPROACH[nav]` against `closestApproach <= within` makes nav 1 the
floor for 5 km and nav 2 for 500 m; and rcs (prop-12) is what gives those
floors a margin, because nav 1 and nav 2 meet their rung only at zero
phase error and the window slider steps by 0.01 of an orbit (3.6°), so
the error is never zero — halved by rcs, both rungs hold at the slider's
worst half-step of 1.8°. `dock` needs `['struct-module', 'prop-11',
'guide-5']` — the dock step wants `closestApproach <= DOCK_RANGE` (100 m),
which nav 3's 50 m meets with margin and nav 2 + rcs's 250 m does not, and
struct-module's prerequisite chain carries the docking adapter (struct-9).
guide-1 and prop-10 arrive through those chains too, so each missing
purchase is reported once. A gate must hold at that worst-case slider
error, not just at zero; `data.test.js` checks each one against the
resolver's constants.

## js/ui — what tier 3 adds

- **Loadout**: `window` slider `[data-loadout="window"]` 0..1 step 0.01,
  shown for rendezvous/dock missions, labelled as a launch window with the
  value shown in degrees of orbit (value × 360). Persisted in `view`. The
  vehicle stats block shows restarts, nav, docking, rcs when non-zero.
  Its hint names the TARGET's own phase ("Station core is at 280°. Inserts
  288° round the orbit."): the target's phase is state — the map draws it
  from its first frame — so quoting it predicts nothing. The hint does NOT
  compute the resulting phase error; that is the flight's to report on the
  result screen, and working it out from the two numbers is the decision.
- **Launch screen** for a mission with a target: the ascent view plays to
  the `insertion` event (or the end, if the flight never inserts), then the
  SAME `canvas#ascent` element is handed to the **map view** (`js/ui/map.js`),
  which plays the orbital phase from insertion. Tap skips whichever view is
  playing. The handoff is `playOutcome`'s `opts.stopAtKind` ('insertion'):
  the ascent's one look-ahead becomes the time playback ENDS at rather than
  the last event's time, which is the same single instant used for the same
  single purpose. The ascent's dashed target marker on these missions is the
  TARGET's periapsis — the orbit the resolver cuts the ascent off at, and
  state, so it leaks nothing.
- **Map view**: planet-centred. Planet drawn as a circle with the day/night
  terminator implied by shading; orbits as ellipses; altitude exaggerated by
  a constant factor (`ALT_EXAGGERATION`, about 6) so a 200 km orbit is
  legible against a 6371 km planet; a note in the header says so. Shows the
  vehicle on its current orbit, the target on its, both moving by
  `positionAt` at a fixed playback rate (`MAP_RATE`, 600× real time, so a
  three-period sequence plays in about 25 s), burns as a flash and a ticker
  line at their event time, the closest approach as a line between the two
  when the approach event lands, docking as the two merging. Same no-leak
  contract: nothing drawn or timed from the outcome ahead of sim time; the
  vehicle's orbit is drawn from `insertion` (already happened), and after
  each burn's time from the burn's resulting elements. The target's orbit
  and phase are state, drawable from the start. Two things the picture has to
  decide that the resolver does not: the vehicle's drawn phase carries across
  a burn unchanged, except that the second phasing burn (which is what ENDS
  the phasing) puts it at the target's phase and a successful dock merges the
  two; and the line drawn between the craft quotes the `approach` event's own
  text when that event has passed, or, on the final frame of a sequence that
  never approached, the plain geometric separation on screen at that instant
  ("separation 12 000 km") — never `orbital.closestApproach`, which is a model
  number rather than a distance between two drawn dots.
- **Result**: rows per requirement: closest approach, phase error at
  insertion as "Target was 62° ahead" (sign from `phaseErrorDeg`), delta-v
  used of available, docked. Points-at: `stoppedAt: 'restarts'` →
  propulsion; approach too wide → guidance; no docking adapter → structure;
  delta-v → propulsion/structure.
- **Contracts screen**: an "In orbit" block listing `state.objects` with
  their orbit and docked state; the tier 3 goal hint reads best closest
  approach / docked.
- **Contracts screen, missions block**: below the board and above "In
  orbit", `[data-missions]` lists every template of the current tier in
  `js/data/missions.js` order, one non-tappable row each, with its
  requirement, payout, and a reason line: "On the board now." / "Always
  offered." (floor) / "Available — not on this board." / one sentence per
  `lockReasons` entry joined by " · " ("Needs <node name>", "Needs N rep
  (have M)", "Needs a <kind> in orbit", "A <kind> is already in orbit").
  Locked rows carry `.locked` and `[data-locked]`; the head counts
  "k of n available". The board hides what cannot be done yet; this is
  where the ladder and what unlocks each rung are seen.
- **Tier flow**: tier 2 win → Continue → `[data-screen="tier"]` "Tier 3:
  Orbital maneuvering" → contracts. Tier 3 win → "Assembled a station in N
  launches" and phase 2 stops there.
- HUD tier shows "T3".

## UI hooks, additions (phase 2)

- `[data-loadout="window"]`
- `[data-screen="contracts"] [data-objects]` the in-orbit block
- `[data-screen="contracts"] [data-missions]` the tier's mission ladder;
  `.row[data-mission="<id>"]` per template, `.locked` / `[data-locked]`
  when `lockReasons` is non-empty
- the launch canvas stays `canvas#ascent` through both views; tap skips both
- `[data-result="closest-approach"]`, `[data-result="docked"]`

## Balance, phase 2

`tools/balance.mjs` gains tier 3: with the core deployed at its template
orbit, the cheapest prereq-valid set reaching each tier 3 rung (searching
`turn` and `window` coarsely), the greedy player from the tier 2 end state
through the tier 3 goal (target 15 to 60 launches, dry streak 4 or under), the delta-v budget of
the top stage after insertion for the cheapest set (must cover match +
phase(≤ 30°) + approach with margin), and the TWR sweep extended to tier 3
sets. `data.test.js` asserts reachability of every tier 3 rung and greedy
≤ 80.
