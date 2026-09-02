import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTree, collectEffects, canBuy, buy } from '../js/core/tree.js';
import { buildVehicle } from '../js/core/vehicle.js';
import { resolveLaunch } from '../js/core/resolver.js';
import { makeRng } from '../js/core/rng.js';
import { nodes } from '../js/data/tree.js';
import { missions, tierGoals } from '../js/data/missions.js';
import { baseVehicle } from '../js/data/components.js';

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

test('node count is in the 10-12 range across three branches', () => {
  assert.ok(nodes.length >= 10 && nodes.length <= 12, `got ${nodes.length} nodes`);
  const branchesSeen = new Set(nodes.map((n) => n.branch));
  assert.deepEqual([...branchesSeen].sort(), ['propulsion', 'reliability', 'structure']);
});

test('exactly one mission template is the floor contract', () => {
  const floors = missions.filter((m) => m.floor);
  assert.equal(floors.length, 1);
  assert.equal(floors[0].requirement.altitude, 10000);
});

test('every mission has a requirement.altitude', () => {
  for (const m of missions) {
    assert.equal(typeof m.requirement?.altitude, 'number');
  }
});

test('mission count is in the 4-6 range', () => {
  assert.ok(missions.length >= 4 && missions.length <= 6, `got ${missions.length} missions`);
});

test('mission payouts scale with altitude requirement', () => {
  const sorted = [...missions].sort((a, b) => a.requirement.altitude - b.requirement.altitude);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].payout >= sorted[i - 1].payout,
      `payout should not decrease with altitude: ${sorted[i - 1].id} -> ${sorted[i].id}`,
    );
  }
});

test('repGain/repLoss are within the 0-3 / 0-2 documented ranges', () => {
  for (const m of missions) {
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

test('every reachable (prereq-respecting) combination of owned nodes keeps liftoff TWR >= 1', () => {
  // Brute-force every subset of the (small, 10-12 node) tree that respects
  // `requires`, and confirm the tree's cross-branch safety-rail
  // prerequisites (documented in js/data/tree.js) actually hold: no
  // reachable purchase order can leave the player with a vehicle that
  // cannot lift off, which would be an un-recoverable soft-lock.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = nodes.map((n) => n.id);
  const branchOrder = ['propulsion', 'structure', 'reliability'];
  const g = 9.80665;

  function reqsSatisfied(owned, id) {
    return (byId.get(id).requires ?? []).every((r) => owned.has(r));
  }

  function applyEffects(owned) {
    const v = JSON.parse(JSON.stringify(baseVehicle));
    for (const branch of branchOrder) {
      const branchNodes = nodes
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
// Resolver-driven balance regression tests.
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

const dataTree = loadTree(nodes);
const dataNodeIds = nodes.map((n) => n.id);

function buildOwnedVehicle(owned) {
  return buildVehicle(baseVehicle, collectEffects(dataTree, { owned }));
}

// Enumerate every prereq-valid owned set once (2^12 = 4096 masks, each one
// resolveLaunch at ~0.5ms, so well under a second) and reuse it across the
// tests below rather than re-running the brute force per test.
const validOwnedSets = (() => {
  const sets = [];
  for (let mask = 0; mask < 1 << dataNodeIds.length; mask += 1) {
    const owned = [];
    for (let i = 0; i < dataNodeIds.length; i += 1) {
      if (mask & (1 << i)) owned.push(dataNodeIds[i]);
    }
    const ownedSet = new Set(owned);
    let valid = true;
    for (const id of owned) {
      const reqs = dataTree.byId.get(id).requires ?? [];
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

test('some prereq-valid owned set reaches tierGoals[1] (simulated, not ideal dv)', () => {
  const goalAltitude = tierGoals[1].requirement.altitude;
  const best = validOwnedSets.reduce((m, s) => Math.max(m, s.altitude), 0);
  assert.ok(
    best >= goalAltitude,
    `best simulated altitude across every prereq-valid set was ${best.toFixed(0)} m, goal is ${goalAltitude} m`,
  );
});

test('the full tree (all nodes owned) simulates to at least 120 km', () => {
  const full = validOwnedSets.find((s) => s.owned.length === dataNodeIds.length);
  assert.ok(full, 'full-tree set should be among the enumerated valid sets');
  assert.ok(full.altitude >= 120000, `full tree simulated to ${full.altitude.toFixed(0)} m`);
});

test('every mission is reachable by some prereq-valid owned set (simulated)', () => {
  for (const m of missions) {
    const reachable = validOwnedSets.some((s) => s.altitude >= m.requirement.altitude);
    assert.ok(reachable, `no prereq-valid owned set reaches ${m.id}'s ${m.requirement.altitude} m`);
  }
});

test('a greedy player (best reachable mission, then cheapest altitude-boosting node) reaches the tier goal within 40 launches', () => {
  const goalAltitude = tierGoals[1].requirement.altitude;
  const floorMission = missions.find((m) => m.floor);
  let state = { owned: [], funds: 0, resources: {} };
  let altitude = maxAltitudeOf(buildOwnedVehicle(state.owned), 1);
  let launches = 0;
  const MAX_LAUNCHES = 40;

  while (altitude < goalAltitude && launches < MAX_LAUNCHES) {
    let best = floorMission;
    for (const m of missions) {
      if (m.requirement.altitude <= altitude && m.payout > best.payout) best = m;
    }
    state = { ...state, funds: state.funds + best.payout };
    launches += 1;

    for (;;) {
      let pick = null;
      for (const node of dataTree.nodes) {
        if (!canBuy(dataTree, state, node.id)) continue;
        const candidateAltitude = maxAltitudeOf(
          buildOwnedVehicle([...state.owned, node.id]),
          1,
        );
        if (candidateAltitude > altitude + 1e-6) {
          if (!pick || (node.cost.funds ?? 0) < (pick.cost.funds ?? 0)) pick = node;
        }
      }
      if (!pick) break;
      state = buy(dataTree, state, pick.id);
      altitude = maxAltitudeOf(buildOwnedVehicle(state.owned), 1);
    }
  }

  assert.ok(
    altitude >= goalAltitude,
    `greedy player stalled at ${altitude.toFixed(0)} m after ${launches} launches, goal is ${goalAltitude} m`,
  );
  assert.ok(launches <= MAX_LAUNCHES, `greedy player took ${launches} launches, expected <= ${MAX_LAUNCHES}`);
});
