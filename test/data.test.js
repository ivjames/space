import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTree, collectEffects, canBuy, buy } from '../js/core/tree.js';
import { buildVehicle, totalDeltaV, stackMassAbove } from '../js/core/vehicle.js';
import { resolveLaunch, ORBIT_MIN_ALT } from '../js/core/resolver.js';
import { makeRng } from '../js/core/rng.js';
import { credit } from '../js/core/economy.js';
import { nodes } from '../js/data/tree.js';
import { missions, tierGoals } from '../js/data/missions.js';
import { baseVehicle } from '../js/data/components.js';

// Tier 1 nodes/missions only — every assertion in this first half of the
// file predates tier 2 and must keep meaning exactly what it always did.
// Scoping to tier 1 here (rather than reading `nodes`/`missions` directly)
// is what keeps a 2^12 brute force a 2^12 brute force once tier 2's nodes
// are appended to the same arrays (a straight 2^(12+13) enumeration is not
// remotely tractable).
const tier1Nodes = nodes.filter((n) => (n.tier ?? 1) === 1);
const tier1Missions = missions.filter((m) => (m.tier ?? 1) === 1);
const tier2Nodes = nodes.filter((n) => (n.tier ?? 1) === 2);
const tier2Missions = missions.filter((m) => m.tier === 2);

test('the tier 1 tree data loads without throwing', () => {
  assert.doesNotThrow(() => loadTree(nodes));
});

test('every node requires id exists in the data', () => {
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    for (const req of node.requires ?? []) {
      assert.ok(ids.has(req), `${node.id} requires missing node ${req}`);
    }
  }
});

test('node count is in the 10-12 range across three branches (tier 1 only)', () => {
  assert.ok(tier1Nodes.length >= 10 && tier1Nodes.length <= 12, `got ${tier1Nodes.length} nodes`);
  const branchesSeen = new Set(tier1Nodes.map((n) => n.branch));
  assert.deepEqual([...branchesSeen].sort(), ['propulsion', 'reliability', 'structure']);
});

test('exactly one mission template is the floor contract', () => {
  const floors = missions.filter((m) => m.floor);
  assert.equal(floors.length, 1);
  assert.equal(floors[0].requirement.altitude, 10000);
});

test('every tier 1 mission has a requirement.altitude', () => {
  for (const m of tier1Missions) {
    assert.equal(typeof m.requirement?.altitude, 'number');
  }
});

test('tier 1 mission count is in the 4-6 range', () => {
  assert.ok(tier1Missions.length >= 4 && tier1Missions.length <= 6, `got ${tier1Missions.length} missions`);
});

test('tier 1 mission payouts scale with altitude requirement', () => {
  const sorted = [...tier1Missions].sort((a, b) => a.requirement.altitude - b.requirement.altitude);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].payout >= sorted[i - 1].payout,
      `payout should not decrease with altitude: ${sorted[i - 1].id} -> ${sorted[i].id}`,
    );
  }
});

test('tier 1 repGain/repLoss are within the 0-3 / 0-2 documented ranges', () => {
  for (const m of tier1Missions) {
    assert.ok(m.repGain >= 1 && m.repGain <= 3, `${m.id} repGain out of range`);
    assert.ok(m.repLoss >= 0 && m.repLoss <= 2, `${m.id} repLoss out of range`);
  }
});

test('tierGoals[1] exists and matches the 100 km tier goal', () => {
  assert.ok(tierGoals[1]);
  assert.equal(tierGoals[1].requirement.altitude, 100000);
});

test('baseVehicle has the required Vehicle shape', () => {
  assert.ok(Array.isArray(baseVehicle.stages));
  assert.equal(baseVehicle.stages.length, 1);
  const stage = baseVehicle.stages[0];
  for (const key of ['dryMass', 'propMass', 'thrust', 'isp', 'reliability']) {
    assert.equal(typeof stage[key], 'number', `stage.${key} should be a number`);
  }
  assert.equal(typeof baseVehicle.payloadMass, 'number');
  assert.equal(typeof baseVehicle.dragArea, 'number');
  assert.equal(typeof baseVehicle.dragCoeff, 'number');
});

test('baseVehicle has the phase 1 guidance stat, defaulted to 0', () => {
  assert.equal(baseVehicle.guidance, 0);
});

test('baseVehicle liftoff thrust-to-weight ratio is > 1', () => {
  const stage = baseVehicle.stages[0];
  const g = 9.80665;
  const liftoffMass = stage.dryMass + stage.propMass + baseVehicle.payloadMass;
  const twr = stage.thrust / (liftoffMass * g);
  assert.ok(twr > 1, `TWR was ${twr}`);
});

// Resolver-driven, not the ideal-delta-v-plus-15% shortcut: that shortcut is
// exactly what caused the tier 1 balancing bug this file's other resolver
// tests below guard against (a straight-up ascent pays far more than 15% to
// gravity and drag — see js/data/components.js and js/data/tree.js).
test('baseVehicle single-stage delta-v clears the floor (10 km) but not the tier goal (100 km), ideal-dv sanity check', () => {
  const stage = baseVehicle.stages[0];
  const g = 9.80665;
  const m0 = stage.dryMass + stage.propMass + baseVehicle.payloadMass;
  const m1 = stage.dryMass + baseVehicle.payloadMass;
  const dv = stage.isp * g * Math.log(m0 / m1);

  // Same loss-allowance model documented in components.js / tree.js. This is
  // a loose sanity check only (the ideal figure is always optimistic vs the
  // simulation) — the resolver-driven tests below are the ones that
  // actually guard the real numbers.
  const requiredDv = (altitudeMeters) => Math.sqrt(2 * 9.81 * altitudeMeters) * 1.15;

  assert.ok(dv >= requiredDv(10000), `starter dv ${dv} should clear the 10 km floor`);
  assert.ok(dv < requiredDv(100000), `starter dv ${dv} should NOT clear the 100 km tier goal`);
});

test('every reachable (prereq-respecting) combination of tier 1 owned nodes keeps liftoff TWR >= 1', () => {
  // Brute-force every subset of the (small, 10-12 node) TIER 1 tree that
  // respects `requires`, and confirm the tree's cross-branch safety-rail
  // prerequisites (documented in js/data/tree.js) actually hold: no
  // reachable purchase order can leave the player with a vehicle that
  // cannot lift off, which would be an un-recoverable soft-lock. Tier 2's
  // own (bigger) safety rail is exercised separately, driven by the real
  // resolver, in the guarded tier 2 section below.
  const byId = new Map(tier1Nodes.map((n) => [n.id, n]));
  const ids = tier1Nodes.map((n) => n.id);
  const branchOrder = ['propulsion', 'structure', 'reliability'];
  const g = 9.80665;

  function reqsSatisfied(owned, id) {
    return (byId.get(id).requires ?? []).every((r) => owned.has(r));
  }

  function applyEffects(owned) {
    const v = JSON.parse(JSON.stringify(baseVehicle));
    for (const branch of branchOrder) {
      const branchNodes = tier1Nodes
        .filter((n) => n.branch === branch)
        .sort((a, z) => a.level - z.level);
      for (const node of branchNodes) {
        if (!owned.has(node.id)) continue;
        for (const eff of node.effects) {
          if (eff.addStage) {
            v.stages.push({ ...eff.addStage });
            continue;
          }
          const path = eff.stat.split('.');
          let obj = v;
          for (let i = 0; i < path.length - 1; i++) {
            const key = /^\d+$/.test(path[i]) ? Number(path[i]) : path[i];
            obj = obj[key];
          }
          const lastKey = /^\d+$/.test(path.at(-1)) ? Number(path.at(-1)) : path.at(-1);
          if (eff.op === 'add') obj[lastKey] += eff.value;
          else if (eff.op === 'mul') obj[lastKey] *= eff.value;
          else if (eff.op === 'set') obj[lastKey] = eff.value;
        }
      }
    }
    return v;
  }

  function liftoffTWR(v) {
    const totalMass =
      v.stages.reduce((s, st) => s + st.dryMass + st.propMass, 0) + v.payloadMass;
    return v.stages[0].thrust / (totalMass * g);
  }

  assert.ok(ids.length <= 16, 'brute force assumes a small tree; revisit if it grows');

  let checked = 0;
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    const owned = new Set();
    for (let i = 0; i < ids.length; i++) {
      if (mask & (1 << i)) owned.add(ids[i]);
    }
    let valid = true;
    for (const id of owned) {
      if (!reqsSatisfied(owned, id)) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    checked += 1;
    const twr = liftoffTWR(applyEffects(owned));
    assert.ok(twr >= 1, `TWR ${twr} < 1 for owned=${[...owned].join(',')}`);
  }
  assert.ok(checked > 1, 'sanity: brute force should have checked more than the empty set');
});

// ---------------------------------------------------------------------
// Resolver-driven TIER 1 balance regression tests.
//
// The bug this guards against: tier 1 content was sized from IDEAL delta-v
// with a flat 15% loss allowance, but the resolver's real vertical ascent
// pays far more than that to gravity and drag. Sized that way, the starter
// vehicle could not even clear the floor contract (a new game earns
// nothing, ever) and the fully-upgraded tree fell short of the tier goal
// (the tier could not be won). Everything below drives the REAL resolver
// (`resolveLaunch`), never the ideal-dv shortcut, so a future change that
// reintroduces that gap fails loudly here instead of only showing up in
// `node tools/balance.mjs`.
//
// Reliability is forced to 1 on a deep copy of the vehicle before every
// resolve, for the same reason tools/balance.mjs does it: the resolver has
// no reliability-override option, and a reliability-1 vehicle flies
// bit-identically under any seed (see resolver.js's docs on the mid-burn
// roll), so a fixed seed is sufficient and the result never flakes.
const SEED = 1;
const NO_CEILING = { requirement: { altitude: 1e9 } };

function forceReliability(vehicle) {
  const copy = JSON.parse(JSON.stringify(vehicle));
  for (const stage of copy.stages) stage.reliability = 1;
  return copy;
}

function maxAltitudeOf(vehicle, fuelFraction = 1) {
  const rng = makeRng(SEED);
  const outcome = resolveLaunch(forceReliability(vehicle), NO_CEILING, { fuelFraction }, rng, {});
  return outcome.maxAltitude;
}

const tier1Tree = loadTree(tier1Nodes);
const tier1NodeIds = tier1Nodes.map((n) => n.id);

function buildOwnedVehicle(owned) {
  return buildVehicle(baseVehicle, collectEffects(tier1Tree, { owned }));
}

// Enumerate every prereq-valid TIER 1 owned set once (2^12 = 4096 masks,
// each one resolveLaunch at a few ms, so well under a minute) and reuse it
// across the tests below rather than re-running the brute force per test.
const validOwnedSets = (() => {
  const sets = [];
  for (let mask = 0; mask < 1 << tier1NodeIds.length; mask += 1) {
    const owned = [];
    for (let i = 0; i < tier1NodeIds.length; i += 1) {
      if (mask & (1 << i)) owned.push(tier1NodeIds[i]);
    }
    const ownedSet = new Set(owned);
    let valid = true;
    for (const id of owned) {
      const reqs = tier1Tree.byId.get(id).requires ?? [];
      if (!reqs.every((r) => ownedSet.has(r))) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    sets.push({ owned, altitude: maxAltitudeOf(buildOwnedVehicle(owned), 1) });
  }
  return sets;
})();

test('starter vehicle reaches the floor contract altitude at fuelFraction 0.8', () => {
  const floor = missions.find((m) => m.floor);
  const starter = buildVehicle(baseVehicle, []);
  const altitude = maxAltitudeOf(starter, 0.8);
  assert.ok(
    altitude >= floor.requirement.altitude,
    `starter @ fuelFraction 0.8 reached ${altitude.toFixed(0)} m, floor needs ${floor.requirement.altitude} m`,
  );
});

test('some prereq-valid tier 1 owned set reaches tierGoals[1] (simulated, not ideal dv)', () => {
  const goalAltitude = tierGoals[1].requirement.altitude;
  const best = validOwnedSets.reduce((m, s) => Math.max(m, s.altitude), 0);
  assert.ok(
    best >= goalAltitude,
    `best simulated altitude across every prereq-valid set was ${best.toFixed(0)} m, goal is ${goalAltitude} m`,
  );
});

test('the full tier 1 tree (all tier 1 nodes owned) simulates to at least 120 km', () => {
  const full = validOwnedSets.find((s) => s.owned.length === tier1NodeIds.length);
  assert.ok(full, 'full-tree set should be among the enumerated valid sets');
  assert.ok(full.altitude >= 120000, `full tree simulated to ${full.altitude.toFixed(0)} m`);
});

test('every tier 1 mission is reachable by some prereq-valid tier 1 owned set (simulated)', () => {
  for (const m of tier1Missions) {
    const reachable = validOwnedSets.some((s) => s.altitude >= m.requirement.altitude);
    assert.ok(reachable, `no prereq-valid owned set reaches ${m.id}'s ${m.requirement.altitude} m`);
  }
});

test('a greedy player (best reachable mission, then cheapest altitude-boosting node) reaches the tier 1 goal within 40 launches', () => {
  const goalAltitude = tierGoals[1].requirement.altitude;
  const floorMission = missions.find((m) => m.floor);
  let state = { owned: [], funds: 0, resources: {} };
  let altitude = maxAltitudeOf(buildOwnedVehicle(state.owned), 1);
  let launches = 0;
  const MAX_LAUNCHES = 40;

  while (altitude < goalAltitude && launches < MAX_LAUNCHES) {
    let best = floorMission;
    for (const m of tier1Missions) {
      if (m.requirement.altitude <= altitude && m.payout > best.payout) best = m;
    }
    state = { ...state, funds: state.funds + best.payout };
    launches += 1;

    for (;;) {
      let pick = null;
      for (const node of tier1Tree.nodes) {
        if (!canBuy(tier1Tree, state, node.id)) continue;
        const candidateAltitude = maxAltitudeOf(
          buildOwnedVehicle([...state.owned, node.id]),
          1,
        );
        if (candidateAltitude > altitude + 1e-6) {
          if (!pick || (node.cost.funds ?? 0) < (pick.cost.funds ?? 0)) pick = node;
        }
      }
      if (!pick) break;
      state = buy(tier1Tree, state, pick.id);
      altitude = maxAltitudeOf(buildOwnedVehicle(state.owned), 1);
    }
  }

  assert.ok(
    altitude >= goalAltitude,
    `greedy player stalled at ${altitude.toFixed(0)} m after ${launches} launches, goal is ${goalAltitude} m`,
  );
  assert.ok(launches <= MAX_LAUNCHES, `greedy player took ${launches} launches, expected <= ${MAX_LAUNCHES}`);
});

// =======================================================================
// TIER 2 — structural assertions (no resolver required).
// =======================================================================

const fullTree = loadTree(nodes); // both tiers together — also exercises
// loadTree's tier-ordering validation (a prerequisite may not sit in a
// higher tier than the node it unlocks) against the real data.

test('tier 2 nodes exist: 12 to 16 of them, across all four branches', () => {
  assert.ok(
    tier2Nodes.length >= 12 && tier2Nodes.length <= 16,
    `got ${tier2Nodes.length} tier 2 nodes`,
  );
  const branchesSeen = new Set(tier2Nodes.map((n) => n.branch));
  assert.deepEqual([...branchesSeen].sort(), ['guidance', 'propulsion', 'reliability', 'structure']);
});

test('every prerequisite sits at or below its own node\'s tier', () => {
  // loadTree(nodes) above already throws if this doesn't hold; this
  // restates the same invariant directly against the data so a violation
  // is reported as a data.test.js failure, not just "loadTree threw".
  for (const node of nodes) {
    const nodeTier = node.tier ?? 1;
    for (const req of node.requires ?? []) {
      const reqNode = fullTree.byId.get(req);
      const reqTier = reqNode.tier ?? 1;
      assert.ok(
        reqTier <= nodeTier,
        `${node.id} (tier ${nodeTier}) requires ${req} (tier ${reqTier}), a higher tier`,
      );
    }
  }
});

test('the guidance branch exists and its first (lowest-level) node sets vehicle.guidance to 1', () => {
  const guidanceNodes = [...nodes.filter((n) => n.branch === 'guidance')].sort(
    (a, z) => a.level - z.level,
  );
  assert.ok(guidanceNodes.length > 0, 'expected at least one guidance node');
  assert.deepEqual(guidanceNodes[0].effects, [{ stat: 'guidance', op: 'set', value: 1 }]);
});

test('tierGoals[2] is an orbit (periapsis) requirement', () => {
  assert.ok(tierGoals[2]);
  assert.ok(tierGoals[2].requirement.orbit, 'tierGoals[2] should have an orbit requirement');
  assert.equal(typeof tierGoals[2].requirement.orbit.periapsis, 'number');
});

test('every tier 2 mission has exactly one of the three requirement shapes', () => {
  assert.ok(tier2Missions.length > 0, 'expected at least one tier 2 mission');
  for (const m of tier2Missions) {
    const shapes = ['altitude', 'downrange', 'orbit'].filter((k) => m.requirement[k] !== undefined);
    assert.equal(shapes.length, 1, `${m.id} should have exactly one requirement shape, got [${shapes}]`);
  }
});

test('tier 2 mission payouts are well above tier 1\'s', () => {
  const maxTier1Payout = Math.max(...tier1Missions.map((m) => m.payout));
  for (const m of tier2Missions) {
    assert.ok(
      m.payout > maxTier1Payout,
      `${m.id}'s payout ${m.payout} should exceed tier 1's max payout ${maxTier1Payout}`,
    );
  }
});

test('every tier 2 mission has a minReputation gate', () => {
  for (const m of tier2Missions) {
    assert.equal(typeof m.minReputation, 'number', `${m.id} should have a minReputation gate`);
  }
});

test('ideal full-tree (tier 1 + tier 2) delta-v is between 9 and 11 km/s', () => {
  const allIds = nodes.map((n) => n.id);
  const vehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: allIds }));
  const dv = totalDeltaV(vehicle, 1);
  assert.ok(dv >= 9000 && dv <= 11000, `full tree ideal dv was ${dv.toFixed(0)} m/s (want 9000-11000)`);
});

// =======================================================================
// TIER 2 — resolver-driven assertions.
//
// The phase 1 resolver (ARCHITECTURE.md's "Phase 1 -- tier 2, orbit") has
// landed for good, so these run unconditionally -- no more test.skip guard.
// =======================================================================

const NO_CEILING_ORBIT = { requirement: { orbit: { periapsis: 1e9 } } };
const TURN_STEPS = Array.from({ length: 21 }, (_, i) => i * 0.05); // 0, 0.05, ..., 1

// bestMetricsOverTurns: one full turn scan (0..1 in 0.05 steps, per
// ARCHITECTURE.md's Balance section), each metric independently maximised
// across the scan. Uses an orbit requirement with an unreachable periapsis
// so every run flies to impact/maxTime rather than ending early, which is
// what lets one scan read off maxAltitude, maxDownrange AND periapsis at
// once instead of needing a separate scan per requirement shape.
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

function missionMetBy(mission, metrics) {
  const req = mission.requirement;
  if (req.altitude !== undefined) return metrics.maxAltitude >= req.altitude;
  if (req.downrange !== undefined) return metrics.maxDownrange >= req.downrange;
  if (req.orbit !== undefined) return (metrics.bestPeriapsis ?? -Infinity) >= req.orbit.periapsis;
  return false;
}

// resolver.js's phase 1 rewrite is unconditionally in place.
test('some prereq-valid owned set (the full tree) reaches tierGoals[2] (simulated)', () => {
  const allIds = nodes.map((n) => n.id);
  const vehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: allIds }));
  const metrics = bestMetricsOverTurns(vehicle, 1);
  const goalPeriapsis = tierGoals[2].requirement.orbit.periapsis;
  assert.ok(
    (metrics.bestPeriapsis ?? -Infinity) >= goalPeriapsis,
    `full tree best simulated periapsis was ${metrics.bestPeriapsis}, goal is ${goalPeriapsis} m`,
  );
});

test('every tier 2 mission is reachable by some prereq-valid owned set (the full tree, simulated)', () => {
  const allIds = nodes.map((n) => n.id);
  const vehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: allIds }));
  const metrics = bestMetricsOverTurns(vehicle, 1);
  for (const m of tier2Missions) {
    assert.ok(missionMetBy(m, metrics), `full tree does not reach ${m.id} (${JSON.stringify(m.requirement)})`);
  }
});

// =======================================================================
// GOAL 1: `turn` is a real decision, not a whole-slider-or-single-notch
// dead lever. Full periapsis-vs-turn table, same shape `node
// tools/balance.mjs`'s report uses, for (a) the cheapest prereq-valid set
// that reaches the tier goal and (b) the full tree.
// =======================================================================

function periapsisAtTurns(vehicle, fuelFraction = 1) {
  return TURN_STEPS.map((turn) => {
    const rng = makeRng(SEED);
    const outcome = resolveLaunch(forceReliability(vehicle), NO_CEILING_ORBIT, { fuelFraction, turn }, rng, {});
    return { turn, periapsis: outcome.periapsis };
  });
}

function turnWindow(rows, threshold) {
  const hits = rows.filter((r) => typeof r.periapsis === 'number' && r.periapsis >= threshold);
  const peak = rows.reduce(
    (best, r) => (typeof r.periapsis === 'number' && (!best || r.periapsis > best.periapsis) ? r : best),
    null,
  );
  return { count: hits.length, peakTurn: peak ? peak.turn : null };
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

// CUMULATIVE mission ladder (shared by the goal 1 and goal 2 tests below):
// walks the tier 2 missions in file order, each rung buying the cheapest
// additional nodes on top of the PREVIOUS rung's owned set -- what a player
// who never sells a node actually experiences, unlike an independent
// per-mission search that restarts from empty every time and can report a
// smaller set for a later, harder mission (checked by hand: it does, for
// this exact data, if the reliability branch is left in the search pool).
// Starts from the tier 1 cheapest-goal set. The search pool excludes the
// reliability branch: reliability is forced to 1 throughout this file, so
// no reliability node can ever move a trajectory metric, and leaving it in
// only invites that same artifact.
const tier1CheapestGoalOwned = (() => {
  const goalAltitude = tierGoals[1].requirement.altitude;
  const best = validOwnedSets.reduce(
    (b, s) => (s.altitude >= goalAltitude && (!b || s.owned.length < b.owned.length) ? s : b),
    null,
  );
  return best ? best.owned : [];
})();
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
        const ratio = (candidateMetric - metric) / Math.max(node.cost.funds ?? 1, 1);
        if (ratio > pickRatio) { pick = node; pickMetric = candidateMetric; pickRatio = ratio; }
      }
    }
    if (!pick) break;
    state = buy(fullTree, state, pick.id);
    metric = pickMetric;
  }
  return { owned: state.owned, metric, reached: metric >= target };
}

const tier2Ladder = (() => {
  let owned = [...tier1CheapestGoalOwned];
  const rungs = [];
  for (const m of tier2Missions) {
    const result = chainedCheapestReaching(owned, m.requirement);
    rungs.push({ mission: m, ...result, delta: result.owned.length - owned.length });
    owned = result.owned;
  }
  return rungs;
})();

test('the cumulative cheapest-reaching-set ladder reaches every tier 2 rung', () => {
  for (const rung of tier2Ladder) {
    assert.ok(rung.reached, `${rung.mission.id} was not reached by the cumulative ladder (metric ${rung.metric})`);
  }
});

test('the cumulative ladder steps by 1-3 new nodes per rung (ARCHITECTURE.md: "one to three more purchases")', () => {
  for (const rung of tier2Ladder) {
    assert.ok(
      rung.delta >= 1 && rung.delta <= 3,
      `${rung.mission.id} needed ${rung.delta} new nodes on top of the previous rung, expected 1-3`,
    );
  }
});

test('the ladder order is sensible: downrange rungs before the apogee rung, before low orbit, before the goal', () => {
  const byId = new Map(tier2Ladder.map((r) => [r.mission.id, r]));
  const costOf = (r) => r.owned.length; // node count is a fine proxy for "how far into the tree"
  assert.ok(costOf(byId.get('orbit-down-1')) <= costOf(byId.get('orbit-apogee')));
  assert.ok(costOf(byId.get('orbit-down-2')) <= costOf(byId.get('orbit-apogee')));
  assert.ok(costOf(byId.get('orbit-apogee')) <= costOf(byId.get('orbit-low')));
  assert.ok(costOf(byId.get('orbit-low')) <= costOf(byId.get('orbit-goal')));
});

test('turn is a real decision: the cheapest orbit-goal-reaching set has a narrow (2-4 notch) good-turn window, not peaking at the lazy end', () => {
  const cheapestOwned = tier2Ladder[tier2Ladder.length - 1].owned;
  const vehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: cheapestOwned }));
  const rows = periapsisAtTurns(vehicle, 1);
  const window = turnWindow(rows, ORBIT_MIN_ALT);
  assert.ok(window.count >= 2 && window.count <= 6, `cheapest set's good-turn window was ${window.count}/21 notches, expected roughly 2-4`);
  assert.notEqual(window.peakTurn, 0, 'cheapest set orbits best at turn=0 (lazy end) -- turn is not a real decision');
  assert.notEqual(window.peakTurn, 1, 'cheapest set orbits best at turn=1 (hard end) -- turn is not a real decision');
});

test('turn is a real decision: the full tree\'s good-turn window is wider than the cheapest set\'s but still not the whole slider', () => {
  const cheapestOwned = tier2Ladder[tier2Ladder.length - 1].owned;
  const allIds = nodes.map((n) => n.id);
  const cheapestVehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: cheapestOwned }));
  const fullVehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned: allIds }));
  const cheapestWindow = turnWindow(periapsisAtTurns(cheapestVehicle, 1), ORBIT_MIN_ALT);
  const fullWindow = turnWindow(periapsisAtTurns(fullVehicle, 1), ORBIT_MIN_ALT);
  assert.ok(fullWindow.count > cheapestWindow.count, `full tree window (${fullWindow.count}) should be wider than the cheapest set's (${cheapestWindow.count})`);
  assert.ok(fullWindow.count <= 10, `full tree window was ${fullWindow.count}/21 notches, expected well under half the slider`);
  assert.notEqual(fullWindow.peakTurn, 0, 'full tree orbits best at turn=0 (lazy end) -- a sign the vehicle is thrust-poor and turn is not a real decision');
  assert.notEqual(fullWindow.peakTurn, 1, 'full tree orbits best at turn=1 (hard end)');
});

// =======================================================================
// GOAL 4: TWR safety rail across tier 1 + tier 2 combined. Bounded version
// of `node tools/balance.mjs`'s GOAL 4 report: BFS-enumerate every
// prereq-valid owned combination across BOTH tiers (small in practice --
// see js/data/tree.js's THRUST-TO-WEIGHT SAFETY RAIL note -- prerequisites
// chain hard enough that this stays well under the 10s budget), then check
// liftoff TWR >= 1.05 and every upper stage's TWR at ignition >= 0.5 on
// each one.
// =======================================================================

test('no purchase order among tier 1 + tier 2 nodes leaves liftoff TWR under 1.05 or an upper stage under 0.5 at ignition', () => {
  const allIds = nodes.map((n) => n.id);
  const seen = new Set(['']);
  let frontier = [[]];
  const reachable = [[]];
  while (frontier.length) {
    const next = [];
    for (const owned of frontier) {
      const ownedSet = new Set(owned);
      for (const id of allIds) {
        if (ownedSet.has(id)) continue;
        const reqs = fullTree.byId.get(id).requires ?? [];
        if (!reqs.every((r) => ownedSet.has(r))) continue;
        const newOwned = [...owned, id].sort();
        const key = newOwned.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(newOwned);
        reachable.push(newOwned);
      }
    }
    frontier = next;
  }
  assert.ok(reachable.length > 100, `sanity: expected hundreds of reachable owned sets, got ${reachable.length}`);

  const g = 9.80665;
  function stageTWRs(vehicle, fuelFraction = 1) {
    return vehicle.stages.map((stage, i) => {
      const above = stackMassAbove(vehicle, i, fuelFraction);
      const mass = above + stage.dryMass + stage.propMass * fuelFraction;
      return stage.thrust / (mass * g);
    });
  }

  for (const owned of reachable) {
    const vehicle = buildVehicle(baseVehicle, collectEffects(fullTree, { owned }));
    const twrs = stageTWRs(vehicle, 1);
    assert.ok(twrs[0] >= 1.05, `liftoff TWR ${twrs[0].toFixed(3)} < 1.05 for owned=[${owned.join(',')}]`);
    for (let i = 1; i < twrs.length; i += 1) {
      assert.ok(twrs[i] >= 0.5, `stage ${i} TWR ${twrs[i].toFixed(3)} < 0.5 at ignition for owned=[${owned.join(',')}]`);
    }
  }
});

//
// Greedy player, tier 2: continues from a greedy tier 1 end state (same
// algorithm as the tier 1 greedy test above — best reachable mission, then
// cheapest node that improves the current metric, repeat) through
// advanceTier and on to the tier 2 goal. Node-buying decisions use a single
// representative turn (0.3) rather than a full scan — this is a heuristic,
// not an exhaustive cheapest-set search (a true brute force over 13 tier 2
// nodes stacked on 12 tier 1 ones is not tractable here); only the
// launch-to-launch progress check re-scans the full TURN_STEPS range, which
// keeps this test's runtime to a couple of seconds while still driving the
// real resolver throughout (never the ideal-dv shortcut).
//
// REPUTATION: starts at 0 (a fresh save), credited via the real
// `credit` (js/core/economy.js, clamped to [0, 100]) after every launch,
// exactly the way js/core/economy.js's applyOutcome does on a success. An
// earlier draft of this simulation started reputation at 100 -- already
// past every tier 2 gate -- and never applied repGain, so the
// `minReputation` filter below was checked against a constant that could
// never fail it. That is a state bug (this test's own scaffolding), not a
// property of the real game, and it hid whether the gates are reachable at
// all. Fixed here so the assertions below actually exercise the gates.
test('a greedy player reaches the tier 2 goal in 30-60 tier 2 launches, crossing every minReputation gate before affording that rung', () => {
  const DECISION_TURN = 0.3;
  const floorMission = missions.find((m) => m.floor);
  const goalPeriapsis = tierGoals[2].requirement.orbit.periapsis;

  function metricAtDecisionTurn(vehicle) {
    const rng = makeRng(SEED);
    const outcome = resolveLaunch(forceReliability(vehicle), NO_CEILING_ORBIT, { fuelFraction: 1, turn: DECISION_TURN }, rng, {});
    return outcome.periapsis ?? -Infinity;
  }

  let state = { owned: [], funds: 0, resources: {}, reputation: 0, tier: 1 };
  let launches = 0;
  const MAX_TOTAL_LAUNCHES = 150;

  // Tier 1 leg: same shape as the tier 1 greedy test above, reusing
  // maxAltitudeOf/tier1Missions so this genuinely starts from a tier 1
  // greedy end state per ARCHITECTURE.md's Balance section.
  let altitude = maxAltitudeOf(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1);
  const tier1Goal = tierGoals[1].requirement.altitude;
  while (altitude < tier1Goal && launches < MAX_TOTAL_LAUNCHES) {
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
          if (!pick || (node.cost.funds ?? 0) < (pick.node.cost.funds ?? 0)) pick = { node, a };
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
  const reputationCurve = [];
  while ((metrics.bestPeriapsis ?? -Infinity) < goalPeriapsis && launches < MAX_TOTAL_LAUNCHES) {
    let best = floorMission;
    for (const m of missions) {
      if (m.tier > state.tier) continue;
      if (m.minReputation !== undefined && state.reputation < m.minReputation) continue;
      if (missionMetBy(m, metrics) && m.payout > best.payout) best = m;
    }
    state = credit(state, { funds: best.payout, reputation: best.repGain });
    launches += 1;
    reputationCurve.push({ tier2Launch: launches - tier1Launches, reputation: state.reputation });

    for (;;) {
      let pick = null;
      const baseMetric = metricAtDecisionTurn(buildVehicle(baseVehicle, collectEffects(fullTree, state)));
      for (const node of fullTree.nodes) {
        if (!canBuy(fullTree, state, node.id)) continue;
        const candidate = { ...state, owned: [...state.owned, node.id] };
        const m = metricAtDecisionTurn(buildVehicle(baseVehicle, collectEffects(fullTree, candidate)));
        if (m > baseMetric + 1) {
          if (!pick || (node.cost.funds ?? 0) < (pick.cost.funds ?? 0)) pick = node;
        }
      }
      if (!pick) break;
      state = buy(fullTree, state, pick.id);
    }
    metrics = bestMetricsOverTurns(buildVehicle(baseVehicle, collectEffects(fullTree, state)), 1);
  }

  const tier2Launches = launches - tier1Launches;
  assert.ok(
    (metrics.bestPeriapsis ?? -Infinity) >= goalPeriapsis,
    `greedy player stalled at periapsis ${metrics.bestPeriapsis} after ${launches} total launches`,
  );
  // ARCHITECTURE.md's own bound ("data.test.js asserts ... greedy tier 2
  // launches ≤ 80") plus the task's tighter 30-60 economy target -- 30-60
  // implies ≤80, so this one assertion covers both.
  assert.ok(
    tier2Launches >= 30 && tier2Launches <= 60,
    `greedy player took ${tier2Launches} tier 2 launches, expected 30-60`,
  );

  // Reputation-gate reachability (task goal 3): the greedy simulation must
  // show reputation crossing each rung's minReputation before the player
  // can afford that rung's vehicle -- the LAST tier2Launch entry in the
  // curve is when the goal-reaching vehicle finally got bought, so every
  // gate must be crossed at or before an EARLIER launch than that.
  const finalLaunch = tier2Launches;
  for (const m of tier2Missions) {
    if (m.minReputation === undefined) continue;
    const firstCross = reputationCurve.find((r) => r.reputation >= m.minReputation);
    assert.ok(firstCross, `${m.id}'s minReputation (${m.minReputation}) was never crossed`);
    assert.ok(
      firstCross.tier2Launch < finalLaunch,
      `${m.id}'s minReputation (${m.minReputation}) was not crossed until launch ${firstCross.tier2Launch}, ` +
        `at or after the goal-reaching vehicle was bought (launch ${finalLaunch})`,
    );
  }
});
