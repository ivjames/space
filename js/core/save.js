// Versioned save/load, migrations, storage adapter. Pure. See
// ARCHITECTURE.md.

export const SCHEMA_VERSION = 4;

// migrations[v] transforms a save at version v into version v + 1's shape
// (the version field itself is stamped by deserialize, not by the
// migration function). Each one is FROZEN once the next is written: its
// job is to produce the shape of version v + 1 as that version actually
// was, and teaching an old migration about a later phase's fields would
// make the chain skip a step it is meant to walk — deserialize runs them
// in order, so every field arrives at the migration that introduced it.
//
// migrations[0] is the "pre-schema" case: a save from
// before versioning existed, treated as version 0 and back-filled with
// every field newGame() would have set (at v1's shape — migrations[1] then
// carries it the rest of the way to v2, same as any real v1 save).
//
// migrations[1] is phase 1's schema bump (ARCHITECTURE.md, "state.js,
// save.js — tier progression, schema v2"): `best` grows from
// `{ maxAltitude }` to the per-tier/per-metric shape newGame() now
// produces. The one non-mechanical part is `best.wins`: phase 0 saves never
// had a documented `wins` field, but the real UI (js/ui/screens.js) has
// been setting `best.winShown` (a single boolean — one tier existed) since
// before this schema existed, so a genuine v1 save may carry it. That
// boolean becomes `wins[1]`; a save with no `winShown` at all (the
// documented phase 0 shape, or a save that predates the win screen) just
// gets an empty `wins`.
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
  1: (s) => ({
    version: 2,
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
    best: {
      maxAltitude: s.best?.maxAltitude ?? 0,
      maxDownrange: s.best?.maxDownrange ?? 0,
      bestPeriapsis: s.best?.bestPeriapsis ?? null,
      wins: {
        ...(s.best?.wins ?? {}),
        ...(s.best?.winShown ? { 1: true } : {}),
      },
    },
    contracts: s.contracts ?? [],
    history: (s.history ?? []).map((entry) => ({
      periapsis: null,
      downrange: null,
      ...entry,
    })),
  }),
  // migrations[2] is phase 2's schema bump (ARCHITECTURE.md, "state.js,
  // save.js — schema v3"): `objects` is new (everything the player has
  // ever launched and left in orbit), and `best` grows two more fields —
  // `bestClosestApproach` (phase 2's rendezvous-tier metric, mirroring
  // `bestPeriapsis`'s "null means never attempted" convention) and
  // `docked` (has the player ever completed a dock, a plain boolean —
  // WHICH object got docked lives in `objects` itself, per state.js's
  // tierGoalMet doc comment). History entries gain `closestApproach` and
  // `docked`, same "backfill with the null/false a pre-phase-2 outcome
  // could never have set" shape as migrations[1]'s periapsis/downrange
  // backfill above.
  2: (s) => ({
    version: 3,
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
    best: {
      maxAltitude: s.best?.maxAltitude ?? 0,
      maxDownrange: s.best?.maxDownrange ?? 0,
      bestPeriapsis: s.best?.bestPeriapsis ?? null,
      bestClosestApproach: s.best?.bestClosestApproach ?? null,
      docked: s.best?.docked ?? false,
      wins: s.best?.wins ?? {},
    },
    contracts: s.contracts ?? [],
    history: (s.history ?? []).map((entry) => ({
      closestApproach: null,
      docked: false,
      ...entry,
    })),
    objects: s.objects ?? [],
  }),
  // migrations[3] is phase 3's schema bump (ARCHITECTURE.md, "state.js,
  // save.js — schema v4"): `best` grows `lunarStep`, the deepest rung of
  // the lunar ladder any flight has ever completed, and history entries
  // gain the same field. Nothing else moves — a lunar flight deploys
  // nothing, so `objects` is untouched here, and the phase's other new
  // numbers (the delta-v ladder, the capability stats) are all derived at
  // resolve time from the tree rather than persisted.
  //
  // -1 is the back-fill value for both, because -1 is what newGame() now
  // starts a fresh game at and what the resolver reports for a flight that
  // completed no step of the ladder. A pre-phase-3 save cannot have flown
  // to the moon — there were no lunar missions to fly — so "nothing
  // completed" is the true statement about every one of its rows, and -1
  // is how the rest of the codebase spells it. 0 would be a false
  // statement rather than a neutral one: 0 is `tli`, the first real rung,
  // so back-filling 0 would credit every phase 2 save with a translunar
  // injection it never made and hand a `{ moon: { profile: 'flyby' } }`
  // goal to a player who has never left orbit. See state.js's newGame doc
  // block for why -1 rather than null — the field carries the resolver's
  // own step index, and a null there would have to be special-cased by
  // every reader.
  //
  // Written as a whole-object literal, like the three above: a migration
  // that spread `s` would silently carry forward any junk an older save
  // had picked up, and — worse — would stop being a written-down statement
  // of what v4 IS. The `?? default` on every field is the other half of
  // that: this function has to produce a complete v4 save out of anything
  // that claims to be a v3 one, including one an older bug left a field
  // short.
  3: (s) => ({
    version: 4,
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
    best: {
      maxAltitude: s.best?.maxAltitude ?? 0,
      maxDownrange: s.best?.maxDownrange ?? 0,
      bestPeriapsis: s.best?.bestPeriapsis ?? null,
      bestClosestApproach: s.best?.bestClosestApproach ?? null,
      docked: s.best?.docked ?? false,
      lunarStep: s.best?.lunarStep ?? -1,
      wins: s.best?.wins ?? {},
    },
    contracts: s.contracts ?? [],
    // Defaults first, `...entry` last — the back-fill idiom the two
    // migrations above use, and the order is the whole point: an entry
    // that already carries `lunarStep` (which a v3 save's cannot, but a
    // hand-repaired or partly-migrated one might) keeps its own value
    // rather than having it overwritten by the default.
    history: (s.history ?? []).map((entry) => ({
      lunarStep: -1,
      ...entry,
    })),
    objects: s.objects ?? [],
  }),
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
