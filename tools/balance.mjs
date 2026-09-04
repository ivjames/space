#!/usr/bin/env node
// Balance audit for js/data/*, tier 1 and (once the phase 1 resolver has
// landed) tier 2. Runs the REAL resolver — never the ideal delta-v shortcut
// — so what it reports is what a player actually experiences flying through
// real gravity, drag, and (tier 2) a pitch program. See ARCHITECTURE.md
// (vehicle/resolver/tree/missions) and DESIGN.md §6/§7.
//
// Usage: node tools/balance.mjs
//
// Tier 1 reports (unchanged from phase 0):
//   - the starter's max altitude (fuelFraction 1.0 and 0.8)
//   - every mission's cheapest prereq-valid reaching set + cost
//   - the tier goal's cheapest reaching set + cost
//   - the full tree's max altitude
//   - the minimum liftoff TWR over every prereq-valid TIER 1 owned set
//   - a greedy player's launch count to the tier 1 goal
//
// Tier 2 reports (ARCHITECTURE.md, "Balance, phase 1") — only when
// resolveLaunch's outcome actually carries a `periapsis` field. Against the
// still-phase-0 resolver this file was first written against, that field is
// absent; in that case this script prints the tier 1 report above, then
// "tier 2 balance needs the phase 1 resolver" and exits 0 rather than
// crashing on a mission-requirement shape (orbit/downrange) the old resolver
// doesn't understand:
//   - for each tier 2 mission, a cheapest-ish prereq-valid reaching set
//     (HEURISTIC, not exhaustive — see the tier 2 section below for why)
//   - the full tree's best simulated orbit (periapsis x apoapsis)
//   - a greedy player's tier 2 launch count, continuing from a greedy tier
//     1 end state
//
// Tier 4 reports (ARCHITECTURE.md, "Balance, phase 3") — only when
// resolveLaunch's outcome carries a `lunar` field for a `moon` requirement,
// guarded the same way:
//   - the cheapest prereq-valid set reaching each lunar rung (EXHAUSTIVE over
//     the tier 4 additions, which is affordable because the tier chains hard)
//   - the remaining-stack delta-v budget at insertion for each of those sets,
//     against the ladder js/core/moon.js prices from the orbit each flight
//     actually reached
//   - the TWR safety rail across every prereq-valid combination of all four
//     tiers
//   - a greedy player's tier 4 launch count from the tier 3 end state
//
// Determinism: reliability is forced to 1 on a deep copy of the vehicle
// before every resolve. The resolver has no reliability-override option, and
// nothing here depends on the rng beyond that (a reliability-1 vehicle flies
// bit-identically under any seed — see resolver.js's docs on the mid-burn
// roll), so a fixed seed is used throughout for repeatability.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = (p) => path.join(here, '..', 'js', 'core', p);
const data = (p) => path.join(here, '..', 'js', 'data', p);

const { resolveLaunch, ORBIT_MIN_ALT } = await import(core('resolver.js'));
const { buildVehicle, stackMassAbove } = await import(core('vehicle.js'));
const { makeRng } = await import(core('rng.js'));
const { loadTree, collectEffects, canBuy, buy } = await import(core('tree.js'));
const { credit } = await import(core('economy.js'));
const { baseVehicle } = await import(data('components.js'));
const { nodes } = await import(data('tree.js'));
const { missions, tierGoals } = await import(data('missions.js'));

const G0 = 9.80665;
const SEED = 1;
// Larger than any altitude this tree can reach, so the resolver always flies
// the whole trajectory instead of stopping early at a "goal" altitude — we
// want maxAltitude, not success/failure against some requirement.
const NO_CEILING_MISSION = { requirement: { altitude: 1e9 } };

function forceReliability(vehicle) {
  const copy = JSON.parse(JSON.stringify(vehicle));
  for (const stage of copy.stages) stage.reliability = 1;
  // The guidance roll (ARCHITECTURE.md, "Anomalies") is the one roll that is
  // not a stage's; forced for the same reason.
  copy.guidanceReliability = 1;
  return copy;
}

function maxAltitudeOf(vehicle, fuelFraction = 1) {
  const rng = makeRng(SEED);
  const outcome = resolveLaunch(
    forceReliability(vehicle),
    NO_CEILING_MISSION,
    { fuelFraction },
    rng,
    {},
  );
  return outcome.maxAltitude;
}

function liftoffTWR(vehicle, fuelFraction = 1) {
  const totalMass = vehicle.stages.reduce(
    (m, s) => m + s.dryMass + s.propMass * fuelFraction,
    vehicle.payloadMass,
  );
  const liftoffThrust = vehicle.stages[0]?.thrust ?? 0;
  return liftoffThrust / (totalMass * G0);
}

function fundsCost(node) {
  return node.cost?.funds ?? 0;
}

// ---- Enumerate every prereq-valid TIER 1 owned set (2^N over tier 1) ------
//
// Scoped to tier 1 nodes only: js/data/tree.js now also carries tier 2's 12+
// nodes in the same `nodes` export, and 2^(12+13) is not remotely tractable
// to brute force. Tier 2's own report (below) uses a heuristic search
// instead of exhaustive enumeration for exactly this reason.

const tier1Nodes = nodes.filter((n) => (n.tier ?? 1) === 1);
const tree = loadTree(tier1Nodes);
const ids = tier1Nodes.map((n) => n.id);
if (ids.length > 20) {
  throw new Error(`balance.mjs: brute force assumes a small tree, got ${ids.length} nodes`);
}

const validSets = [];
for (let mask = 0; mask < 1 << ids.length; mask += 1) {
  const owned = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (mask & (1 << i)) owned.push(ids[i]);
  }
  const ownedSet = new Set(owned);
  let valid = true;
  for (const id of owned) {
    const reqs = tree.byId.get(id).requires ?? [];
    if (!reqs.every((r) => ownedSet.has(r))) {
      valid = false;
      break;
    }
  }
  if (!valid) continue;

  const state = { owned, funds: 0, resources: {} };
  const effects = collectEffects(tree, state);
  const vehicle = buildVehicle(baseVehicle, effects);
  const altitude = maxAltitudeOf(vehicle, 1);
  const twr = liftoffTWR(vehicle, 1);
  const cost = owned.reduce((sum, id) => sum + fundsCost(tree.byId.get(id)), 0);
  validSets.push({ owned, altitude, twr, cost });
}

function cheapestReaching(requiredAltitude) {
  let best = null;
  for (const set of validSets) {
    if (set.altitude < requiredAltitude) continue;
    if (!best || set.cost < best.cost) best = set;
  }
  return best;
}

// ---- Greedy player simulation ----------------------------------------------
//
// Each launch: fly the highest-payout mission the current vehicle (at
// fuelFraction 1.0, reliability forced to 1 for determinism, matching the
// rest of this script) can reach; if none of the non-floor missions are
// reachable yet, fly the floor contract (always affordable, always offered,
// per DESIGN.md §7). Bank the payout, then greedily buy the cheapest
// afford­able node that increases max altitude, repeating until no such node
// is affordable, then launch again. Stops when max altitude clears the tier
// goal. Reputation gating (minReputation) is not modeled — this is a
// best-case "always qualifies" player, so the reported count is a lower
// bound on launches, which is the right side to be conservative about here.
function greedyLaunchesToGoal() {
  const goalAltitude = tierGoals[1].requirement.altitude;
  const floorMission = missions.find((m) => m.floor);
  let state = { owned: [], funds: 0, resources: {} };
  let launches = 0;
  const MAX_LAUNCHES = 500;

  const altitudeOf = (s) => {
    const vehicle = buildVehicle(baseVehicle, collectEffects(tree, s));
    return maxAltitudeOf(vehicle, 1);
  };

  let altitude = altitudeOf(state);
  while (altitude < goalAltitude) {
    if (launches >= MAX_LAUNCHES) {
      throw new Error(`greedy simulation did not reach the tier goal within ${MAX_LAUNCHES} launches`);
    }
    let best = floorMission;
    for (const m of tier1Missions) {
      if (m.requirement.altitude <= altitude && m.payout > best.payout) best = m;
    }
    state = { ...state, funds: state.funds + best.payout };
    launches += 1;

    // Spend down on the cheapest altitude-increasing node, repeatedly, until
    // nothing affordable helps anymore.
    for (;;) {
      let pick = null;
      for (const node of tree.nodes) {
        if (!canBuy(tree, state, node.id)) continue;
        const candidateState = { ...state, owned: [...state.owned, node.id] };
        const candidateAltitude = altitudeOf(candidateState);
        if (candidateAltitude > altitude + 1e-6) {
          if (!pick || fundsCost(node) < fundsCost(pick)) pick = node;
        }
      }
      if (!pick) break;
      state = buy(tree, state, pick.id);
      altitude = altitudeOf(state);
    }
  }
  return launches;
}

// ---- Report -----------------------------------------------------------------

console.log('=== Starter vehicle ===');
const starterVehicle = buildVehicle(baseVehicle, []);
const starterAlt1 = maxAltitudeOf(starterVehicle, 1);
const starterAlt08 = maxAltitudeOf(starterVehicle, 0.8);
console.log(`  max altitude @ fuelFraction 1.0: ${starterAlt1.toFixed(0)} m`);
console.log(`  max altitude @ fuelFraction 0.8: ${starterAlt08.toFixed(0)} m`);
console.log(`  liftoff TWR: ${liftoffTWR(starterVehicle, 1).toFixed(2)}`);

console.log('\n=== Full tree (all nodes owned) ===');
const fullState = { owned: ids, funds: 0, resources: {} };
const fullVehicle = buildVehicle(baseVehicle, collectEffects(tree, fullState));
const fullAlt = maxAltitudeOf(fullVehicle, 1);
const fullCost = ids.reduce((s, id) => s + fundsCost(tree.byId.get(id)), 0);
console.log(`  max altitude @ fuelFraction 1.0: ${fullAlt.toFixed(0)} m`);
console.log(`  total cost: ${fullCost} funds`);

console.log('\n=== Minimum liftoff TWR over every prereq-valid owned set ===');
let minTwr = Infinity;
let minTwrOwned = [];
for (const set of validSets) {
  if (set.twr < minTwr) {
    minTwr = set.twr;
    minTwrOwned = set.owned;
  }
}
console.log(`  min TWR: ${minTwr.toFixed(3)} (owned=[${minTwrOwned.join(',') || '(none)'}])`);
console.log(`  ${validSets.length} prereq-valid sets checked out of ${1 << ids.length} masks`);

const tier1Missions = missions.filter((m) => (m.tier ?? 1) === 1);

console.log('\n=== Missions: cheapest prereq-valid reaching set (tier 1) ===');
for (const m of tier1Missions) {
  const best = cheapestReaching(m.requirement.altitude);
  const label = m.floor ? ' (floor)' : '';
  if (!best) {
    console.log(`  ${m.id}${label}: UNREACHABLE at ${m.requirement.altitude} m`);
    continue;
  }
  console.log(
    `  ${m.id}${label}: ${m.requirement.altitude} m -> ${best.cost} funds, ` +
    `${best.owned.length} node(s) [${best.owned.join(', ') || '(none)'}], reaches ${best.altitude.toFixed(0)} m`,
  );
}

console.log('\n=== Tier 1 goal: cheapest prereq-valid reaching set ===');
const goalAltitude = tierGoals[1].requirement.altitude;
const goalBest = cheapestReaching(goalAltitude);
if (!goalBest) {
  console.log(`  UNREACHABLE at ${goalAltitude} m`);
} else {
  console.log(
    `  ${goalAltitude} m -> ${goalBest.cost} funds (${((goalBest.cost / fullCost) * 100).toFixed(0)}% of full tree cost), ` +
    `${goalBest.owned.length} node(s) [${goalBest.owned.join(', ')}]`,
  );
}

console.log('\n=== Greedy player simulation ===');
const launches = greedyLaunchesToGoal();
console.log(`  launches to reach the tier 1 goal (${goalAltitude} m): ${launches}`);

// =============================================================================
// TIER 2 — orbit (ARCHITECTURE.md, "Balance, phase 1"). Only runs against a
// resolver whose Outcome actually carries `periapsis` — the tell for a phase
// 1 resolver (js/core/resolver.js's rewrite, concurrent with this file) vs
// the still-phase-0 one this script was first written against, which
// neither returns that field nor understands a downrange/orbit requirement
// shape. Probed once, cheaply, with the starter vehicle.
// =============================================================================

const PHASE1_RESOLVER = (() => {
  try {
    const outcome = resolveLaunch(
      forceReliability(buildVehicle(baseVehicle, [])),
      { requirement: { orbit: { periapsis: 1e9 } } },
      { fuelFraction: 1, turn: 0 },
      makeRng(SEED),
      {},
    );
    return 'periapsis' in outcome;
  } catch {
    return false;
  }
})();

if (!PHASE1_RESOLVER) {
  console.log('\ntier 2 balance needs the phase 1 resolver');
  process.exit(0);
}

// Tier 1 + tier 2 together, and ONLY those: js/data/tree.js now carries
// tier 3 too, and a "full tree" that swept tier 3's nodes in reported a
// turn window (0.00-0.50, peaking at the boundary) that no tier 2 player can
// fly. The maxed tier 2 vehicle is what the tier 2 goal is balanced against.
const tier12Nodes = nodes.filter((n) => (n.tier ?? 1) <= 2);
const fullTree = loadTree(tier12Nodes);
const fullIds = tier12Nodes.map((n) => n.id);
const NO_CEILING_ORBIT = { requirement: { orbit: { periapsis: 1e9 } } };
// 0, 0.05, ..., 1 — ARCHITECTURE.md: "searched over turn in steps of 0.05".
const TURN_STEPS = Array.from({ length: 21 }, (_, i) => i * 0.05);

// One full turn scan reads off maxAltitude, maxDownrange AND periapsis at
// once (an orbit requirement that's never actually met just lets the flight
// run to impact/maxTime rather than ending early at some other shape's
// goal), so mission reachability across all three requirement shapes only
// costs one scan per candidate vehicle, not one scan per mission.
function bestMetricsOverTurns(vehicle, fuelFraction = 1) {
  let maxAltitude = 0;
  let maxDownrange = 0;
  let bestPeriapsis = null;
  for (const turn of TURN_STEPS) {
    const rng = makeRng(SEED);
    const outcome = resolveLaunch(forceReliability(vehicle), NO_CEILING_ORBIT, { fuelFraction, turn }, rng, {});
    if (outcome.maxAltitude > maxAltitude) maxAltitude = outcome.maxAltitude;
    if ((outcome.maxDownrange ?? 0) > maxDownrange) maxDownrange = outcome.maxDownrange ?? 0;
    if (typeof outcome.periapsis === 'number' && (bestPeriapsis === null || outcome.periapsis > bestPeriapsis)) {
      bestPeriapsis = outcome.periapsis;
    }
  }
  return { maxAltitude, maxDownrange, bestPeriapsis };
}

function metricFor(requirement, metrics) {
  if (requirement.altitude !== undefined) return metrics.maxAltitude;
  if (requirement.downrange !== undefined) return metrics.maxDownrange;
  if (requirement.orbit !== undefined) return metrics.bestPeriapsis ?? -Infinity;
  return -Infinity;
}

function requiredValue(requirement) {
  if (requirement.altitude !== undefined) return requirement.altitude;
  if (requirement.downrange !== undefined) return requirement.downrange;
  if (requirement.orbit !== undefined) return requirement.orbit.periapsis;
  return Infinity;
}

// ---- Periapsis-vs-turn table (ARCHITECTURE.md "Balance, phase 1": "the
// cheapest prereq-valid set ... searched over turn in steps of 0.05"). One
// row per TURN_STEP, periapsis at fuelFraction 1. Used both to print the
// full table and to derive the "how wide is the good-turn window" stats the
// task's goal 1 asks for: the `turn` slider is only a real decision if the
// window that reaches orbit (periapsis >= ORBIT_MIN_ALT) is neither the
// whole slider nor a single notch.
function periapsisTable(vehicle, fuelFraction = 1) {
  return TURN_STEPS.map((turn) => {
    const rng = makeRng(SEED);
    const outcome = resolveLaunch(forceReliability(vehicle), NO_CEILING_ORBIT, { fuelFraction, turn }, rng, {});
    return { turn, periapsis: outcome.periapsis };
  });
}

function printPeriapsisTable(label, rows) {
  console.log(`  ${label}`);
  for (const { turn, periapsis } of rows) {
    const val = periapsis === null ? 'null' : `${Math.round(periapsis)} m`;
    console.log(`    turn=${turn.toFixed(2)}  periapsis=${val}`);
  }
}

// windowStats: how many of the 21 notches clear `threshold`, the first/last
// such notch (the window ARCHITECTURE.md's balance section wants "neither
// the whole slider nor a single notch"), and where periapsis peaks. A peak
// at turn=0 (the lazy end) is the "vehicle is thrust-poor" tell called out
// in the task brief -- lazy beats every gravity-turn attempt, so `turn`
// isn't a real choice.
function windowStats(rows, threshold = ORBIT_MIN_ALT) {
  const hits = rows.filter((r) => typeof r.periapsis === 'number' && r.periapsis >= threshold);
  const peak = rows.reduce(
    (best, r) => (typeof r.periapsis === 'number' && (!best || r.periapsis > best.periapsis) ? r : best),
    null,
  );
  return {
    count: hits.length,
    firstTurn: hits.length ? hits[0].turn : null,
    lastTurn: hits.length ? hits[hits.length - 1].turn : null,
    peakTurn: peak ? peak.turn : null,
    peakPeriapsis: peak ? peak.periapsis : null,
  };
}

// cheapestReachingHeuristic: NOT exhaustive. A true "cheapest prereq-valid
// set over tier 1 and tier 2" brute force is 2^(tier1Nodes.length +
// tier2Nodes.length) — with tier 2 alone at a dozen-plus nodes, stacked on
// tier 1's dozen, that is nowhere near tractable the way tier 1's own 2^12
// enumeration above is. Instead: starting from an empty owned set (unlimited
// funds, so `canBuy` only enforces prereqs/tier), repeatedly buy whichever
// affordable node improves the requirement's metric (bestMetricsOverTurns)
// the most per funds spent, until the requirement is met or nothing helps
// anymore. This is a greedy hill-climb, not a proof of optimality — it is
// the same style of approximation as the greedy-player simulations below,
// just used here to describe a "set" rather than a launch sequence.
function cheapestReachingHeuristic(requirement) {
  const target = requiredValue(requirement);
  let owned = [];
  let state = { owned, funds: Number.MAX_SAFE_INTEGER, resources: {}, tier: 2 };

  // A downrange or orbit requirement needs `vehicle.guidance >= 1` before
  // `turn` does anything at all (resolver.js), and a weak, otherwise-stock
  // vehicle sees NO improvement from guidance alone (bestMetricsOverTurns's
  // turn=0 sample is identical with or without it, and every nonzero turn
  // just crashes a still-weak vehicle sooner) -- so the metric-driven hill
  // climb below never finds a reason to buy it on its own, and stalls
  // "UNREACHABLE" even though the full tree (which owns it as a matter of
  // course) clearly reaches these missions. Buy it unconditionally first,
  // the way a player pursuing an orbit mission obviously would.
  if (requirement.downrange !== undefined || requirement.orbit !== undefined) {
    if (canBuy(fullTree, state, 'guide-1')) state = buy(fullTree, state, 'guide-1');
  }

  let metric = metricFor(requirement, bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1));

  while (metric < target) {
    let pick = null;
    let pickMetric = metric;
    for (const node of fullTree.nodes) {
      if (!canBuy(fullTree, state, node.id)) continue;
      const candidate = { ...state, owned: [...state.owned, node.id] };
      const candidateMetric = metricFor(
        requirement,
        bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, candidate)), 1),
      );
      if (candidateMetric > pickMetric) {
        // Prefer the node with the best metric-per-funds ratio among
        // improving candidates, tie-broken by raw metric.
        const gain = candidateMetric - metric;
        const costSoFar = Math.max(fundsCost(node), 1);
        const pickGain = pick ? pickMetric - metric : -Infinity;
        const pickCost = pick ? Math.max(fundsCost(pick), 1) : 1;
        if (!pick || gain / costSoFar > pickGain / pickCost) {
          pick = node;
          pickMetric = candidateMetric;
        }
      }
    }
    if (!pick) {
      // No single node shows an immediate improvement -- a real plateau
      // this hill climb can hit early (e.g. guidance is worthless until
      // enough delta-v/TWR exists for a turn to survive at all, so no ONE
      // node crossing that threshold looks individually worthwhile). Escape
      // it by buying the cheapest still-buyable node outright (any node,
      // prereqs/tier permitting) and re-evaluating, rather than reporting
      // UNREACHABLE the moment the metric stops moving node-by-node. Only
      // actually give up once nothing at all is left to buy.
      let cheapest = null;
      for (const node of fullTree.nodes) {
        if (!canBuy(fullTree, state, node.id)) continue;
        if (!cheapest || fundsCost(node) < fundsCost(cheapest)) cheapest = node;
      }
      if (!cheapest) break; // the whole tree is owned and the target still isn't met
      state = buy(fullTree, state, cheapest.id);
      metric = metricFor(
        requirement,
        bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1),
      );
      continue;
    }
    state = buy(fullTree, state, pick.id);
    metric = pickMetric;
  }

  const cost = state.owned.reduce((sum, id) => sum + fundsCost(fullTree.byId.get(id)), 0);
  return { owned: state.owned, cost, metric, reached: metric >= target };
}

console.log('\n=== TIER 2 ===');
console.log('(heuristic hill-climb, not exhaustive -- see cheapestReachingHeuristic doc comment)');

const tier2Missions = missions.filter((m) => m.tier === 2);
console.log('\n=== Tier 2 missions: heuristic cheapest-ish prereq-valid reaching set ===');
for (const m of tier2Missions) {
  const best = cheapestReachingHeuristic(m.requirement);
  if (!best.reached) {
    console.log(`  ${m.id}: UNREACHABLE (heuristic search stalled at ${best.metric})`);
    continue;
  }
  console.log(
    `  ${m.id} (${JSON.stringify(m.requirement)}): ${best.cost} funds, ${best.owned.length} node(s) ` +
    `[${best.owned.join(', ')}], reaches ${best.metric.toFixed(0)}`,
  );
}

console.log('\n=== Tier 2 goal: heuristic cheapest-ish prereq-valid reaching set ===');
const tier2GoalBest = cheapestReachingHeuristic(tierGoals[2].requirement);
if (!tier2GoalBest.reached) {
  console.log(`  UNREACHABLE (heuristic search stalled at periapsis ${tier2GoalBest.metric})`);
} else {
  console.log(
    `  periapsis ${tierGoals[2].requirement.orbit.periapsis} m -> ${tier2GoalBest.cost} funds, ` +
    `${tier2GoalBest.owned.length} node(s) [${tier2GoalBest.owned.join(', ')}]`,
  );
}
console.log(
  '  NOTE: the independent per-mission heuristic above can pick up reliability-branch\n' +
  '  filler (rel-N) via its "no single node improves the metric -> buy the cheapest\n' +
  '  buyable node" escape hatch. Reliability never touches trajectory (it is forced to\n' +
  "  1 throughout this tool), so those picks are an artifact, not a real requirement --\n" +
  '  the CUMULATIVE ladder below is hand-verified against this and does not have it.',
);

// ---------------------------------------------------------------------------
// CUMULATIVE mission ladder (goal 2): unlike the independent per-mission
// heuristic above (which restarts from an empty owned set for every mission
// and can therefore report a smaller set for a LATER, harder mission than an
// earlier, easier one), this walks the tier 2 missions in file order and
// finds the cheapest ADDITIONAL nodes on top of the PREVIOUS rung's owned
// set -- what a player who never sells a node actually experiences. Starts
// from the tier 1 cheapest-goal set (js/data/tree.js's own documented
// answer) plus tier 2's guide-1 special case (same reasoning as
// cheapestReachingHeuristic above: a stock vehicle sees literally zero
// difference between turn=0 and turn=1 without guidance, so no single node
// ever looks individually worthwhile until guidance is owned).
//
// The search pool deliberately EXCLUDES the reliability branch: reliability
// is forced to 1 everywhere in this tool, so no reliability node can ever
// change any of these metrics, and including it invites exactly the filler
// artifact noted above. This also removes the "no improving node -> buy
// cheapest" fallback entirely (unnecessary once reliability is out of the
// pool and the chain always starts from a state the previous rung already
// proved workable).
const trajectoryPool = fullTree.nodes.filter((n) => n.branch !== 'reliability');

function chainedCheapestReaching(startOwned, requirement) {
  let state = { owned: [...startOwned], funds: Number.MAX_SAFE_INTEGER, resources: {}, tier: 2 };
  if (requirement.downrange !== undefined || requirement.orbit !== undefined) {
    if (!state.owned.includes('guide-1') && canBuy(fullTree, state, 'guide-1')) {
      state = buy(fullTree, state, 'guide-1');
    }
  }
  const target = requiredValue(requirement);
  let metric = metricFor(requirement, bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1));

  while (metric < target) {
    let pick = null;
    let pickMetric = metric;
    let pickRatio = -Infinity;
    for (const node of trajectoryPool) {
      if (!canBuy(fullTree, state, node.id)) continue;
      const candidate = { ...state, owned: [...state.owned, node.id] };
      const candidateMetric = metricFor(
        requirement,
        bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, candidate)), 1),
      );
      if (candidateMetric > metric) {
        const ratio = (candidateMetric - metric) / Math.max(fundsCost(node), 1);
        if (ratio > pickRatio) {
          pick = node;
          pickMetric = candidateMetric;
          pickRatio = ratio;
        }
      }
    }
    if (!pick) break; // genuinely stuck: nothing in the pool moves the metric
    state = buy(fullTree, state, pick.id);
    metric = pickMetric;
  }

  const cost = state.owned.reduce((sum, id) => sum + fundsCost(fullTree.byId.get(id)), 0);
  return { owned: state.owned, cost, metric, reached: metric >= target };
}

console.log('\n=== Tier 2 mission ladder: CUMULATIVE cheapest reaching sets (goal 2) ===');
console.log('  (each rung buys on top of the previous rung\'s owned set; delta = new nodes bought)');
// orbit-entry is the dry-streak filler (js/data/missions.js) -- it needs no
// node beyond the tier 1 baseline to reach by design, so it is not a ladder
// rung and is excluded from the delta-tracking chain below.
const tier2LadderMissions = tier2Missions.filter((m) => !m.filler);
const tier1GoalOwned = goalBest ? goalBest.owned : [];
let ladderOwned = [...tier1GoalOwned];
let ladderPrevCount = ladderOwned.length;
console.log(`  tier 1 baseline: ${ladderOwned.length} node(s) [${ladderOwned.join(', ')}]`);
const ladderRungs = [];
for (const m of tier2LadderMissions) {
  const result = chainedCheapestReaching(ladderOwned, m.requirement);
  const delta = result.owned.length - ladderPrevCount;
  ladderRungs.push({ mission: m, ...result, delta });
  console.log(
    `  ${m.id} (${JSON.stringify(m.requirement)}): ${result.cost} funds, ${result.owned.length} node(s), ` +
    `delta +${delta}, reaches ${result.metric.toFixed(0)}${result.reached ? '' : ' -- UNREACHABLE'}`,
  );
  console.log(`    owned: [${result.owned.join(', ')}]`);
  ladderOwned = result.owned;
  ladderPrevCount = ladderOwned.length;
}
const ladderDeltasOk = ladderRungs.every((r) => r.delta >= 1 && r.delta <= 3);
console.log(`  every rung's delta is 1-3 new nodes: ${ladderDeltasOk ? 'yes' : 'NO -- see deltas above'}`);

console.log('\n=== Full tree (tier 1 + tier 2): best simulated orbit ===');
const fullTreeVehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: fullIds }));
const fullTreeMetrics = bestMetricsOverTurns(fullTreeVehicle, 1);
const fullTreeCost = fullIds.reduce((s, id) => s + fundsCost(fullTree.byId.get(id)), 0);
console.log(`  best periapsis: ${(fullTreeMetrics.bestPeriapsis ?? NaN).toFixed(0)} m`);
console.log(`  max downrange seen in that scan: ${fullTreeMetrics.maxDownrange.toFixed(0)} m`);
console.log(`  max altitude seen in that scan: ${fullTreeMetrics.maxAltitude.toFixed(0)} m`);
console.log(`  total tree cost (tier 1 + tier 2): ${fullTreeCost} funds`);

// ---------------------------------------------------------------------------
// GOAL 1: is `turn` a real decision? Full periapsis-vs-turn tables (steps of
// 0.05, ARCHITECTURE.md's Balance section) for (a) the cheapest set that
// reaches the tier goal (the last ladder rung above) and (b) the full tree.
// windowStats reports how many of the 21 notches clear ORBIT_MIN_ALT and
// where periapsis peaks -- the whole slider, a single notch, or a peak
// pinned to turn=0 (lazy) are each a sign `turn` isn't a real choice.
const cheapestGoalOwned = ladderRungs[ladderRungs.length - 1].owned;
const cheapestGoalVehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: cheapestGoalOwned }));
const cheapestGoalTable = periapsisTable(cheapestGoalVehicle, 1);
const fullTreeTable = periapsisTable(fullTreeVehicle, 1);
const cheapestWindow = windowStats(cheapestGoalTable);
const fullWindow = windowStats(fullTreeTable);

console.log('\n=== GOAL 1: periapsis vs turn (steps of 0.05) ===');
printPeriapsisTable(`Cheapest orbit-goal-reaching set (${cheapestGoalOwned.length} nodes)`, cheapestGoalTable);
console.log(
  `    window (periapsis >= ${ORBIT_MIN_ALT} m): ${cheapestWindow.count}/21 notches` +
  `${cheapestWindow.count ? `, turn ${cheapestWindow.firstTurn.toFixed(2)}-${cheapestWindow.lastTurn.toFixed(2)}` : ''}` +
  `, peak at turn=${cheapestWindow.peakTurn?.toFixed(2)} (${Math.round(cheapestWindow.peakPeriapsis)} m)`,
);
printPeriapsisTable('Full tree (all nodes)', fullTreeTable);
console.log(
  `    window (periapsis >= ${ORBIT_MIN_ALT} m): ${fullWindow.count}/21 notches` +
  `${fullWindow.count ? `, turn ${fullWindow.firstTurn.toFixed(2)}-${fullWindow.lastTurn.toFixed(2)}` : ''}` +
  `, peak at turn=${fullWindow.peakTurn?.toFixed(2)} (${Math.round(fullWindow.peakPeriapsis)} m)`,
);
console.log(
  '  target: cheapest set window 2-4 notches, full tree window ~1/3 of 21 (~7); ' +
  'peak turn should not sit at either boundary (0 or 1).',
);

// ---------------------------------------------------------------------------
// GOAL 4: TWR safety rail across tier 1 + tier 2 together. Exhaustive 2^25 is
// intractable, but the tree's prerequisites chain hard (see js/data/tree.js's
// BALANCING NOTES), so the set of prereq-valid owned combinations is small in
// practice. BFS from the empty set, one purchase at a time, deduplicated by
// canonical (sorted) owned-set key -- exactly ARCHITECTURE.md's suggested
// approach, and what test/data.test.js's bounded version also runs.
function enumerateReachableSets(tree, ids) {
  const seen = new Set(['']);
  let frontier = [[]];
  const results = [[]];
  while (frontier.length) {
    const next = [];
    for (const owned of frontier) {
      const ownedSet = new Set(owned);
      for (const id of ids) {
        if (ownedSet.has(id)) continue;
        const reqs = tree.byId.get(id).requires ?? [];
        if (!reqs.every((r) => ownedSet.has(r))) continue;
        const newOwned = [...owned, id].sort();
        const key = newOwned.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(newOwned);
        results.push(newOwned);
      }
    }
    frontier = next;
  }
  return results;
}

function stageTWRs(vehicle, fuelFraction = 1) {
  return vehicle.stages.map((stage, i) => {
    const above = stackMassAbove(vehicle, i, fuelFraction);
    const mass = above + stage.dryMass + stage.propMass * fuelFraction;
    return stage.thrust / (mass * G0);
  });
}

console.log('\n=== GOAL 4: TWR safety rail, tier 1 + tier 2 combined ===');
const reachableSets = enumerateReachableSets(fullTree, fullIds);
console.log(`  ${reachableSets.length} prereq-valid owned combinations enumerated (BFS, deduplicated)`);
let minLiftoffTWR = Infinity;
let minLiftoffOwned = null;
let minUpperTWR = Infinity;
let minUpperOwned = null;
let minUpperStage = null;
let liftoffViolations = 0;
let upperViolations = 0;
for (const owned of reachableSets) {
  const v = buildVehicle(baseVehicle, collectEffects(fullTree, { owned }));
  const twrs = stageTWRs(v, 1);
  if (twrs[0] < minLiftoffTWR) { minLiftoffTWR = twrs[0]; minLiftoffOwned = owned; }
  if (twrs[0] < 1.05) liftoffViolations += 1;
  for (let i = 1; i < twrs.length; i += 1) {
    if (twrs[i] < minUpperTWR) { minUpperTWR = twrs[i]; minUpperOwned = owned; minUpperStage = i; }
    if (twrs[i] < 0.5) upperViolations += 1;
  }
}
console.log(`  min liftoff TWR: ${minLiftoffTWR.toFixed(3)} (owned=[${minLiftoffOwned.join(',') || '(none)'}])`);
console.log(`  liftoff TWR < 1.05 violations: ${liftoffViolations}`);
console.log(
  `  min upper-stage TWR at ignition: ${minUpperTWR.toFixed(3)} (stage idx ${minUpperStage}, ` +
  `owned=[${minUpperOwned ? minUpperOwned.join(',') : '(none)'}])`,
);
console.log(`  upper-stage TWR < 0.5 violations: ${upperViolations}`);
console.log(`  result: ${liftoffViolations === 0 && upperViolations === 0 ? 'PASS -- no soft-lock found' : 'FAIL -- see violations above'}`);

// ---------------------------------------------------------------------------
// GOAL 3: economy. Greedy player, tier 2: continues from a greedy TIER 1 end
// state (the same greedyLaunchesToGoal-style algorithm, re-run here so this
// section has its own state to hand off) through to the tier 2 goal.
// Node-buying decisions use a single representative turn (0.3) rather than a
// full scan -- see test/data.test.js's matching tier 2 greedy test for the
// same tradeoff and why it's necessary for a tree this size to run in
// reasonable time.
//
// REPUTATION, fixed: earlier drafts of this simulation started reputation at
// 100 (already past every tier 2 gate) and never applied a mission's
// repGain/repLoss, so the minReputation gates were never actually exercised
// -- a state bug, not a data problem. This version starts reputation at 0
// (a fresh save) and credits it via the same clamp-to-[0,100] `credit` the
// real game uses (js/core/economy.js) after every launch. Every launch this
// greedy player takes is one it already knows it can complete (mission
// selection only considers reachable requirements), so success -> repGain is
// the only path exercised here; repLoss never fires, matching a player who
// never attempts a contract until the vehicle can already reach it. That is
// the right side to be conservative on for a "reputation gate is reachable"
// check: if a strictly-improving reputation path clears every gate before
// the corresponding vehicle is affordable, a realistic (occasionally
// failing) player clears it too, since failure only ever costs reputation
// that this player never spends.
function greedyTier2LaunchesToGoal() {
  const DECISION_TURN = 0.3;
  const floorMission = missions.find((m) => m.floor);
  const goalPeriapsis = tierGoals[2].requirement.orbit.periapsis;
  const tier1Goal = tierGoals[1].requirement.altitude;
  const MAX_LAUNCHES = 200;

  function metricAtDecisionTurn(vehicle) {
    const rng = makeRng(SEED);
    const outcome = resolveLaunch(forceReliability(vehicle), NO_CEILING_ORBIT, { fuelFraction: 1, turn: DECISION_TURN }, rng, {});
    return outcome.periapsis ?? -Infinity;
  }

  let state = { owned: [], funds: 0, resources: {}, reputation: 0, tier: 1 };
  let launches = 0;
  const reputationCurve = [];

  // Tier 1 leg.
  let altitude = maxAltitudeOf(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1);
  while (altitude < tier1Goal && launches < MAX_LAUNCHES) {
    let best = floorMission;
    for (const m of tier1Missions) {
      if (m.requirement.altitude <= altitude
        && (m.minReputation === undefined || state.reputation >= m.minReputation)
        && m.payout > best.payout) best = m;
    }
    state = credit(state, { funds: best.payout, reputation: best.repGain });
    launches += 1;
    for (;;) {
      let pick = null;
      for (const node of fullTree.nodes) {
        if (!canBuy(fullTree, state, node.id)) continue;
        const candidate = { ...state, owned: [...state.owned, node.id] };
        const a = maxAltitudeOf(buildVehicle(baseVehicle, collectEffects(fullTree, candidate)), 1);
        if (a > altitude + 1e-6) {
          if (!pick || fundsCost(node) < fundsCost(pick.node)) pick = { node, a };
        }
      }
      if (!pick) break;
      state = buy(fullTree, state, pick.node.id);
      altitude = pick.a;
    }
  }
  const tier1Launches = launches;
  const tier1Reputation = state.reputation;

  // Tier 2 leg.
  state = { ...state, tier: 2 };
  let metrics = bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1);
  while ((metrics.bestPeriapsis ?? -Infinity) < goalPeriapsis && launches < MAX_LAUNCHES) {
    let best = floorMission;
    for (const m of missions) {
      if (m.tier > state.tier) continue;
      if (m.minReputation !== undefined && state.reputation < m.minReputation) continue;
      if (metricFor(m.requirement, metrics) >= requiredValue(m.requirement) && m.payout > best.payout) best = m;
    }
    state = credit(state, { funds: best.payout, reputation: best.repGain });
    launches += 1;
    reputationCurve.push({
      tier2Launch: launches - tier1Launches, mission: best.id, reputation: state.reputation, funds: state.funds,
      ownedBefore: state.owned.length,
    });

    for (;;) {
      let pick = null;
      const baseMetric = metricAtDecisionTurn(buildVehicle(baseVehicle, collectEffects(fullTree, state)));
      for (const node of fullTree.nodes) {
        if (!canBuy(fullTree, state, node.id)) continue;
        const candidate = { ...state, owned: [...state.owned, node.id] };
        const m = metricAtDecisionTurn(buildVehicle(baseVehicle, collectEffects(fullTree, candidate)));
        if (m > baseMetric + 1) {
          if (!pick || fundsCost(node) < fundsCost(pick)) pick = node;
        }
      }
      if (!pick) break;
      state = buy(fullTree, state, pick.id);
    }
    metrics = bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1);
  }

  const reached = (metrics.bestPeriapsis ?? -Infinity) >= goalPeriapsis;
  return {
    reached,
    tier1Launches,
    tier1Reputation,
    tier2Launches: launches - tier1Launches,
    finalReputation: state.reputation,
    reputationCurve,
  };
}

console.log('\n=== Greedy player simulation, tier 2 (GOAL 3: economy) ===');
const tier2Greedy = greedyTier2LaunchesToGoal();
if (!tier2Greedy.reached) {
  console.log(`  did not reach the tier 2 goal (stopped after ${tier2Greedy.tier2Launches} tier 2 launches)`);
} else {
  console.log(`  tier 1 launches: ${tier2Greedy.tier1Launches} (reputation at tier 2 start: ${tier2Greedy.tier1Reputation})`);
  console.log(`  tier 2 launches: ${tier2Greedy.tier2Launches} (target: 15-60, dry streak <= 4, per ARCHITECTURE.md)`);
  console.log(`  final reputation: ${tier2Greedy.finalReputation}`);

  // Dry streak: consecutive launches with no purchase and no new rung. The
  // owner's grind complaint is exactly this number; keep it at 4 or under.
  {
    let streak = 0; let worst = 0; let prevMission = null;
    const rows = tier2Greedy.reputationCurve;
    for (let i = 0; i < rows.length; i += 1) {
      const bought = i + 1 < rows.length ? rows[i + 1].ownedBefore > rows[i].ownedBefore : false;
      const newRung = rows[i].mission !== prevMission;
      prevMission = rows[i].mission;
      streak = (bought || newRung) ? 0 : streak + 1;
      if (streak > worst) worst = streak;
    }
    console.log(`  longest dry streak (no purchase, no new rung): ${worst} launches (keep <= 4)`);
  }
  console.log('\n  reputation curve (tier 2 leg, one row per launch):');
  for (const r of tier2Greedy.reputationCurve) {
    console.log(`    launch ${r.tier2Launch}: ${r.mission} -> reputation ${r.reputation}, funds ${r.funds}`);
  }

  console.log('\n  reputation-gate reachability (must cross before the rung is bought):');
  for (const m of tier2Missions) {
    if (m.minReputation === undefined) continue;
    const firstCross = tier2Greedy.reputationCurve.find((r) => r.reputation >= m.minReputation);
    console.log(`    ${m.id}: minReputation ${m.minReputation} -> first crossed at tier 2 launch ${firstCross ? firstCross.tier2Launch : 'NEVER'}`);
  }
}

// =============================================================================
// TIER 4 — the Moon (ARCHITECTURE.md, "Balance, phase 3"). Only runs against a
// resolver whose Outcome actually carries a `lunar` field for a `moon`
// requirement — the tell for a phase 3 resolver, probed once and cheaply, the
// same guard shape the tier 2 section above uses for `periapsis`.
//
// Four reports, in ARCHITECTURE.md's own order:
//   - the cheapest prereq-valid set reaching each lunar rung (cumulative, the
//     way the tier 2 ladder is walked: each rung buys on top of the last)
//   - the remaining-stack delta-v budget at insertion for each of those sets,
//     against the ladder js/core/moon.js prices from the orbit it actually
//     reached — the "must cover the profile's ladder with margin" check
//   - the TWR safety rail, extended to every prereq-valid combination across
//     all four tiers
//   - a greedy player from the tier 3 end state through the tier 4 goal
//     (target: 15-60 tier 4 launches, longest dry streak 4 or under)
// =============================================================================

const { lunarLadder, LUNAR_STEPS } = await import(core('moon.js'));
const { LUNAR_PROFILES, requiredLunarStep } = await import(core('resolver.js'));

const R_EARTH_BAL = 6.371e6;

const PHASE3_RESOLVER = (() => {
  try {
    const outcome = resolveLaunch(
      forceReliability(buildVehicle(baseVehicle, [])),
      { requirement: { moon: { profile: 'flyby' } } },
      { fuelFraction: 1, turn: 0 },
      makeRng(SEED),
      {},
    );
    return 'lunar' in outcome;
  } catch {
    return false;
  }
})();

if (!PHASE3_RESOLVER) {
  console.log('\ntier 4 balance needs the phase 3 resolver');
  process.exit(0);
}

// Every node, all four tiers: unlike the tier 2 section (which deliberately
// sweeps tier 1 + 2 only, because a tier 2 goal has to be flyable by a tier 2
// vehicle), a lunar flight is the top of the tree and there is nothing above it
// to exclude.
const lunarTree = loadTree(nodes);
const lunarIds = nodes.map((n) => n.id);
const tier4Missions = missions.filter((m) => m.tier === 4);
const lunarMissions = tier4Missions.filter((m) => m.requirement.moon !== undefined);

function lunarVehicle(owned) {
  return buildVehicle(baseVehicle, collectEffects(lunarTree, { owned }));
}

/**
 * Best outcome of a lunar mission over the turn slider, ranked the way a player
 * reading the result screen would: a flight that flew the profile beats one
 * that did not, then deeper is better, then a smaller shortfall.
 *
 * `turn` is the only loadout control a lunar mission has (there is no window
 * slider without a phasing target, and the profile is the mission), so this
 * sweep IS the player's whole decision space at full tanks.
 */
function bestLunar(vehicle, mission, steps = TURN_STEPS) {
  let best = null;
  for (const turn of steps) {
    const outcome = resolveLaunch(
      forceReliability(vehicle), mission, { fuelFraction: 1, turn }, makeRng(SEED), {},
    );
    const l = outcome.lunar;
    const score = (outcome.success ? 1e12 : 0)
      + (l ? l.reached * 1e6 - Math.min(l.shortBy ?? 0, 1e5) : -1e9);
    if (!best || score > best.score) best = { score, turn, outcome };
  }
  return best;
}

// ---------------------------------------------------------------------------
// The cheapest prereq-valid set reaching each lunar rung. EXHAUSTIVE, unlike
// the tier 2 ladder above, and it has to be: the tier 2 chain buys one node at
// a time and works because every node on its path individually raises
// periapsis, while tier 4's path has plateaus a greedy walk cannot cross.
// struct-12 (the departure stage) bought alone is 22 kg of dead weight with
// nothing to land and nothing to come home in, so it LOWERS every metric; and
// `moon-return` needs the shield, the fifth relight and the descent reserve
// together, none of which improves the outcome without the other two. A
// one-node-at-a-time search reports the goal as unreachable by the whole tree,
// which is simply wrong.
//
// It is affordable because the tier is chain-heavy: the fourteen tier 4 nodes
// admit only 220 prereq-valid subsets on top of a tier 3 winner's owned set.
// And ONE sweep answers all four rungs. A `return` flight walks the whole
// ladder in order and stops at the first step it cannot fly, so the deepest
// step it completes -- `lunar.reached`, an index into LUNAR_STEPS -- is exactly
// how far up any profile this vehicle could get; a profile is flyable when its
// `requiredLunarStep` is at or below it. That holds for the hardware gates too
// (no lander stops the return flight in front of the descent, which is
// precisely where an `orbit` profile has already finished).
const RETURN_MISSION = missions.find((m) => m.id === 'moon-return');
const tier4Nodes = nodes.filter((n) => (n.tier ?? 1) === 4).map((n) => n.id);

// The tier 3 end state a tier 4 player actually arrives with: winning tier 3
// means docking, and `dock`'s gate closure is what docking proves they own.
// Everything tier 4 costs is measured on top of that, not from zero.
function closureOf(ids) {
  const seen = new Set();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of lunarTree.byId.get(id).requires ?? []) stack.push(r);
  }
  return [...seen];
}
const dockMissionBal = missions.find((m) => m.id === 'dock');
const tier3EndOwned = closureOf([].concat(dockMissionBal.requiresNode));
const tier3EndCost = tier3EndOwned.reduce((sum, id) => sum + fundsCost(lunarTree.byId.get(id)), 0);

// Topological order over the tier 4 nodes, so the enumeration below can prune
// on "prerequisites already chosen" -- `nodes` is authored branch by branch and
// prop-14 precedes the struct-12 it requires.
const tier4Ordered = (() => {
  const out = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const r of lunarTree.byId.get(id).requires ?? []) visit(r);
    if (tier4Nodes.includes(id)) out.push(id);
  };
  for (const id of tier4Nodes) visit(id);
  return out;
})();

const tier4Sets = [];
(function grow(i, owned) {
  if (i === tier4Ordered.length) { tier4Sets.push([...owned]); return; }
  grow(i + 1, owned);
  const id = tier4Ordered[i];
  const reqs = lunarTree.byId.get(id).requires ?? [];
  if (reqs.every((r) => tier3EndOwned.includes(r) || owned.includes(r))) {
    grow(i + 1, [...owned, id]);
  }
}(0, []));

function deepestStep(owned) {
  const vehicle = lunarVehicle(owned);
  let best = -1;
  let bestTurn = null;
  for (const turn of TURN_STEPS) {
    const outcome = resolveLaunch(
      forceReliability(vehicle), RETURN_MISSION, { fuelFraction: 1, turn }, makeRng(SEED), {},
    );
    const reached = outcome.lunar ? outcome.lunar.reached : -1;
    if (reached > best) { best = reached; bestTurn = turn; }
  }
  return { reached: best, turn: bestTurn };
}

console.log('\n=== Tier 4 mission ladder: cheapest prereq-valid set reaching each rung ===');
console.log(`  tier 3 baseline (dock's gate closure): ${tier3EndOwned.length} node(s), ${tier3EndCost} funds`);
console.log(`  ${tier4Sets.length} prereq-valid tier 4 additions enumerated`);
const tier4Probed = tier4Sets.map((added) => ({
  added,
  cost: added.reduce((sum, id) => sum + fundsCost(lunarTree.byId.get(id)), 0),
  ...deepestStep([...tier3EndOwned, ...added]),
}));
const lunarRungs = [];
let prevAdded = [];
for (const m of lunarMissions) {
  const need = requiredLunarStep(m.requirement.moon.profile);
  const reaching = tier4Probed.filter((row) => row.reached >= need);
  if (reaching.length === 0) {
    console.log(`  ${m.id} (${m.requirement.moon.profile}): UNREACHABLE by any tier 4 set`);
    lunarRungs.push({ mission: m, owned: [...tier3EndOwned], reached: false });
    continue;
  }
  const cheapest = reaching.reduce((a, r) => (r.cost < a.cost ? r : a));
  const fresh = cheapest.added.filter((id) => !prevAdded.includes(id));
  const dropped = prevAdded.filter((id) => !cheapest.added.includes(id));
  lunarRungs.push({
    mission: m, owned: [...tier3EndOwned, ...cheapest.added], added: cheapest.added,
    cost: tier3EndCost + cheapest.cost, reached: true, turn: cheapest.turn,
  });
  console.log(
    `  ${m.id.padEnd(11)} (${m.requirement.moon.profile.padEnd(6)}, needs step ${need} = ${LUNAR_STEPS[need]}): `
    + `+${cheapest.cost} funds, +${cheapest.added.length} node(s) [${cheapest.added.join(', ') || 'none'}]`
    + `${fresh.length ? `, new: ${fresh.join(', ')}` : ', new: none'}`
    + `${dropped.length ? `  <-- NOT CUMULATIVE: drops ${dropped.join(', ')}` : ''}`,
  );
  prevAdded = cheapest.added;
}
// CUMULATIVE is the property that matters and the one asserted: each rung's
// cheapest set must be a superset of the rung below it, or the ladder is not a
// ladder -- a player who bought their way to `moon-land` must not find that
// `moon-return`'s cheapest path goes somewhere else. The 1-3 new nodes per rung
// that tier 2 holds to is NOT asserted here and does not hold: `moon-return`
// costs six more nodes than `moon-land`, because coming home is a second
// vehicle (an ascent stage, a shield, the engine and reserve that fly them, and
// two more relights) rather than one more upgrade. Reported, not smoothed over
// -- the greedy simulation below is where that wall is checked for being
// crossable, and it crosses it in five launches.
const lunarCumulative = (() => {
  let prev = [];
  return lunarRungs.every((r) => {
    if (!r.reached) return false;
    const dropped = prev.filter((id) => !r.added.includes(id));
    prev = r.added;
    return dropped.length === 0;
  });
})();
console.log(`  the ladder is cumulative (no rung drops a node the rung below needs): ${lunarCumulative ? 'yes' : 'NO -- see above'}`);
console.log('  new nodes per rung: '
  + (() => { let prev = []; return lunarRungs.map((r) => { const f = (r.added ?? []).filter((id) => !prev.includes(id)).length; prev = r.added ?? []; return `${r.mission.id} +${f}`; }).join(', '); })());

// ---------------------------------------------------------------------------
// THE BUDGET AT INSERTION. ARCHITECTURE.md asks for "the remaining-stack
// delta-v budget at insertion for the cheapest set (must cover the profile's
// ladder with margin)". Two numbers per rung, both read off the same flight:
// what the vehicle arrived with (`lunar.dvAvailable` — the cutting stage's
// reserve plus every unfired stage above it) and what js/core/moon.js charges
// for the profile FROM THE ORBIT IT ACTUALLY REACHED, which is the number that
// matters and is not the one ARCHITECTURE.md quotes. The quoted 8 536 m/s is
// the ladder from a 180 km CIRCULAR parking orbit; a real ascent cuts off the
// instant periapsis crosses ORBIT_MIN_ALT and arrives on an ellipse, and the
// departure burn is charged at periapsis, so the flown price is lower — and
// the more eccentric the parking orbit, the lower it goes.
console.log('\n=== Tier 4: remaining-stack delta-v at insertion vs the profile\'s ladder ===');
console.log(`  reference: lunarLadder from a 180 km CIRCULAR parking orbit `
  + `= ${Math.round(LUNAR_STEPS.reduce((s, k) => s + lunarLadder(R_EARTH_BAL + 180000, R_EARTH_BAL + 180000)[k], 0))} m/s `
  + '(ARCHITECTURE.md\'s quoted number, and NOT what anything below flies)');
function budgetRow(mission, owned) {
  const vehicle = lunarVehicle(owned);
  const steps = LUNAR_PROFILES[mission.requirement.moon.profile];
  const rows = [];
  for (const turn of TURN_STEPS) {
    const outcome = resolveLaunch(
      forceReliability(vehicle), mission, { fuelFraction: 1, turn }, makeRng(SEED), {},
    );
    const l = outcome.lunar;
    const ins = outcome.insertion;
    if (!l || !ins) continue;
    const ladder = lunarLadder(R_EARTH_BAL + ins.periapsis, R_EARTH_BAL + ins.apoapsis);
    const needed = steps.reduce((sum, k) => sum + ladder[k], 0);
    rows.push({
      turn, ins, ladder, needed, budget: l.dvAvailable, margin: l.dvAvailable - needed,
      flew: outcome.success === true,
    });
  }
  return { rows, steps };
}

for (const rung of lunarRungs) {
  const { rows, steps } = budgetRow(rung.mission, rung.owned);
  const flew = rows.filter((r) => r.flew);
  if (rows.length === 0) { console.log(`  ${rung.mission.id}: never inserted`); continue; }
  // The widest margin is the notch a player settles on; the narrowest FLYING
  // notch is how close the rung comes to failing on a loadout that still works.
  const widest = flew.length ? flew.reduce((a, r) => (r.margin > a.margin ? r : a)) : null;
  const tightest = flew.length ? flew.reduce((a, r) => (r.margin < a.margin ? r : a)) : null;
  if (!widest) {
    const nearest = rows.reduce((a, r) => (r.margin > a.margin ? r : a));
    console.log(`  ${rung.mission.id.padEnd(11)} NEVER FLIES: best margin ${Math.round(nearest.margin)} m/s `
      + `(budget ${Math.round(nearest.budget)}, ladder ${Math.round(nearest.needed)})`);
    continue;
  }
  console.log(
    `  ${rung.mission.id.padEnd(11)} ${flew.length}/${TURN_STEPS.length} notches fly it`
    + `  | widest: turn ${widest.turn.toFixed(2)}, parking ${Math.round(widest.ins.periapsis / 1000)} x `
    + `${Math.round(widest.ins.apoapsis / 1000)} km, budget ${Math.round(widest.budget)} m/s, `
    + `ladder ${Math.round(widest.needed)} m/s, margin +${Math.round(widest.margin)} m/s`
    + `  | tightest flying: +${Math.round(tightest.margin)} m/s`,
  );
  console.log(`      ladder at the widest notch: ${steps.map((k) => `${k} ${Math.round(widest.ladder[k])}`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// GOAL 4, extended: the TWR safety rail across ALL FOUR tiers. Same BFS as the
// tier 1+2 sweep above (one purchase at a time, deduplicated by sorted owned
// set), now over 53 nodes — still tractable because prerequisites chain hard.
// This is the rail's real test at tier 4: struct-11 multiplies booster
// propellant by 18 and it carries its own engines precisely so no reachable
// owned state can put that mass on the tier 3 booster's thrust.
console.log('\n=== GOAL 4 (tier 4): TWR safety rail, all four tiers ===');
const lunarReachable = enumerateReachableSets(lunarTree, lunarIds);
console.log(`  ${lunarReachable.length} prereq-valid owned combinations enumerated (BFS, deduplicated)`);
let minLiftoff4 = Infinity;
let minLiftoff4Owned = null;
let minUpper4 = Infinity;
let minUpper4Owned = null;
let minUpper4Stage = null;
let liftoff4Violations = 0;
let upper4Violations = 0;
for (const owned of lunarReachable) {
  const v = lunarVehicle(owned);
  const tw = stageTWRs(v, 1);
  if (tw[0] < minLiftoff4) { minLiftoff4 = tw[0]; minLiftoff4Owned = owned; }
  if (tw[0] < 1.05) liftoff4Violations += 1;
  for (let i = 1; i < tw.length; i += 1) {
    if (tw[i] < minUpper4) { minUpper4 = tw[i]; minUpper4Owned = owned; minUpper4Stage = i; }
    if (tw[i] < 0.5) upper4Violations += 1;
  }
}
console.log(`  min liftoff TWR: ${minLiftoff4.toFixed(3)} (owned=[${minLiftoff4Owned.join(',') || '(none)'}])`);
console.log(`  liftoff TWR < 1.05 violations: ${liftoff4Violations}`);
console.log(
  `  min upper-stage TWR at ignition: ${minUpper4.toFixed(3)} (stage idx ${minUpper4Stage}, `
  + `owned=[${minUpper4Owned ? minUpper4Owned.join(',') : '(none)'}])`,
);
console.log(`  upper-stage TWR < 0.5 violations: ${upper4Violations}`);
console.log(`  result: ${liftoff4Violations === 0 && upper4Violations === 0 ? 'PASS -- no soft-lock found' : 'FAIL -- see violations above'}`);

// ---------------------------------------------------------------------------
// GOAL 3 (phase 3): economy. A greedy player from the tier 3 END STATE through
// the tier 4 goal. The start state is the one a tier 3 winner really has: the
// dock gate's closure owned, nothing banked, and reputation 85 — the gate
// `dock` itself carries, so a player who has just docked is standing on it.
//
// Each launch: fly the best-paying tier <= 4 contract the vehicle can actually
// complete (orbit-shaped rungs judged on the periapsis scan, lunar rungs on a
// real resolveLaunch probe over the turn slider), credit funds and reputation
// through the same clamped `credit` the game uses, then spend down on the
// cheapest node that measurably improves the goal probe — deepest lunar step
// first, then smallest shortfall — falling back to the cheapest affordable node
// when nothing improves it. Reliability is forced to 1 as everywhere here, so
// this player never loses a launch to a bad roll and never pays repLoss; that
// is the conservative side for a "the gates are reachable" check.
function greedyTier4LaunchesToGoal() {
  const floorMission = missions.find((m) => m.floor);
  const goalMission = missions.find((m) => m.id === 'moon-return');
  const MAX_LAUNCHES = 300;
  const DECISION_TURNS = Array.from({ length: 11 }, (_, i) => i * 0.1);

  let state = {
    owned: [...tier3EndOwned], funds: 0, resources: {}, reputation: 85, tier: 4, objects: [],
  };
  let launches = 0;
  const curve = [];

  const goalScore = (owned) => {
    const best = bestLunar(lunarVehicle(owned), goalMission, DECISION_TURNS);
    const l = best.outcome.lunar;
    if (!l) return -1e9;
    return (best.outcome.success ? 1e12 : 0) + l.reached * 1e6 - Math.min(l.shortBy ?? 0, 1e5);
  };

  let won = false;
  while (!won && launches < MAX_LAUNCHES) {
    const vehicle = lunarVehicle(state.owned);
    const metrics = bestMetricsOverTurns(vehicle, 1);

    let best = floorMission;
    for (const m of missions) {
      if ((m.tier ?? 1) > 4) continue;
      if (m.minReputation !== undefined && state.reputation < m.minReputation) continue;
      if (m.requiresNode && ![].concat(m.requiresNode).every((id) => state.owned.includes(id))) continue;
      if (m.requiresObject && !state.objects.some((o) => o.kind === m.requiresObject)) continue;
      if (m.requirement.rendezvous !== undefined || m.requirement.dock !== undefined) continue;
      if (m.payout <= best.payout) continue;
      if (m.requirement.moon !== undefined) {
        if (bestLunar(vehicle, m, DECISION_TURNS).outcome.success) best = m;
      } else if (metricFor(m.requirement, metrics) >= requiredValue(m.requirement)) {
        best = m;
      }
    }

    const turn = best.requirement.moon !== undefined
      ? bestLunar(vehicle, best, DECISION_TURNS).turn
      : (metrics.bestTurn ?? 0.3);
    const outcome = resolveLaunch(
      forceReliability(vehicle), best, { fuelFraction: 1, turn }, makeRng(SEED + launches), {},
    );
    state = credit(state, { funds: best.payout, reputation: best.repGain });
    launches += 1;
    const ownedBefore = state.owned.length;

    for (;;) {
      let pick = null;
      const base = goalScore(state.owned);
      for (const node of lunarTree.nodes) {
        if (!canBuy(lunarTree, state, node.id)) continue;
        const s = goalScore([...state.owned, node.id]);
        if (s > base + 1 && (!pick || fundsCost(node) < fundsCost(pick))) pick = node;
      }
      if (!pick) {
        for (const node of lunarTree.nodes) {
          if (!canBuy(lunarTree, state, node.id)) continue;
          if (!pick || fundsCost(node) < fundsCost(pick)) pick = node;
        }
      }
      if (!pick) break;
      state = buy(lunarTree, state, pick.id);
    }

    curve.push({
      launch: launches, mission: best.id, success: outcome.success === true,
      reputation: state.reputation, funds: state.funds,
      bought: state.owned.length - ownedBefore, owned: state.owned.length,
    });
    if (best.id === goalMission.id && outcome.success) won = true;
  }
  return { won, launches, curve, finalOwned: state.owned };
}

console.log('\n=== Greedy player simulation, tier 4 (GOAL 3: economy) ===');
const tier4Greedy = greedyTier4LaunchesToGoal();
if (!tier4Greedy.won) {
  console.log(`  did not reach the tier 4 goal (stopped after ${tier4Greedy.launches} tier 4 launches)`);
} else {
  console.log(`  tier 4 launches: ${tier4Greedy.launches} (target: 15-60, dry streak <= 4, per ARCHITECTURE.md)`);
  console.log(`  nodes owned at the win: ${tier4Greedy.finalOwned.length} of ${lunarIds.length}`);
  {
    let streak = 0; let worst = 0; let prevMission = null;
    for (const row of tier4Greedy.curve) {
      const newRung = row.mission !== prevMission;
      prevMission = row.mission;
      streak = (row.bought > 0 || newRung) ? 0 : streak + 1;
      if (streak > worst) worst = streak;
    }
    console.log(`  longest dry streak (no purchase, no new rung): ${worst} launches (keep <= 4)`);
  }
  console.log('\n  one row per launch:');
  for (const r of tier4Greedy.curve) {
    console.log(`    launch ${String(r.launch).padStart(2)}: ${r.mission.padEnd(11)} -> reputation ${String(r.reputation).padStart(3)}, funds ${String(r.funds).padStart(7)}, bought ${r.bought} (owned ${r.owned})`);
  }
  console.log('\n  reputation-gate reachability (must cross before the rung is bought):');
  for (const m of tier4Missions) {
    if (m.minReputation === undefined) continue;
    const first = tier4Greedy.curve.find((r) => r.reputation >= m.minReputation);
    console.log(`    ${m.id}: minReputation ${m.minReputation} -> first crossed at tier 4 launch ${first ? first.launch : 'NEVER'}`);
  }
}
