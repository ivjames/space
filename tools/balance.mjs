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

const { resolveLaunch } = await import(core('resolver.js'));
const { buildVehicle } = await import(core('vehicle.js'));
const { makeRng } = await import(core('rng.js'));
const { loadTree, collectEffects, canBuy, buy } = await import(core('tree.js'));
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

const fullTree = loadTree(nodes); // tier 1 + tier 2 together
const fullIds = nodes.map((n) => n.id);
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

console.log('\n=== Full tree (tier 1 + tier 2): best simulated orbit ===');
const fullTreeVehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: fullIds }));
const fullTreeMetrics = bestMetricsOverTurns(fullTreeVehicle, 1);
const fullTreeCost = fullIds.reduce((s, id) => s + fundsCost(fullTree.byId.get(id)), 0);
console.log(`  best periapsis: ${(fullTreeMetrics.bestPeriapsis ?? NaN).toFixed(0)} m`);
console.log(`  max downrange seen in that scan: ${fullTreeMetrics.maxDownrange.toFixed(0)} m`);
console.log(`  max altitude seen in that scan: ${fullTreeMetrics.maxAltitude.toFixed(0)} m`);
console.log(`  total tree cost (tier 1 + tier 2): ${fullTreeCost} funds`);

// Greedy player, tier 2: continues from a greedy TIER 1 end state (the same
// greedyLaunchesToGoal-style algorithm, re-run here so this section has its
// own state to hand off) through to the tier 2 goal. Node-buying decisions
// use a single representative turn (0.3) rather than a full scan -- see
// test/data.test.js's matching tier 2 greedy test for the same tradeoff
// (this is a heuristic, not an exhaustive cheapest-set search) and why it's
// necessary for a tree this size to run in reasonable time.
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

  let state = { owned: [], funds: 0, resources: {}, reputation: 100, tier: 1 };
  let launches = 0;

  // Tier 1 leg.
  let altitude = maxAltitudeOf(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1);
  while (altitude < tier1Goal && launches < MAX_LAUNCHES) {
    let best = floorMission;
    for (const m of tier1Missions) {
      if (m.requirement.altitude <= altitude && m.payout > best.payout) best = m;
    }
    state = { ...state, funds: state.funds + best.payout };
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
    state = { ...state, funds: state.funds + best.payout };
    launches += 1;

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

  if ((metrics.bestPeriapsis ?? -Infinity) < goalPeriapsis) {
    return { reached: false, tier1Launches, tier2Launches: launches - tier1Launches };
  }
  return { reached: true, tier1Launches, tier2Launches: launches - tier1Launches };
}

console.log('\n=== Greedy player simulation, tier 2 ===');
const tier2Greedy = greedyTier2LaunchesToGoal();
if (!tier2Greedy.reached) {
  console.log(`  did not reach the tier 2 goal (stopped after ${tier2Greedy.tier2Launches} tier 2 launches)`);
} else {
  console.log(`  tier 1 launches: ${tier2Greedy.tier1Launches}`);
  console.log(`  tier 2 launches: ${tier2Greedy.tier2Launches} (target: 30-60, per ARCHITECTURE.md)`);
}
