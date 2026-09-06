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
  One view may import another's constants, and its world-drawing, where the two
  have to agree about something visible — `js/ui/surface.js` takes `VIEW_SPAN_M`
  and the rest of the ruler from `js/ui/ascent.js`, which is what makes the
  landing at the moon the same scale as the launch rather than a scale that
  looks like it, and it takes `skyAt`, `paintSky`, `drawStarField`,
  `drawCloudLayer` and the ink/ground blends as well, so the capsule comes home
  through the atmosphere the rocket launched through rather than a second one
  that resembles it.
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
sw.js                      service worker: cache-first on a per-deploy cache;
                           its CACHE_NAME stamp is the update signal
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
                            // the failure that ENDED powered flight (terminal);
                            //   see "Stage abort systems" (tier 2 addition,
                            //   below) for what this means once a failure can
                            //   be escaped instead
  readout: string,          // one line the result screen shows,
                            //   e.g. "Reached 62 km. Short by 410 m/s."
                            //   e.g. "Stage 2 ignition failure at T+142s."
  timeline: Event[],        // sorted by t
  samples: Sample[]         // for the renderer: { t, alt, vel, mass, stage, dv }
                            //   dv is the delta-v still ABOARD at that
                            //   instant (m/s): what is in the flying stage's
                            //   tank at the isp it is actually running, plus
                            //   the ideal delta-v of every stage above it.
                            //   0 once a terminal failure has happened. Like
                            //   `vel` and `mass` it is a property of the
                            //   state at `t`, so the renderer may show it
                            //   live without breaking the no-leak contract.
                            //   Not to be confused with `deltaVAchieved`
                            //   (spent) or `deltaVRequired` (the budget)
}
// Event: { t, kind, stage?, alt?, text }
//   kinds: 'liftoff' | 'burnout' | 'separation' | 'ignition' | 'failure'
//          | 'apogee' | 'goal' | 'end'
//   a 'failure' event can carry `escaped: true` and a 'separation' event
//   `{ abort: true }` — see "Stage abort systems" below; later phases add
//   'turn', 'orbit', 'insertion' and 'anomaly' (see "Anomalies", last)
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
export function boardStale(state, missions, count = 3) // redraw state.contracts?
```

`boardStale` says when a board drawn earlier no longer matches the state:
it holds an offer that is not eligible any more, or it fell short of the
current tier (a slot empty or reached back to an earlier tier) and a
current-tier template it does not hold has become eligible since — the
"bought guidance, board still has no orbit contract" case. A board whose
drawn slots are all eligible current-tier offers is never stale, so a
purchase is not a re-roll. `main.js` applies it at boot and `screens.js`
every time the contracts screen is shown; both redraw through the same
rng stream a launch does.

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

**Gating rule.** `requiresNode` is a node id or an array of them, and every
listed node must be owned. DESIGN.md §9 says contracts follow the player's
unlocked capabilities, and this is how: the board never offers a contract
the current vehicle cannot fly. For an altitude, downrange or orbit
template the gate is the *generator set of the cheapest prereq-valid node
set that reaches its requirement* — that set's nodes minus those another
member's prerequisite chain already implies, so a locked contract reports
each missing purchase once. `tools/gates.mjs` derives these from the real
resolver (every prereq-valid set of trajectory-affecting nodes, full fuel,
reliability forced to 1, the turn range swept) and `test/data.test.js`
pins each template's list to it. A rung reachable by some other path stays
hidden until that purchase; the ladder tab names it. A node that makes the
vehicle worse for a shape can leave a superset of a gate short of the rung
(prop-7 on orbit-low); data cannot say "not this node", so each such
exception is named at the template and pinned by test. Where a node is
harmful only in some purchase orders, making it *require* the node that
offsets it retires the exception outright — prop-13 requires struct-10 for
exactly this reason, and satellite has no falling supersets as a result.

For a rendezvous or dock template the gate is the hardware the orbital
sequence's own checks refuse to run without (restarts, nav level, rcs, the
docking adapter, the station module) **plus the ascent hardware that leaves
the sequence a reserve to spend** (prop-13, and struct-10 through its
chain). `requiresObject: 'core'` does *not* stand in for the second half:
a core in orbit proves the vehicle reached 160 km, not that it arrived
with propellant held back and on a shape worth matching, and the orbit
match is charged before nav quality is consulted at all. Both halves are
read off `js/core/resolver.js`, measured against it over every
prereq-valid node set and every selectable loadout, and documented per
node in `js/data/missions.js`.

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
  plus a telemetry card in the top-left corner — two columns of three rows:
  mission clock (`T+ MM:SS`), altitude and speed on the left; stage `n/N`,
  downrange and the delta-v still aboard (`sample.dv`) on the right. Failure is
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
  reliability). From the tier 2 abort systems on (below), the readout's own
  `kind` is `'failure'` only for a terminal failure — an escaped one colours
  as whatever the flight went on to do, with its own reliability hint.
- Tier 1 win: `tierGoalMet` after a launch → win screen with the launch
  count. Phase 0 stops there; the button says "Continue" and returns to
  contracts.

## UI hooks

Stable selectors so an end-to-end smoke test does not depend on copy:

- `#hud [data-hud="funds"|"reputation"|"launches"]`
- `#screen [data-screen="contracts"|"loadout"|"launch"|"result"|"tree"|"win"]`
  — exactly one present at a time
- `.tabs [data-tab="contracts"|"missions"|"tree"]` in the hud or top of screen
- contracts: `.row[data-contract="<missionId>"]`, tapping selects it
- loadout: `input[type=range][data-loadout="fuelFraction"]`
- launch: `canvas#ascent`; tapping it skips playback
- result: `.readout[data-readout]`, and `[data-points-at="propulsion"|"structure"|"reliability"|"guidance"|"loadout"]` when applicable
- tree: `.row[data-node="<id>"]` with classes owned / buyable / locked.
  Owned rows are hidden by default; `[data-toggle-owned]` (a button in the
  `.shop-bar` above the branches, `aria-pressed` reflecting the state) shows
  and hides them. The setting lives for the page, not in the save.
- primary button: `#actions .btn-primary[data-action="select"|"launch"|"continue"|"back"]`.
  On the launch screen there is none while the flight plays — `#actions` is
  `hidden` and the ticker takes the room — and `continue` appears when
  playback finishes. Tap the canvas to skip to that point.
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
renderer can follow horizontally and draw a trajectory, and `dv` (m/s, the
delta-v still aboard) so the telemetry card can show it live.

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
reliability, plus the two abort-system nodes — "Stage abort systems",
below). Twelve to sixteen nodes (15, currently). The balance tool proves the
ladder.

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

Every template carries the gate the rule under "js/core/contracts.js"
gives it: the generators of its cheapest reaching set. The `downrange` and
`orbit` shapes all include `guide-1` (`pitchProgram` flies straight up
unless `vehicle.guidance >= 1`, and guide-1 is the only node that sets it);
the two altitude shapes do not, since they are flown vertical. The sounding
filler `orbit-entry` is gated on the tier 1 goal set's generators, which a
tier 2 arrival owns by construction, so a fresh tier 2 board still has it.

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

## Stage abort systems (tier 2 addition)

Reliability failures can be escaped instead of ending the flight, once the
tree has bought coverage for them. Only the failures that put an engine out
— the `'ignition'` and `'burn'` kinds — are escapable, because an abort
exists to throw the stack clear of a stage that has physically failed. An
anomaly ("Anomalies", last) is not one: an underperforming engine is still
burning and a guidance failure leaves every engine healthy, so dropping a
working stage would cost the rest of its burn and give nothing back. This
needs no guard in the code — an anomaly never calls `cutThrust`, which is
the only place an abort is decided.

**Vehicle gains a stat.** `vehicle.escape` (integer, default 0), added to
`CAPABILITY_STATS` alongside `guidance`, `restarts`, `nav`, `docking`, `rcs`,
`dockBonus`; `components.js` declares `escape: 0` on the starter. Meaning:
abort coverage — a failure, in flight, of any of the bottom `escape` stages
lets the stack above separate clear and light its own engine, still flying
its pitch program (control is retained). A failure below `ESCAPE_MIN_ALT`
(the stack has not cleared the pad — an ignition failure at T+0, or a burn
failure in the first seconds off it) and a failure of the top stage are never
escaped, whatever `escape` is set to: below that altitude the stack would
coast straight back into the ground before the relight, so the abort is not
armed and the failure takes the stack down as before. The abort itself never
rolls and adds no mass.

`js/core/resolver.js` exports `ESCAPE_DELAY = 2` (s) and `ESCAPE_MIN_ALT =
100` (m). On an escapable failure of 1-based stage `k` at time `t`:
- the `'failure'` event carries `escaped: true` (same text as an unescaped
  failure, e.g. "Stage 1 engine failure at T+40s.");
- a `'separation'` event `{ stage: k, abort: true }` fires, text "Abort:
  stage k+1 separates from stage k.";
- the failed stage's dry mass and remaining propellant are dropped from the
  stack;
- stage `k+1` ignites at exactly `t + ESCAPE_DELAY`, with its normal
  ignition roll — if that fails and is itself covered, another abort
  follows.

Apogee detection is suppressed during the coast (a burn is still coming),
but a turnover of the altitude rate seen inside it is not lost: if the
relight then fails terminally, the 'apogee' event is emitted on the first
step after the coast (at `maxAltitude`) and the end-at-apogee rule for
altitude missions applies, so such a flight ends at apogee rather than
running to impact. If the relight lights, the turnover is discarded and the
real apogee is found after the burn, as before.

No rng draw is added for the abort itself, so a flight with no escaped
failure has an unchanged draw order and the save-replay contract
(js/core/rng.js) holds whether or not `escape` is set.

**Outcome.** `failure` keeps its shape (`{ t, stage, kind }`) but its
meaning narrows: it is the failure that ended powered flight (terminal), or,
if none did, the first escaped failure, carrying `escaped: true`; null if
nothing failed. An orbital-phase restart failure (phase 2) is terminal and
so replaces an escaped ascent failure here — the field always names the
failure that actually ends the flight. New field `escapes: number`, the
count of aborts actually flown (0 on a flight with no failure, or with an
uncovered one).

**Readout.** A terminal failure reads as before. Each escaped failure
appends a clause: "Stage 1 engine failure at T+40s; stage 2 escaped clear.",
e.g. "Reached 61 km. Short by 400 m/s. Stage 1 engine failure at T+40s;
stage 2 escaped clear." The escape clauses come before the anomaly sentences
("Anomalies", last), which stay last of all: what the flight ended with or
survived, then what merely went wrong on the way.

**Tree** (`js/data/tree.js`, tier 2, reliability branch): two new nodes,
`rel-escape-1` "Booster abort system" (level 6, 11000 funds, requires
`rel-2` and `struct-4`, `{ stat: 'escape', op: 'set', value: 1 }`) and
`rel-escape-2` "Upper-stage abort system" (level 8, 19000 funds, requires
`rel-escape-1` and `struct-6`, `{ stat: 'escape', op: 'set', value: 2 }`).
The existing tier 2 reliability levels shift to keep order: old `rel-6`
(Stage 3 restart qualification) becomes level 7, old `rel-7` becomes level
9, old `rel-8` becomes level 10 — ids unchanged, only `level` moves. Pure
funds cost, no trajectory effect: the reliability branch keeps its
invariant that it never touches delta-v (the balance tool forces
reliability to 1, and `data.test.js` excludes the branch from trajectory
searches). Tier 2 is now 15 nodes (still within "twelve to sixteen", above).

**UI.**
- Result: an escaped failure does not read as `readoutKind: 'failure'` (see
  the phase 0 note above) but, when `outcome.escapes > 0`, adds a
  reliability hint — "A stage failed and the abort system carried the rest
  clear. Reliability upgrades make the failure itself rarer."
  (`data-points-at="reliability"`) — alongside the ordinary shortfall hints
  on a miss; an escape does not suppress them.
- Loadout vehicle stats block (see tier 3's restarts/nav/docking/rcs line,
  below): shows "Abort coverage: booster" when `escape === 1` and "Abort
  coverage: stages 1–N" when `escape >= 2`.
- Ascent view (`js/ui/ascent.js`): draws every failure event's bang at its
  own position, not just the first. The rocket keeps flying its pitch
  program after an escaped failure; only the terminal failure leaves the
  tumbling wreck on screen. The escaped stage tumbles away through the same
  separation handling as an ordinary stage drop. The wreck is keyed on
  `'failure'` timeline events, so an orbital-phase `'restart-failure'` (an
  `outcome.failure` of kind `'restart'`) never draws a wreck in the ascent
  view — intended: on a target mission the ascent playback hands off to
  `js/ui/map.js` at `'insertion'` (`js/ui/screens.js`, `stopAtKind`), and
  every orbital failure happens after insertion, so the map view owns it.
- Shop (`js/ui/shop.js`): the set-`escape` effects render as "booster abort
  system" (value 1) and "abort coverage: stages 1–N" (value N).

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
achieved periapsis.

**The release is also an event on the timeline**, `kind: 'deploy'`, carrying
the object's `name` as a field beside its sentence. It is not a step: no
delta-v, no restart, no roll, and success is decided before it — a flight that
missed its orbit deploys nothing, the same test `state.js` applies. It exists
because a deployment contract is not paid for reaching an orbit but for leaving
something in one, and without it the object appeared on another screen after a
flight that never showed it come off the stack. The flight runs on past the
release rather than ending on it, and the wait in front of it is set by
**which camera is watching**: `DEPLOY_COAST` seconds where there is no phase
after insertion (the ascent view has no notion of an orbit, plays a coast at a
fixed rate, and draws from the sample stream — so the integrator coasts far
enough to have samples under the release); a quarter of the target's own orbit
where the map view is playing at `MAP_RATE`; a quarter of `LLO_PERIOD` at the
moon. `js/ui/ascent.js` draws the payload easing off the stack; `js/ui/map.js`
draws it as a marker in the lunar close-up, lagging its own track by
`RELEASE_LAG` for the same presentational reason (a payload let go with no burn
stays exactly where the vehicle is, which is one marker where two objects are). Objects are always circular: an elliptical or
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
  insertion: { t, periapsis, apoapsis, phase } | null,
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

All `tier: 3`. `satellite` (orbit ≥ 100 km, `deploys: { kind: 'satellite' }`,
repeatable, the tier's income filler — its periapsis is `tierGoals[2]`'s,
never above it, because a tier 3 board on arrival holds `satellite`, `core`
(from 40 reputation; below that the slot falls back to an earlier tier) and
the floor, and nothing else until a core is in orbit, so a player who has
just reached orbit at 100 km must be able to fly satellite; `data.test.js`
pins this), `core` (orbit ≥ 200 km, `deploys:
{ kind: 'core', name: 'Station core' }`, `unique: true`), `rdv-1`
(rendezvous within 5 km, `requiresObject: 'core'`), `rdv-2` (within 500 m),
`dock` (the goal: `{ dock: { target: 'core' } }`, `deploys: { kind:
'module', name: 'Lab module' }` docked on success, `requiresNode`
including `'struct-module'`). `tierGoals[3] = { requirement: { dock: {
target: 'core' } }, name: 'Assemble a station' }`. Reputation gates rise
again.

`generateContracts`: templates with `requiresNode` (a node id or an array
of them) are offered only when every listed node is owned. The floor
contract stays tier 1's. Under the gating rule ("js/core/contracts.js"),
`satellite` carries the tier 2 goal's gate (`prop-9`, `guide-1`: it is the
tier 2 goal's orbit) and `core` needs `struct-10` on top of `prop-8` and
`guide-1` — no vehicle without the lighter fairing reaches 160 km. The
target-shaped rungs follow the orbital sequence's own checks *and* the
reserve rule above: `rdv-1` needs `['prop-11', 'guide-3', 'prop-12',
'prop-13']` and `rdv-2` `['prop-11', 'guide-4', 'prop-12', 'prop-13']` —
the match step stops at `restarts < 2`, which only prop-11 lifts (rcs
waives the approach restart, never the match's); `NAV_APPROACH[nav]`
against `closestApproach <= within` makes nav 1 the floor for 5 km and
nav 2 for 500 m; rcs (prop-12) is what gives those floors a margin,
because nav 1 and nav 2 meet their rung only at zero phase error and the
window slider steps by 0.001 of an orbit (0.36°), so the error is never
zero — halved by rcs, both rungs hold at the slider's worst half-step of
0.18°; and prop-13 is the top-stage reserve the match burn is paid out
of, without which no loadout reaches any of the three rungs. `dock` needs
`['struct-module', 'prop-11', 'guide-5', 'prop-12', 'prop-13']` — the
dock step wants `closestApproach <= DOCK_RANGE` (100 m), which nav 3's
50 m meets with margin and nav 2 + rcs's 252 m does not; struct-module's
prerequisite chain carries the docking adapter (struct-9); and prop-12 is
a gate here for a second reason, the phasing pair. prop-11's three
restarts are exactly match (2) + approach (1), so outside
`PHASE_TOLERANCE_DEG` the phasing burn has no restart left unless rcs
waives the approach's — without it dock is flyable on a three-notch
window band and stops for want of restarts on every other notch. guide-1,
prop-10 and struct-10 arrive through those chains, so each missing
purchase is reported once. A gate must hold at the worst-case slider
error, not just at zero, and must be flyable with exactly the hardware it
lists; `data.test.js` checks both against the resolver.

## js/ui — what tier 3 adds

- **Loadout**: `window` slider `[data-loadout="window"]` 0..1 step 0.001,
  shown for rendezvous/dock missions, labelled as a launch window with the
  value shown in degrees of orbit (value × 360). Persisted in `view`. The
  vehicle stats block shows restarts, nav, docking, rcs when non-zero, and
  abort coverage (from tier 2's `escape` stat, "Stage abort systems" above)
  when `escape >= 1`.
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
- **Missions screen** (`[data-screen="missions"]`, the MISSIONS tab
  between CONTRACTS and TECH TREE, Back returns to contracts):
  `[data-missions]` lists every template of the current tier in
  `js/data/missions.js` order, one non-tappable row each, with its
  requirement, payout, and a reason line: "On the board now." / "Always
  offered." (floor) / "Available — not on this board." / one sentence per
  `lockReasons` entry joined by " · " ("Needs <node name>", "Needs N rep
  (have M)", "Needs a <kind> in orbit", "A <kind> is already in orbit").
  Locked rows carry `.locked` and `[data-locked]`; the head counts
  "k of n available". The board hides what cannot be done yet; this is
  where the ladder and what unlocks each rung are seen. It is its own
  screen, not a block on the contracts page: a list of rows that cannot
  be tapped next to a list that can reads as a broken board.
- **Board redraw**: `show('contracts')` redraws the board when
  `boardStale` (contracts.js) says so, so a purchase on the tree tab that
  makes a current-tier contract eligible reaches the board on the way back
  to it, without waiting for the next launch.
- **Tier flow**: tier 2 win → Continue → `[data-screen="tier"]` "Tier 3:
  Orbital maneuvering" → contracts. Tier 3 win → "Assembled a station in N
  launches" and phase 2 stops there.
- HUD tier shows "T3".

## UI hooks, additions (phase 2)

- `[data-loadout="window"]`
- `[data-screen="contracts"] [data-objects]` the in-orbit block
- `[data-screen="missions"]`, reached by `.tabs [data-tab="missions"]`;
  its `[data-missions]` ladder has `.row[data-mission="<id>"]` per
  template, `.locked` / `[data-locked]` when `lockReasons` is non-empty
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

# Anomalies — guidance failure, engine underperformance

Two more ways a launch goes wrong, added after phase 2. A component failure
(ignition, burn, restart) cuts thrust and the run reads as that failure; an
**anomaly** leaves the engines running and puts the vehicle somewhere other
than where it was aiming. Tiers 1 to 3 keep working; every existing test
keeps passing, with the scripted-rng tests updated for the draw order below.
An anomaly is therefore never escapable by an abort system ("Stage abort
systems", above): there is no failed stage to throw clear of.

## js/core/resolver.js

**Guidance failure.** One roll per *guided* flight — `vehicle.guidance >= 1`
and the loadout is not `vertical`; an unguided or sounding flight has no
guidance to lose, so tier 1 is untouched — against
`vehicle.guidanceReliability` (0..1; a vehicle that does not declare it never
fails, so hand-written fixtures are unaffected). On a failed roll the flight
computer drops off its program at a moment drawn uniformly over the nominal
powered flight (the sum of every stage's burn time at the loadout's fuel
fraction), and from then on the thrust vector drifts away from the program
in a drawn direction at `GUIDANCE_DRIFT_RATE` (0.3°/s) up to
`GUIDANCE_DRIFT_MAX` (30°), applied on top of whatever pitch function is in
use (`opts.pitch` included). A moment that falls after the last burn ended
never happens; one inside the final integrator step of powered flight is
announced at the instant the burn ended, where it can no longer steer. The
trajectory up to the drawn moment is independent of the rng (announced at
the first integrator boundary at or after it, as the mid-burn roll is).

**Engine underperformance.** One roll per ignition against the stage's own
reliability, after the ignition roll. On a failed roll the stage runs below
spec for its whole burn: thrust × (1 − deficit), isp × (1 − deficit/2), with
the deficit uniform in [`ENGINE_DEFICIT_MIN`, `ENGINE_DEFICIT_MAX`] (3% to
12%). Lower thrust lengthens the burn (more gravity loss); lower isp is
delta-v gone outright, and `deltaVAchieved` credits the isp the burn actually
ran at. The mid-burn roll is independent of it.

A relight in the orbital phase is an ignition too, so each restart consumed
rolls for performance after its restart roll. An impulsive burn does not
care about thrust, but a lower isp burns more propellant for the same
delta-v: an underperforming relight delivers the burn it was asked for
(`orbital.burns[].dv` is unchanged) and charges the budget
dv / (1 − deficit/2) for it (`dvUsed` counts the charge), every burn under
that relight alike (the phasing pair). A later burn the budget can then no
longer carry stops the sequence there for want of delta-v, as a smaller
reserve would have. An rcs approach is thrusters, not a relight, and never
underperforms.

**Draw order.** Per ignition: ignition roll; then, only if it passed, the
performance roll; then, only if *that* failed, the deficit; then the
burn-roll fraction; later the burn roll. An ignition failure still costs
exactly one draw. Per flight, right after the first stage's ignition draws
and only on a guided flight: the guidance roll; then, only if it failed, the
moment and the direction. The orbital phase draws after every ascent draw,
as before, and per restart consumed: the restart roll; then, only if it
passed, the performance roll; then, only if that failed, the deficit. The
docking roll is unchanged. A post-abort ignition is an ignition and draws
exactly as one, and an abort itself draws nothing, so a vehicle with
`escape: 0` has bit-for-bit the draw order above. This is the replay
contract from here on.

**Outcome** gains one field, alongside the abort systems' `escapes`;
`failure` keeps its meaning (nothing here ends the flight, so it is never
set by an anomaly, and an anomaly never makes a failure escaped or
terminal):

```js
{
  ...phase 0, 1 and 2 fields, and `escapes`,
  anomalies: [                        // in time order, [] when clean
    { t, stage, kind: 'guidance', direction: -1 | 1 },
    { t, stage, kind: 'underperform', factor: 0..1 },   // thrust fraction
  ],
}
```

**Events**: `'anomaly'`, text "Guidance failure at T+84s." (no stage: the
flight computer is the vehicle's, `stage` records which was flying) or
"Stage 2 engine underperforming: 91% thrust.", at the moment it happens.

**Readouts**: unchanged, with each anomaly's sentence appended last of all,
whatever the verdict — "Reached 62 km. Short by 410 m/s. Stage 1 engine
underperforming: 91% thrust." — so the result screen can point at the branch
on a success as well, the way a survived failure already does. On a flight
that also flew an abort, the escape clauses come first: "Reached 61 km.
Short by 400 m/s. Stage 1 engine failure at T+40s; stage 2 escaped clear.
Stage 1 engine underperforming: 93% thrust."

## js/core/vehicle.js, js/data/components.js, js/data/tree.js

`guidanceReliability` is an ordinary extra top-level stat (carried through
by `buildVehicle`, targetable by effects), not a capability stat: its
absence means 1, not 0. The starter declares 0.9. `guide-2` ("Guidance
refinements") sets it to 0.98 — the honest effect the tier 3 section above
asked for — and keeps its `guidance` add. Engine underperformance has no
stat of its own: it rolls against stage reliability, so the reliability
branch is its lever and propulsion/structure margin is the other.

## Balance

`forceReliability` in `tools/balance.mjs` and `test/data.test.js` also sets
`guidanceReliability` to 1, so the balance numbers stay deterministic and no
anomaly appears in a cheapest-reaching set.

## js/ui

- `ascent.js` marks an `'anomaly'` event with a brief amber pulse where it
  happened and a small ring that stays; the rocket keeps flying. Same
  no-leak contract: events at or before sim time only. `--warn` is the
  colour.
- Ticker: `.tick.anomaly` in `--warn`.
- Result points-at: a guidance anomaly → `guidance`; an underperformance →
  `reliability`. Shown whatever the verdict, before the existing hints
  (including the escaped-failure hint), one per kind. An anomaly never
  changes `readoutKind`, which is still `'failure'` only for a terminal
  failure.

# Phase 3 — tier 4, the Moon

Additions to the phase 0, 1 and 2 contracts. Tiers 1 to 3 keep working
unchanged; every existing test keeps passing.

## What tier 4 is, and what it is not

DESIGN.md §14 lists phase 3 as "profiles, survey, first resources, base
equipment, **the clock**, manual haul, storage notification", and says in the
same breath that phase 3 must not be split because "splitting it leaves half
of a system visible with nothing to do".

Both halves of that are respected by cutting the phase in a different place
than the sentence implies. **Tier 4 here is the flight tier only**: the
profiles ladder (flyby, orbit, land, return) and the destination that gives
those profiles a meaning. Survey, resources, equipment, bases, the clock,
offline accrual, haul and notifications are deferred **together**, as phase
3b, because they are the system the doc is protecting — a survey shipped
alone reveals two hidden numbers per site that nothing reads, which is
exactly the half-a-system failure. A landing shipped without them is not
half a system: it pays a contract, wins the tier, and reads as finished. The
order inside the phase that DESIGN.md fixes (survey → land → equipment and
production → storage and offline accrual → haul → notification) is preserved
by 3b; only survey moves, from the front of the flight half to the front of
the economy half, where the thing it feeds lives.

So: **goal, land and return.** Four profiles with escalating payouts, one
new destination, no resources.

**The moon is not a second attractor.** The ascent integrator keeps its
single central gravity term and its single planet-centred frame. A lunar
flight is resolved the way a rendezvous already is — analytically, after
insertion, as a sequence of burns the vehicle can or cannot afford — because
that is the model the game already has and it is the one that produces
"short by X m/s for return", which is what DESIGN.md §6 says the failure
must read as. No patched conics, no sphere of influence, no hyperbolic
elements. `orbitElements` (`resolver.js:330`) keeps its planet-centred
altitude sentinels and is never asked about a translunar state vector.

## js/core/moon.js — new, pure

The moon's constants and the delta-v ladder derived from them. Pure: no DOM,
no `Date.now`, no `Math.random`. It is a sibling of `orbit.js`, not a
parameterisation of it: `orbit.js` keeps its module-level `MU`/`R` and its
"there is exactly one planet" test (`test/orbit.test.js:33`) unchanged.

```js
export const R_MOON, MU_MOON, A_MOON   // radius, gravitational parameter,
                                       //   orbital radius about the planet
export const LLO_ALT                   // the low lunar orbit the ladder prices, m
export const LANDING_LOSS              // gravity/steering loss factor on the
                                       //   powered descent and ascent, ~1.15
export const LLO_PERIOD                // the low lunar orbit's period, s
export function lunarLadder(parkPeriapsis, parkApoapsis)
  // -> { tli, loi, descent, ascent, tei, tof }  all m/s, tof in s
```

Every number in the ladder is **computed, not looked up** (DESIGN.md §14.3):

- `tli` — `hohmann(rPark, A_MOON).dv1`, the departure burn of a Hohmann
  transfer from the achieved parking orbit to lunar distance. `tof` is that
  transfer's `tof`.
- `loi` — arrival hyperbolic speed against lunar circular speed. The excess
  is `|v_transfer(A_MOON) - v_moon|` with `v_moon = sqrt(MU / A_MOON)`;
  capture is `sqrt(vInf² + 2 MU_MOON / rLLO) - sqrt(MU_MOON / rLLO)`.
- `descent`, `ascent` — `sqrt(MU_MOON / rLLO) * LANDING_LOSS` each. There is
  no atmosphere, so the two are symmetric and the loss factor is the whole
  difference from the ideal.
- `tei` — equal to `loi` by the same symmetry. Entry at the planet is free:
  the atmosphere does the braking, and a vehicle without a heat shield does
  not get to spend delta-v instead (see `shield` below).

The eccentricity-mismatch approximation `transferDeltaV` documents is not
reused here; a lunar transfer departs from the parking orbit's own apsis, so
the Hohmann pair is the honest price. Document the approximation that *is*
made — impulsive burns, coplanar, the moon treated as a point the transfer
apoapsis touches — in the module header, as `orbit.js:144` does for its own.

## js/core/resolver.js — the lunar sequence

**New requirement shape** (a mission has exactly one, as ever):

```js
{ moon: { profile: 'flyby' | 'orbit' | 'land' | 'return' } }
```

`requirementKind` (`:370`) gains a `'moon'` arm. `needsTarget` (`:381`) keeps
its current meaning — "flies to a `state.objects` entry" — and a lunar
mission is **not** one: the moon is not an object in `state.objects`, it is
a constant. The predicate that gates the ascent cutoff and the analytic
phase becomes "needs an insertion", true for both, and `needsTarget` narrows
to what it always meant. A lunar mission's `cutoffAlt` is `ORBIT_MIN_ALT`:
it parks in the lowest orbit it can reach, because every metre of altitude
bought on the ascent is delta-v not spent on the transfer.

**`dvAvailable` becomes the remaining stack, not the cutting stage.**
Today it is Tsiolkovsky on `reserveProp`/`reserveMass` — what was left in the
stage that was burning when `cutoff()` fired (`:1660-1663`). Tier 4 needs
8 km/s past insertion, which no single stage carries, and the real answer is
the one Apollo used: arrive in the parking orbit with stages still unfired.
So the budget sums the cutting stage's reserve **plus every stage above it
that has not been ignited**, each priced with the mass of everything above
it, in order.

This is a no-op for tiers 1 to 3, and that claim is a test, not a hope: a
three-stage vehicle inserts on its last stage, so the sum has one term and
equals today's number. `resolver.test.js` pins it as arithmetic rather than as
a magic number — it reconstructs the old formula from the outcome's own frozen
post-cutoff sample and asserts equality — and the tier 3 gate measurements in
`data.test.js` are the real check: if any of them move, the change was not a
no-op and the contract is wrong.

**The insertion cutoff comes with it.** `cutoff()` was scoped to the last
stage, which makes "stages still unfired" vacuous: a lunar stack would burn its
departure stage into the parking orbit and arrive with nothing. It fires on
whichever stage is burning when periapsis crosses the cutoff. Same no-op claim,
same check — a tier 1 to 3 stack only crosses an 80–160 km periapsis on its top
stage. `dvRemaining()`, which feeds the flight readout's "delta-v aboard",
needs a fired-yet guard alongside it, or the HUD reads zero with a full stage
still attached.

**New capability stats** (seeded in `CAPABILITY_STATS`, `vehicle.js:88`, so
they are a data change once declared):

| stat | set by | the resolver reads it as |
|------|--------|--------------------------|
| `lander` | structure | 0 blocks `descent`; the sequence stops at `stoppedAt: 'lander'` |
| `shield` | structure | 0 blocks the return leg **in front of** `tei` |
| `landerBonus` | reliability | added to the landing roll threshold, capped as `dockBonus` is |

**`resolveLunarSequence(vehicle, profile, insertion, dvAvailable, rng)`** —
a sibling of `resolveOrbitalSequence`, returning the same shape so the result
screen and the map read one thing:

```js
{ burns, dvAvailable, dvUsed, shortBy, stoppedAt, reached, landed, readout }
```

`burns[].kind` is one of `'tli' | 'loi' | 'descent' | 'ascent' | 'tei'`;
`reached` is the deepest step completed, as an index into
`LUNAR_STEPS = ['tli', 'loi', 'descent', 'ascent', 'tei']`. Each step is
`restartOk` then `spend(..., restAfter)` exactly as the orbital sequence
does, so `relightCost` couples an underperforming relight to a later
shortfall the same way, and `shortBy` is again *this step's cost plus
everything the profile still needs after it* — that is what makes the tier's
failure line "short by 640 m/s for return" rather than "short by 640 m/s",
and the `restAfter` threading is where the "for return" comes from.

Five restarts is the deepest profile's requirement (tli, loi, descent,
ascent, tei), so `restarts` is a real gate again and the propulsion branch
has something to sell.

Burn times are the transfer's own: `tli` **at the next periapsis passage
after insertion**, `loi` at `tli.t + tof`, `descent` a quarter of a lunar
period later, `ascent` after a surface stay of `SURFACE_STAY` seconds, and
`tei` a quarter of a lunar period after the ascent has finished.

**The two powered legs have a length, and it is the only place the impulsive
approximation is given one.** `lunarSchedule` returns two times that are not
burns — `touchdown` at `descent + DESCENT_TIME` and `orbited` at
`ascent + ASCENT_TIME` — and the surface stay is measured from `touchdown`
rather than from the burn that starts the descent. Delta-v does not care how
long an engine ran and no rung is priced against either constant; what needs
them is that the descent is the one step whose whole content is the trip
between two places, and a step that begins and ends at the same instant cannot
be watched. So the resolver draws the landing roll where it always did, in
ladder order, and emits the `landing` (or `landing-failure`) event at
`stepTime.touchdown` — twelve minutes of falling after the burn — which is the
interval the map view flies the vehicle down in.

**An orbit profile's revolution is an event, not a step**, by exactly the
argument the flyby's arrival is made by one paragraph down. `orbit`'s last burn
is the capture, so without this its flight ends on the frame the engine cuts
off: a vehicle that reached lunar orbit and was never in one. A completed
capture is therefore followed by a `lunar-orbit` event one `LLO_PERIOD` later.
It spends nothing, uses no restart, does not move `reached` and does not touch
success. `survey` gets the same event, with its own line — the two profiles are
the same two burns by construction, and the pass over the ground is the one
thing a survey is FOR, so leaving the revolution to `orbit` alone ended the
mapping flight on the frame the capture cut off and gave the instrument nothing
to look at. `land` and `return` do not get it: they have their own reasons to
still be there afterwards, and two hours added to a flight that is about to
descend would delay the descent to say what the descent says better.

A completed `ascent` emits the same event at `stepTime.orbited`, and that one
is not decoration: a `return` that climbs back to orbit and then cannot make
the burn home — no shield, no restart, not enough delta-v — breaks before `tei`
pushes anything, so without it the last entry on that flight's timeline is the
ascent burn's own instant, and the map stopped with the vehicle on the surface
at the start of a climb `reached` says it finished.

**A flyby's arrival is an event, not a step.** `flyby` is the one profile
whose ladder ends with a burn made at the PLANET: it rounds the moon on the
transfer the injection bought and makes no burn there, which is what makes it
the cheapest rung. So a successful flyby's last timeline entry was the
injection — five days and 380 000 km short of the moon — and the map, which
plays the timeline and stops at its last event, stopped with the vehicle drawn
in the parking orbit it was in the act of leaving. Every other profile reaches
the moon for free, because every other profile's last burn is made there. The
sequence therefore emits a `flyby` event at `stepTime.loi` — the arrival time
the schedule already computes, and the one the map already places the moon at
— once the injection has been flown. It spends nothing, uses no restart, does
not move `reached` and does not touch success, which is still `tli`'s: it is
the moment the mission is about, and the flight ends on it.

**The departure burn must happen where it is priced, and getting that wrong is
silent.** `lunarLadder` charges the transfer from the parking orbit's
periapsis, because that is the efficient place to leave from and it is the
Oberth discount the whole tier is sized against. An earlier draft of this
contract scheduled the burn half a parking orbit after insertion — "the vehicle
coasts to the far side and leaves from there" — which is apoapsis, the worst
place to leave from. On an 80 km × 4 381 km parking orbit that charged 2 234 m/s
for a burn that costs 3 218 m/s: 983 m/s of delta-v the vehicle never had, and
every lunar mission reading as affordable when it was not. Nothing failed; the
numbers were simply wrong in the direction that lets a flight succeed.

Half a period is not the fix either, because **insertion does not happen at
periapsis**: the cutoff fires when the achieved orbit's periapsis crosses
`ORBIT_MIN_ALT`, which happens partway up the ascent with the vehicle still
climbing — measured at 284 to 385 km on an orbit whose periapsis is 80 km. So
the resolver records the orbit phase at cutoff (mean anomaly over 2π since
periapsis, `orbitPhase`, the inverse of `orbit.js`'s `positionAt`) on
`insertion`, and the schedule coasts `(1 - phase)` of a period to the next
periapsis. The map reads the same field for the same reason, so the drawn
departure point is the periapsis the burn was priced at.

The invariant that keeps them together is a test rather than a comment: on a
genuinely eccentric parking orbit, the vehicle's radius at the scheduled
departure equals the parking orbit's periapsis radius, and the delta-v charged
equals the vis-viva cost of departing from there. A `return` flight's
timeline is days long, which the map plays back at its own rate and the
result screen reports as mission elapsed time — the same simulated seconds
every other flight already uses. Nothing in state or the UI learns about
real time in this phase; that arrives with the clock, in 3b.

**Success, shortfall, readout** — the three ladders at `:1696-1711`,
`:1727-1766` and `:1770-1812` each gain a `'moon'` arm. Success is
`reached >= LUNAR_STEPS.indexOf(requiredStep(profile))`. The shortfall is
the sequence's own `shortBy`, unfloored, as the orbital one already is.

## js/core/state.js, js/core/save.js — schema v4

`SCHEMA_VERSION = 4` in `save.js:4` **and** the duplicated literal in
`newGame` (`state.js:32`; the duplication is deliberate, see `state.js:12`).
`migrations[3]` adds `best.lunarStep: -1` and back-fills history entries with
`lunarStep: -1`, following the whole-literal rewrite the other three use. The
field stores the resolver's `outcome.lunar.reached` untranslated, so it shares
that value's `-1` sentinel for "nothing completed" — which is also the true
statement about a save that predates this phase. Zero would not be: zero is
`tli`'s own index, and a field defaulted to it reads as "reached TLI" on a fresh
game, which a `flyby` goal would believe.
`recordLaunch` raises `best.lunarStep` from `outcome.lunar.reached`.
`tierGoalMet` gains a `{ moon }` arm reading `best.lunarStep` against the
profile's required step — the fall-through at `state.js:310` silently
reports "never met" for an unknown shape, so this arm is not optional.

`objects` is untouched: a lunar flight deploys nothing in phase 3.

## js/core/tree.js, js/data/tree.js — tier 4

Tier 4 nodes (`tier: 4`), 12 to 14, four branches. Costs step up from tier
3's 25 000–62 500 the way tier 3 stepped up from tier 2's.

- **propulsion**: a cryogenic deep-space engine (isp mul), a descent
  propellant reserve (top-stage propMass), and the fourth and fifth relights
  (`restarts` add 1 each — five is what `return` needs).
- **structure**: a lunar-class launch vehicle, the cryogenic departure stage
  (`addStage`), the lander (`lander` set 1), the ascent stage (`addStage`),
  the heat shield (`shield` set 1).
- **guidance**: deep-space navigation, terrain-relative landing (feeds the
  landing roll).
- **reliability**: insertion-stage requalification, lunar engine
  qualification, landing rehearsal (`landerBonus`).

**Four things measurement established that the paragraph above originally got
wrong.** They are recorded because each of them is a trap the next tier will
walk into as well.

1. **A stage-adding node must be a structure node.** `collectEffects` hoists
   every `addStage` ahead of the stat effects, in *branch* order, and
   propulsion sorts before structure. A departure stage sold by propulsion
   therefore lands at stage index 1 and silently renumbers every
   `stages.1.*` and `stages.2.*` effect in tiers 2 and 3. Both new stages are
   structure; propulsion sells their engine. A test pins it.
2. **Tier 4 is a launch vehicle, not an attachment.** The tier 3 stack reaches
   orbit with 430 to 800 m/s left. Nothing bolted on top of it flies to the
   moon; the tier's first structure node is an 18× booster stretch, and
   everything else hangs off that.
3. **Selling that thrust as its own node is a trap, so it carries its own
   engines.** Uprating the tier 3 core's thrust alone *lowers* best periapsis
   — 184 627 m at ×1 down to 121 009 m at ×2 — because a heavier-thrusting
   core on the same propellant burns out sooner and steeper. `gates.mjs`
   reports it precisely: 24 supersets of `relay`'s gate that fall short of
   it. The cross-branch TWR rail still applies to the two stages structure
   *adds*, but not inside the launch vehicle node.
4. **Guidance has two nodes, not three.** "Entry guidance" has no resolver
   hook: entry is free and `shield` is a hardware gate rather than a roll, so
   a third node would gate nothing. `stages.3.reliability` is dead data for
   the same reason — stages above the insertion stage never ignite during the
   ascent, and the lunar sequence rolls only the topmost stage — so no node
   sells it.

The cross-branch TWR rail (`js/data/tree.js:41`) extends unchanged: a stage
added by structure requires the thrust that flies it. `data.test.js`'s
ideal-full-tree delta-v bound moves with this tier and is re-pinned, not
deleted — it exists to catch a tree that has quietly become a shop. Tier 4
takes it from 9 000–11 000 m/s to **17 500–19 500** (measured 18 530, over a
five-stage 3 037 kg stack).

## js/data/missions.js — tier 4 ladder

Five rungs, all `tier: 4`, following tier 3's composition exactly:

- `relay` — the income filler. Orbit-shaped at the `core` template's own
  160 km, `deploys: { kind: 'satellite' }`, repeatable, **no
  `minReputation`**. Tier 3's `satellite` exists because a tier 3 arrival's
  board was the 400-fund floor and nothing else for a hundred launches
  (`missions.js:339`); a tier 4 arrival is in the same position and gets the
  same answer. Its requirement is capped at hardware a tier 3 winner owns by
  construction, and `data.test.js` pins that, as it does for `satellite`.
- `moon-flyby`, `moon-orbit`, `moon-land` — the escalating profiles.
- `moon-return` — the goal.

```js
tierGoals[4] = { requirement: { moon: { profile: 'return' } },
                 name: 'Land and return' };
```

`mission.profile` **stops being dead data** in this phase. It is written on
every template today and read by nothing (`tools/gates.mjs`'s probe fixtures
set it and `resolveLaunch` ignores it). It does not become a second dispatch
axis — every switch in the codebase reads the requirement shape and that
stays true — but `data.test.js` pins that a template's `profile` agrees with
its requirement, so the annotation is either correct or it fails. Tier 4's
values are `'flyby' | 'orbit' | 'land' | 'return'` on the lunar rungs and
`'orbit'` on `relay`.

**Gates.** `tools/gates.mjs`'s `MAX_TIER` goes to 4 and its subset
enumeration keeps deriving gates for the altitude/downrange/orbit shapes —
`relay`'s among them. The four lunar rungs are hand-authored and *measured*,
the way the rendezvous and dock rungs are (`missions.js:404`): each must be
flyable with exactly its `requiresNode` closure across every selectable
loadout, and must stop being flyable when the node the rung is really about
is removed. `data.test.js` checks both against the real resolver.

## js/ui — what tier 4 adds

- **Map view, a second frame.** The planet-centred frame with its ×6
  altitude exaggeration cannot express a body 60 planetary radii away
  (`map.js:235`, `:68`): the stretch is nonsense at that distance and a fit
  that includes the moon collapses a parking orbit to a sub-pixel dot. So a
  lunar outcome selects a **cislunar frame**: no altitude exaggeration, the
  fit set by `A_MOON`, both bodies drawn at `max(true radius, MIN_BODY_PX)`
  with the corner note saying the bodies are not to scale (it currently says
  the altitudes are). The transfer is a planet-centred Hohmann ellipse, so
  `drawOrbit`, `elementsFrom` and `positionAt` all still apply — no
  hyperbola tracer is needed, which is the point of resolving the transfer
  as a Hohmann pair. The lunar-orbit and surface steps are drawn at the moon
  marker as a ring and a landed dot while the picture is wide, and by the
  close-up below once the camera has gone in; the moon moves on its own circle.
  The no-leak contract is unchanged and is the reason the moon's position is
  drawable from frame one: it is a constant, like a target's orbit is state.
  Placing the moon before any burn has played back needs the burn schedule,
  which is why `lunarSchedule` is an exported function of `moon.js` rather
  than arithmetic the resolver keeps to itself: both callers derive it from the
  parking orbit and the constants, and neither reads a burn. Two agreeing
  copies would not have stayed agreeing — a departure time only the resolver
  knew about would flash the capture burn beside the moon rather than at it.
- **The flown arc, not the route.** The transfer drawn as one closed ellipse at
  the instant the TLI lights is a route diagram: the whole way to the moon is
  on screen before the vehicle has moved, and nothing after that grows. So the
  cislunar frame draws the vehicle's conic **twice** — faint and dashed for the
  whole of it, which is the same information the single curve carried, and
  bright over the arc flown since the burn that put the vehicle on it, fading
  out behind (`drawTrail`). Only the bright arc grows, and growing is what
  approaching looks like. It is the ascent view's trail on a curve instead of a
  line, and it reads the drawn orbit and the playback clock alone — strictly
  less than the closed curve, so the no-leak contract is unaffected. The arc
  holds at the arrival point while the vehicle is AT the moon, where there is
  no planet-centred motion left to trace, and a departure burn starts a new
  one. The marker is a craft glyph pointed along its heading rather than the
  tier 3 ring (heading is the whole of what a transfer looks like from out
  here; two craft on near-identical orbits have no heading worth telling
  apart), and the chrome carries the closing range to the moon — measured off
  the two positions on screen, exactly as tier 3's separation line is.
- **The close-up, a camera rather than a third frame.** The three steps AT the
  moon have no planet-centred orbit worth drawing, which is why the resolver
  hands them `elements: null`; drawing them ON the moon marker — a ring around
  it, a dot on its limb — put a capture, a descent, a landing, a stay, an
  ascent and a departure inside ten floored pixels, so the part of the tier the
  contract is named for was the part that could not be seen. So the cislunar
  frame keeps its two bodies, its clock and its events and moves its CAMERA:
  centre and fit ease from the planet at the origin fitted to `A_MOON` to the
  moon itself fitted to the drawn lunar orbit, about 150x closer. The scale
  eases geometrically and the pan is derived from the scale rather than from
  the eased parameter, so the moon holds roughly still while the picture opens
  around it; panning linearly against a geometric zoom throws it off the canvas
  halfway and brings it back. The two pictures do not cross-fade evenly — each
  is faded over the half of the move it means anything in and cut below
  `FRAME_CUTOFF`, because planet-centred furniture at the close-up's scale is a
  set of arcs thousands of pixels wide. In the close-up the moon is drawn at
  TRUE size and the 100 km orbit is stretched by `LUNAR_ALT_EXAGGERATION`,
  which is the planet-centred frame's trade made again one body over, and the
  corner note says so. The camera holds wide for `LUNAR_DWELL_S` after the
  capture and again after the burn home, so each of those reads as the event it
  is before the view moves, and `finish` holds the last frame for
  `LUNAR_HOLD_S` of real time with the simulation stopped rather than cutting
  to the result screen mid-move.
- **What the close-up draws, and where each part of it comes from.** The
  vehicle is on the orbit the capture put it in, at the period the ladder is
  priced against, entered on the side facing home (which is the side a transfer
  arrives from). The powered descent flies it down over `DESCENT_TIME` with
  altitude going as `(1-u)^2` and the angle swept as the integral of `(1-u)`,
  so it brakes as it falls and touches down with both rates at zero, about 18
  degrees of moon downrange — Apollo's descent covered 16. The ascent is the
  same in reverse over `ASCENT_TIME`, and each leaves the fading trail the
  transfer leaves, in the MOON's frame (sampling the moon's own motion along a
  twelve-minute descent would smear it across the thousand kilometres the moon
  travels while it happens). An ABORT is drawn short of the ground — `ABORT_U`,
  a few hundred metres — because an abort is not a touchdown and the failure is
  announced at ground level, the roll being about the contact itself. The
  no-leak contract is untouched: every position is derived from a burn that has
  already happened, the constants in `moon.js` and the playback clock. The one
  thing worth naming is that the descent's LENGTH is known when it starts and
  its OUTCOME is not — both the `landing` and the `landing-failure` event
  arrive at the far end of it — which is what makes a descent something to
  watch rather than something to have watched.
- **The flight home is on the timeline.** A `return` profile's last event used
  to be the trans-earth injection itself, on the reasoning that entry is free —
  the atmosphere does the braking and the heat shield is a hardware gate rather
  than a rung. Free is not the same as eventless: the burn for home is 380 000
  km from home, and the map plays the timeline and stops at its last event, so
  the flight the contract pays for RETURNING from ended with the vehicle still
  at the moon. `lunarSchedule` therefore carries two more moments — `entry`,
  one `RETURN_TOF` after the burn, and `home`, `ENTRY_TIME` (600 s, Apollo's
  interface-to-splashdown was about 840) after that — and the resolver emits an
  `entry` and a `recovery` event at them. The leg home is **aimed at the
  atmosphere**: a trans-earth injection targets an entry corridor, not the
  parking orbit it left from, so the conic the resolver hands the map for it has
  its periapsis at `ENTRY_ALT` and `RETURN_TOF` is that conic's own half-period
  — sixty seconds longer than the way out over five days, and the reason the
  coast home ends at the altitude and on the frame the entry view opens at.
  Handing back the outbound ellipse instead flew the capsule down to the parking
  orbit's periapsis, 40 km under it, and announced the interface a minute and a
  half after the vehicle had crossed it. Neither is a step or a burn: no delta-v, no restart, `reached`
  does not move, and the profile's success is still the injection's, exactly as
  the ascent's `lunar-orbit` event and the flyby's pass are. A `flyby`'s free
  return is deliberately untouched: its mission is the pass, and its timeline
  ends there.
- **The shot on the ground, a third picture and a CUT.** The close-up is a
  picture of an orbit, and in the last kilometres of a descent it stops being a
  picture of a landing: at a fit set by the drawn lunar orbit the moon is ninety
  pixels of radius, so the final kilometre is two of them and the touchdown the
  tier is named for is a marker meeting a limb. So below `SURFACE_ALT` (8 km)
  the view cuts to `js/ui/surface.js` — the **surface shot** — which draws the
  approach, the touchdown, the stay and the liftoff that starts the trip home
  side-on, at EXACTLY the scale the launch was drawn at. `VIEW_SPAN_M`, the km
  ruler, the ground-mark spacing and the screen anchor are imported from
  `js/ui/ascent.js` rather than copied, so "the same scale as the launch" is a
  shared constant and not a claim (`test/surface.test.js` pins it, and
  `test/map.test.js` pins the sequence of corner notes across a whole `return`
  flight: *bodies not to scale → lunar altitude ×6 → launch scale → lunar
  altitude ×6 → bodies not to scale*).
  It is a CUT, dipped through black over `SHOT_CUT_S`, and not the camera move
  the close-up is. The camera could travel from the planet to the moon because
  both pictures share an origin, an orientation and a projection and differ only
  by 150× of scale; the surface shot shares none of them — its up is the local
  vertical at the site, its ground is flat, its altitudes are honest where the
  close-up's are stretched ×6 — and it is another 180× in. Easing between two
  pictures with nothing in common is a smear. What asks for the cut is the
  altitude the vehicle is drawn at right now, which is a position already on the
  screen: the same licence the lunar rates take, and it says nothing about how
  the flight ends. The corner note, which in every other picture says which of
  the two things is a lie, says `launch scale` here, because nothing in this one
  is: no body is drawn, nothing is exaggerated, and a pixel is the number of
  metres it was on the way up off the planet. Two things are the renderer's own
  opinion, both about the sprite rather than the flight: the lander's ATTITUDE
  is a function of altitude, not of the velocity direction (the ladder's descent
  holds one ten-degree slope all the way down, so a vehicle pointed along it
  would still be lying on its side at contact — it leans back into its braking
  high up and is level over the last 800 m, and an ascent is the mirror image),
  and the crater field is deterministic scenery in world coordinates, the same
  trick the launch view's cloud layer uses. An ABORT is the one thing this
  picture shows that the close-up could not: `ABORT_U` leaves the vehicle 360 m
  up and two kilometres short of the site, which at this scale is visibly short
  of a site that is drawn.
- **Coming home, in the same two pictures.** The coast back is flown in the
  cislunar frame the transfer out was flown in — the same fading arc, the same
  radius-scaled rate — with the closing range in the corner pointed the other
  way (`TO EARTH`, the vehicle's own altitude above the planet, measured off
  the picture like the range to the moon is). At the `entry` event the view
  cuts to the surface shot again, at the PLANET this time: `state.body` picks
  between grey ground under a black sky and the launch view's own sky, stars
  and cloud layer, and the sprite becomes a capsule — a plasma sheath keyed on
  altitude alone (in at the interface, gone by 25 km) and a canopy that comes
  out at 6 km and fills over 900 m. That shot opens at `ENTRY_ALT` rather than
  at `SURFACE_ALT`, because an entry has no orbital half to hand over from: all
  120 km of it is weather. `entryAt` is the only opinion anything has about its
  shape, as `poweredAt` is for the descent — altitude as `(1-u)^1.9` and the
  distance still to run as `(1-u)^3`, so the capsule crosses the interface at
  11 km/s about two degrees below the horizon, loses the downrange in the first
  minute of atmosphere, and comes down the last kilometres nearly vertically
  with both rates reaching zero at the ground. The chrome says `ENTRY PHASE`
  there rather than `CISLUNAR PHASE`, which at 8 km under a canopy is the sort
  of label a player reads twice.
- **Playback rate, the one invariant this phase widens.** Tier 3's rule is that
  the rate is a constant (`MAP_RATE`, 600×). No constant works across cislunar
  distances: one fast enough to cross five days of transfer reduces a `flyby`,
  whose entire map is the parking orbit, to a twentieth of a second. So the
  cislunar rate scales with the vehicle's currently drawn radius — about
  54 000× at lunar distance and a sixtieth of that in the parking orbit. It
  reads a position already on the screen, so it stays outcome-independent, and
  it is the same shape as the ascent view's burn and coast rates. `formatClock`
  grows a days branch here; tier 3's timelines never reached one. At the moon
  the radius that scales it stops meaning anything — everything there happens
  within a thousandth of `A_MOON` — so three more rates take over, keyed on
  what the vehicle is DOING, which a burn or an event has already said:
  `LUNAR_RATE` coasting (a two-hour revolution in about nine seconds),
  `LUNAR_BURN_RATE` on the high part of the two powered legs (the first ninety
  kilometres of a descent in about four seconds), and `SURFACE_RATE` for the
  stay, which is a day of nothing in two. A fourth, `SHOT_RATE`, takes over
  inside the surface shot: the burn rate would put the last eight kilometres of
  a descent inside a fraction of a second, where this plays them in about
  fourteen. `ENTRY_RATE` is the fifth and last, for the empty hundred
  kilometres between the interface and the part of the entry with a ground in
  it, which `SHOT_RATE` plays. The three that are not `LUNAR_RATE` or
  `SURFACE_RATE` were halved once the descent was watched end to end: the whole
  trip from lunar orbit to the ground took nine seconds, of which the part with
  ground in it was seven, so the approach the tier is named for was over before
  it read as an approach. All of them are applied as a fraction of the
  playback rate, so an overridden `speed` still scales everything together.
  A rate is only valid up to the next thing that changes it, so a frame never
  carries the clock past a burn or an event: one frame of `SURFACE_RATE` is
  4 320 simulated seconds, ten times the whole climb back to orbit, and
  unclamped the frame that ends the stay steps over the ascent burn, over
  `ASCENT_TIME` and out the far side — the vehicle was on the moon on one frame
  and in orbit round it on the next, with the climb never drawn. The clamp drops
  the remainder of that frame, which costs at most one frame at the new rate,
  and it lands every burn flash on its own instant rather than up to a frame
  late.
- **Loadout**: no new control. The profile is the mission, not a choice, and
  the window slider is meaningless without a phasing target.
- **Result**: rows for the deepest step reached, delta-v used of available,
  and the shortfall named with the step it stopped before ("short by 640 m/s
  for the return burn"). That row REPLACES the generic "short by" row on a
  lunar mission rather than sitting beside it — two rows for one shortfall,
  one of them missing the half that matters, is worse than either alone. The
  resolver composes the sentence; the screen renders it rather than
  recomputing it, and shows it for any stop, not just a delta-v one, because
  it is the only row that reports why the ladder ended. Points-at: `stoppedAt: 'restarts'` → propulsion;
  `'lander'` → structure; `'shield'` → structure; `'deltaV'` → propulsion
  and structure.
- **Tier flow**: tier 3 win → "Tier 4: The Moon" → contracts. Tier 4 win →
  "Landed and returned in N launches". `TIER_NAMES`, `TIER_BLURB` and
  `TIER_TEASER` (`screens.js:195`, `:202`, `:220`) each gain a `4:` entry,
  and `winHtml`'s headline switch (`:823`) gains a `moon` arm — without it a
  lunar win prints "Reached 100 km", because the switch falls through to the
  altitude default.
- HUD tier shows "T4".

## UI hooks, additions (phase 3)

- `[data-result="lunar-step"]`, `[data-result="lunar-shortfall"]`
- the launch canvas stays `canvas#ascent` through both views; tap skips both

## Balance, phase 3

`tools/balance.mjs` gains tier 4: the cheapest prereq-valid set reaching each
rung, the greedy player from the tier 3 end state through the goal (target
15 to 60 launches, dry streak 4 or under), the remaining-stack delta-v budget
at insertion for the cheapest set (must cover the profile's ladder with
margin), and the TWR sweep extended to tier 4 sets. `data.test.js` asserts
reachability of every tier 4 rung and greedy ≤ 80.

**Measured, once the tier was built.** Greedy reaches the goal in **18 tier 4
launches** (target 15 to 60) with a longest dry streak of 2. Reputation crosses
every gate on the first launch; the wait is hardware, which is the right way
round. The TWR rail holds over 161 032 prereq-valid combinations across four
tiers, minimum liftoff 1.186, minimum upper stage 0.971, no violations. Budget
against ladder at insertion: flyby +3 964 m/s, orbit +3 142, land +1 295,
return **+623 m/s at its widest and +37 at its tightest flying notch** — the
goal rung flies on 12 of 21 turn notches, the other three on all 21. The
measured gates are flyby `[struct-11, guide-1]`, orbit `+prop-11`, land
`[struct-13, prop-11, guide-1]`, return `[struct-15, prop-17, prop-15,
guide-1]`; `restarts` gates two rungs and delta-v gates none of them alone.

Two consequences worth stating. The flyby rung gates on the launch vehicle
rather than the departure stage, because a bare probe is 5 kg against the
lunar stack's 92 and the core that barely inserts the stack inserts a probe
with 6 800 m/s to spare. And the step from `land` to `return` is **six nodes**,
not the one-to-three the tier 2 ladder holds itself to: coming home is a second
vehicle, and pretending otherwise would mean pricing the return as a bolt-on.
The greedy player crosses it in five launches, which is what makes it a wall to
climb rather than one to stop at.

The numbers above are the shape, not the answer. Tier 3's contract said
200 km and shipped 160 km because the resolver disagreed with it
(`js/data/tree.js:657`); the same applies here. What the tools measure wins,
and what they measure gets written back into this file.

**Measured, from the phase 3 core work, so the tier is priced against the
right number.** From a 180 km circular parking orbit the ladder is tli 3 136,
loi 822, descent 1 878, ascent 1 878, tei 822 — 8 536 m/s, transfer 4.98 days.
But the parking orbit a real ascent reaches is not circular: the cutoff fires
the instant periapsis crosses `ORBIT_MIN_ALT`, leaving apoapsis around 1 800 km,
and the departure burn is charged at periapsis. The Oberth discount is worth
about 415 m/s, so a `return` flight spends nearer **8 100 m/s** than 8 540. Size
the tree against the flown number, not the circular one — and note that this
makes a low, eccentric parking orbit the *right* answer for a lunar mission,
which is why the cutoff is `ORBIT_MIN_ALT` rather than something tidier.

## Deferred to phase 3b, together

Survey (the orbital profile that reveals plentitude and quality), resources
as anything other than the ledger `economy.js` already carries, equipment,
surface bases, orbital depots, the clock, offline accrual, storage caps,
manual haul, and the storage-full notification. `state.resources` and
`cost.resources` stay as they are: a complete, unused foundation
(`ARCHITECTURE.md:320`). Nothing in phase 3 credits a resource, and no tree
node is priced in one.


# Phase 3b — the economy, whole

Additions to the phase 0, 1, 2 and 3 contracts. Tiers 1 to 4 keep working
unchanged; every existing test keeps passing.

This is the half of DESIGN.md's phase 3 that phase 3 deferred: survey,
resources as something other than a ledger, equipment, bases, depots, the
clock, offline accrual, storage caps, manual haul, and the storage-full
notification. Phase 3 split at survey and said why; **3b does not split
further**, because the thing DESIGN.md §14 is protecting is exactly this set —
"splitting it leaves half of a system visible with nothing to do", and a
survey that reveals two hidden numbers nothing reads is the example it gives.

The order inside the phase is DESIGN.md's own and is preserved: survey →
equipment and production → storage and offline accrual → haul → notification.
(Landing sits in that list too; it shipped in phase 3.)

## What 3b is, and what it is not

**3b adds no tier and no goal.** Tier 4 is already won by the time any of this
matters, and tier 5 has not been built. What 3b adds is a second income that is
not a contract, a second currency that funds cannot buy, and the first thing in
the game that happens while the player is not looking.

**It adds no lose condition.** DESIGN.md §7: bankruptcy cannot happen, and a
base that produces nothing is not a soft-lock — the floor contract still pays,
and every tier 4 rung is still flyable with no base at all. Nothing in 3b is on
the critical path to a tier goal, which is what makes it safe to ship after the
flight tiers rather than before them.

**The clock is for production and for nothing else.** DESIGN.md §3's table is
the contract: research, purchases, launches and hauls all resolve now; only
base production accrues over wall-clock time. A timer the player waits on for
anything else is the mechanic DESIGN.md §12 excludes by name.

## js/core/clock.js — new, pure

The one module that is *about* wall-clock time, and it never reads one.

```js
export const ELAPSED_CLAMP           // 24h in ms (DESIGN.md §3, placeholder)
export function elapsedSince(lastTick, now)   // -> ms, clamped to [0, CLAMP]
export function tick(state, now)              // -> { state, elapsed }
```

**`now` is always an argument.** `Date.now` appears nowhere in `js/core`, and
this module is the reason the rule needs restating rather than the exception to
it: a module named for the clock is exactly where a `Date.now()` would look
harmless. The caller in `js/ui` reads the real clock and passes the number in,
which is what keeps every accrual test a pure function of two integers.

**The clamp is not a fairness device, it is a bound.** `elapsedSince` returns 0
for a `now` at or before `lastTick` — a clock moved backwards accrues nothing
rather than accruing negatively — and `ELAPSED_CLAMP` for anything beyond a
day. DESIGN.md §3 is explicit that clock manipulation is the player's own
problem and we do not fight it; the clamp exists so that a save opened after a
month does not credit a month, which would make storage caps meaningless and
the first app-open of a new week better than every launch in it.

**Storage is the real limit and the clamp is the backstop.** Accrual stops at
the storage cap (see `base.js`), so on a well-built base the clamp is never the
binding constraint. That is the intended relationship: the cap is the thing the
player upgrades, the clamp is the thing that stops arithmetic going silly.

## js/data/sites.js — new

The candidate landing sites, and the two hidden numbers per resource per site
that DESIGN.md §8 asks for.

```js
export const SITES = [
  { id, body: 'moon', name,
    resources: { water: { plentitude, quality }, metals: { plentitude, quality } } },
  ...
]
```

Four sites on the moon, and they differ enough to be a decision: a site rich in
water and poor in metals, its mirror, one middling in both, and one poor in
both that exists so a survey can come back with bad news. A survey that always
found a good site would be a cutscene with a delta-v cost.

**Plentitude and quality are not the same number and do not do the same job.**
Plentitude scales the *extraction* rate (how much water and metals come out of
the ground per hour); quality scales the *processing* yield (how much fuel and
oxidizer a unit of water becomes). So a site can be worth landing on for its
water and worth nothing for its propellant, which is what makes the pre-landing
decision a decision. Both are held as multipliers around 1.

**They are data, not rolls.** A site's numbers are fixed in `sites.js`, not
drawn from the rng. Two reasons: a survey is meant to *reveal* information the
world already has, which a roll made at survey time is not; and a re-rolled
site would make the save's `sites` entry the source of truth for the world
rather than for what the player knows about it. What the player knows is
`state.sites[id].surveyed`; what is true is `SITES`.

## js/core/resolver.js — the survey profile

`survey` joins `LUNAR_PROFILES` as a fifth entry, flying the same two rungs an
`orbit` profile does:

```js
survey: ['tli', 'loi']
```

That is the whole resolver change, and it is deliberately that small. A survey
*is* an orbital mission (DESIGN.md §8: "a survey, an orbital mission profile"),
so it costs what an orbit costs, is judged on the capture the way an orbit is,
and reaches the same `best.lunarStep`. What differs is what the contract asks
for and what the outcome credits, and neither of those is the resolver's
business.

The requirement carries the site:

```js
{ moon: { profile: 'survey', site: 'mare-tranquil' } }
```

`requirementKind` is unchanged — it already answers `'moon'` for anything whose
`moon.profile` is in `LUNAR_PROFILES`, and adding the key is what makes
`survey` a legal profile rather than a rejected one. `requiredLunarStep`
answers `loi`'s index for it by the same rule it answers for `orbit`, because
the profile's last step is the same step.

**What credits the reveal is `state.js`, not the resolver.** `recordLaunch`
marks `state.sites[req.moon.site].surveyed = true` on a successful survey,
beside where it already raises `best.lunarStep`. The resolver stays a function
of vehicle, mission and rng that knows nothing about what the player has
learned — the same separation that keeps `objects` out of it.

## js/core/base.js — new, pure

Equipment, production rates, storage caps, and accrual. Pure: no DOM, no
`Date.now`, no `Math.random`. It is the economy's `orbit.js`.

```js
export const EQUIPMENT = ['power', 'extractor', 'processor', 'storage', 'transport']
export const POWER_PER_LEVEL, DRAW                 // supply, and draw per type
export function powerBalance(base)                 // -> { supply, draw, ratio }
export function rates(base, site)                  // -> per-hour production
export function capacity(base)                     // -> per-resource storage cap
export function accrue(base, site, elapsed)        // -> { base, produced }
export function buildCost(type, level)             // -> { funds } | { resources }
```

**Five types with levels, and the chain is the one DESIGN.md §8 draws:**

```
power  ->  extractor (water, metals)  ->  processor (water -> fuel + oxidizer)
                                          ->  storage  ->  transport
```

**Power is a shared cap, and that is what makes the five a system rather than
five sliders.** Every other type draws power; supply is `power` level times
`POWER_PER_LEVEL`. When draw exceeds supply, everything runs at
`supply / draw` — a single throttle rather than a priority order, because a
priority order is a rule the player has to be taught and a throttle is one they
can read off two numbers. So the bottleneck moves as the base grows, which is
the whole point of the table in §8: every type creates one, and power creates
the one that makes the others matter.

**Extraction is plentitude, processing is quality, and neither is capacity.**
`rates` returns water and metals at `plentitude × level × BASE_RATE`, and fuel
and oxidizer at `quality × processor level × YIELD`, capped by the water the
extractor actually delivers — a processor larger than its extractor is idle
capacity, which is a legible mistake rather than a hidden one.

**That cap is `min(processor capacity, extraction + stockpile)`, and for a
while it was only written down here.** `rates` quoted the processor's capacity
outright, so on any site with a water plentitude below 1 the extractor could
not feed it and the quote was too high — by 1.8× at Aristarchus and 2.5× at Far
Side Flats, with `fillTime` too low by the same factor. `accrue` had always
done the arithmetic correctly, so the number the base tab showed and the number
the game banked disagreed, and the tab was the one the player believed.
The minimum is exactly what `accrue` does over one hour, which is what makes
them agree by construction; `test/base.test.js` walks every site and level and
asserts the quote equals the accrual. `rates` also returns `processorCapacity`
and `waterLimited`, because a starved processor has net water zero — nothing
piling up, nothing drawn down — so neither of the base tab's two water
diagnoses fired, and the one state a player cannot infer from the four bars was
the one nothing said.

**"Every propellant tank fills inside the clamp" is not true at every site, and
was never the requirement.** It held only under the overstated rate. Fill time
is `storage level / extractor level` times a constant the site sets, so a base
whose storage keeps pace with a starved extractor holds more than a day of its
own output at *every* level, and no single `STORE_PER_LEVEL` fixes that without
making the good sites fill in five hours. What is true is in two halves, and
`test/base.test.js` and `tools/balance.mjs` measure both: where the extractor
keeps the processor fed, every equal-level tank fills inside the clamp; where
it cannot, the tank fills more slowly in exact proportion — that is what makes
a site water-poor — and what must hold is that the storage LADDER still starts
as a real limit. It does: with the rest of the base maxed, Mare Tranquillitatis
and Shackleton Rim fill all five storage levels inside a day, Aristarchus four,
Far Side Flats two. Above those, the propellant half of a storage upgrade is
capacity a daily player cannot reach; the metals half still binds everywhere,
which is what keeps storage from ever being a dead purchase.

**`fillTime` asks the sustained rate, not the hour in front of the base.**
`rates` will spend a water stockpile inside the hour it quotes; a tank that
takes thirty hours to fill will not have one for twenty-nine of them. So
`fillTime` asks the base in the state it converges to — stockpile gone, the
extractor feeding the processor directly.

**Storage caps offline accrual, per resource** (DESIGN.md §3). `accrue` fills
toward `capacity(base)` and stops; the surplus is not banked, not queued, and
not lost with a warning — it simply was never produced, which is what a full
tank means. The cap is therefore both the offline limit and the natural
upgrade, exactly as §3 says.

**Metals are spent on-site and never launched.** `buildCost` prices the first
level of each type in funds (it is launched) and every level after it in
metals (it is built there). That is the payoff DESIGN.md §8 promises the metals
branch, and it is why metals have a plentitude but no quality: nothing
processes them.

**Accrual is a pure function of a base, a site and a duration.** It does not
know what time it is, does not clamp (that is `clock.js`), and returns the new
base beside what it produced so the UI can say what happened while the player
was away without diffing two states.

## js/core/state.js, js/core/save.js — schema v5

`SCHEMA_VERSION = 5` in `save.js` **and** the duplicated literal in `newGame`
(the duplication is deliberate — `state.js:12`). `migrations[4]` adds the four
new fields as a whole-object literal, like the four before it:

```js
lastTick: null,                 // ms epoch of the last accrual, null = never
sites: {},                      // { [siteId]: { surveyed: bool } }
bases: {},                      // { [siteId]: { equipment: { ...: level } } }
```

and back-fills history entries with `surveyed: null` and `hauled: null`.

**`lastTick: null` rather than 0.** A migrated save has never ticked, and 0 is
the epoch — an `elapsedSince(0, now)` would clamp to a full day and credit a
save that has never had a base with a day of production the first time it is
opened. `null` means "start the clock now, accrue nothing", which is the true
statement, and `clock.js`'s `tick` returns `elapsed: 0` for it.

**`sites` holds what the player knows, `bases` holds what they have built**, and
the two are separate maps rather than one because they answer different
questions and are written at different times: a survey writes `sites`, a
landing and a purchase write `bases`. A site can be surveyed and unbuilt (the
common case, and the one that makes the survey a decision) or built and
unsurveyed (impossible today, but the shape should not forbid what a later
tier might want).

**`resources` stops being a complete, unused foundation.** It has carried
`{ water, fuel, oxidizer, metals }` since phase 0 (`ARCHITECTURE.md:320`) with
nothing crediting it. `accrue`'s output is credited through `economy.js`'s
existing `credit`, which already takes a `resources` bag — so the ledger needs
no change at all, which is what that foundation was for.

## Depots, and the manual haul

**A depot is an object, not a new collection.** `state.objects` already holds
everything launched and left in orbit, with a `kind`; a depot is
`kind: 'depot'` with a `store` of propellant and the body it orbits. It is
deployed by a mission the way a station core is, and `contracts.js`'s
`requiresObject` and `unique` gates already say what needs saying about "one of
these already exists".

**The haul is resolved analytically, and does not launch from the pad.** A haul
flies from a base on the lunar surface to a depot in lunar orbit, and the
integrator has one planet-centred frame and one atmosphere — the same
constraint that kept the moon from being a second attractor. So `resolveHaul`
is a sibling of the lunar sequence rather than a case of `resolveLaunch`: a
delta-v ladder of exactly one rung (`moon.js`'s `ascent`, 1 879 m/s), a
reliability roll on the tanker, and a cargo number. The launch *flow* is
unchanged — pick it off the board, watch it, read the outcome — which is what
DESIGN.md §8 means by "it uses the same launch flow as a mission, so nothing
new is built". `js/ui/surface.js` already draws a lunar liftoff.

**Hauls count toward the launch score** (DESIGN.md §8), so `recordLaunch`
counts them like any other launch. That is what makes auto-transport a score
improvement and not only a convenience.

**"Hauling pays from the first trip" is a tree constraint, and the number says
which one.** A one-way tanker climbing the 1 879 m/s ascent rung delivers this
much cargo per unit of propellant it burns, at 15% dry mass:

| tanker isp | mass ratio | cargo delivered per unit burned |
|-----------:|-----------:|--------------------------------:|
| 280 | 1.982 | **0.89** |
| 320 | 1.820 | **1.06** |
| 360 | 1.703 | 1.24 |
| 450 | 1.531 | **1.64** |

So a hypergolic tanker *loses* propellant on every trip and a storable one
breaks even inside the noise. Hauling pays only if the tanker burns what the
processor makes — so **the one tanker the tree sells is hydrolox** (`struct-16`
sets `haulIsp` to 450), which is exactly what the processor makes out of the
site's water: the tanker burns the thing it is there to carry, and that is what
closes the chain. That is not a balance knob; it is the ascent rung and the
rocket equation, and the tests assert the ratio for every tanker the tree can
sell rather than trusting it. A 4 t run at
isp 450 burns 2 441 kg to deliver 4 000, netting **+1 559 kg** at the depot; at
isp 320 it nets +230 kg, which is a chore that pays nothing.

**The smallest haul worth flying is half a tank, not a tonne.** A floor on the
cargo exists so a launch is not spent on a gesture, and its whole content is
the advice "let the tanks fill". An ABSOLUTE floor cannot give that advice
honestly: what a base can send is `maxCargo`, and with full tanks that is
`223.6 kg` per storage level (STORE_PER_LEVEL 360, split at the mixture ratio,
less what the 1 879 m/s ascent burns). A one-tonne floor was therefore
unreachable below storage 5 — a full level-1 farm holds 224 kg and can never
hold more — so the base tab's "Storage full … find a cargo run" prompt pointed
at a run the resolver refused, and `tools/balance.mjs`'s own model of the
economy (five manual runs out of a level-1 farm to afford auto-transport) was
counting flights the game would not fly. So the floor is `MIN_HAUL_FRACTION`
(0.5) of `fullCargo` — what this base could send with its tanks at their cap —
and "let the tanks fill" is true at every storage level. `tools/balance.mjs`
walks all five and `test/haul.test.js` pins it.

**Advice is not a flight.** The three refusals — no tanker, no transport
equipment, tanks below the floor — are things `haul.js` says without anything
leaving the pad. Resolving one anyway still spent a launch, wrote a history row
and charged the mission's `repLoss`, so a player was docked reputation for
being told their tanks were not full yet. `haulBlocker(vehicle, base)` returns
the reason or null; `js/ui/screens.js` asks it BEFORE resolving and shows the
answer as a screen error the way it already does for a missing base or depot,
and `resolveHaul` asks the same function so the two can never drift.

## js/data/missions.js — 3b's rungs

No new tier, so these are `tier: 4` templates that appear once their gates
open:

- `moon-survey` — the survey, one per site, `requirement: { moon: { profile:
  'survey', site } }`, gated on the tier 4 orbit hardware and offered only for
  a site not yet surveyed. Cheap, repeatable across sites, and the reason the
  orbit tier still has something to do.
- `depot-deploy` — deploys the depot, `unique: true`, gated on the depot
  hardware.
- `haul` — the cargo run, `requiresObject: 'depot'` plus a built base with
  product in it. Its payout is not funds: it moves resources.

`mission.profile` gains `'survey'` and `'haul'`, and `data.test.js` keeps
pinning that a template's `profile` agrees with its requirement.

## js/ui — the BASE tab and the notification

- **A fourth tab.** `tabsHtml` has held CONTRACTS / MISSIONS / TECH TREE since
  phase 2; 3b adds BASE, and it is empty-with-an-explanation until the first
  survey rather than hidden, because a tab that appears without warning is a
  worse surprise than one that says what would fill it.
- **What it shows**: each site (surveyed or not, and what a survey would tell
  you), each base's five equipment levels with the next level's cost, the
  power balance as supply against draw, and per-resource storage as a bar
  against its cap with the current rate beside it. The rate is the number the
  player is buying, so it is quoted per hour and not per second.
- **What happened while you were away.** On the first render after a `tick`
  with a non-zero elapsed, the base tab leads with what accrued and what
  filled. This is the whole visible payoff of the clock, and a game that
  accrued silently would have built an idle mechanic nobody noticed. It speaks
  when nothing accrued too, which is the case that matters most: a player who
  was away eight hours and gained nothing because a tank was full needs telling
  that more than one who gained something. It says what the automatic route
  delivered, and the storage-full warning carries the button that reaches the
  board a cargo run is offered on, rather than naming a screen to go and find.

## The base tab, laid out (a correction)

The section above says what the tab shows and was true of the markup from the
day it was written. What it did not say is how any of it is arranged, and the
first version got that wrong in a way no check caught for a phase:

- **A site is a block, not a row.** `.row` is `display: flex; flex-direction:
  row` — right for a contract, which is a title beside a price, and wrong for a
  site, whose children are a heading, two sentences and two lists. Reusing it
  made those five children into five columns: the site name rendered one letter
  per line and the tank list was pushed off the right-hand edge of the phone.
  `.site` therefore carries its own padding and rule and does not reuse `.row`.
- **The browser check reads boxes now, not only text.** Every text assertion in
  `test/e2e/base-tab.mjs` passed throughout, because the words were right and
  only their geometry was wrong. It runs at 390 x 844 and measures the site
  name's width, the tab labels' line count and the screen's horizontal
  overflow — the three things that were broken and the class of thing a
  `textContent` check can never see.
- **The tab strip breaks at 460px, not 380.** "TECH TREE" is two words, and
  every phone in the current range (390 / 393 / 402 / 430) sat above the old
  breakpoint with the strip wrapped to two lines.

Three readouts were added at the same time, each one a number the core already
computed and the screen did not show:

- **When a tank fills**, from where it is rather than from empty — that is what
  the storage upgrade sells (DESIGN.md §8), and `js/core/base.js`'s `fillTime`
  answers the from-empty question for `tools/balance.mjs` instead. A tank whose
  net rate is negative says when it empties, which is the same sentence about a
  processor eating a stockpile.
- **A level against `MAX_LEVEL`**, so a maxed piece and a first level do not
  read alike.
- **How long an unaffordable metals price is away**, in hours at the base's own
  metals rate. A metals cost is paid out of the base's own store at the base's
  own rate, so "400 short" and "two hours short" are the same fact and only the
  second says whether to wait. A funds shortfall gets no such number: funds do
  not accrue, and the answer to that one is a launch.

And one sentence per base saying what is wrong with the chain — browned out,
no processor, processor outrunning extractor, or extractor outrunning
processor. Every fact in it is already on the screen; the line exists because
reading four bars that way requires knowing the chain, and the chain is the
mechanic rather than something to infer.
- **The storage-full notification** (DESIGN.md §8) fires when a resource
  reaches its cap while its route is manual, and stops once auto-transport is
  bought — that is what the player is buying. Web build: the Notifications API
  behind a permission the player grants from the base tab, and nothing at all
  if they do not. Capacitor: Local Notifications, the one native plugin
  DESIGN.md §13 identifies. It is never a badge on a timer the player is
  waiting out.
- **The permission is asked for on the base tab or nowhere.** A button that
  appears only once there is a base to notify about, on the screen the
  notification is about. Asking at boot — before the player has a base, a tank,
  or any idea what would be notified — is the pattern every user has learned to
  dismiss, and a refusal is an answer rather than a thing to ask again. A
  player who never presses it loses only the notification: the same warning is
  on the page.

## Balance, phase 3b

`tools/balance.mjs` gains an economy section, and it asserts the four things
DESIGN.md states as requirements rather than as hopes:

1. **A haul pays from the first trip.** Cargo delivered per unit burned > 1
   with the cheapest transport-node closure, computed from `moon.js`'s ascent
   rung and the tanker's own isp. Fails the build if the tree lets a player buy
   a losing tanker.
2. **Auto-transport is in reach.** Its total funds cost is affordable to a
   player with one base and a handful of hauls, measured from the tier 4 end
   state the greedy simulation already produces (100 reputation, ~77 000
   funds, 53 nodes).
3. **Storage is the offline limit, not the clamp.** At every buyable
   combination of extractor and storage levels, the time to fill storage from
   empty is under `ELAPSED_CLAMP` — otherwise the cap never binds and the
   upgrade sells nothing.
4. **Metals pay for the next piece of equipment.** The metals a site yields at
   level 1 cover the level 2 build cost in a bounded number of days, or the
   metals branch is a resource that only gates.

**Measured, once 3b was built.** Every one of the four passes, and two of them
moved a number to get there:

- **Hauling pays.** The one tanker the tree sells (`struct-16`, isp 450) burns
  **2 441 kg to deliver 4 000**, a ratio of **1.64** and a net of **+1 559 kg**
  at the depot. Nothing in the tree can sell a losing tanker; the test walks
  every `haulIsp` effect rather than the one that exists today.
- **Storage binds before the clamp, with margin.** The slowest propellant tank
  is far-side-flats at level 3: **21.4 hours** against a 24-hour clamp. It was
  **23.8 hours** at the first sizing, which passed and would have stopped
  passing on any change to a rate, a site or the clamp — so `STORE_PER_LEVEL`
  came down from 400 to 360 and the metals share went up to keep the stockpile
  clearing the dearest next-level cost. A margin a tool reports is worth more
  than a pass it does not.
- **Metals pay quickly enough to matter.** The cheapest level 2 (storage, 350
  metals) takes **0.5 days** at the metal-rich site, **0.8** at the middling
  one and **1.8** at the poorest. The site choice is visible in the number,
  which is what the survey is for.
- **The metals stockpile holds the next upgrade at every level**, which is the
  soft-lock rule rather than a balance one.

## Deferred out of 3b

Mining as a profile of its own, the asteroid economy, and anything that makes a
resource sellable for funds — DESIGN.md §15 excludes the last by name, and the
first two are tier 6.

# Phase 4 — automation, resource gates, refueling

The three things DESIGN.md's table lists for phase 4, and they are one phase
because each is meaningless without 3b and none of them needs the others.

## js/data/tree.js — automation flags and resource-priced nodes

**Automation is tiered, and each tier removes one named chore** (DESIGN.md §8):

| node | effect | the chore it removes |
|------|--------|----------------------|
| auto-route | `autoHaul` set 1 for one body's base→depot route | the haul launch |
| auto-rate | `haulRate` add | waiting between automatic hauls |
| auto-capacity | `haulCapacity` mul | a depot that fills slower than the base |

Three small purchases rather than one large one, and the manual phase returns
briefly each time a new body opens — which is the shape §8 asks for and the
reason `autoHaul` is per route rather than global.

**Resource-priced nodes are what `cost.resources` was built for.** `economy.js`
has taken `{ funds, resources }` costs since phase 0 and `canAfford`/`debit`
already handle them; phase 4 is where a node finally carries one. The rule
DESIGN.md §8 sets is the one to keep: a resource-gated node costs something
**no contract pays out**, so only landings unlock it. A node priced in funds
*and* metals is fine; a node priced in metals that a contract could pay for in
funds is the "funds with a detour" §8 forbids.

## js/core/base.js — auto-transport on the clock

With `autoHaul` owned for a route, `accrue` moves product to the depot as part
of the same tick, at `transport level × haulRate`, and the storage cap stops
being the binding constraint on that resource — which is precisely what the
notification stopping means. The propellant the automatic haul burns is charged
at the same ratio a manual one pays, so automation buys away the *launch*, not
the physics.

## js/core/resolver.js — refueling at a depot

The mechanic DESIGN.md §8 calls "what makes tiers 5 and 6 reachable", and the
smallest change in phase 4:

> A vehicle that reaches a depot holding propellant tops up its remaining-stack
> budget before the sequence spends it.

Concretely, in the analytic phase, after the insertion budget is summed and
before the ladder is walked: if the mission's route passes a depot with a
`store`, and the vehicle carries the refuel fitting, add

```
isp * G0 * ln((m + p) / m)
```

for the propellant `p` the depot can transfer into the stage of mass `m`. It is
the same Tsiolkovsky term the budget is already built out of, so a refuel is
not a new kind of number — it is more of the one number the whole game is
about (DESIGN.md §4).

**It is a stop, so it takes time on the timeline.** The `refuel` event sits at
`loi + LLO_PERIOD / 8` — squarely between the capture and the descent burn a
quarter of a lunar orbit after it — and not one second after the capture, which
is where it used to be: at the map view's cislunar rate that put the two on the
same playback frame, so the flight arrived at the moon and refuelled in one
instant, three hundred and eighty thousand kilometres away with the camera
still wide. Nothing about the pricing moves; the delta-v is still credited the
moment the sequence walks past that line.

**What it does to the ladders already measured.** Nothing to the ladders: they
are properties of the bodies. What moves is the budget they are spent out of —
a lunar depot turns the tier 4 `return`'s 623 m/s of margin into whatever the
depot holds, and the tier 5 goal's 12 555 m/s stops being measured from
9 151 m/s of remaining stack. ARCHITECTURE.md's phase 5 section says this from
the other side and stays true as written.

## Balance, phase 4

1. **A refuel is worth more than the haul that filled it.** The delta-v a
   depot's propellant buys a departing vehicle, against the propellant the
   hauls burned to put it there. If that is under 1 the depot is a way of
   destroying fuel.
2. **Automation does not break the launch score.** The greedy simulation runs
   with and without the automation nodes; the automated run must take fewer
   launches (§8: buying auto-transport improves the score) without collapsing
   the tier below the 15-launch floor.
3. **No resource-gated node is reachable by funds alone**, checked by
   enumeration over the tree — the §8 rule, asserted.

**Measured, once phase 4 was built.**

- **A refuel is worth far more than the haul that filled it.** One tankful into
  the full tree's top stage — **70 kg into a 14 kg stage at isp 467** — is
  **8 201 m/s**, against the 43 kg of base production the hauls burned to put
  it there. That is not a balance error, it is the rocket equation on a stage
  whose dry mass is a tenth of its propellant, and it is exactly why
  `TANK_LIMIT` caps the transfer at one tankful rather than at what the depot
  holds. What it costs is the long way round: a survey, a base landing, five
  equipment purchases, a depot, several hauls and two tree nodes, against the
  two nodes the direct route to the same goal needs.
- **Auto-transport is in reach.** `guide-8` is 150 000 funds and 900 kg of
  propellant; a tier 4 winner ends the tier on **76 800 funds**, and one full
  level-1 tank farm sends 248 kg, so it is **four manual runs** and a few more
  contracts away. "A handful of hauls" is met.
- **The greedy tier 4 player is unchanged at 18 launches**, which is the result
  that matters most: 3b and 4 add to the tier without disturbing the ladder it
  is scored on. None of the economy templates is on the critical path to the
  tier goal, and the simulation confirms the board still routes around them.


# Phase 5 — tier 5, the neighbours

Additions to the phase 0, 1, 2 and 3 contracts. Tiers 1 to 4 keep working
unchanged; every existing test keeps passing.

## Where this sits in the build order, and the conflict to settle first

DESIGN.md §14's phase table puts **3b** (survey, resources, equipment, bases,
the clock, haul) and then **4** (auto-transport, resource-gated nodes,
refueling delta-v) before this one, and §8 says in as many words that
refueling "is the mechanic that makes tiers 5 and 6 reachable without absurd
vehicles". This document was written before either of those, and recorded the
order as the owner's call rather than resolving it.

**That call has since been made: 3b and 4 are built first, completely.** Their
contract is the two sections immediately above this one, and the table's order
stands as written. So tier 5 is built on a game that already has resources,
bases, depots and refueling — which changes none of the measurements below and
one of the conclusions, noted where it lands.

The measurement that made that a free choice still stands and is still worth
keeping. The ladder in §"Measured, before the tier was built" is priced **with
no refueling anywhere in it**, from the parking orbit a tier 4 vehicle actually
reaches, and it closes. Refueling makes tier 5 cheaper; it is not what makes
tier 5 possible. Its value now is as a floor rather than as a schedule: the
tier 5 tree must still be able to close the goal for a player who has built no
base, because 3b adds no tier goal and nothing forces a player through it. The
last section says what phase 4's refueling changes on top of that floor.

## What tier 5 is, and what it is not

DESIGN.md §6 gives the tier one line — "Land on a body in another system.
Transfer windows, mission duration, many bodies. Depth comes from profiles per
body, not body count" — and two failures: "missed window" and "short by X".

**Tier 5 is the flight tier again**, on the phase 3 precedent and for the same
reason: each rung pays a contract and the tier wins on the last of them, so it
reads as finished with no resource in the game. Nothing here surveys, extracts,
processes, hauls or accrues.

**The enemy of tier 5 is time, not thrust.** That is the sentence the whole
phase hangs off, and it is what makes the tier different from tier 4 rather
than being tier 4 at a longer range. The measured ladders below say why: every
rung except the goal is already inside what a tier 4 winner's stack can spend,
so a tier priced on delta-v alone would open with five rungs already flyable
and one wall at the end. What a tier 4 stack cannot do is *last*: the goal is a
**972-day** flight, the cheapest rung is **259 days**, and a lunar return is
eleven. So the tier introduces two gates that are not delta-v —

- **the window**, which costs days spent in the parking orbit waiting for the
  next departure opportunity, and
- **endurance**, the days of propellant, power and thermal control the vehicle
  carries, which is what those days are spent out of

— and they are the two failures DESIGN.md names, in that order.

**The star is not a third attractor, for the same reason the moon was not a
second one.** The ascent integrator keeps its one central gravity term and its
one planet-centred frame (`resolver.js`); an interplanetary flight is resolved
analytically after insertion, as a sequence of burns and waits the vehicle can
or cannot afford. `js/core/system.js` is to the star what `js/core/moon.js` is
to the planet: a set of constants and a ladder derived from them.

## js/core/system.js — new, pure

The star, the home planet's heliocentric orbit, the other bodies, and the
ladder and schedule derived from them. Pure: no DOM, no `Date.now`, no
`Math.random`. A sibling of `moon.js` one level up, and it prices everything by
calling `orbit.js`'s own functions, so there is no magic m/s in it either.

```js
export const MU_STAR                  // the star's gravitational parameter
export const A_HOME                   // the planet's heliocentric radius, m
export const HOME_PERIOD              // the planet's year, s (derived)

export const BODIES                   // the table, keyed by id
export function bodyLadder(body, parkPeriapsis, parkApoapsis)
  // -> { tmi, capture, descent, ascent, tri, tof, stay, synodic, departPhase }
export function bodySchedule(t0, parkPeriod, ladder, phase, windowWait)
```

**The shape change from `moon.js`, and it is the only one.** `moon.js` holds
*the* moon: module-level constants, and `lunarLadder(rp, ra)`. `system.js`
holds a *table*, and every function takes the body as its first argument.
Everything else — the units discipline (radii, never altitudes, with the two
named-altitude exceptions), the "computed, not looked up" rule, the header that
lists every approximation — carries over unchanged, and the list of
approximations is the same five with one addition: **the transfer is coplanar
and circular-to-circular about the star**, so no body's eccentricity or
inclination is ever charged. Real windows move by hundreds of m/s between
oppositions because of exactly that; the game has no clock to move them with.

**The bodies.** Four, which is "many bodies" as DESIGN.md means it — depth is
the profiles, not the count.

| id | what | heliocentric a | why it is here |
|----|------|----------------|----------------|
| `inner` | the inner planet | 0.72 AU | a second window, in the other direction, and a body you can reach but not come home from |
| `outer` | the outer planet | 1.52 AU | the tier's destination and its goal |
| `outer/a` | its inner moon | 9 376 km from `outer` | a landing that is a docking |
| `outer/b` | its outer moon | 23 460 km from `outer` | the same, further out and cheaper to reach than to leave |

The moon ids are paths because a moon is priced *through* its planet: the
capture is made at the moon's own orbital radius rather than at a low orbit, so
`bodyLadder` for `outer/a` calls the `outer` arrival and then stops at 9 376 km
instead of at 300 km. That is one branch in one function, not a second module.

**The rungs, all derived.** `tmi` is the departure burn from the parking
orbit's periapsis to the heliocentric transfer's excess speed — the same
`sqrt(vInf² + 2 mu / rp) - v_park` form `moon.js` uses for `loi`, run the other
way, which is what makes the two modules obviously the same physics. `capture`
is that form at the destination. `descent` and `ascent` are circular speed at
the destination's low orbit times a loss factor, and **the atmosphere is a real
term for the first time**: on a body with one, entry does most of the braking
and the descent is charged a quarter of circular speed rather than 1.15× it,
which is the difference between a 6 546 m/s landing and a 10 000 m/s one. It is
still not free — `moon.js`'s approximation 5 gives a *free* entry at the home
planet only, where the vehicle arrives on a return trajectory it does not have
to survive an orbit in.

**`stay` is computed, and this is the one number tier 4 could not compute.**
`moon.js`'s `SURFACE_STAY` is a game constant with a comment apologising for it
("nothing measures it"). At another planet nothing is arbitrary about it: a
vehicle that lands must wait on the surface until the geometry for the way home
comes round, and that wait falls straight out of the two orbital periods and
the time of flight. The derivation is the same phase-angle algebra the
departure window uses, run once more at the far end. Measured: **455 days** at
the outer planet, **467** at the inner. Nothing is chosen.

## js/core/resolver.js — the interplanetary sequence

**New requirement shape** (a mission has exactly one, as ever):

```js
{ body: { id: 'outer' | 'inner' | 'outer/a' | 'outer/b',
          profile: 'flyby' | 'orbit' | 'land' | 'return' } }
```

`requirementKind` gains a `'body'` arm; `needsInsertion` gains it too;
`needsTarget` keeps its tier 3 meaning and stays false — a body is a constant
in `system.js`, not an entry in `state.objects`, exactly as the moon is.
`cutoffAlt` is `ORBIT_MIN_ALT` for the same reason it is for a lunar mission,
and with a larger payoff: the Oberth discount on the eccentric parking orbit an
`ORBIT_MIN_ALT` cutoff actually leaves is worth **up to 893 m/s** on the goal
rung (12 555 m/s from 85 × 194 km, 11 662 from 80 × 4 381).

**The sequence loop is extracted, not duplicated.** `resolveLunarSequence` and
the new `resolveBodySequence` are the same function: walk a ladder in flight
order, check the hardware gate in front of each step, check the restart, check
the delta-v, roll the landing, push the burn and the events, stop at the first
step that cannot be flown, and report the shortfall as this step plus
everything the profile still had to fly. The two differ only in *which* ladder,
*which* schedule and *which* labels. So the loop moves to one place and the two
callers supply a ladder, a schedule, a step list, a label map and a gate map.

The tier 4 tests are what make that safe, and they are the condition on it: the
lunar sequence has pinned behaviour down to its **rng draw order**, and any
extraction that moves a draw is wrong. If the extraction distorts the lunar
case, it is abandoned and the loop is written twice — a shared function is not
worth a changed tier 4.

**The ladder's steps keep their five names.** `LUNAR_STEPS` becomes the shape
both ladders share (`['tli','loi','descent','ascent','tei']` for the moon,
`['tmi','capture','descent','ascent','tri']` for a body), and `reached` stays
an index into whichever list the mission is flying. The two lists are the same
length by construction, and both modules' comments already say that inserting a
step renumbers every saved best.

**The window.** `loadout.window` already exists and already means "where in the
cycle you launch" (`resolver.js`, tier 3). For a body mission it is the
fraction of the **synodic** cycle, and the wait is forward-only:

```
windowWait = ((departPhase - window) mod 1) * synodic
```

The departure burn happens `windowWait` after the parking orbit is reached, and
those days are spent out of `endurance`.

**Why the window costs time and not delta-v, measured.** The obvious model is
tier 3's — an error in degrees, priced per degree — and it is wrong here, which
is worth recording because it is not obvious. Buying a different arrival with a
faster transfer barely moves the departure geometry: at the outer planet a
transfer with 1.5× the Hohmann semi-major axis cuts the trip from 259 days to
108, costs **3 404 m/s** extra at departure, and moves the required departure
phase angle by **6.9 degrees**. At 2.2 days of waiting per degree that is
fifteen days of endurance bought for three and a half kilometres per second. So
there is no delta-v answer to a missed window, in this model or in the real one
— you wait, and if you cannot afford to wait you do not go. Tier 3's phasing
burn stays what it is; the two are different problems that happen to share a
slider.

The cliff is real and is handled by **visibility, not by softening**: the wrap
means a window set slightly *late* costs most of a synodic period (780 days at
the outer planet), which no tier 5 vehicle survives. The map draws the bodies
and the departure point, and the shop quotes the wait in days before the
launch is bought, so a missed window is a decision the player made with the
number in front of them rather than a surprise. That is the same contract the
tier 3 window slider already keeps.

**Endurance.** A new capability stat on the vehicle, in the shape of `lander`
and `shield` (`vehicle.js`'s `CAPABILITY_STATS`, defaulting to 0), and the
first one that is a *quantity* rather than a flag:

```
endurance   seconds of mission the vehicle's propellant, power and thermal
            control support after insertion
```

The sequence checks it in front of every step, against the schedule's own time
for that step, and stops with `stoppedAt: 'endurance'`:

> "Consumables exhausted on day 412 of 972, waiting for the descent."

It is checked before the delta-v, because a vehicle that has run out of days
never gets to be short of m/s. It is not rolled: boiloff is not a dice throw,
and a tier whose failures were all rolls would have nothing to buy against.
A tier 4 mission is unaffected — the lunar ladder's longest flight is eleven
days and every tier 4 stack has `endurance` 0, so the lunar caller passes no
endurance ladder and the check is not made. (Making `endurance` bite on tier 4
retroactively would break a shipped tier; the gate belongs to the sequence's
caller, not to the loop.)

## js/core/state.js, js/core/save.js — schema v6

`SCHEMA_VERSION = 6` in `save.js` **and** the duplicated literal in `newGame`.
`migrations[5]` adds `best.bodySteps: {}` and back-fills history entries with
`bodyStep: null`, following the whole-literal rewrite the five before it use.

**The version number, and why it is 6 rather than 5.** This section was written
when tier 5 was the next phase and claimed v5. Phase 3b takes v5 (the clock,
sites and bases); phase 4 takes none, because automation is owned nodes,
resource pricing is a cost shape `economy.js` already handles, and a depot's
store is a field 3b's `objects` already carries. So tier 5 lands at v6 — and
the general rule this is an instance of is that **a phase's schema number is
whatever is next when it is built, not what the plan guessed**, since the
migration chain is walked in order and a gap in it is a save that cannot load.

`best.lunarStep` is a single number because tier 4 has a single destination.
Tier 5 has four, and a per-body best is what a per-body goal has to read:

```js
best.bodySteps = { [bodyId]: step }   // step is the resolver's own `reached`
```

Absent key means "nothing completed", which is the same statement `-1` makes
for `lunarStep` and is why the map is empty on a fresh game rather than
pre-filled with `-1`s. `recordLaunch` raises `best.bodySteps[id]` from
`outcome.body.reached`. `tierGoalMet` gains a `{ body }` arm reading
`best.bodySteps[req.body.id]` against the profile's required step, with the
same `required < 0` guard the `{ moon }` arm makes and for the same reason —
the function ends in `return false`, so an unmapped profile has to be rejected
before the comparison rather than by it.

`state.js`'s local `LUNAR_STEP_ORDER` copy gains a second list on the same
terms and for the same two reasons the first one is a copy (`state.js` is on
the load path of the save screen; what it needs is an ordinal, not orbital
mechanics). `test/state.test.js` pins both orders against their modules.

`objects` is untouched: an interplanetary flight deploys nothing in phase 5.

## js/core/tree.js, js/data/tree.js — tier 5

Tier 5 nodes (`tier: 5`), 14 to 16 — tier 4 shipped 14 — four branches, costs
stepping up from tier 4's 80 000–240 000 the way tier 4 stepped up from
tier 3's.

- **propulsion**: a storable or actively-cooled deep-space stage (isp mul *and*
  the first `endurance` add — the propellant is what boils off), a departure
  propellant stretch, and a sixth relight (`restarts` add 1). An `outer`
  `return` spends five burns — tmi, capture, descent, ascent, tri — which is
  exactly what tier 4 already sells, so whether a sixth is bought for margin or
  the branch spends its nodes on isp and propellant instead is a `balance.mjs`
  question, not one to settle here.
- **structure**: the interplanetary launch vehicle, the transfer stage
  (`addStage`), an aeroshell rated for the destination's atmosphere
  (`landerBonus`, and it is what makes the quarter-of-circular-speed descent
  legitimate), and the long-duration bus (`endurance` add, the large one).
- **guidance**: deep-space navigation, and window planning — the node that
  narrows the window the shop will let a launch be bought inside, which is the
  only guidance node in the game that changes a *pre-launch* number.
- **reliability**: long-duration qualification (`endurance` mul), and landing
  rehearsal at the second body (`landerBonus`).

**Every trap phase 3 recorded still applies, and one is now load-bearing.** A
stage-adding node must be a structure node (`collectEffects` hoists `addStage`
in branch order, and propulsion sorts before structure), so the transfer stage
is structure and propulsion sells its engine. Tier 5 is a launch vehicle, not
an attachment, for the same reason tier 4 was. The cross-branch TWR rail
extends unchanged. `data.test.js`'s ideal-full-tree delta-v bound moves with
this tier and is re-pinned rather than deleted.

**`endurance` is the first stat sold by three branches at once**, which is
deliberate: it is the tier's real currency, and a tier whose one new axis was
buyable from a single branch would make the other three optional.

## js/data/missions.js — tier 5 ladder

Seven rungs, all `tier: 5`, following tier 4's composition:

- `deep-relay` — the income filler, orbit-shaped, `deploys`, repeatable, **no
  `minReputation`**, requirement capped at hardware a tier 4 winner owns by
  construction. Tier 3 needed one, tier 4 needed one, and a tier 5 arrival is
  in the same position: without it the board's only income is the floor
  contract for as long as the first transfer stage takes to buy.
- `outer-flyby`, `outer-orbit` — the first two rungs, both flyable on a tier 4
  stack's delta-v and gated on endurance instead.
- `moon-land` (`outer/a`) — the landing that is a docking: 9 m/s of touchdown
  at the end of a 259-day flight.
- `outer-land`, `inner-orbit` — the two mid rungs, and the pair that makes the
  tier about bodies rather than about one body.
- `outer-return` — the goal.

```js
tierGoals[5] = { requirement: { body: { id: 'outer', profile: 'return' } },
                 name: 'Land on another world and return' };
```

`mission.profile` keeps the meaning phase 3 gave it and `data.test.js` keeps
pinning that it agrees with the requirement. A body rung's `profile` is the
same four values; the body is in the requirement, not in the profile, because
the profile is what is flown and the body is where.

**Gates.** `tools/gates.mjs`'s `MAX_TIER` goes to 5 and keeps deriving gates
for the altitude/downrange/orbit shapes. The six body rungs are hand-authored
and *measured*, as the lunar four are: each flyable with exactly its
`requiresNode` closure across every selectable loadout, and not flyable when
the node the rung is really about is removed. Endurance makes that measurement
harder than tier 4's, because a rung can now be gated by a node that changes no
delta-v at all — `gates.mjs` must report the endurance gate separately from the
delta-v gate, or a rung will look ungated.

## js/ui — what tier 5 adds

- **Map view, a third frame.** The planet-centred frame is stretched ×6 and the
  cislunar frame fits `A_MOON`; neither can hold 2 AU. At a fit that holds
  the outer planet's orbit the moon's entire orbit is about a pixel across, so
  the whole tier 4 picture is one dot. So a body outcome selects a **heliocentric
  frame**: the star at the centre, the home planet's orbit and the
  destination's drawn as circles, both bodies at `MIN_BODY_PX`, the transfer as
  the planet-centred code's own ellipse about the star, and the corner note
  saying the bodies are not to scale. `drawOrbit`, `elementsFrom` and
  `positionAt` all still apply — the transfer is a Hohmann ellipse about a
  different focus, which is the whole payoff of resolving it as one.
- **The camera goes in, twice.** The cislunar frame already hands off to a
  close-up at the moon and then to `surface.js` on the ground. The same two
  handoffs happen at the destination, and `surface.js` already takes
  `state.body` and already draws a sky, so a third body is a data addition
  there rather than a new module.
- **The window is drawn before the launch.** The shop's loadout panel gets the
  departure geometry: where the destination is, where it has to be, and the
  wait in days for the current slider position. This is the only pre-launch
  number in the game that comes out of `system.js`, and it is what keeps the
  window from being a cliff (see the sequence above).
- **Duration, everywhere.** Mission elapsed time stops being minutes and
  becomes years. The result screen reports it in days, the playback rate needs
  a fourth scale (a 972-day flight at the cislunar rate is a twenty-minute
  animation), and the mission list quotes each rung's duration next to its
  payout — a 972-day contract that pays 3× a 259-day one is a worse deal per
  day, and the player should be able to see that.

## Balance, phase 5

`tools/balance.mjs` gains tier 5: the cheapest prereq-valid set reaching each
rung, the greedy player from the tier 4 end state through the goal (target 15
to 60 launches, dry streak 4 or under), the remaining-stack delta-v budget at
insertion against each profile's ladder, **the endurance budget against each
profile's duration**, and the TWR sweep extended to tier 5 sets.
`data.test.js` asserts reachability of every tier 5 rung and greedy ≤ 80.

**Measured, before the tier was built**, and reproducible: `tools/t5-ladders.mjs`
prints every number below from `orbit.js`'s own functions, against the parking
orbit a tier 4 `return` actually flies (85 × 194 km — the widest notch
`balance.mjs` reports today). It exists because the module that will own these
constants, `js/core/system.js`, does not exist yet, and **it is deleted when
that module lands** — `balance.mjs` measures the tier against the real resolver
from then on, and a superseded probe is a second source of truth. All m/s at
insertion:

| rung | body | tmi | capture | descent | ascent | tri | ladder | duration |
|------|------|-----|---------|---------|--------|-----|--------|----------|
| `outer-flyby` | `outer` | 3 603 | — | — | — | — | **3 603** | 259 d |
| `moon-land` | `outer/a` | 3 603 | 1 881 | 9 | — | — | **5 493** | 259 d |
| `outer-orbit` | `outer` | 3 603 | 2 091 | — | — | — | **5 694** | 259 d |
| `outer-land` | `outer` | 3 603 | 2 091 | 852 | — | — | **6 546** | 259 d |
| `inner-orbit` | `inner` | 3 497 | 3 318 | — | — | — | **6 815** | 146 d |
| `outer-return` | `outer` | 3 603 | 2 091 | 852 | 3 918 | 2 091 | **12 555** | 972 d |

And the schedule, derived the same way: the outer planet's transfer is
**258.8 days** each way with a departure phase angle of **44.3°** and a
**455-day** surface stay, for a round trip of **972 days (2.66 home years)**;
its synodic period is **780 days**, so a degree of window error is 2.17 days of
waiting. The inner planet is 146.1 days each way, −54.1°, a 467-day stay and a
584-day synodic period.

**Three things those numbers settle.**

1. **The tier opens playable and closes hard.** A tier 4 winner's stack carries
   **9 151 m/s** at insertion (`balance.mjs`, `moon-return`'s widest notch), so
   five of the six body rungs are already inside its delta-v on the day the
   tier opens and the goal is at 137% of it. That is the opposite of tier 4,
   which opened with `flyby` at 42% of budget and closed at 93%, and it is why
   the tier's early rungs are gated on endurance rather than on m/s. A tier
   whose first five rungs were also delta-v walls would be tier 4 again, longer.
2. **The inner planet is a body you cannot come home from, and that is content.**
   Its ascent alone is **8 224 m/s** — its surface gravity is nine-tenths of the
   home planet's and its low orbit is nearly as fast, and there is no cheap way
   off it — which puts a `return` at **20 146 m/s**,
   well past anything this tree will sell. So the inner planet ships with
   `flyby` and `orbit` only, the mission list says why, and the body is a
   standing argument for the refueling phase 4 has not built yet.
3. **The moons are where the landings are affordable.** Capturing at
   `outer/a`'s orbital radius costs **1 881 m/s**, *less* than capturing into a
   low orbit at the planet (2 091), and the touchdown is **9 m/s** — the whole
   descent is a station-keeping burn. A landing on the moon of another planet
   is therefore cheaper than an orbit of the planet itself, which is a genuinely
   surprising fact that falls out of the physics, and it is what makes "planets
   and their moons" a ladder rather than a label.

These are the shape, not the answer. Tier 3's contract said 200 km and shipped
160 km because the resolver disagreed with it; tier 4's tree was sized by
measurement against the flown parking orbit rather than the circular one it was
first quoted from. The same applies here, and the endurance ladder in
particular has no precedent to be sized against — it will be whatever
`balance.mjs` says makes the greedy player take 15 to 60 launches.

## Deferred, and what phase 4 would change

Deferred, unchanged from phase 3's list: survey, resources beyond the ledger
`economy.js` already carries, equipment, bases, depots, the clock, offline
accrual, storage caps, haul, notifications. Nothing in phase 5 credits a
resource and no tier 5 node is priced in one.

Also deferred, and named because they are the obvious next questions:

- **Gravity assists.** Not modelled, and the reason is the same one that keeps
  the moon from being a second attractor. Their absence is what puts the gas
  giant out of reach: capturing into its system costs **12 841 m/s** at a low
  orbit, and the real answer is a decade of moon flybys the game has no clock
  for. The giant is a tier 6 problem or a phase 4 one, not this tier's.
- **Aerocapture.** The atmosphere brakes the descent here but not the arrival.
  Letting a rated aeroshell take the capture burn to zero would drop the goal
  from 12 555 to **10 464 m/s** — a fifth of the tier's climb, sold as one
  hardware node. It is left out because the tier does not need it and because
  a capability that large should be a tier's identity rather than a node in
  the middle of one.

**If phase 4 lands first**, refueling changes exactly one thing and it is the
tree's job, not the resolver's: a vehicle that departs from a fuelled depot
starts the sequence with a full tank instead of with what its ascent left, so
the ladder above stops being measured from 9 151 m/s of remaining stack. Every
number in this document stays true — the ladders are properties of the bodies —
and what moves is how many propulsion and structure nodes tier 5 has to sell to
close a 12 555 m/s goal. The tier is cheaper to build after phase 4 and
possible without it, which is the point of pricing it this way.
