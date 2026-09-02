import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newGame, deriveVehicle, recordLaunch, tierGoalMet } from '../js/core/state.js';
import { loadTree } from '../js/core/tree.js';
import { nodes } from '../js/data/tree.js';
import { baseVehicle } from '../js/data/components.js';
import { missions, tierGoals } from '../js/data/missions.js';

const vehicleModulePath = fileURLToPath(new URL('../js/core/vehicle.js', import.meta.url));

test('newGame returns the documented schema at version 1', () => {
  const state = newGame(42);
  assert.equal(state.version, 1);
  assert.equal(state.seed, 42);
  assert.equal(state.draws, 0);
  assert.equal(state.funds, 0);
  assert.equal(state.reputation, 0);
  assert.deepEqual(state.resources, { water: 0, fuel: 0, oxidizer: 0, metals: 0 });
  assert.deepEqual(state.owned, []);
  assert.equal(state.tier, 1);
  assert.deepEqual(state.launches, { 1: 0 });
  assert.deepEqual(state.best, { maxAltitude: 0 });
  assert.deepEqual(state.contracts, []);
  assert.deepEqual(state.history, []);
});

test('newGame with the same seed is deep-equal (no hidden nondeterminism)', () => {
  assert.deepEqual(newGame(7), newGame(7));
});

test('recordLaunch increments launches for the current tier', () => {
  const state = newGame(1);
  const mission = { id: 'sound-1' };
  const outcome = { success: true, maxAltitude: 21000, readout: 'ok' };
  const next = recordLaunch(state, mission, outcome);
  assert.equal(next.launches[1], 1);
  assert.equal(state.launches[1], 0); // original untouched
});

test('recordLaunch updates best.maxAltitude to the running max', () => {
  const state = { ...newGame(1), best: { maxAltitude: 30000 } };
  const lower = recordLaunch(state, { id: 'm' }, { success: false, maxAltitude: 10000, readout: 'x' });
  assert.equal(lower.best.maxAltitude, 30000);
  const higher = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 50000, readout: 'x' });
  assert.equal(higher.best.maxAltitude, 50000);
});

test('recordLaunch caps history at 20 entries, keeping the most recent', () => {
  let state = newGame(1);
  for (let i = 0; i < 25; i++) {
    state = recordLaunch(state, { id: `m${i}` }, { success: true, maxAltitude: i, readout: 'x' });
  }
  assert.equal(state.history.length, 20);
  assert.equal(state.history[0].missionId, 'm5');
  assert.equal(state.history[19].missionId, 'm24');
});

test('recordLaunch advances draws by the optional draws argument', () => {
  const state = newGame(1);
  const next = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 1, readout: 'x' }, 17);
  assert.equal(next.draws, 17);
  const noDraws = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 1, readout: 'x' });
  assert.equal(noDraws.draws, 0);
});

test('tierGoalMet false below the goal, true at/above it', () => {
  const below = { ...newGame(1), best: { maxAltitude: 99999 } };
  const at = { ...newGame(1), best: { maxAltitude: 100000 } };
  assert.equal(tierGoalMet(below, tierGoals), false);
  assert.equal(tierGoalMet(at, tierGoals), true);
});

test('tierGoalMet also accepts the missions module namespace', () => {
  const at = { ...newGame(1), best: { maxAltitude: 100000 } };
  assert.equal(tierGoalMet(at, { missions, tierGoals }), true);
});

test('tierGoalMet false for a tier with no goal registered', () => {
  const state = { ...newGame(1), tier: 99, best: { maxAltitude: 1e9 } };
  assert.equal(tierGoalMet(state, tierGoals), false);
});

// deriveVehicle depends on js/core/vehicle.js, owned by another agent and
// written concurrently with this module. Skip only this test when that
// file isn't there yet; every other test in this file runs regardless.
test('deriveVehicle builds a vehicle from the tree + base components', async (t) => {
  if (!existsSync(vehicleModulePath)) {
    t.skip('js/core/vehicle.js not present yet');
    return;
  }
  const tree = loadTree(nodes);
  const state = newGame(1);
  const vehicle = await deriveVehicle(state, tree, baseVehicle);
  assert.ok(Array.isArray(vehicle.stages));
  assert.equal(vehicle.stages.length, 1);
  assert.deepEqual(vehicle.stages[0], baseVehicle.stages[0]);
  assert.equal(vehicle.payloadMass, baseVehicle.payloadMass);
});

test('deriveVehicle applies owned-node effects (when vehicle.js exists)', async (t) => {
  if (!existsSync(vehicleModulePath)) {
    t.skip('js/core/vehicle.js not present yet');
    return;
  }
  const tree = loadTree(nodes);
  const state = { ...newGame(1), owned: ['prop-1'] };
  const vehicle = await deriveVehicle(state, tree, baseVehicle);
  assert.equal(vehicle.stages[0].thrust, baseVehicle.stages[0].thrust * 1.1);
});
