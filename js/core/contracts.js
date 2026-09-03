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

// isEligible(state, m) -> boolean
// The tier/reputation gates phase 0/1 already had, plus phase 2's three
// object-aware gates (ARCHITECTURE.md, "Persistent objects in orbit" —
// "Contracts get `state` as they already do; `generateContracts` applies
// both rules" — extended here to three since `requiresNode` joins
// `unique`/`requiresObject` in the tier 3 write-up):
//   - `unique: true` — offered only while no UNDOCKED object of the kind
//     it deploys exists yet (e.g. `core`, so a second station core can't be
//     contracted for while the first is still sitting there undocked).
//     Read off `m.deploys.kind`, since a unique template is always a
//     deploying one — there is nothing else "one of these already exists"
//     could mean.
//   - `requiresObject: <kind>` — offered only while at least one object of
//     that kind exists (docked or not — e.g. a dock mission's target,
//     'core', stays offered even after an earlier module has already
//     docked to it, because the core object itself is never marked docked).
//   - `requiresNode: <id>` — offered only once that tech-tree node is
//     owned (e.g. `dock`'s `struct-module`, the station module hardware).
function isEligible(state, m) {
  if (m.floor) return false;
  if (m.tier > state.tier) return false;
  if (m.minReputation !== undefined && state.reputation < m.minReputation) return false;
  const objects = state.objects ?? [];
  if (m.unique) {
    const kind = m.deploys?.kind;
    if (kind && objects.some((obj) => obj.kind === kind && obj.dockedTo == null)) return false;
  }
  if (m.requiresObject !== undefined && !objects.some((obj) => obj.kind === m.requiresObject)) {
    return false;
  }
  if (m.requiresNode !== undefined && !(state.owned ?? []).includes(m.requiresNode)) {
    return false;
  }
  return true;
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
