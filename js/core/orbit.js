// Kepler helpers for the orbital phase and the map view. Pure: no DOM, no
// Date.now, no Math.random. Shared by js/core/resolver.js (which resolves the
// tier 3 rendezvous sequence analytically) and js/ui/map.js (which plays it
// back), so the two cannot disagree about where anything is.
//
// UNITS. Every distance in this module is a RADIUS from the planet's centre in
// metres — never an altitude. The resolver and the state store orbits as
// ALTITUDES (periapsis/apoapsis above the surface, which is what a player
// reads), so a caller converts on the way in and out:
//
//   radiusOf(altitude)   altitude -> radius      (exported below)
//   altitudeOf(radius)   radius   -> altitude
//
// Getting that wrong is a 6 371 km mistake, so the two helpers exist rather
// than leaving `+ R` scattered across call sites.
//
// FRAME. Planet-centred, planar, right-handed: angles increase anticlockwise
// from +x, and an orbit is described by (periapsis radius, apoapsis radius,
// argument of periapsis, phase). PHASE is the fraction of an orbit completed
// since periapsis passage — 0 at periapsis, 0.5 at apoapsis — which is mean
// anomaly / 2pi. It is what state.objects store (`phase`) and what a launch
// window is quoted against, because it advances linearly with time and so can
// be compared between two objects without solving anything.

import { G0 } from './vehicle.js';

/** Planet radius, m. Same planet as resolver.js, which imports these two. */
export const R = 6.371e6;
/** Standard gravitational parameter, m^3/s^2: mu = g0 * R^2. */
export const MU = G0 * R * R;

/**
 * Phasing cost, m/s per degree of phase error (ARCHITECTURE.md, phase 2).
 *
 * A game number, not a derivation: a real phasing maneuver's cost depends on
 * how many orbits you are willing to spend closing the angle, so quoting it
 * per degree fixes the schedule (here: the two-burn pair at +1.5P and +2.5P)
 * and makes the launch window a decision with a price the player can read.
 */
export const PHASING_DV_PER_DEG = 4;

const TWO_PI = Math.PI * 2;

/** Altitude above the surface (m) -> radius from the centre (m). */
export function radiusOf(altitude) {
  return R + altitude;
}

/** Radius from the centre (m) -> altitude above the surface (m). */
export function altitudeOf(radius) {
  return radius - R;
}

/**
 * Orbit shape from its two apsides (RADII, m).
 *
 *   a = (rp + ra) / 2
 *   e = (ra - rp) / (ra + rp)
 *   period = 2 pi sqrt(a^3 / mu)
 *
 * The arguments are ordered so that swapping them is harmless: whichever is
 * smaller is treated as the periapsis. A degenerate orbit (a <= 0) reports
 * e = 0 and period 0 rather than NaN, so callers can guard on `period > 0`.
 *
 * @param {number} rp periapsis radius, m
 * @param {number} ra apoapsis radius, m
 * @returns {{ a: number, e: number, period: number }}
 */
export function elementsFrom(rp, ra) {
  const lo = Math.min(rp, ra);
  const hi = Math.max(rp, ra);
  const a = (lo + hi) / 2;
  if (!(a > 0) || !Number.isFinite(a)) return { a, e: 0, period: 0 };
  const e = hi + lo > 0 ? (hi - lo) / (hi + lo) : 0;
  const period = TWO_PI * Math.sqrt((a * a * a) / MU);
  return { a, e, period };
}

/**
 * Vis-viva: speed on an orbit of semi-major axis `a` at radius `r`.
 *
 *   v = sqrt(mu (2/r - 1/a))
 *
 * `velocityAt(a, a)` is therefore the circular speed at radius a, which is how
 * the eccentricity term in transferDeltaV is scaled.
 *
 * @param {number} a semi-major axis, m
 * @param {number} r radius, m
 * @returns {number} m/s (0 where the expression is not defined)
 */
export function velocityAt(a, r) {
  if (!(r > 0)) return 0;
  const v2 = MU * (2 / r - (Number.isFinite(a) && a !== 0 ? 1 / a : 0));
  return v2 > 0 ? Math.sqrt(v2) : 0;
}

/**
 * Hohmann transfer between two CIRCULAR orbits of radii r1 and r2.
 *
 * Two burns on the ellipse that touches both circles: one to leave, one to
 * arrive. Symmetric — lowering costs the same as raising — so both delta-vs are
 * returned as magnitudes and r2 < r1 is fine.
 *
 * @param {number} r1 starting circular radius, m
 * @param {number} r2 target circular radius, m
 * @returns {{ dv1: number, dv2: number, tof: number }} m/s, m/s, seconds
 */
export function hohmann(r1, r2) {
  if (!(r1 > 0) || !(r2 > 0)) return { dv1: 0, dv2: 0, tof: 0 };
  const at = (r1 + r2) / 2;
  const dv1 = Math.abs(velocityAt(at, r1) - velocityAt(r1, r1));
  const dv2 = Math.abs(velocityAt(r2, r2) - velocityAt(at, r2));
  const tof = Math.PI * Math.sqrt((at * at * at) / MU);
  return { dv1, dv2, tof };
}

/**
 * Total delta-v to go from orbit 1 to orbit 2, both given as apsis RADII.
 *
 * THE APPROXIMATION (ARCHITECTURE.md, phase 2). A general transfer between two
 * arbitrary ellipses depends on where the burns are made and on the angle
 * between the two lines of apsides — none of which this game models, because
 * nothing is piloted. So the cost is split into the two parts that dominate it:
 *
 *   1. the size change: a Hohmann transfer between the two SEMI-MAJOR AXES,
 *      i.e. between the circular orbits of radius a1 and a2. That captures the
 *      whole energy change, which is what a transfer mostly pays for.
 *   2. the shape change: |e1 - e2| * velocityAt(a2, a2) * 0.5 — an
 *      eccentricity mismatch of de costs roughly de/2 of the local circular
 *      speed, which is the first-order cost of rotating the velocity vector
 *      onto the target ellipse.
 *
 * It is exact for circle-to-circle (term 2 vanishes), right to first order for
 * near-circular orbits, and an underestimate for a large apsidal rotation. It
 * is also symmetric and zero between identical orbits, which is what the game
 * needs: a vehicle inserted into its target's orbit pays nothing to match it.
 *
 * @param {number} rp1 periapsis radius of the starting orbit, m
 * @param {number} ra1 apoapsis radius of the starting orbit, m
 * @param {number} rp2 periapsis radius of the target orbit, m
 * @param {number} ra2 apoapsis radius of the target orbit, m
 * @returns {number} m/s
 */
export function transferDeltaV(rp1, ra1, rp2, ra2) {
  const one = elementsFrom(rp1, ra1);
  const two = elementsFrom(rp2, ra2);
  if (!(one.a > 0) || !(two.a > 0)) return 0;
  const { dv1, dv2 } = hohmann(one.a, two.a);
  const eccentricity = Math.abs(one.e - two.e) * velocityAt(two.a, two.a) * 0.5;
  return dv1 + dv2 + eccentricity;
}

/**
 * Cost of closing a phase error of `angleDeg` degrees, m/s.
 *
 * Linear in the angle (PHASING_DV_PER_DEG per degree) and never negative: the
 * caller's sign says which way round the two objects are, which does not change
 * the price.
 *
 * @param {number} angleDeg degrees of phase error
 * @returns {number} m/s
 */
export function phasingDeltaV(angleDeg) {
  const deg = Math.abs(Number(angleDeg) || 0);
  return PHASING_DV_PER_DEG * deg;
}

/**
 * Solve Kepler's equation M = E - e sin E for the eccentric anomaly E.
 *
 * Newton-Raphson from a first-order guess, which converges to machine precision
 * in a handful of iterations for every eccentricity this game produces (e < 1;
 * the iteration count is capped so a pathological input cannot hang a frame).
 */
function solveKepler(meanAnomaly, e) {
  const M = ((meanAnomaly % TWO_PI) + TWO_PI) % TWO_PI;
  if (!(e > 0)) return M;
  let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI;
  for (let i = 0; i < 40; i += 1) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    if (Math.abs(fp) < 1e-15) break;
    const step = f / fp;
    E -= step;
    if (Math.abs(step) < 1e-13) break;
  }
  return E;
}

/**
 * Where an object on a fixed orbit is at time `t`.
 *
 * The orbit is given by its apsis RADII, the direction of its periapsis
 * (`argPeriapsis`, radians anticlockwise from +x) and `phase0`, the orbit
 * fraction — mean anomaly / 2pi — at t = 0. Mean anomaly advances linearly, so
 * the solve is: phase -> mean anomaly -> eccentric anomaly (Kepler, above) ->
 * true anomaly -> position.
 *
 * @param {number} rp periapsis radius, m
 * @param {number} ra apoapsis radius, m
 * @param {number} [argPeriapsis=0] radians
 * @param {number} [phase0=0] 0..1 at t = 0 (values outside wrap)
 * @param {number} [t=0] seconds
 * @returns {{ x: number, y: number, r: number, trueAnomaly: number }}
 *   position in planet-centred metres, radius, and true anomaly in radians
 */
export function positionAt(rp, ra, argPeriapsis = 0, phase0 = 0, t = 0) {
  const { a, e, period } = elementsFrom(rp, ra);
  if (!(a > 0) || !Number.isFinite(a)) {
    return { x: 0, y: 0, r: 0, trueAnomaly: 0 };
  }
  const turns = phase0 + (period > 0 ? t / period : 0);
  const E = solveKepler(TWO_PI * turns, e);
  const trueAnomaly = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
  const r = a * (1 - e * Math.cos(E));
  const angle = trueAnomaly + argPeriapsis;
  return { x: r * Math.cos(angle), y: r * Math.sin(angle), r, trueAnomaly };
}

/**
 * The fixed orbital phase of an object, from its id.
 *
 * FNV-1a over the id's UTF-16 code units, scaled into [0, 1). Deterministic,
 * dependent on nothing but the string, and unrelated to the game's rng — an
 * object's place on its orbit is a property of the object, so it survives a
 * save/load and cannot drift when the rng's draw count changes.
 *
 * @param {string} id
 * @returns {number} 0 <= phase < 1
 */
export function phaseFor(id) {
  const s = String(id ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}
