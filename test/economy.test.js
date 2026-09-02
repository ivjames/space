import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credit, debit, canAfford, applyOutcome } from '../js/core/economy.js';

function makeState(overrides = {}) {
  return {
    version: 1,
    seed: 1,
    draws: 0,
    funds: 100,
    reputation: 50,
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

test('credit adds funds without mutating input', () => {
  const state = makeState({ funds: 100 });
  const next = credit(state, { funds: 50 });
  assert.equal(state.funds, 100);
  assert.equal(next.funds, 150);
});

test('credit adds reputation and clamps at 100', () => {
  const state = makeState({ reputation: 95 });
  const next = credit(state, { reputation: 20 });
  assert.equal(next.reputation, 100);
});

test('credit subtracts reputation and clamps at 0', () => {
  const state = makeState({ reputation: 5 });
  const next = credit(state, { reputation: -20 });
  assert.equal(next.reputation, 0);
});

test('credit merges resources additively', () => {
  const state = makeState({ resources: { water: 1, fuel: 0, oxidizer: 0, metals: 0 } });
  const next = credit(state, { resources: { water: 2, metals: 3 } });
  assert.deepEqual(next.resources, { water: 3, fuel: 0, oxidizer: 0, metals: 3 });
  assert.deepEqual(state.resources, { water: 1, fuel: 0, oxidizer: 0, metals: 0 });
});

test('canAfford true when funds and resources suffice', () => {
  const state = makeState({ funds: 100, resources: { water: 5, fuel: 0, oxidizer: 0, metals: 0 } });
  assert.equal(canAfford(state, { funds: 50, resources: { water: 3 } }), true);
});

test('canAfford false when funds insufficient', () => {
  const state = makeState({ funds: 10 });
  assert.equal(canAfford(state, { funds: 50 }), false);
});

test('canAfford false when a resource is insufficient', () => {
  const state = makeState({ resources: { water: 1, fuel: 0, oxidizer: 0, metals: 0 } });
  assert.equal(canAfford(state, { resources: { water: 5 } }), false);
});

test('debit subtracts funds and resources without mutating input', () => {
  const state = makeState({ funds: 100, resources: { water: 5, fuel: 0, oxidizer: 0, metals: 0 } });
  const next = debit(state, { funds: 40, resources: { water: 2 } });
  assert.equal(state.funds, 100);
  assert.equal(next.funds, 60);
  assert.equal(next.resources.water, 3);
});

test('debit throws when unaffordable', () => {
  const state = makeState({ funds: 10 });
  assert.throws(() => debit(state, { funds: 50 }), /unaffordable/i);
});

test('applyOutcome credits payout and repGain on success', () => {
  const state = makeState({ funds: 0, reputation: 0 });
  const mission = { id: 'm', payout: 400, repGain: 2, repLoss: 1 };
  const outcome = { success: true };
  const next = applyOutcome(state, mission, outcome);
  assert.equal(next.funds, 400);
  assert.equal(next.reputation, 2);
});

test('applyOutcome applies repLoss and no payout on failure', () => {
  const state = makeState({ funds: 0, reputation: 10 });
  const mission = { id: 'm', payout: 400, repGain: 2, repLoss: 3 };
  const outcome = { success: false };
  const next = applyOutcome(state, mission, outcome);
  assert.equal(next.funds, 0);
  assert.equal(next.reputation, 7);
});

test('applyOutcome clamps reputation loss at 0', () => {
  const state = makeState({ reputation: 1 });
  const mission = { id: 'm', payout: 400, repGain: 2, repLoss: 5 };
  const next = applyOutcome(state, mission, { success: false });
  assert.equal(next.reputation, 0);
});
