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
```

The floor contract is always affordable and always offered. It exists so the
player can never be stuck (DESIGN.md §7).

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
  shown at the moment it happens; a spent stage drops away at separation.
  Skippable by tap.
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
- result: `.readout[data-readout]`, and `[data-points-at="propulsion"|"structure"|"reliability"]` when applicable
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
