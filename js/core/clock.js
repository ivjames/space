// The clock: how much wall-clock time has passed since the last accrual, and
// nothing else. Pure — no DOM, no `Date.now`, no `Math.random`. See
// ARCHITECTURE.md, "Phase 3b — the economy, whole".
//
// `now` IS ALWAYS AN ARGUMENT. Every other module in js/core is pure for the
// obvious reason; this one is pure for a less obvious one, and it is worth
// stating because this is precisely the file where a `Date.now()` would look
// harmless. It is the module named for the clock, so reading the clock here
// reads as the module doing its job — and it would make every accrual test a
// function of when the test ran. js/main.js is the only module in the codebase
// allowed to be non-deterministic (it already owns the seed), so it reads the
// real clock and passes the number in.
//
// WHAT IS ON THE CLOCK. Exactly one thing: base production (DESIGN.md §3's
// table, decision 9). Research, purchases, launches and hauls all resolve now.
// A timer the player waits out for anything else is the mechanic DESIGN.md §12
// excludes by name — "a clock tuned for fun and a clock tuned to sell skips are
// different clocks" — so this module deliberately exports no way to ask "how
// long until X is ready". Nothing is ever not ready.

/**
 * The most elapsed time a single accrual may credit, ms.
 *
 * 24 hours, DESIGN.md §3's placeholder. A BOUND, NOT A FAIRNESS DEVICE: §3 is
 * explicit that clock manipulation is the player's own problem and we do not
 * fight it. What the clamp is for is that a save opened after a month must not
 * credit a month — that would make storage caps meaningless (js/core/base.js
 * stops accrual at the cap, and a cap you always arrive at full is not an
 * upgrade) and would make the first app-open of a new week worth more than
 * every launch in it.
 *
 * The intended relationship with storage is that this is the BACKSTOP and the
 * cap is the binding constraint: on a base whose storage holds less than a day
 * of production, accrual stops at the cap long before it stops here, and
 * `tools/balance.mjs` asserts that is true at every buyable level.
 */
export const ELAPSED_CLAMP = 24 * 60 * 60 * 1000;

/**
 * Milliseconds to credit for an accrual running from `lastTick` to `now`.
 *
 * Three cases, and the two that are not the ordinary one both answer 0 or the
 * clamp rather than throwing, because this is called on every app open with
 * whatever the save happens to hold:
 *
 *   - `lastTick` null (a save that has never ticked — see state.js's newGame
 *     and save.js's migrations[4]) -> 0. A game that has never had a base has
 *     not been producing, and the alternative encoding, 0, is the epoch: it
 *     would clamp to a full day and credit a brand-new game with one.
 *   - `now` at or before `lastTick` (a clock moved backwards, a save carried
 *     between devices) -> 0. Never negative: accruing backwards would take
 *     resources away, which is a bug that would read as cheating punished.
 *   - anything else -> the difference, capped at ELAPSED_CLAMP.
 *
 * @param {number|null} lastTick ms epoch of the last accrual, or null
 * @param {number} now ms epoch
 * @returns {number} ms in [0, ELAPSED_CLAMP]
 */
export function elapsedSince(lastTick, now) {
  if (lastTick === null || lastTick === undefined) return 0;
  if (!Number.isFinite(lastTick) || !Number.isFinite(now)) return 0;
  const delta = now - lastTick;
  if (!(delta > 0)) return 0;
  return Math.min(delta, ELAPSED_CLAMP);
}

/**
 * Advance the state's clock, reporting how long it advanced by.
 *
 * It does NOT accrue anything — that is js/core/base.js's job, and keeping the
 * two apart is what lets the accrual be a pure function of a base, a site and
 * a duration with no notion of when it is. This function only answers "how
 * much time is there to spend" and stamps that the time has been spent.
 *
 * `lastTick` is set to `now` even when the elapsed time is 0, which is the
 * point of the null case: the first tick of a fresh or migrated save starts
 * the clock rather than paying out on it.
 *
 * @param {object} state
 * @param {number} now ms epoch
 * @returns {{ state: object, elapsed: number }} the stamped state, and ms
 */
export function tick(state, now) {
  const elapsed = elapsedSince(state.lastTick ?? null, now);
  const stamped = Number.isFinite(now) ? now : (state.lastTick ?? null);
  return { state: { ...state, lastTick: stamped }, elapsed };
}

/** Milliseconds in an hour — the unit every production rate is quoted in. */
export const HOUR = 60 * 60 * 1000;

/**
 * Hours in a span of milliseconds, as a float.
 *
 * Production rates are per hour because that is the number a player can read
 * off a screen and reason about ("this fills overnight"), and the accrual is
 * continuous rather than ticking in whole hours — a base that produced nothing
 * for the first fifty-nine minutes of every hour would be a different, worse
 * mechanic, and one the player would notice.
 */
export const hoursIn = (ms) => (Number.isFinite(ms) && ms > 0 ? ms / HOUR : 0);
