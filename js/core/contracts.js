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

// generateContracts(state, missions, rng, count = 3) -> mission ids
// Index 0 is always the floor contract. The remaining (count - 1) slots
// are drawn without replacement, via rng.int(n), from templates whose
// tier <= state.tier and whose minReputation (if any) <= state.reputation.
// If fewer templates qualify than requested, returns as many as qualify.
export function generateContracts(state, missions, rng, count = 3) {
  const floor = floorContract(missions);

  const eligible = missions.filter(
    (m) =>
      !m.floor &&
      m.tier <= state.tier &&
      (m.minReputation === undefined || state.reputation >= m.minReputation),
  );

  const pool = [...eligible];
  const picked = [];
  const want = Math.max(0, count - 1);
  for (let i = 0; i < want && pool.length > 0; i++) {
    const idx = rng.int(pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return [floor.id, ...picked.map((m) => m.id)];
}
