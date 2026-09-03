import { test } from 'node:test';
import { makeRng } from '../js/core/rng.js';
import assert from 'node:assert/strict';
import { generateContracts, floorContract } from '../js/core/contracts.js';
import { missions as realMissions } from '../js/data/missions.js';

// Deterministic fake rng: pulls from a fixed sequence of "random" indices.
function fakeRng(sequence) {
  let i = 0;
  return {
    int(n) {
      const v = sequence[i % sequence.length] % n;
      i += 1;
      return v;
    },
  };
}

const missions = [
  { id: 'floor', tier: 1, floor: true, payout: 400, repGain: 1, repLoss: 0, requirement: { altitude: 20000 } },
  { id: 'a', tier: 1, payout: 700, repGain: 1, repLoss: 1, requirement: { altitude: 40000 } },
  { id: 'b', tier: 1, payout: 1100, repGain: 2, repLoss: 1, requirement: { altitude: 60000 } },
  { id: 'c', tier: 2, payout: 5000, repGain: 3, repLoss: 2, requirement: { altitude: 200000 } },
  { id: 'd', tier: 1, minReputation: 50, payout: 1600, repGain: 2, repLoss: 2, requirement: { altitude: 80000 } },
];

function makeState(overrides = {}) {
  return {
    version: 1,
    seed: 1,
    draws: 0,
    funds: 0,
    reputation: 0,
    resources: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
    owned: [],
    tier: 1,
    launches: { 1: 0 },
    best: { maxAltitude: 0 },
    contracts: [],
    history: [],
    ...overrides,
  };
}

test('floorContract returns the single floor: true template', () => {
  const m = floorContract(missions);
  assert.equal(m.id, 'floor');
});

test('floorContract throws when there is not exactly one floor mission', () => {
  assert.throws(() => floorContract([]), /exactly one/i);
  assert.throws(
    () => floorContract([...missions, { ...missions[0], id: 'floor2' }]),
    /exactly one/i,
  );
});

test('generateContracts always puts the floor contract first', () => {
  const state = makeState();
  const rng = fakeRng([0, 0, 0]);
  const ids = generateContracts(state, missions, rng, 3);
  assert.equal(ids[0], 'floor');
});

test('generateContracts excludes templates above state.tier', () => {
  const state = makeState({ tier: 1 });
  const rng = fakeRng([0, 1, 2, 3, 4, 5]);
  const ids = generateContracts(state, missions, rng, 10);
  assert.ok(!ids.includes('c'), 'tier 2 mission c should not appear for a tier 1 state');
});

test('generateContracts excludes templates whose minReputation is not met', () => {
  const state = makeState({ tier: 1, reputation: 10 });
  const rng = fakeRng([0, 1, 2, 3, 4]);
  const ids = generateContracts(state, missions, rng, 10);
  assert.ok(!ids.includes('d'));
});

test('generateContracts includes a gated template once reputation is high enough', () => {
  const state = makeState({ tier: 1, reputation: 60 });
  const rng = fakeRng([0, 1, 2, 3, 4]);
  const ids = generateContracts(state, missions, rng, 10);
  assert.ok(ids.includes('d'));
});

test('generateContracts draws without replacement (no duplicate ids)', () => {
  const state = makeState({ tier: 1, reputation: 100 });
  const rng = fakeRng([0, 0, 0, 0, 0]);
  const ids = generateContracts(state, missions, rng, 4);
  assert.equal(new Set(ids).size, ids.length);
});

test('generateContracts respects count', () => {
  const state = makeState({ tier: 1, reputation: 100 });
  const rng = fakeRng([2, 1, 0]);
  const ids = generateContracts(state, missions, rng, 3);
  assert.equal(ids.length, 3);
});

// Real tier 2 data (js/data/missions.js), not the hand-written fake
// templates above: confirms the real tier 2 mission ladder is invisible at
// tier 1 and reachable once state.tier is 2, at full reputation so
// minReputation gates cannot be the thing hiding it.
test('real tier 2 mission templates are not offered at tier 1', () => {
  const state = makeState({ tier: 1, reputation: 100 });
  const rng = fakeRng([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ids = generateContracts(state, realMissions, rng, realMissions.length);
  const tier2Ids = new Set(realMissions.filter((m) => m.tier === 2).map((m) => m.id));
  assert.ok(ids.every((id) => !tier2Ids.has(id)), 'no tier 2 template should be offered at tier 1');
});

test('real tier 2 mission templates are offered once state.tier is 2', () => {
  const state = makeState({ tier: 2, reputation: 100 });
  const rng = fakeRng([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ids = generateContracts(state, realMissions, rng, realMissions.length);
  const tier2Ids = realMissions.filter((m) => m.tier === 2).map((m) => m.id);
  for (const id of tier2Ids) {
    assert.ok(ids.includes(id), `${id} should be offered at tier 2 with reputation 100`);
  }
});

test('generateContracts uses rng.int for its draws', () => {
  const state = makeState({ tier: 1, reputation: 100 });
  let calls = 0;
  const rng = {
    int(n) {
      calls += 1;
      return 0 % n;
    },
  };
  generateContracts(state, missions, rng, 3);
  assert.equal(calls, 2); // count - 1 draws
});

// =========================================================================
// Phase 2 (ARCHITECTURE.md, "Persistent objects in orbit" / "js/data/
// missions.js -- tier 3 ladder"): unique, requiresObject, requiresNode.
// =========================================================================

const objectMissions = [
  { id: 'floor', tier: 1, floor: true, payout: 400, repGain: 1, repLoss: 0, requirement: { altitude: 20000 } },
  {
    id: 'core',
    tier: 3,
    unique: true,
    deploys: { kind: 'core', name: 'Station core' },
    payout: 22000,
    repGain: 7,
    repLoss: 4,
    requirement: { orbit: { periapsis: 200000 } },
  },
  {
    id: 'satellite',
    tier: 3,
    deploys: { kind: 'satellite', name: 'Comsat' },
    payout: 15000,
    repGain: 5,
    repLoss: 3,
    requirement: { orbit: { periapsis: 150000 } },
  },
  {
    id: 'rdv-1',
    tier: 3,
    requiresObject: 'core',
    payout: 18000,
    repGain: 6,
    repLoss: 4,
    requirement: { rendezvous: { target: 'core', within: 5000 } },
  },
  {
    id: 'dock',
    tier: 3,
    requiresObject: 'core',
    requiresNode: 'struct-module',
    deploys: { kind: 'module', name: 'Lab module' },
    payout: 40000,
    repGain: 10,
    repLoss: 6,
    requirement: { dock: { target: 'core' } },
  },
];

function objectState(overrides = {}) {
  return makeState({ tier: 3, reputation: 100, objects: [], owned: [], ...overrides });
}

test('unique: true -- the core template is offered while no undocked core exists', () => {
  const state = objectState();
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(ids.includes('core'));
});

test('unique: true -- the core template is NOT offered while an undocked core already exists', () => {
  const state = objectState({
    objects: [{ id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } }],
  });
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(!ids.includes('core'));
});

test('unique: true -- the core template IS offered again once the existing core is docked', () => {
  const state = objectState({
    objects: [{ id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: 'somewhere', launchedAt: { tier: 3, launch: 1 } }],
  });
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(ids.includes('core'));
});

test('requiresObject: not offered while no object of that kind exists', () => {
  const state = objectState();
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(!ids.includes('rdv-1'));
  assert.ok(!ids.includes('dock'));
});

test('requiresObject: offered once an object of that kind exists', () => {
  const state = objectState({
    objects: [{ id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } }],
  });
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(ids.includes('rdv-1'), 'requiresObject alone should be enough for rdv-1');
  assert.ok(!ids.includes('dock'), 'dock also needs requiresNode, still unmet');
});

test('requiresNode: not offered until the named node is owned', () => {
  const state = objectState({
    objects: [{ id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } }],
    owned: [],
  });
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(!ids.includes('dock'));
});

test('requiresNode: offered once the named node is owned (and requiresObject is also met)', () => {
  const state = objectState({
    objects: [{ id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } }],
    owned: ['struct-module'],
  });
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(ids.includes('dock'));
});

// A repeatable (non-unique) template must stay offerable no matter how
// many objects of its kind already exist -- unlike `core`'s `unique: true`
// gate above, `satellite` carries no such flag.
test('a repeatable template (no unique flag) can be offered any number of times', () => {
  const manySatellites = Array.from({ length: 12 }, (_, i) => ({
    id: `satellite-${i + 1}`,
    kind: 'satellite',
    name: 'Comsat',
    periapsis: 1,
    apoapsis: 1,
    phase: 0,
    dockedTo: null,
    launchedAt: { tier: 3, launch: i + 1 },
  }));
  const state = objectState({ objects: manySatellites });
  const rng = fakeRng([0, 1, 2, 3]);
  const ids = generateContracts(state, objectMissions, rng, objectMissions.length);
  assert.ok(ids.includes('satellite'), 'a repeatable template stays offered regardless of how many objects of its kind exist');
});

// Real tier 3 data (js/data/missions.js): `satellite` has no `unique`
// flag and is offered at tier 3 with no objects deployed at all yet
// (it has no requiresObject/requiresNode gate either) -- the tier's
// income filler, reachable from the very first tier 3 contract screen.
test('real data: the satellite template is offered at tier 3 with no objects deployed', () => {
  const state = makeState({ tier: 3, reputation: 100, objects: [], owned: [] });
  const rng = fakeRng([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ids = generateContracts(state, realMissions, rng, realMissions.length);
  assert.ok(ids.includes('satellite'));
});

test('real data: the dock template is offered only once a core object exists and struct-module is owned', () => {
  const withoutEither = makeState({ tier: 3, reputation: 100, objects: [], owned: [] });
  const idsWithoutEither = generateContracts(withoutEither, realMissions, fakeRng([0, 1, 2, 3, 4]), realMissions.length);
  assert.ok(!idsWithoutEither.includes('dock'));

  const withCoreOnly = makeState({
    tier: 3,
    reputation: 100,
    objects: [{ id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } }],
    owned: [],
  });
  const idsWithCoreOnly = generateContracts(withCoreOnly, realMissions, fakeRng([0, 1, 2, 3, 4]), realMissions.length);
  assert.ok(!idsWithCoreOnly.includes('dock'), 'requiresNode still unmet');

  const withBoth = makeState({
    tier: 3,
    reputation: 100,
    objects: [{ id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } }],
    owned: ['struct-module'],
  });
  const idsWithBoth = generateContracts(withBoth, realMissions, fakeRng([0, 1, 2, 3, 4]), realMissions.length);
  assert.ok(idsWithBoth.includes('dock'));
});

test('the board draws from the current tier first and reaches back only to fill', () => {
  const missions = [
    { id: 'f', tier: 1, floor: true, requirement: { altitude: 1 }, payout: 1, repGain: 0, repLoss: 0 },
    { id: 'a1', tier: 1, requirement: { altitude: 2 }, payout: 1, repGain: 0, repLoss: 0 },
    { id: 'a2', tier: 1, requirement: { altitude: 3 }, payout: 1, repGain: 0, repLoss: 0 },
    { id: 'b1', tier: 2, requirement: { altitude: 4 }, payout: 1, repGain: 0, repLoss: 0 },
    { id: 'b2', tier: 2, requirement: { altitude: 5 }, payout: 1, repGain: 0, repLoss: 0 },
    { id: 'b3', tier: 2, requirement: { altitude: 6 }, payout: 1, repGain: 0, repLoss: 0, minReputation: 50 },
  ];
  const at2 = { tier: 2, reputation: 0, owned: [], objects: [] };
  for (let seed = 1; seed < 40; seed += 1) {
    const ids = generateContracts(at2, missions, makeRng(seed), 3);
    assert.equal(ids[0], 'f');
    assert.deepEqual(ids.slice(1).sort(), ['b1', 'b2'], `seed ${seed} drew ${ids}`);
  }
  // Only one tier 2 template eligible: the second slot falls back to tier 1.
  const gated = missions.map((m) => (m.id === 'b2' ? { ...m, minReputation: 50 } : m));
  const ids = generateContracts(at2, gated, makeRng(3), 3);
  assert.ok(ids.includes('b1'));
  assert.ok(ids.some((id) => id === 'a1' || id === 'a2'));
});
