import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  newGame,
  deriveVehicle,
  recordLaunch,
  advanceTier,
  tierGoalMet,
  findTarget,
  addObject,
  dockObject,
} from '../js/core/state.js';
import { loadTree } from '../js/core/tree.js';
import { nodes } from '../js/data/tree.js';
import { baseVehicle } from '../js/data/components.js';
import { missions, tierGoals } from '../js/data/missions.js';

const vehicleModulePath = fileURLToPath(new URL('../js/core/vehicle.js', import.meta.url));

test('newGame returns the documented schema at version 3', () => {
  const state = newGame(42);
  assert.equal(state.version, 3);
  assert.equal(state.seed, 42);
  assert.equal(state.draws, 0);
  assert.equal(state.funds, 0);
  assert.equal(state.reputation, 0);
  assert.deepEqual(state.resources, { water: 0, fuel: 0, oxidizer: 0, metals: 0 });
  assert.deepEqual(state.owned, []);
  assert.equal(state.tier, 1);
  assert.deepEqual(state.launches, { 1: 0 });
  assert.deepEqual(state.best, {
    maxAltitude: 0,
    maxDownrange: 0,
    bestPeriapsis: null,
    bestClosestApproach: null,
    docked: false,
    wins: {},
  });
  assert.deepEqual(state.contracts, []);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.objects, []);
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
  const state = { ...newGame(1), best: { ...newGame(1).best, maxAltitude: 30000 } };
  const lower = recordLaunch(state, { id: 'm' }, { success: false, maxAltitude: 10000, readout: 'x' });
  assert.equal(lower.best.maxAltitude, 30000);
  const higher = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 50000, readout: 'x' });
  assert.equal(higher.best.maxAltitude, 50000);
});

test('recordLaunch updates best.maxDownrange and best.bestPeriapsis when the outcome carries them', () => {
  const state = newGame(1);
  const outcome = {
    success: true,
    maxAltitude: 5000,
    maxDownrange: 42000,
    periapsis: -18000,
    readout: 'x',
  };
  const next = recordLaunch(state, { id: 'm' }, outcome);
  assert.equal(next.best.maxDownrange, 42000);
  assert.equal(next.best.bestPeriapsis, -18000);

  // A second, worse outcome must not lower the running best.
  const worse = recordLaunch(next, { id: 'm' }, { success: false, maxAltitude: 1, maxDownrange: 100, periapsis: -50000, readout: 'x' });
  assert.equal(worse.best.maxDownrange, 42000);
  assert.equal(worse.best.bestPeriapsis, -18000);

  // A better periapsis (closer to/above 0) raises the running best.
  const better = recordLaunch(worse, { id: 'm' }, { success: true, maxAltitude: 1, maxDownrange: 200, periapsis: 60000, readout: 'x' });
  assert.equal(better.best.bestPeriapsis, 60000);
});

test('recordLaunch treats an outcome with no maxDownrange/periapsis field as no update (old-resolver outcome)', () => {
  const state = {
    ...newGame(1),
    best: { maxAltitude: 0, maxDownrange: 7000, bestPeriapsis: 12000, wins: {} },
  };
  // Phase 0-shaped outcome: no maxDownrange, no periapsis field at all.
  const next = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 9000, readout: 'x' });
  assert.equal(next.best.maxDownrange, 7000);
  assert.equal(next.best.bestPeriapsis, 12000);
});

test('recordLaunch history entries carry periapsis and downrange (null when the outcome lacks them)', () => {
  const state = newGame(1);
  const withFields = recordLaunch(
    state,
    { id: 'm' },
    { success: true, maxAltitude: 1000, maxDownrange: 5000, periapsis: -2000, readout: 'x' },
  );
  assert.equal(withFields.history.at(-1).downrange, 5000);
  assert.equal(withFields.history.at(-1).periapsis, -2000);

  const withoutFields = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 1000, readout: 'x' });
  assert.equal(withoutFields.history.at(-1).downrange, null);
  assert.equal(withoutFields.history.at(-1).periapsis, null);
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

test('advanceTier increments tier, resets the new tier launch count, and clears contracts', () => {
  const state = {
    ...newGame(1),
    launches: { 1: 12, 2: 3 },
    contracts: ['sound-5', 'sound-2'],
  };
  const next = advanceTier(state);
  assert.equal(next.tier, 2);
  assert.equal(next.launches[2], 0);
  assert.equal(next.launches[1], 12); // the old tier's count is untouched
  assert.deepEqual(next.contracts, []);
  assert.equal(state.tier, 1); // original untouched
});

test('advanceTier marks the tier just left as won in best.wins', () => {
  const state = newGame(1);
  const next = advanceTier(state);
  assert.deepEqual(next.best.wins, { 1: true });
  assert.deepEqual(state.best.wins, {}); // original untouched
});

test('advanceTier preserves any wins already recorded', () => {
  const state = { ...newGame(1), tier: 2, best: { ...newGame(1).best, wins: { 1: true } } };
  const next = advanceTier(state);
  assert.deepEqual(next.best.wins, { 1: true, 2: true });
});

test('tierGoalMet false below the goal, true at/above it (tier 1, altitude)', () => {
  const below = { ...newGame(1), best: { ...newGame(1).best, maxAltitude: 99999 } };
  const at = { ...newGame(1), best: { ...newGame(1).best, maxAltitude: 100000 } };
  assert.equal(tierGoalMet(below, tierGoals), false);
  assert.equal(tierGoalMet(at, tierGoals), true);
});

test('tierGoalMet also accepts the missions module namespace', () => {
  const at = { ...newGame(1), best: { ...newGame(1).best, maxAltitude: 100000 } };
  assert.equal(tierGoalMet(at, { missions, tierGoals }), true);
});

test('tierGoalMet false for a tier with no goal registered', () => {
  const state = { ...newGame(1), tier: 99, best: { ...newGame(1).best, maxAltitude: 1e9 } };
  assert.equal(tierGoalMet(state, tierGoals), false);
});

test('tierGoalMet tier 2 checks best.bestPeriapsis against the orbit requirement', () => {
  const goalPeriapsis = tierGoals[2].requirement.orbit.periapsis;
  const below = {
    ...newGame(1),
    tier: 2,
    best: { ...newGame(1).best, maxAltitude: 1e9, bestPeriapsis: goalPeriapsis - 1 },
  };
  const at = {
    ...newGame(1),
    tier: 2,
    best: { ...newGame(1).best, maxAltitude: 1e9, bestPeriapsis: goalPeriapsis },
  };
  const never = {
    ...newGame(1),
    tier: 2,
    best: { ...newGame(1).best, maxAltitude: 1e9, bestPeriapsis: null },
  };
  assert.equal(tierGoalMet(below, tierGoals), false);
  assert.equal(tierGoalMet(at, tierGoals), true);
  assert.equal(tierGoalMet(never, tierGoals), false);
});

// =========================================================================
// Phase 2 (ARCHITECTURE.md, "Phase 2 -- tier 3, orbital maneuvering"):
// findTarget/addObject/dockObject, recordLaunch's deploy handling and
// best.bestClosestApproach/best.docked, and tierGoalMet's dock/rendezvous
// shapes.
// =========================================================================

test('findTarget returns null when no object of that kind exists', () => {
  const state = newGame(1);
  assert.equal(findTarget(state, 'core'), null);
});

test('addObject appends to state.objects without mutating the original', () => {
  const state = newGame(1);
  const obj = { id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 1, launch: 1 } };
  const next = addObject(state, obj);
  assert.deepEqual(next.objects, [obj]);
  assert.deepEqual(state.objects, []); // original untouched
});

test('findTarget returns the newest undocked object of a kind, ignoring docked ones and other kinds', () => {
  let state = newGame(1);
  state = addObject(state, { id: 'core-1', kind: 'core', name: 'a', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 1, launch: 1 } });
  state = addObject(state, { id: 'satellite-1', kind: 'satellite', name: 'b', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 1, launch: 2 } });
  state = addObject(state, { id: 'core-2', kind: 'core', name: 'c', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 1, launch: 3 } });
  assert.equal(findTarget(state, 'core').id, 'core-2'); // newest of the two cores
  assert.equal(findTarget(state, 'satellite').id, 'satellite-1');
  assert.equal(findTarget(state, 'module'), null);

  const docked = dockObject(state, 'core-2', 'core-1');
  assert.equal(findTarget(docked, 'core').id, 'core-1', 'core-2 is docked now, so the newest UNDOCKED core is core-1');
});

test('dockObject sets dockedTo on the named object only, without mutating the original', () => {
  let state = newGame(1);
  state = addObject(state, { id: 'core-1', kind: 'core', name: 'a', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 1, launch: 1 } });
  state = addObject(state, { id: 'module-1', kind: 'module', name: 'b', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 1, launch: 2 } });
  const next = dockObject(state, 'module-1', 'core-1');
  assert.equal(next.objects.find((o) => o.id === 'module-1').dockedTo, 'core-1');
  assert.equal(next.objects.find((o) => o.id === 'core-1').dockedTo, null);
  assert.equal(state.objects.find((o) => o.id === 'module-1').dockedTo, null); // original untouched
});

test('recordLaunch applies mission.deploys on a successful outcome, id from kind + a counter', () => {
  const state = newGame(1);
  const mission = { id: 'core', deploys: { kind: 'core', name: 'Station core' } };
  const outcome = { success: true, maxAltitude: 220000, periapsis: 210000, apoapsis: 300000, readout: 'ok' };
  const next = recordLaunch(state, mission, outcome);
  assert.equal(next.objects.length, 1);
  const obj = next.objects[0];
  assert.equal(obj.id, 'core-1');
  assert.equal(obj.kind, 'core');
  assert.equal(obj.name, 'Station core');
  assert.equal(obj.periapsis, 210000);
  assert.equal(obj.apoapsis, 300000);
  assert.equal(typeof obj.phase, 'number');
  assert.ok(obj.phase >= 0 && obj.phase < 1);
  assert.equal(obj.dockedTo, null);
  assert.deepEqual(obj.launchedAt, { tier: 1, launch: 1 });
  assert.deepEqual(state.objects, []); // original untouched
});

test('recordLaunch numbers deployed objects of the same kind sequentially', () => {
  let state = newGame(1);
  const mission = { id: 'satellite', deploys: { kind: 'satellite', name: 'Comsat' } };
  const outcome = { success: true, maxAltitude: 1, periapsis: 150000, apoapsis: 150000, readout: 'ok' };
  state = recordLaunch(state, mission, outcome);
  state = recordLaunch(state, mission, outcome);
  state = recordLaunch(state, mission, outcome);
  assert.deepEqual(state.objects.map((o) => o.id), ['satellite-1', 'satellite-2', 'satellite-3']);
});

test('recordLaunch does not deploy on a failed outcome or a mission with no deploys', () => {
  const state = newGame(1);
  const mission = { id: 'core', deploys: { kind: 'core', name: 'Station core' } };
  const failed = recordLaunch(state, mission, { success: false, maxAltitude: 1, readout: 'x' });
  assert.deepEqual(failed.objects, []);
  const noDeploys = recordLaunch(state, { id: 'sound-1' }, { success: true, maxAltitude: 1, readout: 'x' });
  assert.deepEqual(noDeploys.objects, []);
});

test('recordLaunch prefers outcome.insertion over bare periapsis/apoapsis for a deployed object\'s orbit', () => {
  const state = newGame(1);
  const mission = { id: 'core', deploys: { kind: 'core', name: 'Station core' } };
  const outcome = {
    success: true,
    maxAltitude: 1,
    periapsis: -999, // stale/irrelevant field -- insertion should win
    apoapsis: -999,
    insertion: { t: 600, periapsis: 205000, apoapsis: 298000 },
    readout: 'ok',
  };
  const next = recordLaunch(state, mission, outcome);
  assert.equal(next.objects[0].periapsis, 205000);
  assert.equal(next.objects[0].apoapsis, 298000);
});

test('recordLaunch on a dock success deploys the module already docked to the target, marking nothing else', () => {
  let state = newGame(1);
  state = recordLaunch(
    state,
    { id: 'core', deploys: { kind: 'core', name: 'Station core' } },
    { success: true, maxAltitude: 1, periapsis: 210000, apoapsis: 300000, readout: 'ok' },
  );
  const before = state.objects[0];
  state = recordLaunch(
    state,
    { id: 'dock', deploys: { kind: 'module', name: 'Lab module' } },
    {
      success: true,
      maxAltitude: 1,
      periapsis: 210000,
      docked: true,
      orbital: { target: { id: 'core-1' } },
      closestApproach: 4.2,
      readout: 'Docked to Station core.',
    },
  );
  assert.equal(state.objects.length, 2);
  const module = state.objects.find((o) => o.id === 'module-1');
  assert.ok(module, 'the module should have been deployed');
  assert.equal(module.dockedTo, 'core-1');
  // "marking nothing else": the core itself is not retroactively touched.
  assert.deepEqual(state.objects.find((o) => o.id === 'core-1'), before);
});

test('recordLaunch updates best.bestClosestApproach (min) and best.docked from the outcome', () => {
  const state = newGame(1);
  const first = recordLaunch(state, { id: 'rdv-1' }, { success: false, maxAltitude: 1, closestApproach: 14000, readout: 'x' });
  assert.equal(first.best.bestClosestApproach, 14000);
  assert.equal(first.best.docked, false);

  // A closer approach lowers the running best; a worse one does not raise it.
  const closer = recordLaunch(first, { id: 'rdv-2' }, { success: true, maxAltitude: 1, closestApproach: 480, readout: 'x' });
  assert.equal(closer.best.bestClosestApproach, 480);
  const worse = recordLaunch(closer, { id: 'rdv-2' }, { success: false, maxAltitude: 1, closestApproach: 9000, readout: 'x' });
  assert.equal(worse.best.bestClosestApproach, 480);

  const docked = recordLaunch(worse, { id: 'dock' }, { success: true, maxAltitude: 1, closestApproach: 3, docked: true, readout: 'x' });
  assert.equal(docked.best.docked, true);
  // Once true, a later non-dock outcome must not clear it.
  const afterward = recordLaunch(docked, { id: 'rdv-1' }, { success: false, maxAltitude: 1, readout: 'x' });
  assert.equal(afterward.best.docked, true);
});

test('recordLaunch leaves best.bestClosestApproach/docked untouched when the outcome lacks those fields (old-resolver outcome)', () => {
  const state = { ...newGame(1), best: { ...newGame(1).best, bestClosestApproach: 500, docked: true } };
  const next = recordLaunch(state, { id: 'sound-1' }, { success: true, maxAltitude: 9000, readout: 'x' });
  assert.equal(next.best.bestClosestApproach, 500);
  assert.equal(next.best.docked, true);
});

test('recordLaunch history entries carry closestApproach and docked (null/false when the outcome lacks them)', () => {
  const state = newGame(1);
  const withFields = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 1, closestApproach: 90, docked: true, readout: 'x' });
  assert.equal(withFields.history.at(-1).closestApproach, 90);
  assert.equal(withFields.history.at(-1).docked, true);

  const withoutFields = recordLaunch(state, { id: 'm' }, { success: true, maxAltitude: 1, readout: 'x' });
  assert.equal(withoutFields.history.at(-1).closestApproach, null);
  assert.equal(withoutFields.history.at(-1).docked, false);
});

test('tierGoalMet handles a { dock } requirement: true once any object has dockedTo set', () => {
  const goals = { 3: { requirement: { dock: { target: 'core' } } } };
  const none = newGame(1);
  assert.equal(tierGoalMet(none, goals), false);

  let withCore = addObject(none, { id: 'core-1', kind: 'core', name: 'a', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } });
  withCore = { ...withCore, tier: 3 };
  assert.equal(tierGoalMet(withCore, goals), false, 'a core with no dock yet does not satisfy the goal');

  const withDock = addObject(withCore, { id: 'module-1', kind: 'module', name: 'b', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: 'core-1', launchedAt: { tier: 3, launch: 2 } });
  assert.equal(tierGoalMet(withDock, goals), true);
});

test('tierGoalMet handles a { rendezvous } requirement: true once best.bestClosestApproach <= within', () => {
  const goals = { 3: { requirement: { rendezvous: { target: 'core', within: 5000 } } } };
  const never = { ...newGame(1), tier: 3 };
  assert.equal(tierGoalMet(never, goals), false);

  const far = { ...newGame(1), tier: 3, best: { ...newGame(1).best, bestClosestApproach: 5001 } };
  assert.equal(tierGoalMet(far, goals), false);

  const at = { ...newGame(1), tier: 3, best: { ...newGame(1).best, bestClosestApproach: 5000 } };
  assert.equal(tierGoalMet(at, goals), true);

  const close = { ...newGame(1), tier: 3, best: { ...newGame(1).best, bestClosestApproach: 12 } };
  assert.equal(tierGoalMet(close, goals), true);
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
  assert.equal(vehicle.guidance, 0);
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
