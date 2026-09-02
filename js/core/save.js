// Versioned save/load, migrations, storage adapter. Pure. See
// ARCHITECTURE.md.

export const SCHEMA_VERSION = 1;

// migrations[v] transforms a save at version v into version v + 1's shape
// (the version field itself is stamped by deserialize, not by the
// migration function). migrations[0] is the "pre-schema" case: a save
// from before versioning existed, treated as version 0 and back-filled
// with every field newGame() would have set. migrations[1] is the
// identity migration for schema version 1 itself — a placeholder kept so
// the step-by-step loop below has something to run when SCHEMA_VERSION
// eventually becomes 2 and a v1 save needs to advance one more step.
export const migrations = {
  0: (s) => ({
    version: 1,
    seed: s.seed ?? 0,
    draws: s.draws ?? 0,
    funds: s.funds ?? 0,
    reputation: s.reputation ?? 0,
    resources: {
      water: 0,
      fuel: 0,
      oxidizer: 0,
      metals: 0,
      ...(s.resources ?? {}),
    },
    owned: s.owned ?? [],
    tier: s.tier ?? 1,
    launches: s.launches ?? { 1: 0 },
    best: s.best ?? { maxAltitude: 0 },
    contracts: s.contracts ?? [],
    history: s.history ?? [],
  }),
  1: (s) => s,
};

// serialize(state) -> string
export function serialize(state) {
  return JSON.stringify(state);
}

// deserialize(str) -> State at SCHEMA_VERSION, migrated.
// - JSON parse errors are wrapped in an Error saying the save is corrupt
//   (never swallowed).
// - A missing/non-number version field is rejected the same way.
// - A version newer than SCHEMA_VERSION is rejected with an Error whose
//   message says so.
// - Anything older is migrated step by step, via `migrations`, up to
//   SCHEMA_VERSION.
export function deserialize(str) {
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch (err) {
    throw new Error(`save is corrupt: invalid JSON (${err.message})`);
  }

  if (parsed === null || typeof parsed !== 'object' || typeof parsed.version !== 'number') {
    throw new Error('save is corrupt: missing or invalid version field');
  }

  if (parsed.version > SCHEMA_VERSION) {
    throw new Error(
      `save version ${parsed.version} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }

  let state = parsed;
  let v = state.version;
  while (v < SCHEMA_VERSION) {
    const migrate = migrations[v];
    if (!migrate) {
      throw new Error(`no migration registered for save version ${v}`);
    }
    state = { ...migrate(state), version: v + 1 };
    v += 1;
  }

  return state;
}

const STORAGE_KEY = 'space.save';

// makeStorage(backend) -> { load(), save(state), clear() }
// backend: anything with getItem/setItem/removeItem (localStorage, or a
// Map-backed shim in tests).
export function makeStorage(backend) {
  return {
    load() {
      const raw = backend.getItem(STORAGE_KEY);
      if (raw == null) return null;
      return deserialize(raw);
    },
    save(state) {
      backend.setItem(STORAGE_KEY, serialize(state));
    },
    clear() {
      backend.removeItem(STORAGE_KEY);
    },
  };
}
