// Seeded PRNG. Pure: no Math.random, no Date.now, no DOM.
//
// mulberry32 — 32-bit state, fast, good enough for game variance and, more
// importantly, trivially reproducible: same seed + same number of draws =>
// same sequence, on any engine, forever. That is what lets a save store
// { seed, draws } and replay a run exactly (ARCHITECTURE.md §js/core/rng.js).

/**
 * Advance one step of mulberry32.
 * @param {number} state uint32
 * @returns {{ value: number, state: number }} value in [0,1), next state
 */
function mulberry32Step(state) {
  let a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: a };
}

/**
 * Make a seeded random number generator.
 *
 * @param {number} seed uint32 (any number is coerced with >>> 0)
 * @param {number} [draws=0] fast-forward this many draws before returning —
 *   pass the saved draw count to resume a game exactly where it left off.
 * @returns {{ next(): number, int(n: number): number, seed: number, draws: number }}
 *   `next()` returns a float in [0,1) and advances the state.
 *   `int(n)` returns an integer in 0..n-1 and consumes exactly one draw.
 *   `seed` is the seed it was made with (uint32).
 *   `draws` is a live, read-only count of how many values have been drawn.
 */
export function makeRng(seed, draws = 0) {
  const seed32 = seed >>> 0;
  let state = seed32;
  let count = 0;

  const rng = {
    next() {
      const step = mulberry32Step(state);
      state = step.state;
      count += 1;
      return step.value;
    },
    int(n) {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`rng.int(n): n must be a positive integer, got ${n}`);
      }
      return Math.floor(rng.next() * n);
    },
  };

  Object.defineProperty(rng, 'seed', { value: seed32, enumerable: true });
  Object.defineProperty(rng, 'draws', {
    get: () => count,
    enumerable: true,
  });

  const skip = draws >>> 0;
  for (let i = 0; i < skip; i += 1) rng.next();

  return rng;
}

/**
 * Stable child seed for the nth derived stream.
 *
 * Pure function of (seed, n) — no internal state, no dependence on how many
 * draws the parent rng has made. Used where a subsystem wants its own
 * reproducible stream (contract generation, per-launch variance) without
 * perturbing the main sequence.
 *
 * @param {number} seed uint32
 * @param {number} n index
 * @returns {number} uint32
 */
export function deriveSeed(seed, n) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (n >>> 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ ((n >>> 0) + 0xc2b2ae35), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  return h >>> 0;
}
