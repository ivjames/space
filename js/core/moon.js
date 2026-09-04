// The moon: its constants, and the delta-v ladder derived from them. Pure: no
// DOM, no Date.now, no Math.random. Shared by js/core/resolver.js (which
// resolves the tier 4 lunar sequence analytically) and js/ui/map.js (which
// plays it back), so the two cannot disagree about what a flight to the moon
// costs or how long it takes.
//
// A SIBLING OF orbit.js, NOT A PARAMETERISATION OF IT. orbit.js keeps its
// module-level MU and R and its "there is exactly one planet" test: every
// function it exports is about the planet the game launches from. This module
// adds a second set of constants and prices the ladder BY CALLING those
// functions — `hohmann`, `velocityAt`, `elementsFrom` — so every number below
// is computed rather than looked up (DESIGN.md §14.3). There is no magic m/s
// in this file, and the only way to move a rung is to move a constant.
//
// UNITS. Same discipline as orbit.js, and for the same reason: every distance
// here is a RADIUS in metres, never an altitude. `lunarLadder` takes the
// parking orbit's two apsis RADII from the PLANET's centre — a caller holding
// altitudes converts with orbit.js's `radiusOf` on the way in, exactly as
// resolver.js's orbital sequence already does. LLO_ALT is the one exception
// and says so in its name: it is an altitude above the MOON's surface, which
// is how a lunar parking orbit is quoted, and it is turned into a radius
// (R_MOON + LLO_ALT) at every point of use below.
//
// THE APPROXIMATIONS, all of them (the way orbit.js documents transferDeltaV's).
// A lunar flight here is a planet-centred Hohmann transfer with a capture at
// the far end, which is the cheapest honest model that produces the four
// numbers the tier is about:
//
//   1. IMPULSIVE BURNS. Every rung is a velocity change made in no time at a
//      point. Real departure and descent burns take minutes and pay finite-burn
//      losses; the descent's are folded into LANDING_LOSS, and the departure's
//      are not modelled at all — a cryogenic upper stage's TLI is close enough
//      to impulsive that the error is under the width of the tier's balance.
//   2. COPLANAR. The moon's orbit is treated as lying in the launch plane, so
//      no plane change is ever charged. A real mission pays up to ~200 m/s for
//      the moon's 5.1 degree inclination and its node timing; the game has no
//      inclination at all (the whole simulation is 2D, resolver.js's frame is
//      planar) so there is nothing to charge it against.
//   3. THE MOON IS A POINT THE TRANSFER APOAPSIS TOUCHES. No patched conics,
//      no sphere of influence, no hyperbolic elements — ARCHITECTURE.md phase 3
//      is explicit that the moon must not become a second attractor, because
//      the ascent integrator has one central gravity term and one frame. So the
//      transfer is priced as if it coasted to lunar distance in the planet's
//      field alone, and the capture is priced from the SPEED DIFFERENCE it
//      arrives with (v-infinity), which is what a patched conic would hand the
//      lunar leg anyway. What is lost is the moon's own gravity pulling the
//      vehicle in over the last ~60 000 km, which makes the real transfer a
//      little cheaper and a little quicker than the numbers here.
//   4. CIRCULAR LUNAR ORBIT. Everything at the moon happens at one radius,
//      R_MOON + LLO_ALT: the capture arrives on it, the descent leaves from it
//      and the ascent returns to it. A real mission uses an elliptical descent
//      orbit and splits the descent into two burns; the split is a piloting
//      decision, and nothing here is piloted.
//   5. NO ATMOSPHERE AT THE MOON, AND A FREE ONE AT THE PLANET. Descent and
//      ascent are therefore symmetric (see LANDING_LOSS), and entry costs
//      nothing at all — the planet's atmosphere does the braking. A vehicle
//      without a heat shield does not get to spend delta-v instead of carrying
//      one; that is a hardware gate in the resolver, not a rung here.
//
// The eccentricity-mismatch term orbit.js's `transferDeltaV` charges is NOT
// reused. It exists because a tier 3 transfer is between two orbits whose
// apsides are wherever they happen to be; a lunar transfer departs from the
// parking orbit's own periapsis by choice, so the Hohmann pair — the burn that
// puts apoapsis at lunar distance, and the one that stops there — is the
// honest price and not an approximation of one.

import { elementsFrom, hohmann, velocityAt } from './orbit.js';

/** Lunar radius, m. */
export const R_MOON = 1.7374e6;
/** Lunar standard gravitational parameter, m^3/s^2. */
export const MU_MOON = 4.9028e12;
/**
 * Radius of the moon's orbit about the planet, m — the distance the transfer
 * apoapsis is placed at. Circular: the real orbit's eccentricity (0.055) moves
 * this by ±21 000 km over a month, which is a timing decision the game does
 * not have a clock for (ARCHITECTURE.md defers the clock to phase 3b).
 */
export const A_MOON = 3.844e8;

/**
 * The low lunar orbit every lunar rung is priced against, as an ALTITUDE above
 * the moon's surface, m.
 *
 * 100 km is the Apollo parking orbit and the natural place to put it: high
 * enough that the mascon-driven decay a real 50 km orbit suffers is not a
 * thing the game would have to lie about, low enough that the capture and the
 * descent are quoted against nearly the same circular speed.
 */
export const LLO_ALT = 100000;

/**
 * Gravity and steering loss factor on the powered descent and the ascent.
 *
 * A GAME NUMBER of the same kind as resolver.js's LOSS_ALLOWANCE, and the whole
 * difference between the ideal and the ladder here: the ideal cost of stopping
 * a 100 km circular orbit dead at the surface is exactly its circular speed,
 * but a real descent spends several minutes fighting lunar gravity while it
 * does so, and steers as well as brakes. Apollo's LM budgeted ~2 100 m/s of
 * descent against a ~1 630 m/s circular speed, but from a 15 km perilune after
 * a separate deorbit burn; measured against the 100 km orbit this module prices
 * everything from, 15% is the honest ratio.
 *
 * The same factor applies to the ascent because there is no atmosphere: an
 * airless launch and an airless landing are the same problem run backwards, so
 * the loss is the same and the two rungs are equal by construction.
 */
export const LANDING_LOSS = 1.15;

/**
 * The lunar ladder's steps, in flight order. `reached` in the resolver's lunar
 * result is an index into this array, and a profile's success is "reached the
 * step this profile is about" — so the array's ORDER is the contract, and a
 * step inserted in the middle of it renumbers every saved `best.lunarStep`.
 */
export const LUNAR_STEPS = ['tli', 'loi', 'descent', 'ascent', 'tei'];

/**
 * The delta-v ladder for a lunar flight departing from a given parking orbit.
 *
 * Every rung is computed from the constants above through orbit.js:
 *
 *   tli      the departure burn of a Hohmann transfer from the parking orbit's
 *            periapsis to lunar distance. Made at periapsis, where it is
 *            cheapest, so an eccentric parking orbit is charged less than a
 *            circular one of the same energy — the vehicle is already moving
 *            faster there. For a CIRCULAR parking orbit this is exactly
 *            `hohmann(rPark, A_MOON).dv1`, which is the form ARCHITECTURE.md
 *            quotes it in and which the tests pin.
 *   loi      the capture at the moon. The transfer arrives at A_MOON moving at
 *            `velocityAt(aTransfer, A_MOON)` while the moon itself moves at
 *            `sqrt(MU / A_MOON)`, so the vehicle turns up in the moon's frame
 *            with an excess speed of the difference:
 *              vInf   = |v_transfer - v_moon|
 *              vHyper = sqrt(vInf^2 + 2 MU_MOON / rLLO)   (vis-viva, e >= 1)
 *              loi    = vHyper - sqrt(MU_MOON / rLLO)
 *            i.e. what it takes to pull a hyperbolic arrival down onto the
 *            circular orbit it is passing through.
 *   descent  circular speed at rLLO, times LANDING_LOSS: stopping dead.
 *   ascent   the same number, for the same reason (see LANDING_LOSS).
 *   tei      equal to `loi`, by the symmetry of a Hohmann transfer: leaving
 *            the moon on the return leg costs exactly what arriving cost, and
 *            entry at the planet is free.
 *   tof      the transfer's own time of flight, s — half the period of the
 *            transfer ellipse, and about five days for a low parking orbit.
 *
 * Degenerate input (a non-positive or non-finite radius) returns a ladder of
 * zeros rather than NaN, matching elementsFrom's and hohmann's guards, so a
 * caller pricing a vehicle that never reached orbit gets a number it can add up.
 *
 * @param {number} parkPeriapsis periapsis RADIUS of the parking orbit, m
 * @param {number} parkApoapsis  apoapsis RADIUS of the parking orbit, m
 * @returns {{ tli: number, loi: number, descent: number, ascent: number,
 *             tei: number, tof: number }} m/s, and tof in seconds
 */
export function lunarLadder(parkPeriapsis, parkApoapsis) {
  const zero = { tli: 0, loi: 0, descent: 0, ascent: 0, tei: 0, tof: 0 };
  const rp = Math.min(parkPeriapsis, parkApoapsis);
  const ra = Math.max(parkPeriapsis, parkApoapsis);
  if (!(rp > 0) || !Number.isFinite(ra)) return zero;

  // --- The transfer, planet-centred ----------------------------------------
  const park = elementsFrom(rp, ra);
  const transfer = elementsFrom(rp, A_MOON);
  if (!(park.a > 0) || !(transfer.a > 0)) return zero;

  // Departure at the parking orbit's periapsis: the speed the transfer needs
  // there, less the speed the vehicle already has there.
  const tli = Math.abs(velocityAt(transfer.a, rp) - velocityAt(park.a, rp));
  // The transfer's own half-period. hohmann() computes exactly this, and
  // asking it rather than repeating the formula is what keeps the two in step.
  const { tof } = hohmann(rp, A_MOON);

  // --- The capture, in the moon's frame ------------------------------------
  const rLLO = R_MOON + LLO_ALT;
  const vCircLunar = Math.sqrt(MU_MOON / rLLO);
  // velocityAt(A_MOON, A_MOON) is the circular speed at lunar distance, which
  // is the moon's own speed — the same vis-viva the transfer is priced with.
  const vInf = Math.abs(velocityAt(transfer.a, A_MOON) - velocityAt(A_MOON, A_MOON));
  const loi = Math.sqrt(vInf * vInf + 2 * (MU_MOON / rLLO)) - vCircLunar;

  // --- The surface ---------------------------------------------------------
  const descent = vCircLunar * LANDING_LOSS;

  return { tli, loi, descent, ascent: descent, tei: loi, tof };
}

/**
 * Period of the low lunar orbit the ladder is priced against, s.
 *
 * Kepler's third law about the MOON — the one thing in the lunar leg that
 * orbit.js cannot be asked for, because every function it exports carries the
 * planet's MU. About two hours, which is what schedules the descent and the
 * ascent in the resolver's timeline.
 */
export const LLO_PERIOD = 2 * Math.PI
  * Math.sqrt(((R_MOON + LLO_ALT) ** 3) / MU_MOON);

/**
 * Seconds spent on the surface between the descent and the ascent.
 *
 * One day, which is between Apollo 11's 21 hours and Apollo 17's 75. Nothing
 * measures it — there is no clock in phase 3 (that is 3b) and no surface
 * activity to spend it on — so it exists only to put the ascent burn somewhere
 * believable on the timeline the map plays back and the result screen reports
 * as mission elapsed time.
 */
export const SURFACE_STAY = 86400;

/**
 * When each step of a lunar flight happens, s.
 *
 * Derived from the insertion and the ladder alone — no burn, nothing the
 * sequence AFTER insertion discovered. That is what lets the map view call it:
 * the cislunar frame has to place the moon where the transfer will arrive from
 * the FIRST frame, before any burn has been played back, and reading burn times
 * off the outcome to do that would break the no-leak contract the map keeps
 * (js/ui/map.js). Both callers derive the schedule instead of sharing it, which
 * is why it is one exported function rather than two agreeing copies: a change
 * to the departure time that only the resolver knew about would leave the map
 * flashing the capture burn beside the moon rather than at it.
 *
 * DEPARTURE IS AT THE NEXT PERIAPSIS PASSAGE, which is what `phase` is for.
 * `lunarLadder` prices TLI as a burn made at the parking orbit's PERIAPSIS —
 * that is the Oberth-efficient place to leave from, it is what a real mission
 * does, and on an eccentric parking orbit it is hundreds of m/s cheaper than
 * anywhere else — so the schedule has to put the burn where the price says it
 * is. It cannot: the two apsides say what the orbit is, not where on it the
 * vehicle is, and insertion cutoff fires the instant the achieved orbit's
 * periapsis crosses the threshold, which on a real ascent is a few hundred km
 * up and still climbing. So the caller passes the orbit PHASE at t0 (mean
 * anomaly / 2pi since periapsis, js/core/orbit.js's convention) and the wait is
 * the rest of that orbit: `(1 - phase) * parkPeriod`.
 *
 * THE BUG THIS REPLACED, because it is worth naming: departure used to be half
 * a parking orbit after insertion, described as coasting "to the far side" and
 * leaving from there. The far side is APOAPSIS — the single worst place to
 * depart from, and the one the price is not quoted at. On an 80 x 4 381 km
 * parking orbit that scheduled a 3 218 m/s burn and charged 2 234 m/s for it,
 * so a lunar mission was marked affordable, and flown, on 983 m/s the vehicle
 * did not have. A phase of 0 (already at periapsis) therefore waits a FULL
 * period rather than burning at t0: a burn at the instant of insertion is not
 * a coast, and the map has to have something to draw.
 *
 * Capture is one transfer time of flight later. Descent and the burn home each
 * sit a quarter of a low lunar orbit after arriving, which is the shortest wait
 * that is not zero.
 *
 * @param {number} t0 insertion time, s
 * @param {number} parkPeriod period of the achieved parking orbit, s
 * @param {{tof: number}} ladder from `lunarLadder`
 * @param {number} [phase=0] orbit fraction since periapsis at t0, 0..1
 *   (values outside wrap; a non-finite one is treated as 0)
 * @returns {{tli: number, loi: number, descent: number, ascent: number, tei: number}}
 */
export function lunarSchedule(t0, parkPeriod, ladder, phase = 0) {
  const p = Number.isFinite(phase) ? ((phase % 1) + 1) % 1 : 0;
  const tli = t0 + (1 - p) * parkPeriod;
  const loi = tli + ladder.tof;
  const descent = loi + LLO_PERIOD / 4;
  const ascent = descent + SURFACE_STAY;
  return { tli, loi, descent, ascent, tei: ascent + LLO_PERIOD / 4 };
}
