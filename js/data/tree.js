// Tier 1 tech tree. Three branches, per DESIGN.md §10: propulsion,
// structure, reliability. Effects are applied by js/core/vehicle.js in the
// order js/core/tree.js's collectEffects returns them (branch order, then
// level) — see the doc comment on `nodes` below for how that plays out.
//
// ---------------------------------------------------------------------
// BALANCING NOTES
// ---------------------------------------------------------------------
//
// Sized against the REAL resolver (js/core/resolver.js), not the ideal
// delta-v shortcut. A straight-up ascent pays gravity losses for the whole
// burn plus drag — far more than the resolver's `LOSS_ALLOWANCE` (15%, a
// readout-quoting game number, not a physical loss model). Content sized
// from the ideal-dv-and-15% arithmetic instead of the simulation is exactly
// the bug this file used to have: hand-computed, the full tree looked like
// it cleared the 100 km goal with ~2993 m/s of ideal delta-v against a
// ~1610 m/s ideal requirement; simulated, it topped out at 93.8 km — under
// the goal — because a low/mid-tier vehicle spends 30-50%+ of its delta-v
// on gravity losses alone, not 15%. So every number below is verified with
// `node tools/balance.mjs`, which drives `resolveLaunch` directly
// (reliability forced to 1 for determinism), not derived from Tsiolkovsky
// and eyeballed. Re-run it after touching any cost or effect here.
//
//   tier 1 goal:  100 km altitude. Cheapest prereq-valid set that reaches
//                 it: prop-1..4 + struct-1..3 (7 of 12 nodes, 16 100 funds,
//                 53% of the full tree's cost) -> 117 344 m simulated. So
//                 the goal is reachable well before the tree is exhausted —
//                 struct-4 (the second stage) and the entire reliability
//                 branch are headroom, not a requirement.
//   floor:        10 km altitude, cleared by the unmodified starter with
//                 margin (14 km @ fuelFraction 1.0, still ~10.5 km @ 0.8 —
//                 see components.js).
//
// Fully upgraded (all 12 nodes owned), the vehicle carries two stages and
// simulates to ~189.8 km — well past the 100 km goal, on purpose: a
// completionist run past the goal is a deliberate high-score option, not
// the only way to win. The reliability branch never touches altitude at
// all — it's a pure "launches wasted to bad luck" lever, so it never shows
// up in a cheapest-reaching set.
//
// THRUST-TO-WEIGHT SAFETY RAIL. Structure nodes add propellant *and* dry
// mass; propulsion nodes add thrust (mostly) and isp. Because structure
// only ever adds weight and never adds thrust, a run that rushes structure
// while skipping propulsion can push liftoff TWR under 1.0 — a vehicle
// that literally cannot leave the pad, which is a soft-lock the economy
// isn't allowed to have (DESIGN.md §7: bankruptcy cannot happen, and the
// floor contract's guarantee is worthless if the vehicle can never fly it).
// So struct-3 and struct-4 (the two nodes with the biggest mass adds) each
// carry an extra cross-branch prerequisite forcing a matching propulsion
// purchase first:
//
//   node         requires                 min TWR at that gate (computed)
//   struct-3     struct-2, prop-2         ~1.19
//   struct-4     struct-3, prop-4         higher still (more thrust, same
//                                         second-stage mass on top)
//
// Every reachable (prereq-respecting) combination of owned nodes keeps
// liftoff TWR >= ~1.19. Verified by exhaustively evaluating all owned-node
// combinations gated by `requires` (see test/data.test.js's brute-force test
// and `node tools/balance.mjs`'s "minimum liftoff TWR" line) rather than
// asserted on faith.
//
// TRADE-OFFS (DESIGN.md §10: siblings must trade off). prop-2 is the
// required propulsion trade-off level: +20% thrust for -3% isp — a real
// cut (multiplicatively undoing part of prop-1's isp gain), but tuned small
// enough that prop-2 alone still doesn't make a real owned-node path fly
// *worse* than before buying it; prop-3 is the dedicated isp-recovery level
// that more than restores it. Every structure node adds dry mass alongside
// its propellant, and struct-4 is the biggest lever in the tree: it adds an
// entire second stage via `addStage`, which is where most of the tier's
// altitude headroom above the goal comes from.
//
// COSTS. Escalating per branch, tuned against a 400-funds floor-contract
// payout (js/data/missions.js) so a greedy player — fly the best-paying
// reachable contract, then buy the cheapest node that raises max altitude,
// repeat (see `node tools/balance.mjs`'s greedy simulation) — reaches the
// 100 km goal in ~19 launches, landing in the "roughly 15 to 30 launches"
// target. The full tree (all 12 nodes, including the reliability branch,
// which is a pure funds sink with no altitude payoff) costs 30 700 funds.
export const nodes = [
  // --- propulsion --------------------------------------------------
  // Raises thrust and isp together most of the time, but prop-2 is the
  // required trade-off level: a big thrust jump paid for with an isp cut
  // (bigger, less efficient engine bell). prop-3 is the isp-recovery
  // level (no thrust change at all), prop-4 is the payoff node.
  {
    id: 'prop-1',
    branch: 'propulsion',
    level: 1,
    name: 'Injector tuning',
    desc: '+10% thrust, +5% isp. A free lunch from a better-mixed injector.',
    cost: { funds: 500 },
    requires: [],
    effects: [
      { stat: 'stages.0.thrust', op: 'mul', value: 1.1 },
      { stat: 'stages.0.isp', op: 'mul', value: 1.05 },
    ],
  },
  {
    id: 'prop-2',
    branch: 'propulsion',
    level: 2,
    name: 'High-flow pintle',
    desc: '+20% thrust, -3% isp. More power, less efficient burn.',
    cost: { funds: 1800 },
    requires: ['prop-1'],
    effects: [
      { stat: 'stages.0.thrust', op: 'mul', value: 1.2 },
      { stat: 'stages.0.isp', op: 'mul', value: 0.97 },
    ],
  },
  {
    id: 'prop-3',
    branch: 'propulsion',
    level: 3,
    name: 'Ablative nozzle extension',
    desc: '+15% isp. Recovers the efficiency the high-flow pintle spent.',
    cost: { funds: 3000 },
    requires: ['prop-2'],
    effects: [{ stat: 'stages.0.isp', op: 'mul', value: 1.15 }],
  },
  {
    id: 'prop-4',
    branch: 'propulsion',
    level: 4,
    name: 'Staged combustion',
    desc: '+25% thrust, +10% isp. The top-tier booster engine.',
    cost: { funds: 5000 },
    requires: ['prop-3'],
    effects: [
      { stat: 'stages.0.thrust', op: 'mul', value: 1.25 },
      { stat: 'stages.0.isp', op: 'mul', value: 1.1 },
    ],
  },

  // --- structure -----------------------------------------------------
  // Every level adds propellant capacity at a dry-mass cost (a real
  // structural-efficiency trade-off). struct-4 is the big one: it adds an
  // entire second stage via `addStage`, which is where most of the tier's
  // delta-v headroom comes from. struct-3/4 require matching propulsion
  // levels — see the THRUST-TO-WEIGHT SAFETY RAIL note above.
  {
    id: 'struct-1',
    branch: 'structure',
    level: 1,
    name: 'Extended tankage',
    desc: '+15 kg propellant, +5 kg dry mass.',
    cost: { funds: 900 },
    requires: [],
    effects: [
      { stat: 'stages.0.propMass', op: 'add', value: 15 },
      { stat: 'stages.0.dryMass', op: 'add', value: 5 },
    ],
  },
  {
    id: 'struct-2',
    branch: 'structure',
    level: 2,
    name: 'Lightweight airframe',
    desc: '+25 kg propellant, +10 kg dry mass.',
    cost: { funds: 1700 },
    requires: ['struct-1'],
    effects: [
      { stat: 'stages.0.propMass', op: 'add', value: 25 },
      { stat: 'stages.0.dryMass', op: 'add', value: 10 },
    ],
  },
  {
    id: 'struct-3',
    branch: 'structure',
    level: 3,
    name: 'Stretched tank',
    desc: '+55 kg propellant, +18 kg dry mass. Needs a stronger engine first.',
    cost: { funds: 3200 },
    requires: ['struct-2', 'prop-2'],
    effects: [
      { stat: 'stages.0.propMass', op: 'add', value: 55 },
      { stat: 'stages.0.dryMass', op: 'add', value: 18 },
    ],
  },
  {
    id: 'struct-4',
    branch: 'structure',
    level: 4,
    name: 'Second stage',
    desc: 'Adds an upper stage. The big jump toward 100 km.',
    cost: { funds: 6400 },
    requires: ['struct-3', 'prop-4'],
    effects: [
      {
        addStage: {
          dryMass: 15,
          propMass: 20,
          thrust: 400,
          isp: 230,
          reliability: 0.8,
        },
      },
    ],
  },

  // --- reliability -----------------------------------------------------
  // No performance gain anywhere in this branch — pure failure-rate
  // reduction, funded by funds like everything else. rel-1..3 raise the
  // booster's (stage 0) reliability from 0.85 toward ~0.99; rel-4 requires
  // the second stage to exist (struct-4) and is the only node that touches
  // `stages.1.reliability`, bringing the upper stage from its 0.80 base to
  // ~0.99 as well.
  {
    id: 'rel-1',
    branch: 'reliability',
    level: 1,
    name: 'Redundant ignitors',
    desc: '+8% booster reliability. No change to thrust or isp.',
    cost: { funds: 800 },
    requires: [],
    effects: [{ stat: 'stages.0.reliability', op: 'mul', value: 1.08 }],
  },
  {
    id: 'rel-2',
    branch: 'reliability',
    level: 2,
    name: 'Avionics hardening',
    desc: '+5% booster reliability.',
    cost: { funds: 1400 },
    requires: ['rel-1'],
    effects: [{ stat: 'stages.0.reliability', op: 'mul', value: 1.05 }],
  },
  {
    id: 'rel-3',
    branch: 'reliability',
    level: 3,
    name: 'Qualified airframe',
    desc: '+3% booster reliability. Booster reliability now ~0.99.',
    cost: { funds: 2400 },
    requires: ['rel-2'],
    effects: [{ stat: 'stages.0.reliability', op: 'mul', value: 1.03 }],
  },
  {
    id: 'rel-4',
    branch: 'reliability',
    level: 4,
    name: 'Upper-stage qualification',
    desc: '+24% upper-stage reliability. Requires the second stage to exist.',
    cost: { funds: 3600 },
    requires: ['rel-3', 'struct-4'],
    effects: [{ stat: 'stages.1.reliability', op: 'mul', value: 1.2375 }],
  },

  // ---------------------------------------------------------------------
  // TIER 2 — orbit. See ARCHITECTURE.md, "Phase 1 — tier 2, orbit".
  // ---------------------------------------------------------------------
  //
  // Balanced against the REAL phase 1 resolver (js/core/resolver.js's
  // central gravity + pitch program), the same way tier 1's numbers are
  // balanced against the phase 0 resolver -- not the ideal-delta-v
  // shortcut. `node tools/balance.mjs` drives `resolveLaunch` directly
  // (reliability forced to 1), scanning `turn` in 0.05 steps per
  // ARCHITECTURE.md's Balance section, and re-running it is how every
  // number below was actually chosen. Re-run it after touching any cost or
  // effect here.
  //
  // TURN IS A REAL DECISION (ARCHITECTURE.md's balance target). A vehicle
  // with too much spare thrust/isp margin orbits best at turn=0 (the lazy,
  // nearly-vertical program) -- more margin just papers over the gravity
  // losses a lazy climb pays, so there's never a reason to turn over
  // early, and the slider stops being a choice. The numbers below are
  // deliberately tuned so the third stage (struct-6/prop-8, see PROPULSION
  // and STRUCTURE below) is only JUST enough to reach orbit: the cheapest
  // prereq-valid set that reaches the tier goal peaks at turn=0.60, clears
  // ORBIT_MIN_ALT for 4 of the 21 turn notches (0.55-0.70), and MISSES
  // orbit entirely at turn=0 -- a lazy climb is not the answer here. The
  // full tree (extra margin from prop-7/9, struct-7/8) widens that to 6
  // notches (0.40-0.65) peaking at turn=0.45, roughly a third of the
  // slider, still nowhere near turn=0 or turn=1. Both figures are `node
  // tools/balance.mjs`'s own periapsis-vs-turn table, not hand estimates.
  //
  // STRUCTURE. struct-5 is a dry-mass-reduction node (composite tankage,
  // stage 0/1), prereq of struct-6; struct-6 is the third stage itself
  // (addStage), gated on struct-4 (the tier 1 second stage must already
  // exist), struct-5, AND prop-6 (see THRUST-TO-WEIGHT SAFETY RAIL below).
  // struct-7/8 are margin buys layered on top -- a small dry-mass cut and
  // a small extra propellant load -- that raise the achievable periapsis
  // and widen the full tree's good-turn window past the minimal set's,
  // rather than being required to reach orbit at all. Both are kept
  // deliberately SMALL: stage 3 is already thin-walled (8 kg dry against
  // 70+ kg of propellant), so anything bigger here swings the ln(m0/mf)
  // ratio (and with it the good-turn window) by far more than the "minor
  // upgrade" the node is supposed to be -- struct-7/8 used to cut/add
  // several kg each and blew the window from a clean ~6-7 notches to
  // 14-16 (over half the slider) for that reason; the values below were
  // walked back down until the window stayed in the target range.
  //
  // THRUST-TO-WEIGHT SAFETY RAIL, tier 2. Same rule as tier 1 (see the note
  // above): a node that only ever adds weight must not be reachable
  // without the matching thrust already in hand. The third stage
  // (struct-6) is by far the biggest mass add in the tree, so it requires
  // prop-6 (the stage 2 vacuum engine, which itself requires prop-5, the
  // booster thrust upgrade) directly, not just struct-4/struct-5 -- every
  // reachable owned-node combination that includes the third stage
  // therefore also includes both propulsion upgrades. Verified
  // exhaustively, not on faith: `node tools/balance.mjs`'s GOAL 4 report
  // (and test/data.test.js's bounded version) BFS-enumerates every
  // prereq-valid owned combination across BOTH tiers together (786 of
  // them -- prerequisites chain hard enough that this is tractable even
  // though 2^25 is not) and checks liftoff TWR >= 1.05 and every upper
  // stage's TWR at ignition >= 0.5 on each one. Worst case: liftoff TWR
  // 1.194 (the tier 1 minimum, unchanged by tier 2 -- struct-6 always
  // brings its own matching thrust) and upper-stage TWR 1.020 (stage 2,
  // owned = prop-1..4 + struct-1..4, before any tier 2 node at all). No
  // violation exists anywhere in the reachable set.
  //
  // PROPULSION. prop-5 is a booster (stage 1 / index 0) thrust upgrade,
  // gated on prop-4 per the spec's own worked example ("the vacuum engine
  // requires prop-4") -- it exists because the third stage (struct-6) adds
  // real mass the booster now has to carry the whole way up, and liftoff
  // TWR is the tree's hard safety rail (see above; the same constraint
  // applies here, just one stage heavier). prop-6 is the stage 2 (index 1)
  // vacuum engine (mul stages.1.thrust AND stages.1.isp -- a straight
  // upgrade, unlike tier 1's engine nodes, because stage 2 now has to lift
  // the whole third stage on top of itself and needs both). prop-7 is its
  // sibling trade-off (more stage 2 thrust for a bit less isp, layered on
  // top of prop-6) -- genuinely close to neutral for reaching orbit (it
  // shows up in neither the minimal reaching set nor as a load-bearing
  // full-tree margin node), which is the DESIGN.md §10 shape a trade-off
  // sibling is supposed to have. prop-8 is the stage 3 (index 2) vacuum
  // engine (mul stages.2.isp) -- gated on prop-6 and struct-6, and the
  // node that makes orbit possible at all: without it stage 3's isp is far
  // too low to carry the required delta-v at ANY turn (periapsis is
  // deeply negative across the whole slider). Its magnitude (+43%) is
  // tuned to clear orbit-low's periapsis (90 km) but fall short of the
  // tier goal's (100 km) -- see COSTS/LADDER below for why that split
  // matters. prop-9 is the margin node that crosses that remaining gap
  // (+2% more isp on top of prop-8), which is also why it is the one
  // tier 2 node the mission ladder needs to go from orbit-low to the tier
  // goal (see LADDER below) rather than a pure full-tree nicety. Both
  // prop-8/9 target `stages.2.isp`, and collectEffects (js/core/tree.js)
  // hoists every `addStage` effect ahead of every other effect
  // specifically so a propulsion-branch node like these can safely target
  // a stage that a later-applied structure-branch node (struct-6) adds.
  //
  // GUIDANCE. guide-1 is the branch's entry point: it sets vehicle.guidance
  // to 1, which is what turns the loadout's `turn` slider from ignored to
  // live (pitchProgram, resolver.js) -- and is a REQUIRED node for every
  // tier 2 mission (downrange, altitude, and orbit alike all need a turn
  // to do anything but fly straight up). guide-2 raises guidance further
  // (to 3, since it folds two integer steps into one node -- see next
  // paragraph) but is HONESTLY DOCUMENTED as not changing how any flight
  // flies: `pitchProgram` (resolver.js) only ever checks `guidance >= 1`,
  // never a higher level, and nothing else in resolver.js or vehicle.js
  // reads `vehicle.guidance` at all. Confirmed by grepping both files for
  // every use of `guidance` before writing this -- there is no lever a
  // higher level could plausibly be given via data without also changing
  // resolver.js's pitch program itself, which is out of scope here (see
  // the task's own instruction not to work around a resolver-physics
  // problem in data). guide-2's description says so plainly rather than
  // implying a benefit it can't deliver.
  //
  // guide-2 used to be two nodes (guide-2/guide-3, ARCHITECTURE.md's
  // "widens the good turn window... refinements the resolver reads" text)
  // -- both equally inert against the current resolver. Rather than ship
  // two placebo purchases, they are folded into one cheaper node here;
  // "fold into a cheaper single node" is one of the two honest options the
  // task allows when a described lever turns out not to exist in the
  // resolver, and it is the more defensible one -- a single clearly-honest
  // placeholder beats two.
  //
  // RELIABILITY. rel-5 continues the stage 2 reliability climb rel-4 (tier
  // 1) started; rel-6 is the first node to touch stage 3 (the third
  // stage), gated on struct-6 existing. Neither touches trajectory --
  // reliability is forced to 1 throughout tools/balance.mjs and
  // test/data.test.js's resolver-driven checks, by design (it's a
  // "launches wasted to bad luck" lever, same as tier 1's reliability
  // branch), so they never appear in a cheapest-reaching set for any
  // requirement shape.
  //
  // LADDER (js/data/missions.js). The five tier 2 rungs step through a
  // CUMULATIVE node sequence (each rung's cheapest set is the previous
  // rung's plus 1-3 more nodes, never a smaller or disjoint set -- see
  // `node tools/balance.mjs`'s GOAL 2 report, hand-cross-checked because
  // an independent per-mission search can and did report a smaller node
  // count for a later, harder mission by picking a different, unrelated
  // path): guide-1 alone reaches orbit-down-1 (a lazy-ish flight already
  // outranges 150 km once it can turn at all); struct-4/5 (second stage +
  // a dry-mass trim) reach orbit-down-2; prop-5/6 (the thrust to carry a
  // third stage) reach orbit-apogee on a strong, mostly-vertical shot with
  // no orbit quality required; struct-6/prop-8 (the third stage and its
  // engine) reach orbit-low's periapsis; prop-9's small isp margin is what
  // crosses the remaining gap to the tier goal's higher periapsis -- which
  // is exactly the two-node split (prop-8 required, prop-9 margin) prop-8's
  // own doc comment above describes, and the reason the two are separate
  // nodes rather than one.
  //
  // COSTS. Tier 1's full tree costs 30 700 funds; tier 2 escalates from
  // there (212 000 funds for its 13 nodes). Node costs (not mission
  // payouts) were raised from an earlier pass once `node tools/balance.mjs`
  // showed a greedy player reaching the tier goal in 20 tier 2 launches --
  // under the 30-60 target -- so the fix here is cost, matching
  // ARCHITECTURE.md's own framing ("costs or requirements should rise, not
  // payouts fall below what makes contracts worth flying"). The greedy
  // simulation now takes 36 tier 2 launches, and its reputation curve
  // (also `node tools/balance.mjs`'s GOAL 3 report) crosses every rung's
  // `minReputation` gate well before that rung's vehicle is actually
  // affordable, so reputation is a real, met-in-advance gate rather than
  // what the player ends up waiting on.
  {
    id: 'prop-5',
    branch: 'propulsion',
    level: 5,
    tier: 2,
    name: 'Booster thrust upgrade',
    desc: '+30% stage 1 thrust. Keeps liftoff TWR healthy once the third stage adds its weight.',
    cost: { funds: 17000 },
    requires: ['prop-4'],
    effects: [{ stat: 'stages.0.thrust', op: 'mul', value: 1.3 }],
  },
  {
    id: 'prop-6',
    branch: 'propulsion',
    level: 6,
    tier: 2,
    name: 'Stage 2 vacuum engine',
    desc: '+250% stage 2 thrust, +30% stage 2 isp. A much larger engine sized for the third stage riding on top. Needs the second stage to exist.',
    cost: { funds: 22000 },
    requires: ['prop-5', 'struct-4'],
    effects: [
      { stat: 'stages.1.thrust', op: 'mul', value: 3.5 },
      { stat: 'stages.1.isp', op: 'mul', value: 1.3 },
    ],
  },
  {
    id: 'prop-7',
    branch: 'propulsion',
    level: 7,
    tier: 2,
    name: 'Stage 2 high-flow injector',
    desc: '+15% stage 2 thrust, -5% stage 2 isp. The booster trade-off, one stage up.',
    cost: { funds: 17000 },
    requires: ['prop-6'],
    effects: [
      { stat: 'stages.1.thrust', op: 'mul', value: 1.15 },
      { stat: 'stages.1.isp', op: 'mul', value: 0.95 },
    ],
  },
  {
    id: 'prop-8',
    branch: 'propulsion',
    level: 8,
    tier: 2,
    name: 'Stage 3 vacuum engine',
    desc: '+43% stage 3 isp. Needs the third stage to exist. Without this '
      + "the stack does not carry enough delta-v to orbit at any turn -- it's "
      + 'the node that makes orbit possible at all. Enough for a low '
      + "periapsis (orbit-low); the tier goal's higher periapsis needs the "
      + 'injector refinement (prop-9) on top.',
    cost: { funds: 26000 },
    requires: ['prop-6', 'struct-6'],
    effects: [{ stat: 'stages.2.isp', op: 'mul', value: 1.43 }],
  },
  {
    id: 'prop-9',
    branch: 'propulsion',
    level: 9,
    tier: 2,
    name: 'Stage 3 injector refinement',
    desc: '+2% stage 3 isp on top of the vacuum engine. Crosses the gap from '
      + "orbit-low's periapsis to the tier goal's, and widens the turn "
      + 'window an orbit attempt survives.',
    cost: { funds: 7000 },
    requires: ['prop-8'],
    effects: [{ stat: 'stages.2.isp', op: 'mul', value: 1.02 }],
  },

  {
    id: 'struct-5',
    branch: 'structure',
    level: 5,
    tier: 2,
    name: 'Composite tankage',
    desc: '-10 kg stage 1 dry mass, -4 kg stage 2 dry mass.',
    cost: { funds: 17000 },
    requires: ['struct-4'],
    effects: [
      { stat: 'stages.0.dryMass', op: 'add', value: -10 },
      { stat: 'stages.1.dryMass', op: 'add', value: -4 },
    ],
  },
  {
    id: 'struct-6',
    branch: 'structure',
    level: 6,
    tier: 2,
    name: 'Third stage',
    desc: 'Adds a vacuum-optimised kick stage. The jump toward orbit. Needs a stage 2 engine that can actually lift it first.',
    cost: { funds: 30000 },
    requires: ['struct-5', 'struct-4', 'prop-6'],
    effects: [
      {
        addStage: {
          dryMass: 8,
          propMass: 60,
          thrust: 1500,
          isp: 320,
          reliability: 0.82,
        },
      },
    ],
  },
  {
    id: 'struct-7',
    branch: 'structure',
    level: 7,
    tier: 2,
    name: 'Stretched third-stage tank',
    desc: '-1 kg stage 3 dry mass, -2 kg stage 2 dry mass. Stage 3 is '
      + 'already thin-walled (8 kg dry against 60+ kg of propellant), so a '
      + 'small absolute cut here is a real fractional one -- kept small on '
      + 'purpose so it reads as a margin buy, not another required stage.',
    cost: { funds: 11000 },
    requires: ['struct-6'],
    effects: [
      { stat: 'stages.2.dryMass', op: 'add', value: -1 },
      { stat: 'stages.1.dryMass', op: 'add', value: -2 },
    ],
  },
  {
    id: 'struct-8',
    branch: 'structure',
    level: 8,
    tier: 2,
    name: 'Extended third-stage tank',
    desc: '+10 kg stage 3 propellant, +2 kg stage 3 dry mass. A margin buy: '
      + 'raises the achievable periapsis rather than unlocking orbit '
      + 'outright.',
    cost: { funds: 9500 },
    requires: ['struct-7'],
    effects: [
      { stat: 'stages.2.propMass', op: 'add', value: 10 },
      { stat: 'stages.2.dryMass', op: 'add', value: 2 },
    ],
  },

  {
    id: 'guide-1',
    branch: 'guidance',
    level: 1,
    tier: 2,
    name: 'Gravity-turn guidance',
    desc: 'Unlocks the loadout turn slider. Without this, every flight is vertical.',
    cost: { funds: 11000 },
    requires: [],
    effects: [{ stat: 'guidance', op: 'set', value: 1 }],
  },
  {
    id: 'guide-2',
    branch: 'guidance',
    level: 2,
    tier: 2,
    name: 'Guidance refinements',
    desc: 'Raises the guidance level further. Honest note: the current flight '
      + 'model only checks guidance >= 1 (whether the turn slider does '
      + "anything at all) -- it does not read a higher level, so this node "
      + "does not change how any flight flies. It is headroom for a future "
      + 'pitch-program refinement (a wider good-turn window, trimmed '
      + 'steering losses), not a purchase that pays off today.',
    cost: { funds: 13000 },
    requires: ['guide-1'],
    effects: [{ stat: 'guidance', op: 'add', value: 2 }],
  },

  {
    id: 'rel-5',
    branch: 'reliability',
    level: 5,
    tier: 2,
    name: 'Stage 2 requalification',
    desc: '+1% stage 2 reliability.',
    cost: { funds: 13000 },
    requires: ['rel-4'],
    effects: [{ stat: 'stages.1.reliability', op: 'mul', value: 1.01 }],
  },
  {
    id: 'rel-6',
    branch: 'reliability',
    level: 6,
    tier: 2,
    name: 'Stage 3 restart qualification',
    desc: '+20% stage 3 reliability. Requires the third stage to exist.',
    cost: { funds: 18500 },
    requires: ['rel-5', 'struct-6'],
    effects: [{ stat: 'stages.2.reliability', op: 'mul', value: 1.2 }],
  },
];
