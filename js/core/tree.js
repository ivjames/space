// Tech tree: load/validate, query, buy. Pure. See ARCHITECTURE.md.
import { canAfford, debit } from './economy.js';

const BRANCH_ORDER = ['propulsion', 'structure', 'reliability'];
const BRANCH_NAMES = {
  propulsion: 'Propulsion',
  structure: 'Structure',
  reliability: 'Reliability',
};

// loadTree(nodes) -> tree
// Validates: duplicate ids, missing prereqs, cycles (DFS). Throws on any
// violation. Returns a tree object with an id -> node lookup map.
export function loadTree(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`);
    }
    byId.set(node.id, node);
  }

  for (const node of nodes) {
    for (const req of node.requires ?? []) {
      if (!byId.has(req)) {
        throw new Error(`node ${node.id} requires missing node ${req}`);
      }
    }
  }

  // Cycle detection: classic 3-color DFS.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(nodes.map((n) => [n.id, WHITE]));

  function visit(id, path) {
    const state = color.get(id);
    if (state === BLACK) return;
    if (state === GRAY) {
      throw new Error(`cycle detected in tech tree: ${[...path, id].join(' -> ')}`);
    }
    color.set(id, GRAY);
    const node = byId.get(id);
    for (const req of node.requires ?? []) {
      visit(req, [...path, id]);
    }
    color.set(id, BLACK);
  }

  for (const node of nodes) {
    visit(node.id, []);
  }

  return { nodes: [...nodes], byId };
}

// branches(tree) -> [{ id, name, nodes: [ordered by level] }]
// Stable order: propulsion, structure, reliability, then any other branch
// ids (alphabetically) the data happens to introduce.
export function branches(tree) {
  const byBranch = new Map();
  for (const node of tree.nodes) {
    if (!byBranch.has(node.branch)) byBranch.set(node.branch, []);
    byBranch.get(node.branch).push(node);
  }

  const extra = [...byBranch.keys()].filter((b) => !BRANCH_ORDER.includes(b)).sort();
  const order = [...BRANCH_ORDER, ...extra];

  return order
    .filter((b) => byBranch.has(b))
    .map((b) => ({
      id: b,
      name: BRANCH_NAMES[b] ?? b,
      nodes: [...byBranch.get(b)].sort((a, z) => a.level - z.level),
    }));
}

// canBuy(tree, state, id) -> boolean
// prereqs owned && funds/resources sufficient && not already owned.
export function canBuy(tree, state, id) {
  const node = tree.byId.get(id);
  if (!node) return false;
  if (state.owned.includes(id)) return false;
  const reqs = node.requires ?? [];
  if (!reqs.every((r) => state.owned.includes(r))) return false;
  return canAfford(state, node.cost);
}

// buy(tree, state, id) -> new state. Throws if not canBuy.
export function buy(tree, state, id) {
  if (!canBuy(tree, state, id)) {
    throw new Error(`cannot buy node: ${id}`);
  }
  const node = tree.byId.get(id);
  const debited = debit(state, node.cost);
  return { ...debited, owned: [...debited.owned, id] };
}

// collectEffects(tree, state) -> effects[]
// Effects of every owned node, in a deterministic order: branch order
// (propulsion, structure, reliability), then level within a branch.
export function collectEffects(tree, state) {
  const owned = new Set(state.owned);
  const effects = [];
  for (const branch of branches(tree)) {
    for (const node of branch.nodes) {
      if (owned.has(node.id)) {
        effects.push(...node.effects);
      }
    }
  }
  return effects;
}
