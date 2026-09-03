import { test } from 'node:test';
import { makeRng } from '../js/core/rng.js';
import assert from 'node:assert/strict';
import { generateContracts, floorContract, lockReasons, isEligible, boardStale } from '../js/core/contracts.js';
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

// The ladder's own sets (js/data/tree.js's LADDER notes, tools/balance.mjs):
// what a player who won tier 1, and then tier 2, owns on arrival in the
// next tier. Every gate in js/data/missions.js is the generators of a
// cheapest reaching set, so these are exactly the sets that open each
// tier's board (ARCHITECTURE.md, "js/core/contracts.js", gating rule).
const TIER1_GOAL_SET = ['prop-1', 'prop-2', 'prop-3', 'prop-4', 'struct-1', 'struct-2', 'struct-3'];
const TIER2_GOAL_SET = [...TIER1_GOAL_SET, 'guide-1', 'struct-4', 'struct-5', 'prop-5', 'prop-6', 'struct-6', 'prop-8', 'prop-9'];

test('real tier 2 mission templates are all offered once state.tier is 2 and the tier 2 goal set is owned', () => {
  const state = makeState({ tier: 2, reputation: 100, owned: TIER2_GOAL_SET });
  const rng = fakeRng([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ids = generateContracts(state, realMissions, rng, realMissions.length);
  const tier2Ids = realMissions.filter((m) => m.tier === 2).map((m) => m.id);
  for (const id of tier2Ids) {
    assert.ok(ids.includes(id), `${id} should be offered at tier 2 with reputation 100 and the goal set`);
  }
});

// The bug the first gate guarded against: at tier 2, before buying guide-1,
// the board offered orbit-down-1 (150 km downrange). Without guide-1
// `vehicle.guidance` is 0, pitchProgram (js/core/resolver.js) ignores the
// turn slider, the flight goes straight up, and the contract cannot be
// completed. The rule has since widened from "unflyable without" to "the
// ladder path to it is owned" (ARCHITECTURE.md, gating rule): a contract
// the vehicle cannot fly is never on the board, hard or impossible.
test('real data: orbit-down-1 is NOT offered at tier 2 with full reputation and nothing owned', () => {
  const state = makeState({ tier: 2, reputation: 100, owned: [] });
  const rng = fakeRng([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ids = generateContracts(state, realMissions, rng, realMissions.length);
  assert.ok(!ids.includes('orbit-down-1'), 'orbit-down-1 needs its ladder set to be flyable');
  assert.deepEqual(lockReasons(state, realMissions.find((m) => m.id === 'orbit-down-1')), [
    { kind: 'node', id: 'prop-4' },
    { kind: 'node', id: 'struct-3' },
    { kind: 'node', id: 'guide-1' },
  ]);
});

test('real data: a tier 2 board offers nothing of tier 2 with nothing owned, only the filler with the tier 1 goal set, and every rung with the tier 2 goal set', () => {
  const tier2Ids = realMissions.filter((m) => m.tier === 2).map((m) => m.id);
  assert.ok(tier2Ids.length >= 5, 'the tier 2 ladder should have at least five rungs');
  const draw = (owned) => generateContracts(makeState({ tier: 2, reputation: 100, owned }), realMissions, fakeRng([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), realMissions.length);

  const bareIds = draw([]);
  for (const id of tier2Ids) {
    assert.ok(!bareIds.includes(id), `${id} should not be offered to a vehicle that cannot fly it`);
  }

  // A tier 2 arrival owns the tier 1 goal set: the filler is flyable, the
  // rest of the ladder is not yet.
  const arrivalIds = draw(TIER1_GOAL_SET);
  assert.ok(arrivalIds.includes('orbit-entry'), 'the sounding filler is offerable on arrival');
  for (const id of tier2Ids.filter((i) => i !== 'orbit-entry')) {
    assert.ok(!arrivalIds.includes(id), `${id} should wait for its ladder purchases`);
  }

  // guide-1 alone opens nothing beyond the filler: a turn without the
  // stack is still a vehicle that cannot fly the rung.
  const guidedIds = draw([...TIER1_GOAL_SET, 'guide-1']);
  assert.ok(guidedIds.includes('orbit-down-1'), 'orbit-down-1 needs only the turn on top of the tier 1 goal set');
  assert.ok(!guidedIds.includes('orbit-low'), 'orbit-low needs the third stage');

  const goalIds = draw(TIER2_GOAL_SET);
  for (const id of tier2Ids) {
    assert.ok(goalIds.includes(id), `${id} should be offered once the goal set is owned`);
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
// (it has no requiresObject gate; its requiresNode is the tier 2 goal's
// own gate, which a tier 3 player owns by construction) -- the tier's
// income filler, reachable from the very first tier 3 contract screen.
test('real data: the satellite template is offered at tier 3 with no objects deployed', () => {
  const state = makeState({ tier: 3, reputation: 100, objects: [], owned: TIER2_GOAL_SET });
  const rng = fakeRng([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ids = generateContracts(state, realMissions, rng, realMissions.length);
  assert.ok(ids.includes('satellite'));
});

test('real data: the dock template is offered only once a core object exists and every listed node is owned', () => {
  const core = { id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } };
  const dock = realMissions.find((m) => m.id === 'dock');
  const dockNodes = [].concat(dock.requiresNode);
  assert.ok(dockNodes.includes('struct-module'));

  const withoutEither = makeState({ tier: 3, reputation: 100, objects: [], owned: [] });
  const idsWithoutEither = generateContracts(withoutEither, realMissions, fakeRng([0, 1, 2, 3, 4]), realMissions.length);
  assert.ok(!idsWithoutEither.includes('dock'));

  const withCoreOnly = makeState({ tier: 3, reputation: 100, objects: [core], owned: [] });
  const idsWithCoreOnly = generateContracts(withCoreOnly, realMissions, fakeRng([0, 1, 2, 3, 4]), realMissions.length);
  assert.ok(!idsWithCoreOnly.includes('dock'), 'requiresNode still unmet');

  // The module alone is not enough: the docking flight also needs the
  // restarts and the sensors, and the array form means ALL of them.
  const withModuleOnly = makeState({ tier: 3, reputation: 100, objects: [core], owned: ['struct-module'] });
  const idsWithModuleOnly = generateContracts(withModuleOnly, realMissions, fakeRng([0, 1, 2, 3, 4]), realMissions.length);
  assert.ok(!idsWithModuleOnly.includes('dock'), 'struct-module alone does not make a docking flight possible');
  const reasons = lockReasons(withModuleOnly, dock);
  assert.ok(reasons.every((r) => r.kind === 'node'), 'only node gates should remain');
  assert.deepEqual(reasons.map((r) => r.id), dockNodes.filter((id) => id !== 'struct-module'));

  const withBoth = makeState({ tier: 3, reputation: 100, objects: [core], owned: dockNodes });
  const idsWithBoth = generateContracts(withBoth, realMissions, fakeRng([0, 1, 2, 3, 4]), realMissions.length);
  assert.ok(idsWithBoth.includes('dock'));
});

// =========================================================================
// lockReasons / isEligible: the shapes the UI reads to explain a locked
// contract (ARCHITECTURE.md, "js/core/contracts.js").
// =========================================================================

const gatedTemplate = {
  id: 'gated',
  tier: 3,
  minReputation: 50,
  requiresNode: ['n-a', 'n-b', 'n-c'],
  requiresObject: 'core',
  payout: 1,
  repGain: 0,
  repLoss: 0,
  requirement: { rendezvous: { target: 'core', within: 5000 } },
};
const coreObject = { id: 'core-1', kind: 'core', name: 'Station core', periapsis: 1, apoapsis: 1, phase: 0, dockedTo: null, launchedAt: { tier: 3, launch: 1 } };

test('lockReasons is empty when every gate is met', () => {
  const state = makeState({ tier: 3, reputation: 50, owned: ['n-a', 'n-b', 'n-c'], objects: [coreObject] });
  assert.deepEqual(lockReasons(state, gatedTemplate), []);
  assert.equal(isEligible(state, gatedTemplate), true);
});

test('lockReasons reports tier, reputation, every missing node in template order, and object, in that order', () => {
  const state = makeState({ tier: 2, reputation: 20, owned: ['n-b'], objects: [] });
  assert.deepEqual(lockReasons(state, gatedTemplate), [
    { kind: 'tier', tier: 3 },
    { kind: 'reputation', need: 50, have: 20 },
    { kind: 'node', id: 'n-a' },
    { kind: 'node', id: 'n-c' },
    { kind: 'object', objectKind: 'core' },
  ]);
  assert.equal(isEligible(state, gatedTemplate), false);
});

test('lockReasons reports unique last, only while an undocked object of the deployed kind exists', () => {
  const uniqueTemplate = {
    id: 'u', tier: 1, unique: true, deploys: { kind: 'core', name: 'Station core' },
    payout: 1, repGain: 0, repLoss: 0, requirement: { orbit: { periapsis: 1 } },
  };
  const undocked = makeState({ tier: 1, objects: [coreObject] });
  assert.deepEqual(lockReasons(undocked, uniqueTemplate), [{ kind: 'unique', objectKind: 'core' }]);
  const docked = makeState({ tier: 1, objects: [{ ...coreObject, dockedTo: 'somewhere' }] });
  assert.deepEqual(lockReasons(docked, uniqueTemplate), []);
  // Ordering: a unique reason follows a node reason for the same template.
  const both = makeState({ tier: 1, objects: [coreObject] });
  assert.deepEqual(lockReasons(both, { ...uniqueTemplate, requiresNode: 'x' }), [
    { kind: 'node', id: 'x' },
    { kind: 'unique', objectKind: 'core' },
  ]);
});

test('lockReasons accepts the string form of requiresNode unchanged', () => {
  const t = { id: 's', tier: 1, requiresNode: 'only', payout: 1, repGain: 0, repLoss: 0, requirement: { altitude: 1 } };
  assert.deepEqual(lockReasons(makeState({ owned: [] }), t), [{ kind: 'node', id: 'only' }]);
  assert.deepEqual(lockReasons(makeState({ owned: ['only'] }), t), []);
});

test('lockReasons ignores floor, but isEligible is false for the floor contract', () => {
  const floor = missions.find((m) => m.floor);
  const state = makeState();
  assert.deepEqual(lockReasons(state, floor), []);
  assert.equal(isEligible(state, floor), false);
});

test('the array form of requiresNode is offered only once every listed node is owned', () => {
  const pool = [
    missions[0],
    { id: 'multi', tier: 1, requiresNode: ['n-a', 'n-b'], payout: 1, repGain: 0, repLoss: 0, requirement: { altitude: 1 } },
  ];
  const draw = (owned) => generateContracts(makeState({ owned }), pool, fakeRng([0, 0, 0]), 3);
  assert.ok(!draw([]).includes('multi'));
  assert.ok(!draw(['n-a']).includes('multi'), 'one of two is not enough');
  assert.ok(!draw(['n-b']).includes('multi'), 'one of two is not enough');
  assert.ok(draw(['n-a', 'n-b']).includes('multi'));
  assert.ok(draw(['n-b', 'n-a', 'other']).includes('multi'), 'order and extra nodes do not matter');
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

// =========================================================================
// boardStale: when a board drawn earlier should be redrawn without a launch.
// =========================================================================

const staleMissions = [
  { id: 'f', tier: 1, floor: true, requirement: { altitude: 1 }, payout: 1, repGain: 0, repLoss: 0 },
  { id: 'a1', tier: 1, requirement: { altitude: 2 }, payout: 1, repGain: 0, repLoss: 0 },
  { id: 'a2', tier: 1, requirement: { altitude: 3 }, payout: 1, repGain: 0, repLoss: 0 },
  { id: 'b0', tier: 2, requirement: { altitude: 4 }, payout: 1, repGain: 0, repLoss: 0 },
  { id: 'b1', tier: 2, requirement: { downrange: 5 }, payout: 1, repGain: 0, repLoss: 0, requiresNode: 'guide-1' },
  { id: 'b2', tier: 2, requirement: { downrange: 6 }, payout: 1, repGain: 0, repLoss: 0, requiresNode: 'guide-1' },
  { id: 'b3', tier: 2, requirement: { downrange: 7 }, payout: 1, repGain: 0, repLoss: 0, requiresNode: 'guide-1', minReputation: 50 },
];

test('boardStale: an empty board is stale', () => {
  assert.equal(boardStale({ tier: 2, reputation: 0, owned: [], contracts: [] }, staleMissions), true);
  assert.equal(boardStale({ tier: 2, reputation: 0, owned: [] }, staleMissions), true);
});

test('boardStale: a board holding an offer the state no longer qualifies for is stale', () => {
  // Drawn under an older build with no guidance gate; the player owns nothing.
  const state = { tier: 2, reputation: 0, owned: [], contracts: ['f', 'b1', 'b0'] };
  assert.equal(boardStale(state, staleMissions), true);
});

test('boardStale: an offer whose template no longer exists makes the board stale', () => {
  const state = { tier: 2, reputation: 0, owned: ['guide-1'], contracts: ['f', 'gone', 'b0'] };
  assert.equal(boardStale(state, staleMissions), true);
});

test('boardStale: a board that reached back to an earlier tier goes stale once a purchase unlocks a current-tier contract', () => {
  // Before guide-1: only b0 is eligible at tier 2, so the second slot fell
  // back to tier 1. That board is not stale while nothing has changed...
  const before = { tier: 2, reputation: 0, owned: [], contracts: ['f', 'b0', 'a1'] };
  assert.equal(boardStale(before, staleMissions), false);
  // ...and is the moment guide-1 makes b1/b2 eligible.
  const after = { ...before, owned: ['guide-1'] };
  assert.equal(boardStale(after, staleMissions), true);
});

test('boardStale: a board short of its slots goes stale the same way', () => {
  const short = { tier: 2, reputation: 0, owned: [], contracts: ['f', 'b0'] };
  assert.equal(boardStale(short, staleMissions), false);
  assert.equal(boardStale({ ...short, owned: ['guide-1'] }, staleMissions), true);
});

test('boardStale: a full board of eligible current-tier offers is never stale, so a purchase is not a re-roll', () => {
  const state = { tier: 2, reputation: 0, owned: ['guide-1'], contracts: ['f', 'b0', 'b1'] };
  assert.equal(boardStale(state, staleMissions), false);
  // b3 becoming eligible (reputation crosses its gate) changes nothing:
  // both drawn slots are still filled from this tier.
  assert.equal(boardStale({ ...state, reputation: 100 }, staleMissions), false);
});

test('boardStale: the floor contract never counts as a drawn slot and never makes a board stale', () => {
  // Tier 1: slots are the two non-floor rows; a board of floor + two tier 1
  // offers is full.
  const full = { tier: 1, reputation: 0, owned: [], contracts: ['f', 'a1', 'a2'] };
  assert.equal(boardStale(full, staleMissions), false);
  // Tier 2 with only the floor drawn is short, and a2 (tier 1) is eligible
  // but not current-tier, so nothing to redraw for yet.
  const onlyFloor = { tier: 2, reputation: 0, owned: [], contracts: ['f'] };
  const withoutB0 = staleMissions.filter((m) => m.id !== 'b0');
  assert.equal(boardStale(onlyFloor, withoutB0), false);
});

test('boardStale agrees with generateContracts: a freshly drawn board is never stale', () => {
  for (const owned of [[], ['guide-1']]) {
    for (let seed = 1; seed < 20; seed += 1) {
      const state = { tier: 2, reputation: 100, owned, objects: [] };
      const contracts = generateContracts(state, staleMissions, makeRng(seed), 3);
      assert.equal(boardStale({ ...state, contracts }, staleMissions), false, `seed ${seed} owned ${owned}`);
    }
  }
});
