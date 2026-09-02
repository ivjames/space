import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateContracts, floorContract } from '../js/core/contracts.js';

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
