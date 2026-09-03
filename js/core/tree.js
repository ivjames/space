// Tech tree: load/validate, query, buy. Pure. See ARCHITECTURE.md.
import { canAfford, debit } from './economy.js';

const BRANCH_ORDER = ['propulsion', 'structure', 'guidance', 'reliability'];
const BRANCH_NAMES = {
  propulsion: 'Propulsion',
  structure: 'Structure',
  guidance: 'Guidance',
  reliability: 'Reliability',
};

// A node's tier defaults to 1: every tier 1 node predates the `tier` field,
// so js/data/tree.js leaves it off rather than writing it everywhere.
function nodeTier(node) {
  return node.tier ?? 1;
}

// loadTree(nodes) -> tree
// Validates: duplicate ids, missing prereqs, cycles (DFS), and that no
// node's prerequisite sits in a HIGHER tier than the node itself (a tier 1
// node cannot depend on a tier 2 one, and a tier 2 node's tier 1
// prerequisites are exactly the "reach back into tier 1" links the phase 1
// tree is built from). Throws on any violation. Returns a tree object with
// an id -> node lookup map.
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

  for (const node of nodes) {
    for (const req of node.requires ?? []) {
      const reqNode = byId.get(req);
      if (nodeTier(reqNode) > nodeTier(node)) {
        throw new Error(
          `node ${node.id} (tier ${nodeTier(node)}) requires ${req} (tier ${nodeTier(reqNode)}), ` +
            'a prerequisite cannot sit in a higher tier than the node it unlocks',
        );
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

// branches(tree, maxTier = Infinity) -> [{ id, name, nodes: [ordered by level] }]
// Stable order: propulsion, structure, guidance, reliability, then any other
// branch ids (alphabetically) the data happens to introduce. Only nodes with
// tier <= maxTier are included, so the shop can render "what this tier's
// player can see" (js/ui/shop.js) while collectEffects (below) always sees
// everything the player has actually bought, regardless of the current tier.
export function branches(tree, maxTier = Infinity) {
  const byBranch = new Map();
  for (const node of tree.nodes) {
    if (nodeTier(node) > maxTier) continue;
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
// prereqs owned && funds/resources sufficient && not already owned && the
// node's tier is not above the player's current tier (state.tier, default
// 1 when absent so older/ad-hoc states without a tier field still behave
// as tier 1).
export function canBuy(tree, state, id) {
  const node = tree.byId.get(id);
  if (!node) return false;
  if (state.owned.includes(id)) return false;
  if (nodeTier(node) > (state.tier ?? 1)) return false;
  const reqs = node.requires ?? [];
  if (!reqs.every((r) => state.owned.includes(r))) return false;
  return canAfford(state, node.cost);
}

// buy(tree, state, id) -> new state. Throws if not canBuy.
// branchExhausted(tree, state, branch) -> boolean
// True when every node of `branch` at or below state.tier is already owned:
// there is nothing left in that branch this tier could ever sell the player,
// whatever their funds or prerequisites. The result screen uses it to stop
// pointing a shortfall at a branch that has nothing left to buy, and to point
// at the loadout instead (ARCHITECTURE.md, "Result" points-at).
export function branchExhausted(tree, state, branch) {
  const tier = state.tier ?? 1;
  return tree.nodes
    .filter((node) => node.branch === branch && nodeTier(node) <= tier)
    .every((node) => state.owned.includes(node.id));
}

export function buy(tree, state, id) {
  if (!canBuy(tree, state, id)) {
    throw new Error(`cannot buy node: ${id}`);
  }
  const node = tree.byId.get(id);
  const debited = debit(state, node.cost);
  return { ...debited, owned: [...debited.owned, id] };
}

// collectEffects(tree, state) -> effects[]
// Effects of every owned node (across every tier), in a deterministic
// order: every `addStage` effect first (in branch order, then level within
// a branch), then every other effect, also in branch order then level.
//
// The `addStage`-first split is what lets a tier 2 propulsion node mul a
// higher stage's isp (e.g. 'stages.1.isp', 'stages.2.isp') even though
// `structure` — the branch that actually appends those stages via
// `addStage` — is applied after `propulsion` in branch order. Without the
// split, a stage-1/2-targeting propulsion effect would run before the
// structure-branch `addStage` that creates that stage and buildVehicle
// would throw on the unresolved stat path (see js/core/vehicle.js's doc
// comment: "addStage effects must ... come before any effect targeting the
// stage they add" — this is how collectEffects satisfies that for tier 2's
// cross-branch stage references without changing BRANCH_ORDER itself).
// It changes nothing for tier 1, which owns exactly one addStage (struct-4)
// and no effect that reorders around it observably.
export function collectEffects(tree, state) {
  const owned = new Set(state.owned);
  const ordered = [];
  for (const branch of branches(tree)) {
    for (const node of branch.nodes) {
      if (owned.has(node.id)) ordered.push(node);
    }
  }

  const addStageEffects = [];
  const otherEffects = [];
  for (const node of ordered) {
    for (const effect of node.effects) {
      if (effect.addStage !== undefined) addStageEffects.push(effect);
      else otherEffects.push(effect);
    }
  }
  return [...addStageEffects, ...otherEffects];
}
