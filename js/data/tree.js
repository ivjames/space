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
  // PROVISIONAL: balance against the resolver in the next pass.
  //
  // js/core/resolver.js and js/core/vehicle.js are being rewritten to the
  // phase 1 spec (central gravity, pitch program, the `guidance` stat,
  // orbit/downrange requirements, requiredDeltaV for every shape)
  // concurrently with this file, so none of the numbers below have been
  // driven through the REAL resolver the way every tier 1 number above was
  // (see the BALANCING NOTES at the top of this file, and
  // tools/balance.mjs). They are sized only against the ideal-delta-v
  // shortcut (Tsiolkovsky, vehicle.js's totalDeltaV) for the full tree:
  // tier 1 alone tops out at ~3.45 km/s ideal; the tier 2 nodes below add
  // enough stage/isp/mass headroom to bring the FULL tree (tier 1 + tier 2,
  // fuelFraction 1) to roughly 9.5-10.5 km/s ideal -- comfortably past the
  // ~7.8 km/s orbital velocity at 100 km and the "9 km/s or more" a real
  // ascent pays (ARCHITECTURE.md). Once the resolver lands, re-run
  // tools/balance.mjs's tier 2 report and retune costs/effects the same way
  // tier 1's were tuned against the simulation instead of the shortcut --
  // this is exactly the ideal-dv-vs-simulated-altitude trap tier 1 fell
  // into before it was fixed (see this file's BALANCING NOTES above).
  //
  // STRUCTURE. struct-5/7 are dry-mass-reduction nodes (composite tankage);
  // struct-6 is the third stage itself (addStage), gated on struct-4 (the
  // tier 1 second stage must already exist) as well as struct-5; struct-8
  // is the tier 2 structure trade-off sibling (more third-stage propellant
  // at a dry-mass cost, same shape as struct-1..3's tier 1 pattern).
  //
  // THRUST-TO-WEIGHT SAFETY RAIL, tier 2. Same rule as tier 1 (see the note
  // above): a node that only ever adds weight must not be reachable without
  // the matching thrust already in hand. The third stage (struct-6) is by
  // far the biggest mass add in the tree, and it lands on stage 2 (index 1)
  // -- whose tier 1 thrust (400 N) is nowhere near enough to lift a third
  // stage's dry+prop mass on top of the payload (checked: liftoff TWR at
  // stage 2 ignition drops under 0.5 without a stage 2 engine upgrade
  // first). So struct-6 requires prop-6 (the stage 2 vacuum engine, which
  // itself requires prop-5, the booster thrust upgrade) directly, not just
  // struct-4/struct-5 -- every reachable owned-node combination that
  // includes the third stage therefore also includes both propulsion
  // upgrades, and stage 0/1/2 liftoff TWR stays >= ~1.09 (worst case:
  // struct-5/6 alone, no struct-7/8, no prop-7/8) across every combination
  // enumerated in test/data.test.js's tier 2 TWR check.
  //
  // PROPULSION. prop-5 is a booster (stage 1 / index 0) thrust upgrade,
  // gated on prop-4 per the spec's own worked example ("the vacuum engine
  // requires prop-4") -- it exists because the third stage (struct-6) adds
  // real mass the booster now has to carry the whole way up, and liftoff
  // TWR is the tree's hard safety rail (see the THRUST-TO-WEIGHT SAFETY
  // RAIL note above; the same constraint applies here, just one stage
  // heavier). prop-6 is the stage 2 (index 1) vacuum engine (mul
  // stages.1.thrust AND stages.1.isp -- a straight upgrade, unlike tier 1's
  // engine nodes, because stage 2 now has to lift the whole third stage on
  // top of itself and needs both). prop-7 is its sibling trade-off (more
  // stage 2 thrust for a bit less isp, layered on top of prop-6). prop-8 is
  // the stage 3 (index 2) vacuum engine (mul stages.2.isp), gated on both
  // prop-6 and struct-6 (the third stage must exist) -- collectEffects
  // (js/core/tree.js) hoists every `addStage` effect ahead of every other
  // effect specifically so a propulsion-branch node like this one can
  // safely target a stage that a later-applied structure-branch node adds.
  //
  // GUIDANCE. guide-1 is the branch's entry point: it sets vehicle.guidance
  // to 1, which is what turns the loadout's `turn` slider from ignored to
  // live (pitchProgram, resolver.js). guide-2/3 raise guidance further (to
  // 2, then 3) -- refinements the resolver reads as a wider "good turn
  // window" / lower steering losses at each higher level, per
  // ARCHITECTURE.md; the exact curve is the resolver's call, not this
  // file's -- this file only supplies the integer.
  //
  // RELIABILITY. rel-5 continues the stage 2 reliability climb rel-4 (tier
  // 1) started; rel-6 is the first node to touch stage 3 (the third
  // stage), gated on struct-6 existing.
  //
  // COSTS. Tier 1's full tree costs 30 700 funds; tier 2 escalates from
  // there (137 000 funds for its 13 nodes, ~4.5x tier 1), matching payouts
  // on the tier 2 mission ladder (js/data/missions.js) that are "well
  // above" tier 1's.
  {
    id: 'prop-5',
    branch: 'propulsion',
    level: 5,
    tier: 2,
    name: 'Booster thrust upgrade',
    desc: '+30% stage 1 thrust. Keeps liftoff TWR healthy once the third stage adds its weight.',
    cost: { funds: 9000 },
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
    cost: { funds: 12000 },
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
    cost: { funds: 9000 },
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
    desc: '+42% stage 3 isp. Needs the third stage to exist.',
    cost: { funds: 14000 },
    requires: ['prop-6', 'struct-6'],
    effects: [{ stat: 'stages.2.isp', op: 'mul', value: 1.42 }],
  },

  {
    id: 'struct-5',
    branch: 'structure',
    level: 5,
    tier: 2,
    name: 'Composite tankage',
    desc: '-10 kg stage 1 dry mass, -4 kg stage 2 dry mass.',
    cost: { funds: 9000 },
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
    cost: { funds: 16000 },
    requires: ['struct-5', 'struct-4', 'prop-6'],
    effects: [
      {
        addStage: {
          dryMass: 8,
          propMass: 45,
          thrust: 1300,
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
    desc: '-2 kg stage 3 dry mass, -3 kg stage 2 dry mass.',
    cost: { funds: 11000 },
    requires: ['struct-6'],
    effects: [
      { stat: 'stages.2.dryMass', op: 'add', value: -2 },
      { stat: 'stages.1.dryMass', op: 'add', value: -3 },
    ],
  },
  {
    id: 'struct-8',
    branch: 'structure',
    level: 8,
    tier: 2,
    name: 'Extended third-stage tank',
    desc: '+40 kg stage 3 propellant, +3 kg stage 3 dry mass.',
    cost: { funds: 13000 },
    requires: ['struct-7'],
    effects: [
      { stat: 'stages.2.propMass', op: 'add', value: 40 },
      { stat: 'stages.2.dryMass', op: 'add', value: 3 },
    ],
  },

  {
    id: 'guide-1',
    branch: 'guidance',
    level: 1,
    tier: 2,
    name: 'Gravity-turn guidance',
    desc: 'Unlocks the loadout turn slider. Without this, every flight is vertical.',
    cost: { funds: 6000 },
    requires: [],
    effects: [{ stat: 'guidance', op: 'set', value: 1 }],
  },
  {
    id: 'guide-2',
    branch: 'guidance',
    level: 2,
    tier: 2,
    name: 'Adaptive pitch program',
    desc: 'Widens the good turn window and trims steering losses.',
    cost: { funds: 9000 },
    requires: ['guide-1'],
    effects: [{ stat: 'guidance', op: 'add', value: 1 }],
  },
  {
    id: 'guide-3',
    branch: 'guidance',
    level: 3,
    tier: 2,
    name: 'Closed-loop guidance',
    desc: 'Further widens the good turn window and trims steering losses.',
    cost: { funds: 12000 },
    requires: ['guide-2'],
    effects: [{ stat: 'guidance', op: 'add', value: 1 }],
  },

  {
    id: 'rel-5',
    branch: 'reliability',
    level: 5,
    tier: 2,
    name: 'Stage 2 requalification',
    desc: '+1% stage 2 reliability.',
    cost: { funds: 7000 },
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
    cost: { funds: 10000 },
    requires: ['rel-5', 'struct-6'],
    effects: [{ stat: 'stages.2.reliability', op: 'mul', value: 1.2 }],
  },
];
