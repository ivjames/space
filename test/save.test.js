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

test('SCHEMA_VERSION is 1', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test('serialize/deserialize round trip a current-version state', () => {
  const state = newGame(123);
  const str = serialize(state);
  const back = deserialize(str);
  assert.deepEqual(back, state);
});

test('migrations[1] is the identity migration', () => {
  const state = newGame(1);
  assert.deepEqual(migrations[1](state), state);
});

test('deserialize migrates a fabricated v0 save up to SCHEMA_VERSION', () => {
  const v0 = {
    version: 0,
    seed: 5,
    funds: 250,
    owned: ['prop-1'],
    // deliberately missing: draws, reputation, resources, tier, launches,
    // best, contracts, history -- migrations[0] must fill these in.
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
  assert.deepEqual(migrated.best, { maxAltitude: 0 });
  assert.deepEqual(migrated.contracts, []);
  assert.deepEqual(migrated.history, []);
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
