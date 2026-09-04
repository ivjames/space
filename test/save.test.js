import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize, migrations, SCHEMA_VERSION, makeStorage } from '../js/core/save.js';
import { newGame } from '../js/core/state.js';

// getItem/setItem/removeItem backed by a Map, standing in for localStorage.
function makeMapBackend() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

test('SCHEMA_VERSION is 4', () => {
  assert.equal(SCHEMA_VERSION, 4);
});

test('serialize/deserialize round trip a current-version state', () => {
  const state = newGame(123);
  const str = serialize(state);
  const back = deserialize(str);
  assert.deepEqual(back, state);
});

// A hand-written v1 fixture: the documented phase 0 shape (`best` is just
// `{ maxAltitude }`), plus `best.winShown` — the one real, undocumented v1
// field the actual UI (js/ui/screens.js) has always written. migrations[1]
// must promote it to v2's per-tier `best` shape and fold winShown into
// wins[1].
test('migrations[1] maps best.winShown to best.wins[1] directly', () => {
  const v1 = { ...newGame(1), version: 1, best: { maxAltitude: 4000, winShown: true } };
  const out = migrations[1](v1);
  assert.deepEqual(out.best.wins, { 1: true });
  assert.equal(out.best.maxAltitude, 4000);
});

// This fixture predates SCHEMA_VERSION reaching 4, so deserialize() now
// carries it all the way there (migrations[1], then [2], then [3]) — the
// name says "through migrations[1]" because that's the step with the
// non-mechanical winShown->wins[1] logic under test; the v2->v3 and v3->v4
// steps below backfill the phase 2 and phase 3 shapes mechanically.
test('a v1 fixture round-trips through migrations[1], [2] and [3] to the v4 shape', () => {
  const v1 = {
    version: 1,
    seed: 7,
    draws: 42,
    funds: 5000,
    reputation: 18,
    resources: { water: 1, fuel: 2, oxidizer: 3, metals: 4 },
    owned: ['prop-1', 'struct-1'],
    tier: 1,
    launches: { 1: 6 },
    best: { maxAltitude: 87000, winShown: true },
    contracts: ['sound-3'],
    history: [{ tier: 1, missionId: 'sound-2', success: true, maxAltitude: 26000, readout: 'ok' }],
  };
  const migrated = deserialize(JSON.stringify(v1));
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.equal(migrated.seed, 7);
  assert.equal(migrated.draws, 42);
  assert.equal(migrated.funds, 5000);
  assert.equal(migrated.reputation, 18);
  assert.deepEqual(migrated.resources, { water: 1, fuel: 2, oxidizer: 3, metals: 4 });
  assert.deepEqual(migrated.owned, ['prop-1', 'struct-1']);
  assert.equal(migrated.tier, 1);
  assert.deepEqual(migrated.launches, { 1: 6 });
  assert.deepEqual(migrated.best, {
    maxAltitude: 87000,
    maxDownrange: 0,
    bestPeriapsis: null,
    bestClosestApproach: null,
    docked: false,
    lunarStep: -1,
    wins: { 1: true },
  });
  assert.deepEqual(migrated.contracts, ['sound-3']);
  assert.equal(migrated.history.length, 1);
  assert.equal(migrated.history[0].maxAltitude, 26000);
  assert.equal(migrated.history[0].periapsis, null);
  assert.equal(migrated.history[0].downrange, null);
  assert.equal(migrated.history[0].closestApproach, null);
  assert.equal(migrated.history[0].docked, false);
  assert.equal(migrated.history[0].lunarStep, -1);
  assert.deepEqual(migrated.objects, []);
});

test('a v1 fixture without winShown migrates to an empty wins map', () => {
  const v1 = {
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
  };
  const migrated = deserialize(JSON.stringify(v1));
  assert.deepEqual(migrated.best.wins, {});
});

test('deserialize migrates a fabricated v0 save up through all four steps to SCHEMA_VERSION (full v0 -> v4 chain)', () => {
  const v0 = {
    version: 0,
    seed: 5,
    funds: 250,
    owned: ['prop-1'],
    // deliberately missing: draws, reputation, resources, tier, launches,
    // best, contracts, history, objects -- migrations[0] must fill these
    // in (at v1's shape), migrations[1] carries it to v2, migrations[2] to
    // v3, and migrations[3] the rest of the way to v4.
  };
  const migrated = deserialize(JSON.stringify(v0));
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.equal(migrated.seed, 5);
  assert.equal(migrated.funds, 250);
  assert.deepEqual(migrated.owned, ['prop-1']);
  assert.equal(migrated.draws, 0);
  assert.equal(migrated.reputation, 0);
  assert.deepEqual(migrated.resources, { water: 0, fuel: 0, oxidizer: 0, metals: 0 });
  assert.equal(migrated.tier, 1);
  assert.deepEqual(migrated.launches, { 1: 0 });
  assert.deepEqual(migrated.best, {
    maxAltitude: 0,
    maxDownrange: 0,
    bestPeriapsis: null,
    bestClosestApproach: null,
    docked: false,
    lunarStep: -1,
    wins: {},
  });
  assert.deepEqual(migrated.contracts, []);
  assert.deepEqual(migrated.history, []);
  assert.deepEqual(migrated.objects, []);
});

// migrations[2] in isolation: the mechanical v2 -> v3 bump (ARCHITECTURE.md,
// "state.js, save.js -- schema v3"). A hand-written v2 fixture — the
// documented phase 1 shape, no `objects`, no `bestClosestApproach`/`docked`
// on `best`, no `closestApproach`/`docked` on a history entry.
test('migrations[2] adds objects: [], best.bestClosestApproach: null, best.docked: false', () => {
  const v2 = {
    version: 2,
    seed: 3,
    draws: 5,
    funds: 9000,
    reputation: 40,
    resources: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
    owned: ['prop-1', 'guide-1'],
    tier: 2,
    launches: { 1: 10, 2: 4 },
    best: { maxAltitude: 150000, maxDownrange: 300000, bestPeriapsis: 95000, wins: { 1: true } },
    contracts: ['orbit-down-1'],
    history: [{ tier: 2, missionId: 'orbit-down-1', success: true, maxAltitude: 150000, periapsis: null, downrange: 300000, readout: 'ok' }],
  };
  const out = migrations[2](v2);
  assert.equal(out.version, 3);
  assert.deepEqual(out.objects, []);
  // The deepEqual is what keeps migrations[2] frozen at the v3 shape: it
  // must NOT have learned about phase 3's best.lunarStep. Every field
  // arrives at the migration that introduced it, and the chain in
  // deserialize walks them in order, so a v4 field appearing here would
  // mean the v3 step is producing a shape v3 never had.
  assert.deepEqual(out.best, {
    maxAltitude: 150000,
    maxDownrange: 300000,
    bestPeriapsis: 95000,
    bestClosestApproach: null,
    docked: false,
    wins: { 1: true },
  });
  assert.equal(out.history[0].closestApproach, null);
  assert.equal(out.history[0].docked, false);
  assert.equal(out.history[0].lunarStep, undefined);
  // Fields migrations[2] didn't touch pass through unchanged.
  assert.equal(out.seed, 3);
  assert.equal(out.funds, 9000);
  assert.deepEqual(out.owned, ['prop-1', 'guide-1']);
  assert.equal(out.tier, 2);
});

// deserialize() end to end, from a real v2 save (no fabrication needed --
// v2 is exactly what a phase 1 save looked like, and newGame() no longer
// produces it, so this fixture is the only way to exercise the v2 -> v3
// step through the public entry point rather than calling migrations[2]
// directly). It now runs on through migrations[3] to v4, which is the
// point of asserting SCHEMA_VERSION rather than a literal 3.
test('deserialize migrates a v2 save through v3 to v4 (objects, bestClosestApproach, docked, lunarStep)', () => {
  const v2 = { ...newGame(1), version: 2 };
  delete v2.objects;
  delete v2.best.bestClosestApproach;
  delete v2.best.docked;
  delete v2.best.lunarStep;
  const migrated = deserialize(JSON.stringify(v2));
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.deepEqual(migrated.objects, []);
  assert.equal(migrated.best.bestClosestApproach, null);
  assert.equal(migrated.best.docked, false);
  assert.equal(migrated.best.lunarStep, -1);
});

// A hand-written v3 fixture: the documented phase 2 shape. `best` carries
// bestClosestApproach/docked but no lunarStep, history entries carry
// closestApproach/docked but no lunarStep, and `objects` is populated --
// a real phase 2 save has a station in orbit, and migrations[3] must carry
// it across untouched (a lunar flight deploys nothing, so v4 has nothing
// to say about objects).
const v3Fixture = () => ({
  version: 3,
  seed: 11,
  draws: 3100,
  funds: 41000,
  reputation: 72,
  resources: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
  owned: ['prop-1', 'guide-1', 'struct-module'],
  tier: 3,
  launches: { 1: 14, 2: 9, 3: 21 },
  best: {
    maxAltitude: 310000,
    maxDownrange: 900000,
    bestPeriapsis: 205000,
    bestClosestApproach: 42,
    docked: true,
    wins: { 1: true, 2: true },
  },
  contracts: ['dock', 'satellite'],
  history: [
    { tier: 3, missionId: 'rdv-2', success: true, maxAltitude: 210000, periapsis: 205000, downrange: null, closestApproach: 380, docked: false, readout: 'Closest approach 380 m.' },
    { tier: 3, missionId: 'dock', success: true, maxAltitude: 210000, periapsis: 205000, downrange: null, closestApproach: 42, docked: true, readout: 'Docked to Station core.' },
  ],
  objects: [
    { id: 'core-1', kind: 'core', name: 'Station core', periapsis: 205000, apoapsis: 205000, phase: 0.25, dockedTo: null, launchedAt: { tier: 3, launch: 8 } },
    { id: 'module-1', kind: 'module', name: 'Lab module', periapsis: 205000, apoapsis: 205000, phase: 0.25, dockedTo: 'core-1', launchedAt: { tier: 3, launch: 21 } },
  ],
});

// migrations[3] in isolation: the mechanical v3 -> v4 bump (ARCHITECTURE.md,
// "state.js, save.js -- schema v4").
test('migrations[3] adds best.lunarStep: -1 and back-fills history entries with lunarStep: -1', () => {
  const out = migrations[3](v3Fixture());
  assert.equal(out.version, 4);
  assert.deepEqual(out.best, {
    maxAltitude: 310000,
    maxDownrange: 900000,
    bestPeriapsis: 205000,
    bestClosestApproach: 42,
    docked: true,
    lunarStep: -1,
    wins: { 1: true, 2: true },
  });
  assert.deepEqual(out.history.map((entry) => entry.lunarStep), [-1, -1]);
  // Fields migrations[3] didn't touch pass through unchanged.
  assert.equal(out.seed, 11);
  assert.equal(out.draws, 3100);
  assert.equal(out.funds, 41000);
  assert.equal(out.reputation, 72);
  assert.deepEqual(out.owned, ['prop-1', 'guide-1', 'struct-module']);
  assert.equal(out.tier, 3);
  assert.deepEqual(out.launches, { 1: 14, 2: 9, 3: 21 });
  assert.deepEqual(out.contracts, ['dock', 'satellite']);
  assert.deepEqual(out.objects, v3Fixture().objects);
});

test('migrations[3] leaves a history entry that already carries lunarStep alone', () => {
  // The defaults-first / ...entry-last back-fill idiom: the default fills
  // entries that lack the field, never overwrites one that has it. A v3
  // save's entries cannot carry it, but a hand-repaired or partly-migrated
  // one can, and losing a real step to the -1 sentinel is the failure this
  // ordering exists to prevent.
  const v3 = v3Fixture();
  v3.history[1] = { ...v3.history[1], lunarStep: 4 };
  const out = migrations[3](v3);
  assert.deepEqual(out.history.map((entry) => entry.lunarStep), [-1, 4]);
});

test('migrations[3] fills in best.lunarStep for a v3 save whose best is missing entirely', () => {
  // Every field in the literal carries `?? default` precisely so a v3 save
  // an older bug left a field short still comes out a complete v4 one.
  const out = migrations[3]({ version: 3 });
  assert.equal(out.best.lunarStep, -1);
  assert.equal(out.best.bestClosestApproach, null);
  assert.deepEqual(out.best.wins, {});
  assert.deepEqual(out.history, []);
  assert.deepEqual(out.objects, []);
  assert.deepEqual(out.resources, { water: 0, fuel: 0, oxidizer: 0, metals: 0 });
});

// The same v3 -> v4 step through the public entry point. This is the old-save
// path that actually matters: a phase 2 player's real save, with history and
// objects in it, must load into phase 3 with lunarStep at the "nothing
// completed" sentinel everywhere and nothing else disturbed.
test('deserialize migrates a v3 save with history entries to v4, lunarStep -1 everywhere and every other field preserved', () => {
  const v3 = v3Fixture();
  const migrated = deserialize(JSON.stringify(v3));
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.equal(migrated.best.lunarStep, -1);
  assert.deepEqual(migrated.history.map((entry) => entry.lunarStep), [-1, -1]);
  // Everything else is byte-for-byte what went in: the only difference
  // between the v3 save and the v4 one is `version` and the new field.
  assert.deepEqual(migrated, {
    ...v3,
    version: SCHEMA_VERSION,
    best: { ...v3.best, lunarStep: -1 },
    history: v3.history.map((entry) => ({ ...entry, lunarStep: -1 })),
  });
});

test('deserialize accepts a save already at SCHEMA_VERSION without running any migration', () => {
  // The loop in deserialize is `while (v < SCHEMA_VERSION)`, so a current
  // save must come back untouched -- including a real lunarStep, which a
  // re-run of migrations[3] would reset to -1.
  const current = { ...newGame(2), best: { ...newGame(2).best, lunarStep: 4 } };
  const back = deserialize(serialize(current));
  assert.deepEqual(back, current);
  assert.equal(back.best.lunarStep, 4);
});

test('deserialize rejects a version newer than SCHEMA_VERSION', () => {
  const future = JSON.stringify({ version: SCHEMA_VERSION + 1 });
  assert.throws(() => deserialize(future), /newer/i);
});

test('deserialize wraps a JSON parse error, does not swallow it', () => {
  assert.throws(() => deserialize('{not json'), /corrupt/i);
});

test('deserialize rejects a save with a missing/invalid version field', () => {
  assert.throws(() => deserialize(JSON.stringify({ funds: 1 })), /version/i);
  assert.throws(() => deserialize(JSON.stringify({ version: 'nope' })), /version/i);
});

test('makeStorage: load() returns null when absent', () => {
  const storage = makeStorage(makeMapBackend());
  assert.equal(storage.load(), null);
});

test('makeStorage: save() then load() round-trips a state', () => {
  const backend = makeMapBackend();
  const storage = makeStorage(backend);
  const state = newGame(9);
  storage.save(state);
  assert.deepEqual(storage.load(), state);
});

test('makeStorage: clear() removes the saved state', () => {
  const backend = makeMapBackend();
  const storage = makeStorage(backend);
  storage.save(newGame(1));
  storage.clear();
  assert.equal(storage.load(), null);
});

test('makeStorage uses a single fixed key regardless of state contents', () => {
  const backend = makeMapBackend();
  const storage = makeStorage(backend);
  storage.save(newGame(1));
  storage.save(newGame(2));
  assert.equal(backend._map.size, 1);
});
