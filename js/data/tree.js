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
  // prereq-valid owned combination across BOTH tiers together (1422 of
  // them, up from 786 before the two abort-system nodes, rel-escape-1/2,
  // joined the tree -- prerequisites chain hard enough that this is
  // tractable even though 2^27 is not) and checks liftoff TWR >= 1.05 and
  // every upper stage's TWR at ignition >= 0.5 on each one. Worst case:
  // liftoff TWR 1.194 (the tier 1 minimum, unchanged by tier 2 -- struct-6
  // always brings its own matching thrust) and upper-stage TWR 1.020
  // (stage 2, owned = prop-1..4 + struct-1..4, before any tier 2 node at
  // all). No violation exists anywhere in the reachable set.
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
  // to do anything but fly straight up). guide-2 is the branch's
  // reliability node: it sets `guidanceReliability` (the per-flight roll
  // the resolver makes on every guided flight, ARCHITECTURE.md
  // "Anomalies") from the starter's 0.9 to 0.98. A failed roll drops the
  // flight computer off its program mid-ascent and the vehicle drifts off
  // target, so this is the one lever against that -- the trajectory
  // itself is untouched, which is why guide-2 never appears in a
  // cheapest-reaching set (the balance tool forces guidanceReliability to
  // 1, as it does stage reliability). It also still adds 2 to `guidance`
  // (to 3); `pitchProgram` only ever checks `guidance >= 1`, so that part
  // remains inert and is kept only so the level reads as "refined" in the
  // vehicle stats.
  //
  // guide-2 used to be two nodes (guide-2/guide-3, ARCHITECTURE.md's
  // "widens the good turn window... refinements the resolver reads" text)
  // -- both inert against the resolver of the time, and folded into one
  // cheaper node for that reason. The guidance roll is the honest effect
  // ARCHITECTURE.md's tier 3 section asked for "if the resolver reads
  // guidance for anything".
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
  // STAGE ABORT SYSTEMS (rel-escape-1/2, ARCHITECTURE.md's "Stage abort
  // systems"). The branch's other lever: instead of making a failure rarer,
  // these make one survivable. `escape` (js/core/vehicle.js) is the count
  // of bottom stages whose in-flight failure lets the stack above separate
  // clear, coast ESCAPE_DELAY seconds, and light its own engine still
  // flying the pitch program -- so the flight ends in a "Reached N km.
  // Short by M m/s." readout with a failure clause appended, not a bang.
  // rel-escape-1 sets it to 1 (the booster is covered); rel-escape-2 sets
  // it to 2 (the second stage too). A failure before the stack has cleared
  // the pad (below the resolver's ESCAPE_MIN_ALT, 100 m -- an ignition
  // failure at T+0 or a burn failure in the first seconds) and a failure of
  // the top stage are never escaped, whatever the level -- there is nothing
  // above the top stage to escape with, and the description says so.
  //
  // Gating. Both need rel-2 (avionics hardening): an abort is only as good
  // as the failure detection that triggers it, and that is what rel-2 is,
  // so the stat sits behind it rather than being a free-standing purchase.
  // rel-escape-1 needs struct-4 and rel-escape-2 needs struct-6 because the
  // stage that escapes must exist: covering the booster is meaningless
  // with nothing on top of it, and covering the second stage is meaningless
  // without a third. (rel-escape-2 also chains on rel-escape-1, so the
  // branch's `level` order and its prerequisite order agree.)
  //
  // Cost. Pure funds, no mass and no roll: the abort is resolved by the
  // resolver's failure handling, not by a stat on any stage, so the
  // reliability branch's invariant -- it never touches a trajectory --
  // still holds and tools/balance.mjs / test/data.test.js keep excluding
  // the whole branch from their trajectory searches. What the player buys
  // is not altitude but the difference between two outcomes of the same
  // bad roll. Be honest about when it pays: a failure LATE in a stage's
  // burn, where the stack above already has most of the margin it was
  // going to get, can still make the contract; a failure early in the
  // burn leaves the upper stage lighting far too low and slow, and it
  // still falls short -- but it falls short by a readable number instead
  // of ending in wreckage, which is the point of the "short by" contract
  // (DESIGN.md §4: every miss reads as "short by").
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
  // there (299 500 funds for its 15 nodes, 30 000 of that the two abort
  // systems). Node costs (not mission
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
    desc: 'A stronger first-stage engine, giving the booster the extra push a heavier stack needs off the pad.',
    cost: { funds: 22000 },
    requires: ['prop-4'],
    effects: [{ stat: 'stages.0.thrust', op: 'mul', value: 1.3 }],
  },
  {
    id: 'prop-6',
    branch: 'propulsion',
    level: 6,
    tier: 2,
    name: 'Stage 2 vacuum engine',
    desc: 'A much larger second-stage engine, sized to carry a third stage the rest of the way to orbit.',
    cost: { funds: 28500 },
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
    desc: 'Runs the second-stage engine harder: more thrust, at the cost of a less efficient burn.',
    cost: { funds: 22000 },
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
    desc: 'A dedicated vacuum engine for the third stage, tuned for the long high-altitude burn that finishes the climb to orbit.',
    cost: { funds: 34000 },
    requires: ['prop-6', 'struct-6'],
    effects: [{ stat: 'stages.2.isp', op: 'mul', value: 1.43 }],
  },
  {
    id: 'prop-9',
    branch: 'propulsion',
    level: 9,
    tier: 2,
    name: 'Stage 3 injector refinement',
    desc: 'A refined injector for the third-stage vacuum engine, squeezing a little more efficiency from every burn.',
    cost: { funds: 9000 },
    requires: ['prop-8'],
    effects: [{ stat: 'stages.2.isp', op: 'mul', value: 1.02 }],
  },

  {
    id: 'struct-5',
    branch: 'structure',
    level: 5,
    tier: 2,
    name: 'Composite tankage',
    desc: 'Composite tank walls shave dead weight off the first two stages.',
    cost: { funds: 22000 },
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
    desc: 'Adds a vacuum-optimised third stage, the final push into orbit.',
    cost: { funds: 39000 },
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
    desc: 'A lighter third-stage airframe, trimmed down without losing capacity.',
    cost: { funds: 14500 },
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
    desc: 'A bigger third-stage propellant tank for a longer final burn.',
    cost: { funds: 12500 },
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
    desc: 'A flight computer that can fly a gravity turn, steering the ascent instead of flying straight up.',
    cost: { funds: 8000 },
    requires: [],
    effects: [{ stat: 'guidance', op: 'set', value: 1 }],
  },
  {
    id: 'guide-2',
    branch: 'guidance',
    level: 2,
    tier: 2,
    name: 'Guidance refinements',
    desc: 'Hardens the flight computer against a mid-flight guidance failure: 98% of guided flights stay on program, up from 90%.',
    cost: { funds: 17000 },
    requires: ['guide-1'],
    effects: [
      { stat: 'guidance', op: 'add', value: 2 },
      { stat: 'guidanceReliability', op: 'set', value: 0.98 },
    ],
  },

  {
    id: 'rel-5',
    branch: 'reliability',
    level: 5,
    tier: 2,
    name: 'Stage 2 requalification',
    desc: 'Requalifies the second-stage engine for a lower failure rate.',
    cost: { funds: 17000 },
    requires: ['rel-4'],
    effects: [{ stat: 'stages.1.reliability', op: 'mul', value: 1.01 }],
  },
  {
    id: 'rel-escape-1',
    branch: 'reliability',
    level: 6,
    tier: 2,
    name: 'Booster abort system',
    desc: 'If the booster fails in flight, the stack above separates clear and lights its own engine, still under guidance. Does nothing on the pad.',
    cost: { funds: 11000 },
    requires: ['rel-2', 'struct-4'],
    effects: [{ stat: 'escape', op: 'set', value: 1 }],
  },
  {
    id: 'rel-6',
    branch: 'reliability',
    level: 7,
    tier: 2,
    name: 'Stage 3 restart qualification',
    desc: 'Extra qualification testing for the third-stage engine, cutting its failure rate.',
    cost: { funds: 24000 },
    requires: ['rel-5', 'struct-6'],
    effects: [{ stat: 'stages.2.reliability', op: 'mul', value: 1.2 }],
  },
  {
    id: 'rel-escape-2',
    branch: 'reliability',
    level: 8,
    tier: 2,
    name: 'Upper-stage abort system',
    desc: 'Extends abort coverage to the second stage: a third stage escapes clear of a second stage that fails under it.',
    cost: { funds: 19000 },
    requires: ['rel-escape-1', 'struct-6'],
    effects: [{ stat: 'escape', op: 'set', value: 2 }],
  },

  // ---------------------------------------------------------------------
  // TIER 3 — orbital maneuvering. See ARCHITECTURE.md, "Phase 2 -- tier 3,
  // orbital maneuvering".
  //
  // Balanced against the REAL phase 2 resolver (js/core/resolver.js's
  // orbital phase + js/core/orbit.js's Kepler helpers), the same way tier 1
  // and tier 2 are balanced against their own resolver phases -- not the
  // ideal-delta-v shortcut. `node tools/balance.mjs`'s TIER 3 section drives
  // `resolveLaunch` directly against a target object (reliability forced to
  // 1), scanning `turn` and `window` in 0.05 steps per ARCHITECTURE.md's
  // Balance section; re-run it after touching any cost or effect here.
  //
  // THE ECCENTRICITY TRAP, and why struct-10/prop-13 are sized the way they
  // are. The ascent model is a single continuous gravity-turn burn (no
  // discrete "coast to apoapsis, then circularize" maneuver), and the pitch
  // program pitches over at FIXED altitudes (TURN_START/END_LAZY/HARD,
  // resolver.js) regardless of vehicle capability. Push the top stage's
  // capability far past what a mission's cutoff altitude needs and the
  // extra delta-v does not raise periapsis further -- it keeps burning past
  // the turn program's fixed pitch-over point and balloons APOAPSIS
  // instead, so periapsis crosses the mission's cutoff altitude only after
  // the vehicle is already deep into a near-vertical, highly eccentric
  // trajectory (apoapsis in the millions of metres against a periapsis in
  // the low hundreds of thousands -- confirmed by hand against the real
  // resolver while balancing this section, not asserted on faith). That
  // matters here specifically because `dock`/`rdv-1`/`rdv-2` need the
  // vehicle's OWN insertion to be close to the target's near-circular
  // orbit -- `dvMatch` (js/core/orbit.js's transferDeltaV) scales with how
  // far apart the two shapes are, and an eccentricity that extreme puts
  // dvMatch far beyond any reserve tank this tree could plausibly carry
  // without itself breaking the liftoff/upper-stage TWR rail. So `core`'s
  // periapsis requirement (js/data/missions.js) is picked to sit in the
  // narrow band where the tree's real capability crosses it WITHOUT that
  // blowout -- verified directly (not assumed): at 160 km the cheapest
  // reaching set's own insertion comes in around periapsis 160-180 km,
  // apoapsis roughly 1-3x periapsis, not a two-orders-of-magnitude escape
  // trajectory. `satellite` and `core` (deploys only, no target) are
  // immune to this -- their own success test is periapsis alone -- but the
  // ladder is built around what `rdv-1`/`rdv-2`/`dock` can actually fly to,
  // since a station core no rendezvous can ever reach is not a real rung.
  //
  // FOUR BRANCHES, twelve nodes:
  //
  //   propulsion (4): restartable upper stage, multi-restart, reaction
  //     control, a propellant reserve on the top stage. The multi-restart /
  //     reliability tradeoff below is the one ARCHITECTURE.md spells out
  //     explicitly: prop-11 buys two more restarts (three total) at a 3%
  //     reliability cost to the top stage, recoverable by also buying the
  //     reliability branch's restart qualification (rel-7).
  //   guidance (3): rendezvous radar, star tracker, docking sensors — a
  //     straight chain raising `nav` from 1 to 3, off guide-1 (tier 2's
  //     entry point, since a flight with no gravity-turn guidance at all
  //     has no business attempting a rendezvous either).
  //   structure (3): a docking adapter (`docking` set 1), a lighter top-
  //     stage fairing (a small dry-mass trim, the branch's usual shape),
  //     and struct-module — the station module itself. Its id is load-
  //     bearing: js/data/missions.js's `dock` template gates on
  //     `requiresNode: 'struct-module'` by this exact string, so the id
  //     can't be renamed independently of that file. It carries no vehicle
  //     effect (see its own comment below for why that's an honest choice,
  //     not an oversight) — it gates a MISSION, not a stat.
  //   reliability (2): restart qualification (recovers prop-11's cut) and
  //     docking rehearsal (`dockBonus`, which ARCHITECTURE.md says the
  //     resolver adds to the docking roll threshold, capped at 0.99 —
  //     that capping is the resolver's job, not data's).
  //
  // Every tier 3 node requires at least one tier 2 (or tier 3) node, never
  // a bare tier 1 one, matching the branch-top prerequisites tier 2's own
  // nodes used to reach back into tier 1.
  {
    id: 'prop-10',
    branch: 'propulsion',
    level: 10,
    tier: 3,
    name: 'Restart igniter',
    desc: 'Lets the top stage relight once after its first burn, so it can fly the separate burns a rendezvous or docking attempt needs.',
    cost: { funds: 40000 },
    requires: ['prop-9'],
    effects: [{ stat: 'restarts', op: 'set', value: 1 }],
  },
  {
    id: 'prop-11',
    branch: 'propulsion',
    level: 11,
    tier: 3,
    name: 'Multi-restart plumbing',
    desc: 'More relights for the top stage, at a cost: repeated hot restarts stress the ignition system and trim its reliability a little.',
    cost: { funds: 56000 },
    requires: ['prop-10'],
    effects: [
      { stat: 'restarts', op: 'add', value: 2 },
      { stat: 'stages.2.reliability', op: 'mul', value: 0.97 },
    ],
  },
  {
    id: 'prop-12',
    branch: 'propulsion',
    level: 12,
    tier: 3,
    name: 'Reaction control thrusters',
    desc: 'Small cold-gas thrusters for a gentle, precise final approach.',
    cost: { funds: 35000 },
    requires: ['prop-10'],
    effects: [{ stat: 'rcs', op: 'set', value: 1 }],
  },
  {
    id: 'prop-13',
    branch: 'propulsion',
    level: 13,
    tier: 3,
    name: 'Top-stage propellant reserve',
    desc: 'A bigger propellant reserve held back on the top stage for the rendezvous burns.',
    cost: { funds: 32500 },
    // struct-10 is a PREREQUISITE, not a sibling, and that is the whole
    // point of it being here: bought before the lighter fairing, the extra
    // 35 kg on the stage that has to circularise dropped the tier 2 goal set
    // from 127 848 m periapsis to -365 703 m -- no orbit at all, and with
    // struct-7 added still only 83 669 m. That made prop-13 a TRAP: the
    // contract gates cannot express "not this node", so the ladder tab told
    // a player who owned it that satellite was available and the vehicle
    // could not fly it (36 of satellite's supersets fell short, every one of
    // them carrying prop-13 without struct-10 -- `node tools/gates.mjs`
    // listed them). Requiring the fairing makes that set of owned states
    // unreachable rather than merely documented, and the fairing's -4 kg on
    // the same stage very nearly cancels this node's +5 kg of dry mass, so
    // what the pair adds is the 30 kg of propellant. The trap is impossible
    // to buy into; test/data.test.js's harmful-node list no longer names
    // prop-13, so a regression that reintroduces it fails there.
    //
    // The tank is also NOT optional above this line: it is what the three
    // target-shaped rungs are gated on (js/data/missions.js, THE RESERVE),
    // because the orbit-match burn has to come out of what the top stage
    // keeps back at cutoff.
    requires: ['prop-10', 'struct-10'],
    effects: [
      { stat: 'stages.2.propMass', op: 'add', value: 30 },
      { stat: 'stages.2.dryMass', op: 'add', value: 5 },
    ],
  },

  {
    id: 'guide-3',
    branch: 'guidance',
    level: 3,
    tier: 3,
    name: 'Rendezvous radar',
    desc: 'Coarse radar ranging to a target in orbit.',
    cost: { funds: 32500 },
    requires: ['guide-1'],
    effects: [{ stat: 'nav', op: 'set', value: 1 }],
  },
  {
    id: 'guide-4',
    branch: 'guidance',
    level: 4,
    tier: 3,
    name: 'Star tracker',
    desc: 'A star tracker for a much sharper fix on a target\'s position.',
    cost: { funds: 42500 },
    requires: ['guide-3'],
    effects: [{ stat: 'nav', op: 'set', value: 2 }],
  },
  {
    id: 'guide-5',
    branch: 'guidance',
    level: 5,
    tier: 3,
    name: 'Docking sensors',
    desc: 'Millimetre-wave sensors for the final metres of a docking approach.',
    cost: { funds: 50000 },
    requires: ['guide-4'],
    effects: [{ stat: 'nav', op: 'set', value: 3 }],
  },

  {
    id: 'struct-9',
    branch: 'structure',
    level: 9,
    tier: 3,
    name: 'Docking adapter',
    desc: 'A standard docking port on the top stage.',
    cost: { funds: 37500 },
    requires: ['struct-8'],
    effects: [{ stat: 'docking', op: 'set', value: 1 }],
  },
  {
    id: 'struct-10',
    branch: 'structure',
    level: 10,
    tier: 3,
    name: 'Lightweight top-stage fairing',
    desc: 'A lighter top-stage fairing, trimmed down further.',
    cost: { funds: 25000 },
    requires: ['struct-8'],
    effects: [{ stat: 'stages.2.dryMass', op: 'add', value: -4 }],
  },
  {
    id: 'struct-module',
    branch: 'structure',
    level: 11,
    tier: 3,
    name: 'Station module',
    desc: 'The lab module a successful docking flight carries up and leaves attached to the station.',
    cost: { funds: 62500 },
    requires: ['struct-9'],
    // Honest placeholder, in the same spirit as tier 2's guide-2 doc
    // comment: this node's whole job is to gate a MISSION template
    // (js/data/missions.js's `dock`, via `requiresNode: 'struct-module'`),
    // not to change how any vehicle flies. Giving it a made-up vehicle
    // stat just to have an `effects` entry would be dishonest about what
    // owning it actually does — an empty array says so plainly.
    effects: [],
  },

  {
    id: 'rel-7',
    branch: 'reliability',
    level: 9,
    tier: 3,
    name: 'Restart qualification',
    desc: 'Extra qualification testing that steadies the top stage\'s engine after repeated relights.',
    cost: { funds: 27500 },
    requires: ['rel-6', 'prop-11'],
    effects: [{ stat: 'stages.2.reliability', op: 'mul', value: 1 / 0.97 }],
  },
  {
    id: 'rel-8',
    branch: 'reliability',
    level: 10,
    tier: 3,
    name: 'Docking rehearsal',
    desc: 'Practice runs against a mock target, sharpening the crew\'s docking technique.',
    cost: { funds: 32500 },
    requires: ['rel-7', 'struct-9'],
    effects: [{ stat: 'dockBonus', op: 'add', value: 0.05 }],
  },

  // ---------------------------------------------------------------------
  // TIER 4 -- the Moon. See ARCHITECTURE.md, "Phase 3 -- tier 4, the Moon".
  //
  // Balanced against the REAL phase 3 resolver (js/core/resolver.js's lunar
  // phase + js/core/moon.js's ladder), the same way every tier above is
  // balanced against its own resolver phase. `node tools/balance.mjs`'s
  // TIER 4 section drives `resolveLaunch` against each lunar profile
  // (reliability forced to 1), scanning `turn` in 0.05 steps; re-run it
  // after touching any cost or effect here.
  //
  // WHAT THE TIER HAS TO BUY, in one number. A `return` flight spends the
  // whole lunar ladder after insertion -- tli, loi, descent, ascent, tei --
  // and js/core/moon.js prices that at 8 536 m/s from a 180 km CIRCULAR
  // parking orbit. That is NOT the number to size against. The orbit a real
  // ascent reaches is eccentric (the cutoff fires the instant periapsis
  // crosses ORBIT_MIN_ALT, leaving apoapsis anywhere from a few hundred to
  // several thousand km) and the departure burn is charged at periapsis,
  // where the vehicle is already moving fastest, so the flown price of
  // `return` is nearer 8 100 m/s from an 80 x 1 800 km parking orbit -- and
  // lower still from the wilder ellipses this tree can reach (8 352 m/s at
  // 80 x 300 km, 6 700 at 80 x 7 000 km). Measured, not assumed:
  // `lunarLadder` was asked for each, and the tree is sized against the
  // flown number rather than the quoted one.
  //
  // WHICH MEANS THE TIER IS A LAUNCH VEHICLE, not an attachment. The tier 3
  // stack carries 10 934 m/s of ideal delta-v and arrives in its parking
  // orbit with 430-800 m/s left in the top stage -- a fifth of what the
  // CHEAPEST lunar profile (flyby: one 2 900 m/s burn) needs and a
  // twentieth of `return`. No attachment fixes that. The only way to arrive
  // with 8 km/s aboard is to arrive with stages still unfired, and the only
  // way to lift those stages is a bigger launcher: struct-11 is an 18x
  // booster stretch with the engines to fly it, and every other node in the
  // tier hangs off it. This is the tier that turns a satellite launcher into
  // a moon rocket, and it is priced like one.
  //
  // SIX MEASURED FACTS ABOUT THE PHASE 3 RESOLVER, each of which moved this
  // design away from ARCHITECTURE.md's sketch, and each checked against
  // resolveLaunch rather than reasoned about:
  //
  //   1. AN `addStage` NODE MUST LIVE IN THE STRUCTURE BRANCH.
  //      ARCHITECTURE.md puts the cryogenic departure stage in PROPULSION.
  //      It cannot go there. js/core/tree.js's collectEffects hoists every
  //      `addStage` effect ahead of every other effect *in branch order*,
  //      and propulsion sorts before structure -- so a propulsion
  //      `addStage` would append its stage BEFORE struct-4's and
  //      struct-6's, making the departure stage index 1 and renumbering
  //      `stages.1.*` and `stages.2.*` in every tier 2 and tier 3 effect
  //      that targets them. The hoist exists precisely so propulsion can
  //      upgrade a stage STRUCTURE adds (see collectEffects's own comment);
  //      reversing the relationship breaks two tiers. Both new stages are
  //      therefore structure nodes and propulsion sells their engine --
  //      which is the division of labour struct-6/prop-8 already has.
  //   2. A THRUST-ONLY NODE IS A TRAP HERE, so the core stretch and its
  //      engines are ONE purchase. The rail below normally splits them: buy
  //      the thrust, then the mass. Measured, the split does not survive
  //      this tier's scale. On the tier 3 stack, uprating all three core
  //      stages' thrust with no mass added drops the best reachable
  //      periapsis from 184 627 m to 121 009 m at x2 and to -1 683 466 m at
  //      the x10 this tier needs: at that thrust-to-weight the vehicle
  //      clears the pitch program's fixed pitch-over altitudes before it
  //      has any horizontal speed and flies an enormous lob instead of an
  //      orbit. `node tools/gates.mjs` reported it as 24 supersets of
  //      `relay`'s gate falling short, all of them carrying the thrust node
  //      without the mass node -- i.e. a player who bought the engines
  //      first would lose the tier's only income until they could afford
  //      the core, six figures later. Data cannot express "not this node",
  //      and the trap is not a trade-off worth documenting, so the two are
  //      one node and the failing supersets are gone (0 now). Same
  //      resolution as prop-13's, arrived at the same way: make the harmful
  //      owned state unreachable rather than merely written down.
  //   3. STAGES ABOVE THE INSERTION STAGE NEVER IGNITE IN THE ASCENT. The
  //      cutoff fires on whichever stage is burning when periapsis crosses
  //      ORBIT_MIN_ALT, and for every set below the ascent finishes on
  //      stage 3 (the enlarged third stage) with the departure and ascent
  //      stages untouched. That is what makes `dvAvailable` -- the cutting
  //      stage's reserve plus every unfired stage above it -- come out at
  //      6 800-9 300 m/s instead of a few hundred. It also means
  //      `stages.3.reliability` is read by nothing at all, and
  //      `stages.4.reliability` only by the lunar sequence, which rolls
  //      every restart against `stages[stages.length - 1]`. So there is no
  //      node here selling departure-stage reliability: it would be a stat
  //      nothing rolls. rel-10 sells the ascent stage's, which is the one
  //      that IS rolled.
  //   4. A MOON ROCKET CARRYING A 5 kg PAYLOAD IS ALREADY A FLYBY VEHICLE.
  //      The lunar stack (departure stage + ascent stage) masses ~92 kg
  //      against the game's 5 kg payload, so the same core that can barely
  //      insert the full stack inserts a BARE payload with 6 800 m/s left
  //      over, on an ellipse whose apoapsis is in the tens of thousands of
  //      km -- which makes its departure burn cheaper as well. Measured:
  //      struct-11 + guide-1 alone flies `flyby` on all 21 turn notches. So
  //      js/data/missions.js gates the flyby rung on the CORE, not on the
  //      departure stage; the departure stage earns its place as the thing
  //      the lander and the ascent stage bolt to. Gating flyby on hardware
  //      the resolver does not need would have been a gate the data
  //      invented.
  //   5. `restarts` IS A REAL LADDER RUNG AGAIN. The profiles need 1, 2, 3
  //      and 5 restarts (LUNAR_PROFILES: one per step), and tier 3 leaves
  //      the player with 3. So `moon-orbit` genuinely gates on prop-11 --
  //      with one restart the sequence stops in front of the lunar orbit
  //      insertion burn having spent nothing, whatever the budget -- and
  //      `moon-return` gates on prop-17, the fifth relight, without which
  //      the crew lifts off the surface and stays in lunar orbit. Neither
  //      is a delta-v gate, which is why neither ever shows up in a
  //      cheapest-reaching set the way a propellant node does.
  //   6. THE LAST 286 m/s IS prop-15. With the shield, the ascent stage and
  //      five restarts but WITHOUT the descent propellant reserve, the best
  //      loadout in the whole sweep lands, lifts off, and stops 286 m/s
  //      short of the trans-earth injection -- `reached 3, short 286`. That
  //      is the shape prop-9 has at the top of tier 2 (the small margin
  //      node that crosses the last gap to the goal), and it is deliberate:
  //      the goal rung should cost one more purchase than the rung below
  //      it, not fall out of the tree for free.
  //
  // FOUR BRANCHES, FOURTEEN NODES:
  //
  //   propulsion (4): prop-14 is the cryogenic deep-space engine that turns
  //     the departure stage from a storable into a cryogenic one (isp 330
  //     -> 462) and is what makes `return` affordable at all; prop-15 is
  //     the descent propellant reserve, the margin node of fact 6; prop-16
  //     and prop-17 are the fourth and fifth relights, one node each,
  //     because four of them strand the crew in lunar orbit and the ladder
  //     should be able to say so (fact 5).
  //   structure (5): struct-11 is the lunar-class launch vehicle -- an 18x
  //     booster stretch, upper stages to match, and the engines that fly
  //     them, all in one purchase (fact 2); struct-12 the cryogenic
  //     departure stage; struct-13 the lander (`lander` set 1); struct-14
  //     the ascent stage; struct-15 the heat shield (`shield` set 1).
  //     struct-13 and struct-15 carry NO mass, deliberately: they are
  //     hardware gates the resolver reads off the vehicle, exactly as
  //     struct-9's docking adapter is, and the mass of the hardware is
  //     already in the stage each rides on.
  //   guidance (2): guide-6 (deep-space navigation) and guide-7
  //     (terrain-relative landing). ARCHITECTURE.md asks for a third,
  //     "entry guidance" -- there is nothing for it to do. Entry at the
  //     planet is free in js/core/moon.js (the atmosphere does the braking,
  //     and a vehicle without a shield does not get to spend delta-v
  //     instead), so entry is not a rung, not a roll, and not a number any
  //     guidance stat could sharpen. A node for it would have been a second
  //     struct-module with nothing to gate. Two honest nodes beat three
  //     with a passenger.
  //   reliability (3): rel-9 requalifies the insertion stage (which now
  //     flies a 3-tonne stack to orbit instead of a 330 kg one), rel-10
  //     qualifies the ascent-stage engine -- the one every lunar restart is
  //     rolled against, per fact 3 -- and rel-11 is landing rehearsal
  //     (`landerBonus`, which the resolver adds to the landing roll's
  //     threshold and caps at LANDING_RELIABILITY_MAX; the capping is the
  //     resolver's job, not data's, exactly as with rel-8's dockBonus).
  //
  // THE CROSS-BRANCH TWR RAIL, as it applies here. Its subject is a stage
  // ADDED by structure, and it holds for both: struct-12 (the departure
  // stage) requires struct-11, which is where the thrust that lifts it
  // lives, and struct-14 (the ascent stage) requires prop-14, the departure
  // stage's engine, which is what flies it. What the rail does NOT do here
  // is separate struct-11's own mass from its own thrust -- fact 2 is why,
  // and the reason is the rail's own reason turned around: the split it
  // normally prevents a soft-lock with would create a worse one.
  // Measured over every prereq-valid combination across all four tiers by
  // `node tools/balance.mjs`'s GOAL 4 report and test/data.test.js's
  // bounded version: no combination drops liftoff TWR below 1.05 or an
  // upper stage below 0.5 at ignition.
  //
  // Every tier 4 node's prerequisites are tier 4 or tier 3, never a bare
  // tier 1 or tier 2 node -- the same rule tier 3 follows, one tier along.
  //
  // LADDER (js/data/missions.js). Measured, one to three new purchases per
  // rung, and each rung verified BOTH ways (flyable with exactly this
  // closure over every selectable loadout, and not flyable without the node
  // the rung is about):
  //
  //   relay        no lunar hardware at all: a 160 km orbit, flyable by
  //                whatever won tier 3. The tier's income filler.
  //   moon-flyby   struct-11 + guide-1        the launch vehicle (fact 4)
  //   moon-orbit   + prop-11                  the second restart (fact 5)
  //   moon-land    + struct-13                the lander
  //   moon-return  + struct-15, prop-17, prop-15
  //                                           the shield, the fifth
  //                                           restart, and the last 286 m/s
  //
  // COSTS. Tier 3's twelve nodes cost 473 500 funds; tier 4's fourteen cost
  // 1 665 000, a 3.5x step where tier 3's step from tier 2 (299 500) was
  // 1.6x. The bigger jump is deliberate and is set by the GREEDY SIMULATION
  // rather than by symmetry: tier 4 payouts are three to four times tier
  // 3's (js/data/missions.js), so at tier 3's cost ratio the whole tree
  // would fall to a player in well under ten launches -- far under
  // ARCHITECTURE.md's 15-60 target. `node tools/balance.mjs`'s tier 4
  // greedy report is the number that fixed these, exactly as it fixed tier
  // 2's: from the tier 3 end state it now takes 18 tier 4 launches to land
  // and return, with a longest dry streak of 2.
  {
    id: 'prop-14',
    branch: 'propulsion',
    level: 14,
    tier: 4,
    name: 'Cryogenic deep-space engine',
    desc: 'Replaces the departure stage\'s storable engine with a cryogenic one: far more efficient, and the difference between reaching the moon and coming home from it.',
    cost: { funds: 145000 },
    // Targets a stage STRUCTURE adds (struct-12), which is exactly the
    // cross-branch pattern collectEffects's addStage hoist exists for --
    // prop-8 does the same to struct-6's third stage one tier down.
    requires: ['struct-12'],
    effects: [{ stat: 'stages.3.isp', op: 'mul', value: 1.4 }],
  },
  {
    id: 'prop-15',
    branch: 'propulsion',
    level: 15,
    tier: 4,
    name: 'Descent propellant reserve',
    desc: 'Stretched departure-stage tanks holding back the propellant the powered descent spends, so landing does not eat the fuel for the trip home.',
    cost: { funds: 95000 },
    requires: ['prop-14'],
    effects: [
      { stat: 'stages.3.propMass', op: 'add', value: 52 },
      { stat: 'stages.3.dryMass', op: 'add', value: 2 },
    ],
  },
  {
    id: 'prop-16',
    branch: 'propulsion',
    level: 16,
    tier: 4,
    name: 'Cryogenic restart system',
    desc: 'A fourth relight for the top of the stack: enough to land and lift off again.',
    cost: { funds: 85000 },
    // prop-11 is where restarts stand at 3 (prop-10 sets 1, prop-11 adds
    // 2), so this branch's tier 4 pair continues that chain rather than
    // restarting it. Four relights fly tli, loi, descent and ascent -- the
    // whole mission except the way home, which is prop-17's job.
    requires: ['prop-11', 'prop-14'],
    effects: [{ stat: 'restarts', op: 'add', value: 1 }],
  },
  {
    id: 'prop-17',
    branch: 'propulsion',
    level: 17,
    tier: 4,
    name: 'Boiloff and ullage control',
    desc: 'Insulation and settling thrusters that keep the cryogenic stage lightable after days in space: the fifth relight, and the one that comes home.',
    cost: { funds: 90000 },
    requires: ['prop-16'],
    effects: [{ stat: 'restarts', op: 'add', value: 1 }],
  },

  {
    id: 'struct-11',
    branch: 'structure',
    level: 12,
    tier: 4,
    name: 'Lunar-class launch vehicle',
    desc: 'Rebuilds the three core stages around the lunar mission: eighteen times the booster propellant, upper stages to match, and the engines to fly them.',
    cost: { funds: 240000 },
    // THE SPINE OF THE TIER, and the one node that carries both its own
    // mass and its own thrust -- fact 2 above has the measurement and the
    // reason. 2 250 kg of booster propellant on the tier 3 booster's
    // engines would leave liftoff TWR at 0.09 (a vehicle that cannot leave
    // the pad, the soft-lock DESIGN.md 7 forbids); the same engines without
    // the propellant fly a lob instead of an orbit and cost the player the
    // tier's income. Neither half is purchasable alone.
    //
    // prop-13 is the other prerequisite so the structure branch's top still
    // sits on the propulsion branch's top, the way struct-6 sits on prop-6.
    requires: ['struct-10', 'prop-13'],
    effects: [
      { stat: 'stages.0.thrust', op: 'mul', value: 10 },
      { stat: 'stages.1.thrust', op: 'mul', value: 10 },
      { stat: 'stages.2.thrust', op: 'mul', value: 10 },
      { stat: 'stages.0.propMass', op: 'mul', value: 18 },
      { stat: 'stages.0.dryMass', op: 'mul', value: 4 },
      { stat: 'stages.1.propMass', op: 'mul', value: 5 },
      { stat: 'stages.1.dryMass', op: 'mul', value: 2.5 },
      { stat: 'stages.2.propMass', op: 'mul', value: 3 },
      { stat: 'stages.2.dryMass', op: 'mul', value: 1.8 },
    ],
  },
  {
    id: 'struct-12',
    branch: 'structure',
    level: 13,
    tier: 4,
    name: 'Cryogenic departure stage',
    desc: 'A fourth stage that rides to orbit unfired and then makes the burn that leaves it.',
    cost: { funds: 150000 },
    requires: ['struct-11'],
    // Storable propellant and a modest engine as bought; prop-14 is what
    // makes it cryogenic. Sized so the stage is worth having with the
    // engine it comes with and transformative with prop-14's -- see fact 6.
    effects: [
      {
        addStage: {
          dryMass: 6,
          propMass: 16,
          thrust: 900,
          isp: 330,
          reliability: 0.86,
        },
      },
    ],
  },
  {
    id: 'struct-13',
    branch: 'structure',
    level: 14,
    tier: 4,
    name: 'Lunar lander',
    desc: 'Landing legs, a throttleable descent engine and a radar altimeter: the hardware a powered descent needs.',
    cost: { funds: 140000 },
    requires: ['struct-12'],
    // No mass, on purpose, and for the same reason struct-9's docking
    // adapter carries none: what the resolver reads is the STAT (`lander`,
    // without which resolveLunarSequence stops at `stoppedAt: 'lander'`
    // having spent nothing), and the mass of the thing is already in the
    // departure stage it rides on. A dry-mass add here would double-count
    // it, and would also drag a pure mission gate into tools/gates.mjs's
    // trajectory enumeration, where it does not belong.
    effects: [{ stat: 'lander', op: 'set', value: 1 }],
  },
  {
    id: 'struct-14',
    branch: 'structure',
    level: 15,
    tier: 4,
    name: 'Ascent stage',
    desc: 'A small stage left on top of the lander, carrying just enough propellant to get off the surface and start home.',
    cost: { funds: 120000 },
    // The cross-branch TWR rail: this stage rides on the departure stage,
    // and prop-14 is the engine that flies it.
    requires: ['struct-13', 'prop-14'],
    effects: [
      {
        addStage: {
          dryMass: 2.5,
          propMass: 11,
          thrust: 200,
          isp: 320,
          reliability: 0.9,
        },
      },
    ],
  },
  {
    id: 'struct-15',
    branch: 'structure',
    level: 16,
    tier: 4,
    name: 'Ablative heat shield',
    desc: 'The shield that survives entry at translunar speed. Without one the flight has no way home and stops in lunar orbit.',
    cost: { funds: 110000 },
    requires: ['struct-14'],
    // Massless for the same reason struct-13 is. The resolver puts this
    // gate IN FRONT of the trans-earth injection burn (js/core/resolver.js),
    // so a shieldless vehicle never raises `best.lunarStep` to "returned".
    effects: [{ stat: 'shield', op: 'set', value: 1 }],
  },

  {
    id: 'guide-6',
    branch: 'guidance',
    level: 6,
    tier: 4,
    name: 'Deep-space navigation',
    desc: 'Star sightings against the planet\'s limb, and a flight computer that almost never drops its program.',
    cost: { funds: 100000 },
    requires: ['guide-5'],
    // The honest effect is `guidanceReliability`: the guidance roll fires
    // on every guided flight (ARCHITECTURE.md, "Anomalies") and a lunar
    // ascent is a guided flight, so 0.98 -> 0.995 is a real cut in the
    // flights that wander off program. The `nav` add is INERT and kept for
    // the same reason guide-2 keeps its `guidance` add: the orbital
    // sequence clamps nav to NAV_APPROACH's range (0..3) and the lunar
    // sequence never reads it at all, so this raises a number the stats
    // panel shows and nothing else. Said plainly rather than dressed up.
    effects: [
      { stat: 'nav', op: 'add', value: 1 },
      { stat: 'guidanceReliability', op: 'set', value: 0.995 },
    ],
  },
  {
    id: 'guide-7',
    branch: 'guidance',
    level: 7,
    tier: 4,
    name: 'Terrain-relative landing',
    desc: 'The descent computer matches what it sees against a map and picks its own spot, instead of taking whatever is underneath.',
    cost: { funds: 115000 },
    requires: ['guide-6', 'struct-13'],
    effects: [{ stat: 'landerBonus', op: 'add', value: 0.04 }],
  },

  {
    id: 'rel-9',
    branch: 'reliability',
    level: 11,
    tier: 4,
    name: 'Insertion-stage requalification',
    desc: 'Requalifies the third-stage engine for the far heavier stack it now flies to orbit.',
    cost: { funds: 80000 },
    requires: ['rel-8', 'struct-11'],
    effects: [{ stat: 'stages.2.reliability', op: 'mul', value: 1.01 }],
  },
  {
    id: 'rel-10',
    branch: 'reliability',
    level: 12,
    tier: 4,
    name: 'Lunar engine qualification',
    desc: 'Qualification firings for the topmost engine, the one every burn of the lunar sequence is rolled against.',
    cost: { funds: 90000 },
    // struct-14 is a prerequisite because this targets the stage it adds,
    // and because the description is only true once that stage exists:
    // resolveLunarSequence rolls every restart against
    // `stages[stages.length - 1]`, which is the ascent stage on a complete
    // lunar stack.
    requires: ['rel-9', 'struct-14'],
    effects: [{ stat: 'stages.4.reliability', op: 'mul', value: 1.08 }],
  },
  {
    id: 'rel-11',
    branch: 'reliability',
    level: 13,
    tier: 4,
    name: 'Landing rehearsal',
    desc: 'Practice descents flown against a simulator and a free-flying training vehicle, sharpening the last hundred metres.',
    cost: { funds: 105000 },
    requires: ['rel-10'],
    effects: [{ stat: 'landerBonus', op: 'add', value: 0.05 }],
  },
];
