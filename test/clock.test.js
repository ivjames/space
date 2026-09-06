// js/core/clock.js — the one module that is about wall-clock time and never
// reads one. Every test here is a pure function of two integers, which is the
// property the module exists to have.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ELAPSED_CLAMP, HOUR, elapsedSince, hoursIn, tick,
} from '../js/core/clock.js';

const T0 = 1_700_000_000_000;

test('ELAPSED_CLAMP is 24 hours, in ms', () => {
  assert.equal(ELAPSED_CLAMP, 24 * 60 * 60 * 1000);
  assert.equal(HOUR, 3600000);
});

test('elapsedSince returns the plain difference inside the clamp', () => {
  assert.equal(elapsedSince(T0, T0 + 5 * HOUR), 5 * HOUR);
  assert.equal(elapsedSince(T0, T0 + 1), 1);
});

test('elapsedSince caps at ELAPSED_CLAMP', () => {
  assert.equal(elapsedSince(T0, T0 + 30 * HOUR), ELAPSED_CLAMP);
  assert.equal(elapsedSince(T0, T0 + 400 * 24 * HOUR), ELAPSED_CLAMP);
});

test('elapsedSince is exactly the clamp at the boundary, not one tick over', () => {
  assert.equal(elapsedSince(T0, T0 + ELAPSED_CLAMP), ELAPSED_CLAMP);
  assert.equal(elapsedSince(T0, T0 + ELAPSED_CLAMP - 1), ELAPSED_CLAMP - 1);
});

// The two guards, and each is a bug that would read as something other than a
// bug if it got out: a negative elapsed would take resources away from a
// player whose clock moved, and a null lastTick treated as 0 would hand a
// brand-new game a day of production.
test('elapsedSince never goes negative when the clock moves backwards', () => {
  assert.equal(elapsedSince(T0, T0 - HOUR), 0);
  assert.equal(elapsedSince(T0, T0), 0);
});

test('elapsedSince treats a null lastTick as "the clock has not started"', () => {
  assert.equal(elapsedSince(null, T0), 0);
  assert.equal(elapsedSince(undefined, T0), 0);
  // And specifically NOT as the epoch, which would clamp to a full day.
  assert.equal(elapsedSince(0, T0), ELAPSED_CLAMP);
});

test('elapsedSince answers 0 rather than NaN for a non-finite input', () => {
  assert.equal(elapsedSince(NaN, T0), 0);
  assert.equal(elapsedSince(T0, NaN), 0);
  assert.equal(elapsedSince(T0, Infinity), 0);
});

test('tick stamps lastTick and reports the elapsed time', () => {
  const state = { lastTick: T0, funds: 10 };
  const { state: next, elapsed } = tick(state, T0 + 3 * HOUR);
  assert.equal(elapsed, 3 * HOUR);
  assert.equal(next.lastTick, T0 + 3 * HOUR);
  assert.equal(next.funds, 10);
  assert.equal(state.lastTick, T0, 'the input is not mutated');
});

test('the first tick of a fresh save starts the clock and pays nothing', () => {
  const { state: next, elapsed } = tick({ lastTick: null }, T0);
  assert.equal(elapsed, 0);
  assert.equal(next.lastTick, T0, 'the clock is now running');
  // ...and the tick after it is a normal one.
  const { elapsed: second } = tick(next, T0 + HOUR);
  assert.equal(second, HOUR);
});

test('tick with a non-finite now leaves lastTick alone rather than poisoning it', () => {
  const { state: next, elapsed } = tick({ lastTick: T0 }, NaN);
  assert.equal(elapsed, 0);
  assert.equal(next.lastTick, T0);
});

test('hoursIn converts ms to fractional hours, and refuses nonsense', () => {
  assert.equal(hoursIn(HOUR), 1);
  assert.equal(hoursIn(HOUR * 2.5), 2.5);
  assert.equal(hoursIn(0), 0);
  assert.equal(hoursIn(-HOUR), 0);
  assert.equal(hoursIn(NaN), 0);
});

// The module's whole claim, pinned as source rather than as behaviour: there
// is no way to write a test that proves a function did not read the clock, so
// the file is read instead. js/main.js is the only module allowed to be
// non-deterministic (ARCHITECTURE.md §Constraints), and this is the file where
// a Date.now() would look most like the module doing its job.
test('clock.js never reads a clock of its own', () => {
  const src = readFileSync(fileURLToPath(new URL('../js/core/clock.js', import.meta.url)), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now|new Date|performance\.now/.test(code), 'no clock read in clock.js');
  assert.ok(!/Math\.random/.test(code), 'no rng in clock.js');
});
