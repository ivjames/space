import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTree } from '../js/core/tree.js';
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
  assert.equal(floors[0].requirement.altitude, 20000);
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

test('baseVehicle single-stage delta-v clears the floor (20 km) but not the tier goal (100 km)', () => {
  const stage = baseVehicle.stages[0];
  const g = 9.80665;
  const m0 = stage.dryMass + stage.propMass + baseVehicle.payloadMass;
  const m1 = stage.dryMass + baseVehicle.payloadMass;
  const dv = stage.isp * g * Math.log(m0 / m1);

  // Same loss-allowance model documented in components.js / tree.js.
  const requiredDv = (altitudeMeters) => Math.sqrt(2 * 9.81 * altitudeMeters) * 1.15;

  assert.ok(dv >= requiredDv(20000), `starter dv ${dv} should clear the 20 km floor`);
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
