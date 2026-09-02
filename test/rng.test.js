import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRng, deriveSeed } from '../js/core/rng.js';

test('same seed gives the same sequence', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('different seeds give different sequences', () => {
  const a = makeRng(1);
  const b = makeRng(2);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test('next() stays in [0, 1)', () => {
  const rng = makeRng(0xdecafbad);
  for (let i = 0; i < 5000; i += 1) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `draw ${i} out of range: ${v}`);
  }
});

test('int(n) is an integer in 0..n-1 and covers the range', () => {
  const rng = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const v = rng.int(6);
    assert.ok(Number.isInteger(v), `not an integer: ${v}`);
    assert.ok(v >= 0 && v < 6, `out of range: ${v}`);
    seen.add(v);
  }
  assert.equal(seen.size, 6, 'every face of a d6 should turn up in 2000 rolls');
});

test('int(n) rejects a non-positive or non-integer n', () => {
  const rng = makeRng(7);
  assert.throws(() => rng.int(0), /positive integer/);
  assert.throws(() => rng.int(-3), /positive integer/);
  assert.throws(() => rng.int(2.5), /positive integer/);
});

test('seed is exposed and draws counts every draw', () => {
  const rng = makeRng(99);
  assert.equal(rng.seed, 99);
  assert.equal(rng.draws, 0);
  rng.next();
  rng.next();
  assert.equal(rng.draws, 2);
  rng.int(4);
  assert.equal(rng.draws, 3, 'int() consumes exactly one draw');
});

test('a save can replay: seed + draws resumes the same sequence', () => {
  const live = makeRng(2024);
  for (let i = 0; i < 17; i += 1) live.next();
  const saved = { seed: live.seed, draws: live.draws };

  const resumed = makeRng(saved.seed, saved.draws);
  assert.equal(resumed.draws, 17);

  const rest = Array.from({ length: 10 }, () => live.next());
  const replay = Array.from({ length: 10 }, () => resumed.next());
  assert.deepEqual(replay, rest);
});

test('deriveSeed is stable and pure', () => {
  assert.equal(deriveSeed(42, 3), deriveSeed(42, 3));
  // Calling it must not depend on, or disturb, any generator state.
  const rng = makeRng(42);
  rng.next();
  assert.equal(deriveSeed(42, 3), deriveSeed(42, 3));
  assert.equal(rng.draws, 1);
});

test('deriveSeed varies with n and with seed, and returns a uint32', () => {
  const bySeed = new Set();
  for (let n = 0; n < 64; n += 1) {
    const s = deriveSeed(42, n);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `not uint32: ${s}`);
    bySeed.add(s);
  }
  assert.equal(bySeed.size, 64, 'derived seeds should not collide over 64 indices');
  assert.notEqual(deriveSeed(1, 5), deriveSeed(2, 5));
});

test('derived seeds produce independent streams', () => {
  const a = makeRng(deriveSeed(1000, 0));
  const b = makeRng(deriveSeed(1000, 1));
  assert.notDeepEqual(
    Array.from({ length: 8 }, () => a.next()),
    Array.from({ length: 8 }, () => b.next()),
  );
});
