import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTree, branches, canBuy, buy, collectEffects } from '../js/core/tree.js';
import { nodes } from '../js/data/tree.js';

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

test('loadTree loads the real tier 1 data without throwing', () => {
  const tree = loadTree(nodes);
  assert.equal(tree.nodes.length, nodes.length);
});

test('loadTree throws on duplicate id', () => {
  const dup = [
    { id: 'a', branch: 'propulsion', level: 1, cost: { funds: 1 }, requires: [], effects: [] },
    { id: 'a', branch: 'propulsion', level: 2, cost: { funds: 1 }, requires: [], effects: [] },
  ];
  assert.throws(() => loadTree(dup), /duplicate/i);
});

test('loadTree throws on missing prereq', () => {
  const bad = [
    {
      id: 'a',
      branch: 'propulsion',
      level: 1,
      cost: { funds: 1 },
      requires: ['nope'],
      effects: [],
    },
  ];
  assert.throws(() => loadTree(bad), /missing/i);
});

test('loadTree throws on cycle', () => {
  const cyclic = [
    { id: 'a', branch: 'p', level: 1, cost: { funds: 1 }, requires: ['b'], effects: [] },
    { id: 'b', branch: 'p', level: 2, cost: { funds: 1 }, requires: ['a'], effects: [] },
  ];
  assert.throws(() => loadTree(cyclic), /cycle/i);
});

test('loadTree accepts a self-referencing-free longer cycle (a->b->c->a)', () => {
  const cyclic = [
    { id: 'a', branch: 'p', level: 1, cost: { funds: 1 }, requires: ['c'], effects: [] },
    { id: 'b', branch: 'p', level: 2, cost: { funds: 1 }, requires: ['a'], effects: [] },
    { id: 'c', branch: 'p', level: 3, cost: { funds: 1 }, requires: ['b'], effects: [] },
  ];
  assert.throws(() => loadTree(cyclic), /cycle/i);
});

test('branches returns propulsion, structure, reliability in that order', () => {
  const tree = loadTree(nodes);
  const bs = branches(tree);
  assert.deepEqual(
    bs.map((b) => b.id),
    ['propulsion', 'structure', 'reliability'],
  );
});

test('branches sorts nodes by level within a branch', () => {
  const tree = loadTree(nodes);
  const bs = branches(tree);
  for (const b of bs) {
    const levels = b.nodes.map((n) => n.level);
    const sorted = [...levels].sort((x, y) => x - y);
    assert.deepEqual(levels, sorted);
  }
});

test('canBuy is false when prereqs are not owned', () => {
  const tree = loadTree(nodes);
  const state = makeState({ funds: 100000 });
  assert.equal(canBuy(tree, state, 'prop-2'), false);
});

test('canBuy is false when unaffordable', () => {
  const tree = loadTree(nodes);
  const state = makeState({ funds: 0 });
  assert.equal(canBuy(tree, state, 'prop-1'), false);
});

test('canBuy is false when already owned', () => {
  const tree = loadTree(nodes);
  const state = makeState({ funds: 100000, owned: ['prop-1'] });
  assert.equal(canBuy(tree, state, 'prop-1'), false);
});

test('canBuy is true when prereqs owned and affordable', () => {
  const tree = loadTree(nodes);
  const state = makeState({ funds: 100000 });
  assert.equal(canBuy(tree, state, 'prop-1'), true);
});

test('buy returns a new state, debits cost, and adds the node to owned', () => {
  const tree = loadTree(nodes);
  const state = makeState({ funds: 1000 });
  const next = buy(tree, state, 'prop-1');
  assert.notEqual(next, state);
  assert.deepEqual(state.owned, []); // original untouched
  assert.deepEqual(next.owned, ['prop-1']);
  assert.equal(next.funds, 1000 - 500);
});

test('buy throws when not canBuy', () => {
  const tree = loadTree(nodes);
  const state = makeState({ funds: 0 });
  assert.throws(() => buy(tree, state, 'prop-1'), /cannot buy/i);
});

test('collectEffects is empty for a fresh state', () => {
  const tree = loadTree(nodes);
  const state = makeState();
  assert.deepEqual(collectEffects(tree, state), []);
});

test('collectEffects orders effects by branch order then level', () => {
  const tree = loadTree(nodes);
  // Own one node from each branch, in a scrambled order, plus prereqs.
  const state = makeState({ owned: ['rel-1', 'struct-1', 'prop-1'] });
  const effects = collectEffects(tree, state);
  // prop-1 effects first (2), then struct-1 effects (2), then rel-1 (1).
  assert.deepEqual(effects, [
    { stat: 'stages.0.thrust', op: 'mul', value: 1.1 },
    { stat: 'stages.0.isp', op: 'mul', value: 1.05 },
    { stat: 'stages.0.propMass', op: 'add', value: 15 },
    { stat: 'stages.0.dryMass', op: 'add', value: 5 },
    { stat: 'stages.0.reliability', op: 'mul', value: 1.08 },
  ]);
});

test('collectEffects only includes owned nodes', () => {
  const tree = loadTree(nodes);
  const state = makeState({ owned: ['prop-1'] });
  const effects = collectEffects(tree, state);
  assert.equal(effects.length, 2);
});
