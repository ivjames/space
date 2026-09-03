import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTree, branches, canBuy, buy, collectEffects, branchExhausted } from '../js/core/tree.js';
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

test('branches returns propulsion, structure, guidance, reliability in that order', () => {
  const tree = loadTree(nodes);
  const bs = branches(tree);
  assert.deepEqual(
    bs.map((b) => b.id),
    ['propulsion', 'structure', 'guidance', 'reliability'],
  );
});

test('branches(tree, 1) hides tier 2 nodes', () => {
  const tree = loadTree(nodes);
  const bs = branches(tree, 1);
  for (const b of bs) {
    for (const node of b.nodes) {
      assert.equal(node.tier ?? 1, 1, `${node.id} should not appear under maxTier 1`);
    }
  }
  // Every tier 1 node is still there.
  const tier1Ids = nodes.filter((n) => (n.tier ?? 1) === 1).map((n) => n.id);
  const seenIds = bs.flatMap((b) => b.nodes.map((n) => n.id));
  assert.deepEqual([...seenIds].sort(), [...tier1Ids].sort());
});

test('branches(tree) with no maxTier includes tier 2 nodes', () => {
  const tree = loadTree(nodes);
  const bs = branches(tree);
  const seenIds = bs.flatMap((b) => b.nodes.map((n) => n.id));
  assert.ok(nodes.some((n) => (n.tier ?? 1) === 2), 'sanity: data should have tier 2 nodes');
  assert.equal(seenIds.length, nodes.length);
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

test('canBuy refuses a tier 2 node while state.tier is 1', () => {
  const tree = loadTree(nodes);
  const tier2Node = nodes.find((n) => (n.tier ?? 1) === 2);
  assert.ok(tier2Node, 'sanity: data should have at least one tier 2 node');
  // Fully fund and own every prerequisite so tier is the only blocker.
  const owned = [];
  const seen = new Set();
  function addWithPrereqs(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const node = tree.byId.get(id);
    for (const req of node.requires ?? []) addWithPrereqs(req);
    owned.push(id);
  }
  for (const req of tier2Node.requires ?? []) addWithPrereqs(req);
  const state = makeState({ funds: 1e9, tier: 1, owned });
  assert.equal(canBuy(tree, state, tier2Node.id), false);
});

test('canBuy allows a tier 2 node once state.tier reaches 2', () => {
  const tree = loadTree(nodes);
  const tier2Node = nodes.find((n) => (n.tier ?? 1) === 2);
  const owned = [];
  const seen = new Set();
  function addWithPrereqs(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const node = tree.byId.get(id);
    for (const req of node.requires ?? []) addWithPrereqs(req);
    owned.push(id);
  }
  for (const req of tier2Node.requires ?? []) addWithPrereqs(req);
  const state = makeState({ funds: 1e9, tier: 2, owned });
  assert.equal(canBuy(tree, state, tier2Node.id), true);
});

test('loadTree throws when a node requires a higher-tier prerequisite', () => {
  const bad = [
    { id: 'a', branch: 'propulsion', level: 1, tier: 1, cost: { funds: 1 }, requires: ['b'], effects: [] },
    { id: 'b', branch: 'propulsion', level: 2, tier: 2, cost: { funds: 1 }, requires: [], effects: [] },
  ];
  assert.throws(() => loadTree(bad), /higher tier|tier/i);
});

test('loadTree accepts a tier 2 node requiring a tier 1 prerequisite', () => {
  const ok = [
    { id: 'a', branch: 'propulsion', level: 1, tier: 1, cost: { funds: 1 }, requires: [], effects: [] },
    { id: 'b', branch: 'propulsion', level: 2, tier: 2, cost: { funds: 1 }, requires: ['a'], effects: [] },
  ];
  assert.doesNotThrow(() => loadTree(ok));
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

test('collectEffects hoists every addStage effect before other effects', () => {
  // struct-4 (structure) adds stage 1; a tier 2 propulsion node muls
  // stages.1.isp. Branch order alone would run propulsion (and its
  // stages.1 effect) before structure's addStage — collectEffects must
  // reorder so every addStage runs first regardless of branch.
  const tree = loadTree(nodes);
  const vacuumNode = nodes.find(
    (n) => n.branch === 'propulsion' && n.effects.some((e) => e.stat === 'stages.1.isp'),
  );
  assert.ok(vacuumNode, 'sanity: data should have a stage-1-isp propulsion effect');
  const owned = [];
  const seen = new Set();
  function addWithPrereqs(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const node = tree.byId.get(id);
    for (const req of node.requires ?? []) addWithPrereqs(req);
    owned.push(id);
  }
  addWithPrereqs(vacuumNode.id);
  const effects = collectEffects(tree, makeState({ owned }));
  const addStageIndex = effects.findIndex((e) => e.addStage !== undefined);
  const stage1IspIndex = effects.findIndex((e) => e.stat === 'stages.1.isp');
  assert.ok(addStageIndex !== -1, 'sanity: the addStage effect should be present');
  assert.ok(stage1IspIndex !== -1, 'sanity: the stages.1.isp effect should be present');
  assert.ok(addStageIndex < stage1IspIndex, 'addStage must come before the effect targeting it');
});

test('branchExhausted: true only when every node of the branch at or below the tier is owned', () => {
  const tree = loadTree(nodes);
  const ids = (branch, maxTier) => nodes.filter((n) => n.branch === branch && (n.tier ?? 1) <= maxTier).map((n) => n.id);
  const tier2Prop = ids('propulsion', 2);
  const tier2Struct = ids('structure', 2);
  assert.ok(tier2Prop.length > 0 && tier2Struct.length > 0);

  // Empty tree at tier 2: nothing owned, nothing exhausted.
  assert.equal(branchExhausted(tree, makeState({ tier: 2 }), 'propulsion'), false);

  // Every tier 1 + 2 propulsion node owned: exhausted at tier 2, but funds
  // and prerequisites play no part (funds 0 here).
  const maxed = makeState({ tier: 2, owned: [...tier2Prop, ...tier2Struct] });
  assert.equal(branchExhausted(tree, maxed, 'propulsion'), true);
  assert.equal(branchExhausted(tree, maxed, 'structure'), true);
  assert.equal(branchExhausted(tree, maxed, 'guidance'), false);

  // A branch with nothing at or below the tier is exhausted too: guidance
  // has no tier 1 node, so at tier 1 there is nothing in it to point at.
  assert.equal(ids('guidance', 1).length, 0);
  assert.equal(branchExhausted(tree, makeState({ tier: 1 }), 'guidance'), true);

  // One node short is not exhausted.
  const short = makeState({ tier: 2, owned: tier2Prop.slice(1) });
  assert.equal(branchExhausted(tree, short, 'propulsion'), false);

  // The same owned set is NOT exhausted once tier 3 opens more of the branch.
  const tier3 = makeState({ tier: 3, owned: [...tier2Prop, ...tier2Struct] });
  assert.equal(branchExhausted(tree, tier3, 'propulsion'), ids('propulsion', 3).length === tier2Prop.length);
});
