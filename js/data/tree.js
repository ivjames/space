// Tier 1 tech tree. Three branches, per DESIGN.md §10: propulsion,
// structure, reliability. Effects are applied by js/core/vehicle.js in the
// order js/core/tree.js's collectEffects returns them (branch order, then
// level) — see the doc comment on `nodes` below for how that plays out.
//
// ---------------------------------------------------------------------
// BALANCING NOTES
// ---------------------------------------------------------------------
//
// Delta-v arithmetic (Tsiolkovsky, dv = isp * 9.80665 * ln(m0/m1)), using
// js/data/components.js's baseVehicle (dry 40, prop 30, payload 5, isp 170,
// thrust 1500) as the starting point:
//
//   tier 1 goal:  100 km altitude -> ~1610 m/s required
//                 (sqrt(2*9.81*100000) ≈ 1401 m/s ideal, * 1.15 loss factor)
//   floor:        20 km altitude  -> ~720 m/s required (already met by the
//                 starter's ~852 m/s, see components.js)
//
// Fully upgraded (all 12 nodes owned), the vehicle carries two stages and
// totals ~2993 m/s of delta-v — well past the 1610 m/s goal, on purpose:
// the tier goal is reachable partway through the tree (e.g. full
// propulsion + two structure levels already clears ~1627 m/s), so a
// completionist run past the goal is a deliberate high-score option, not
// the only way to win. The reliability branch never touches delta-v at
// all — it's a pure "launches wasted to bad luck" lever.
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
//   struct-3     struct-2, prop-2         ~1.07
//   struct-4     struct-3, prop-4         ~1.13
//
// Every reachable (prereq-respecting) combination of owned nodes keeps
// liftoff TWR >= ~1.07. Verified by exhaustively evaluating all owned-node
// combinations gated by `requires` (see test/data.test.js and the working
// notes in this task's report) rather than asserted on faith.
//
// COSTS. Escalating per branch, tuned against a ~400-funds floor-contract
// payout (js/data/missions.js): the cheapest node (rel-1, 400) is
// affordable after exactly one floor launch; the first propulsion/structure
// node (450-500) after two. Summed, the full tree costs 15,600 funds —
// about 39 floor-only launches, or noticeably fewer once better-paying
// non-floor contracts unlock — landing in the "25 to 40 launches for the
// whole tree" target.
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
    desc: '+20% thrust, -5% isp. More power, less efficient burn.',
    cost: { funds: 900 },
    requires: ['prop-1'],
    effects: [
      { stat: 'stages.0.thrust', op: 'mul', value: 1.2 },
      { stat: 'stages.0.isp', op: 'mul', value: 0.95 },
    ],
  },
  {
    id: 'prop-3',
    branch: 'propulsion',
    level: 3,
    name: 'Ablative nozzle extension',
    desc: '+15% isp. Recovers the efficiency the high-flow pintle spent.',
    cost: { funds: 1500 },
    requires: ['prop-2'],
    effects: [{ stat: 'stages.0.isp', op: 'mul', value: 1.15 }],
  },
  {
    id: 'prop-4',
    branch: 'propulsion',
    level: 4,
    name: 'Staged combustion',
    desc: '+25% thrust, +10% isp. The top-tier booster engine.',
    cost: { funds: 2500 },
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
    cost: { funds: 450 },
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
    cost: { funds: 850 },
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
    desc: '+40 kg propellant, +18 kg dry mass. Needs a stronger engine first.',
    cost: { funds: 1600 },
    requires: ['struct-2', 'prop-2'],
    effects: [
      { stat: 'stages.0.propMass', op: 'add', value: 40 },
      { stat: 'stages.0.dryMass', op: 'add', value: 18 },
    ],
  },
  {
    id: 'struct-4',
    branch: 'structure',
    level: 4,
    name: 'Second stage',
    desc: 'Adds an upper stage. The big jump toward 100 km.',
    cost: { funds: 3200 },
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
    cost: { funds: 400 },
    requires: [],
    effects: [{ stat: 'stages.0.reliability', op: 'mul', value: 1.08 }],
  },
  {
    id: 'rel-2',
    branch: 'reliability',
    level: 2,
    name: 'Avionics hardening',
    desc: '+5% booster reliability.',
    cost: { funds: 700 },
    requires: ['rel-1'],
    effects: [{ stat: 'stages.0.reliability', op: 'mul', value: 1.05 }],
  },
  {
    id: 'rel-3',
    branch: 'reliability',
    level: 3,
    name: 'Qualified airframe',
    desc: '+3% booster reliability. Booster reliability now ~0.99.',
    cost: { funds: 1200 },
    requires: ['rel-2'],
    effects: [{ stat: 'stages.0.reliability', op: 'mul', value: 1.03 }],
  },
  {
    id: 'rel-4',
    branch: 'reliability',
    level: 4,
    name: 'Upper-stage qualification',
    desc: '+24% upper-stage reliability. Requires the second stage to exist.',
    cost: { funds: 1800 },
    requires: ['rel-3', 'struct-4'],
    effects: [{ stat: 'stages.1.reliability', op: 'mul', value: 1.2375 }],
  },
];
