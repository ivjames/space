// Contract generation. Pure — takes an explicit rng, never touches
// Math.random. See ARCHITECTURE.md.

// floorContract(missions) -> mission template
// The single mission with `floor: true`. Throws unless there is exactly one.
export function floorContract(missions) {
  const floors = missions.filter((m) => m.floor);
  if (floors.length !== 1) {
    throw new Error(`expected exactly one floor mission, found ${floors.length}`);
  }
  return floors[0];
}

// requiredNodes(m) -> node ids
// `requiresNode` on a template is either a single node id or an array of
// them (ARCHITECTURE.md, "js/core/contracts.js"). The string form is the
// original phase 2 shape and still means exactly what it did; the array
// form exists because a mission can need more than one piece of hardware
// (a docking flight needs the adapter, the restarts AND the sensors), and
// every listed id must be owned. Normalised here so the rest of the file
// only ever sees a list.
function requiredNodes(m) {
  if (m.requiresNode === undefined || m.requiresNode === null) return [];
  return Array.isArray(m.requiresNode) ? m.requiresNode : [m.requiresNode];
}

// lockReasons(state, m) -> [{ kind, ... }]
// Every reason a template is NOT offerable to this state, in a fixed order;
// an empty array means the template is offerable. `m.floor` is deliberately
// NOT a reason: the floor contract is handled by generateContracts itself
// (always slot 0, never drawn), so it is neither "locked" nor "eligible" in
// the sense this list describes — isEligible below is where that check
// lives. The UI reads these shapes to explain a locked contract, so they
// are part of the module contract (ARCHITECTURE.md) rather than internal:
//
//   { kind: 'tier', tier }                 m.tier > state.tier
//   { kind: 'reputation', need, have }     m.minReputation not yet reached
//   { kind: 'node', id }                   ONE entry per missing node id, in
//                                          the order the template lists them
//   { kind: 'object', objectKind }         requiresObject, no object of that
//                                          kind exists (docked or not)
//   { kind: 'unique', objectKind }         unique: true, and an UNDOCKED
//                                          object of m.deploys.kind exists
//
// Checks run in that order — tier, reputation, node(s), object, unique —
// and every unmet gate is reported, not just the first, so a player two
// purchases and a core delivery away from `dock` sees all three.
//
// The gates themselves are the tier/reputation gates phase 0/1 had plus
// phase 2's three object-aware gates (ARCHITECTURE.md, "Persistent objects
// in orbit" — "Contracts get `state` as they already do; `generateContracts`
// applies both rules" — extended to three since `requiresNode` joined
// `unique`/`requiresObject` in the tier 3 write-up):
//   - `requiresNode: <id> | [<id>, ...]` — offered only once EVERY listed
//     tech-tree node is owned. This began as the station-module gate
//     (`dock`'s `struct-module`, hardware the mission carries up) and is
//     now also the "hardware this mission is unflyable without" gate: a
//     mission whose requirement the resolver cannot meet without a node
//     (a downrange or orbit flight without guide-1 flies straight up and
//     goes nowhere; a rendezvous without the restarts to burn twice stops
//     at the match step) lists that node here so the random draw never
//     offers a contract the player has no way to complete. js/data/
//     missions.js documents which node each template needs and why.
//   - `requiresObject: <kind>` — offered only while at least one object of
//     that kind exists (docked or not — e.g. a dock mission's target,
//     'core', stays offered even after an earlier module has already
//     docked to it, because the core object itself is never marked docked).
//   - `unique: true` — offered only while no UNDOCKED object of the kind
//     it deploys exists yet (e.g. `core`, so a second station core can't be
//     contracted for while the first is still sitting there undocked).
//     Read off `m.deploys.kind`, since a unique template is always a
//     deploying one — there is nothing else "one of these already exists"
//     could mean.
export function lockReasons(state, m) {
  const reasons = [];
  const tier = state.tier ?? 1;
  if ((m.tier ?? 1) > tier) reasons.push({ kind: 'tier', tier: m.tier });
  const reputation = state.reputation ?? 0;
  if (m.minReputation !== undefined && reputation < m.minReputation) {
    reasons.push({ kind: 'reputation', need: m.minReputation, have: reputation });
  }
  const owned = state.owned ?? [];
  for (const id of requiredNodes(m)) {
    if (!owned.includes(id)) reasons.push({ kind: 'node', id });
  }
  const objects = state.objects ?? [];
  if (m.requiresObject !== undefined && !objects.some((obj) => obj.kind === m.requiresObject)) {
    reasons.push({ kind: 'object', objectKind: m.requiresObject });
  }
  if (m.unique) {
    const kind = m.deploys?.kind;
    if (kind && objects.some((obj) => obj.kind === kind && obj.dockedTo == null)) {
      reasons.push({ kind: 'unique', objectKind: kind });
    }
  }
  return reasons;
}

// isEligible(state, m) -> boolean
// Whether a template can be drawn into a random board slot: not the floor
// contract (which is slot 0 by construction, never drawn), and no
// lockReasons. This is the one predicate generateContracts filters on, so
// "is it in the pool" and "why is it not" can never disagree.
export function isEligible(state, m) {
  return !m.floor && lockReasons(state, m).length === 0;
}

// generateContracts(state, missions, rng, count = 3) -> mission ids
// Index 0 is always the floor contract. The remaining (count - 1) slots
// are drawn without replacement, via rng.int(n), from templates that pass
// isEligible above (tier/reputation, plus phase 2's unique/requiresObject/
// requiresNode gates). If fewer templates qualify than requested, returns
// as many as qualify.
export function generateContracts(state, missions, rng, count = 3) {
  const floor = floorContract(missions);

  const eligible = missions.filter((m) => isEligible(state, m));

  // The board is the current tier's board: draw from this tier's templates
  // first, and reach back to earlier tiers only when this tier cannot fill
  // the slots (early in a tier, before its reputation gates open). Without
  // this, tier 1 sounding contracts keep turning up at tier 3.
  const tier = state.tier ?? 1;
  const current = eligible.filter((m) => (m.tier ?? 1) === tier);
  const earlier = eligible.filter((m) => (m.tier ?? 1) !== tier);
  const picked = [];
  const want = Math.max(0, count - 1);
  for (const pool of [current, earlier]) {
    while (picked.length < want && pool.length > 0) {
      const idx = rng.int(pool.length);
      picked.push(pool[idx]);
      pool.splice(idx, 1);
    }
  }

  return [floor.id, ...picked.map((m) => m.id)];
}
