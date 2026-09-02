// Launch resolver: vehicle + mission + loadout + rng -> outcome + timeline.
// Pure: no DOM, no Date.now, no Math.random. The resolver never renders —
// js/ui/ascent.js plays `outcome.samples` and `outcome.timeline`.
//
// Physics is a 2D point mass. Phase 0 flew straight up over flat ground;
// phase 1 puts the planet's centre at world (0, -R) and makes gravity central,
// which is what turns "go up" into "go sideways fast enough to keep missing
// the ground". A vertical flight is the same problem it was under the
// flat-ground model (see CENTRAL GRAVITY below), so tier 1 is unchanged.
// See DESIGN.md §14 and ARCHITECTURE.md §js/core/resolver.js.
//
// STAGE NUMBERING: every `stage` field in the outcome (events, samples,
// `failure.stage`) is 1-BASED — "Stage 1" is vehicle.stages[0]. It matches the
// readouts the player sees ("Stage 2 ignition failure at T+142s."). Subtract 1
// to index vehicle.stages. ARCHITECTURE.md does not pin this down; this is the
// module's documented choice and it is consistent across the whole outcome.
//
// CENTRAL GRAVITY. The pad is world (0, 0); the planet's centre is world
// (0, -R_EARTH). So the position vector from the centre is r = (x, y + R),
// altitude is |r| - R, and gravity is -mu/|r|^2 along r with mu = g0 * R^2.
// On the x = 0 axis that is algebraically identical to the phase 0 model
// (|r| = y + R, so |g| = g0 * (R/(R+y))^2 pointing at -y): a vertical flight
// differs only by floating-point noise, which is what lets the tier 1
// regression test assert 0.5% and actually see ~1e-10.
//
// Thrust points along the pitch program: an angle measured from the local
// vertical (the r direction) rotating toward the prograde horizontal, which on
// the launch axis is +x. Downrange is the surface arc from the pad,
// R * atan2(x, y + R), not the straight-line x.

import { G0, stageDeltaV, stackMassAbove } from './vehicle.js';
import {
  MU as ORBIT_MU,
  R as ORBIT_R,
  elementsFrom,
  velocityAt,
  hohmann,
  transferDeltaV,
  phasingDeltaV,
} from './orbit.js';

/**
 * Planet radius, m. Earth-like and unnamed (DESIGN.md: real physics, fictional
 * setting). Defined in js/core/orbit.js and re-exported here so the simulated
 * ascent and the analytic orbital phase cannot be flying around two planets.
 */
export const R_EARTH = ORBIT_R;
/** Standard gravitational parameter, m^3/s^2: mu = g0 * R^2. */
export const MU = ORBIT_MU;
/** Sea-level density, kg/m^3, for the exponential atmosphere. */
export const RHO0 = 1.225;
/** Atmospheric scale height, m: rho(h) = RHO0 * exp(-h / SCALE_HEIGHT). */
export const SCALE_HEIGHT = 8500;

/**
 * Gravity/drag loss allowance folded into `deltaVRequired`.
 *
 * The ideal delta-v to coast from rest to altitude h is sqrt(2 * g0 * h) — it
 * ignores every loss a real ascent pays (gravity losses while the engine
 * burns, drag through the lower atmosphere, steering). A real vertical ascent
 * pays far more than 15%, but `deltaVRequired` is a GAME NUMBER: the budget
 * the shop and the "short by X m/s" readout are quoted against. 15% keeps that
 * number close to the honest ideal, so a player who has read the delta-v of
 * their vehicle in the shop can reason about it, while still making the
 * requirement strictly harder than the textbook figure.
 *
 *   deltaVRequired = sqrt(2 * g0 * h_required) * (1 + LOSS_ALLOWANCE)
 *
 * Success is decided by the simulation (maxAltitude >= requirement), never by
 * this number — it only sets how the shortfall reads.
 *
 * CAVEAT, and the reason `shortBy` has a floor below: 15% is generous for a
 * gravity-turn ascent and much too small for the straight-up flight phase 0
 * actually flies, which pays gravity losses over the whole burn. So a vehicle
 * can carry more delta-v than `deltaVRequired` and still fall short in the
 * simulation. Raising this constant (or making it per-profile) is the lever if
 * playtesting says the shop's target reads as a lie; the floor below keeps the
 * readout honest either way.
 */
export const LOSS_ALLOWANCE = 0.15;

/**
 * Loss allowance for an ORBIT requirement (ARCHITECTURE.md, phase 1).
 *
 *   deltaVRequired = sqrt(mu / (R + periapsis_required)) * (1 + ORBIT_LOSS_ALLOWANCE)
 *
 * Bigger than LOSS_ALLOWANCE because an orbital ascent is a longer, lossier
 * flight than a sounding shot: circular velocity at 100 km is ~7.85 km/s and a
 * real ascent pays ~9.5 km/s, so 25% is close to the honest ratio rather than
 * the deliberately optimistic 15% quoted for altitude.
 */
export const ORBIT_LOSS_ALLOWANCE = 0.25;

/**
 * Periapsis (altitude, m) at or above which a trajectory counts as an orbit.
 * 80 km is below every tier 2 orbit requirement, so it is a telemetry
 * threshold ("you are in orbit") and not a pass mark — the mission's own
 * `requirement.orbit.periapsis` decides success.
 */
export const ORBIT_MIN_ALT = 80000;

/**
 * Once orbit is confirmed the flight coasts this long before ending, so the
 * ascent view has something to show after the announcement instead of cutting
 * on the same frame.
 */
export const ORBIT_CONFIRM_COAST = 30;

// --- Pitch program constants (ARCHITECTURE.md, phase 1) ---------------------
// The program is vertical until `turnStart`, then pitches over linearly with
// ALTITUDE to 90 degrees at `turnEnd`. Both ends lerp with the loadout's
// `turn`:
//
//   turnStart = lerp(TURN_START_LAZY, TURN_START_HARD, turn)
//   turnEnd   = lerp(TURN_END_LAZY,   TURN_END_HARD,   turn)
//
// turn = 0 is a lazy turn: it holds vertical to 8 km and is not horizontal
// until 160 km, so it pays gravity losses. turn = 1 is an early hard turn: off
// vertical by 1 km and horizontal by 60 km, which pays drag and leaves a weak
// vehicle with too low an apogee. Exported so js/data and tools/balance.mjs
// can search the window without hard-coding it.
// --- Orbital phase constants (ARCHITECTURE.md, phase 2) ---------------------
// Tier 3 is resolved analytically after insertion: a sequence of burns the
// vehicle can or cannot perform. These are the numbers that sequence is priced
// and judged against; exported so js/data, js/ui and tools/balance.mjs read the
// same figures the resolver uses.

/**
 * Closest approach a rendezvous reaches, in metres, indexed by `vehicle.nav`
 * (0 = no navigation, 3 = docking sensors). Halved when the vehicle has `rcs`.
 * This is the whole reason the guidance branch exists in tier 3: nothing else
 * moves this number.
 */
export const NAV_APPROACH = [50000, 5000, 500, 50];

/** Range (m) within which a docking attempt is possible at all. */
export const DOCK_RANGE = 100;

/** Probability a docking attempt succeeds without fine thrusters. */
export const DOCK_RELIABILITY = 0.9;
/** Probability a docking attempt succeeds with `rcs`. */
export const DOCK_RELIABILITY_RCS = 0.98;
/** Ceiling on the docking roll, however much `dockBonus` the tree buys. */
export const DOCK_RELIABILITY_MAX = 0.99;

/**
 * Phase error (degrees) small enough that no phasing burn is made at all. The
 * error is still charged to the approach (see NAV_APPROACH's `1 + |err| / 30`
 * term), so a tolerable window is not a free one.
 */
export const PHASE_TOLERANCE_DEG = 5;

/**
 * Delta-v allowance for the final approach, m/s.
 *
 * ARCHITECTURE.md quotes "approach allowance (50 m/s)" as part of
 * `deltaVRequired` for a rendezvous but does not price the approach step
 * itself; charging the same 50 m/s for the burn keeps the two consistent — the
 * budget a mission is quoted against is exactly the budget the sequence spends.
 */
export const APPROACH_DV = 50;

/** Altitude (m) at which a `turn: 0` program starts to pitch over. */
export const TURN_START_LAZY = 8000;
/** Altitude (m) at which a `turn: 1` program starts to pitch over. */
export const TURN_START_HARD = 1000;
/** Altitude (m) at which a `turn: 0` program reaches horizontal. */
export const TURN_END_LAZY = 160000;
/** Altitude (m) at which a `turn: 1` program reaches horizontal. */
export const TURN_END_HARD = 60000;

const EPS = 1e-9;
const HALF_PI = Math.PI / 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, u) => a + (b - a) * u;

/** Gravitational acceleration at altitude h (m), m/s^2. */
export function gravityAt(h) {
  const r = R_EARTH / (R_EARTH + Math.max(h, 0));
  return G0 * r * r;
}

/** Atmospheric density at altitude h (m), kg/m^3. */
export function densityAt(h) {
  if (h < 0) return RHO0;
  return RHO0 * Math.exp(-h / SCALE_HEIGHT);
}

/**
 * The pitch program a vehicle flies for a loadout.
 *
 * Pure and total: returns `(t, alt) => angle from local vertical, radians`,
 * monotonically non-decreasing in `alt`, exactly 0 at or below `turnStart` and
 * exactly PI/2 at or above `turnEnd`. `t` is accepted (and ignored) so the
 * shape can become time-aware later without touching every call site.
 *
 * `loadout.turn` is IGNORED unless `vehicle.guidance >= 1`: with no guidance
 * the vehicle cannot steer at all, so the program is identically vertical.
 * That is also what keeps every tier 1 flight a phase 0 flight.
 *
 * @param {object} vehicle
 * @param {object} [loadout] { turn: 0..1 }
 * @returns {(t: number, alt: number) => number}
 */
export function pitchProgram(vehicle, loadout = {}) {
  const guidance = vehicle?.guidance ?? 0;
  if (!(guidance >= 1)) return () => 0;

  const turn = clamp(Number(loadout?.turn) || 0, 0, 1);
  const turnStart = lerp(TURN_START_LAZY, TURN_START_HARD, turn);
  const turnEnd = lerp(TURN_END_LAZY, TURN_END_HARD, turn);
  const span = turnEnd - turnStart;

  return (t, alt) => {
    if (!(alt > turnStart)) return 0;
    if (alt >= turnEnd || span <= 0) return HALF_PI;
    return HALF_PI * ((alt - turnStart) / span);
  };
}

/**
 * Two-body orbital elements from a state vector, planet centred at the origin.
 *
 *   eps = v^2/2 - mu/r          specific orbital energy
 *   h   = |r x v|               specific angular momentum (a scalar in 2D)
 *   a   = -mu / (2 eps)         semi-major axis (negative when hyperbolic)
 *   e   = sqrt(1 + 2 eps h^2 / mu^2)
 *   periapsis = a(1-e) - R,   apoapsis = a(1+e) - R
 *
 * Periapsis and apoapsis are returned as ALTITUDES (radius minus R_EARTH), and
 * apoapsis is +Infinity whenever eps >= 0. They are computed through the conic
 * semi-latus rectum — p = h^2/mu, r_p = p/(1+e), r_a = p/(1-e) — which is the
 * same answer as a(1 -+ e) but stays finite and NaN-free at e = 1 (a parabola,
 * where a is infinite and a(1-e) is Infinity * 0).
 *
 * @param {{x: number, y: number}} r position, m, from the planet's centre
 * @param {{x: number, y: number}} v velocity, m/s
 * @returns {{ energy: number, h: number, a: number, e: number,
 *             periapsis: number, apoapsis: number }}
 */
export function orbitElements(r, v) {
  const rmag = Math.hypot(r.x, r.y);
  const vmag = Math.hypot(v.x, v.y);
  if (!(rmag > 0)) {
    return { energy: -Infinity, h: 0, a: 0, e: 1, periapsis: -R_EARTH, apoapsis: -R_EARTH };
  }

  const energy = (vmag * vmag) / 2 - MU / rmag;
  const h = Math.abs(r.x * v.y - r.y * v.x);
  const a = energy === 0 ? Infinity : -MU / (2 * energy);
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (MU * MU)));

  // Purely radial (h = 0) is a degenerate conic: it passes through the centre,
  // so periapsis radius is 0 and apoapsis is the turning radius 2a (infinite
  // if unbound). Straight up and straight down both land here.
  if (h <= 0) {
    return {
      energy,
      h: 0,
      a,
      e: 1,
      periapsis: -R_EARTH,
      apoapsis: energy < 0 ? 2 * a - R_EARTH : Infinity,
    };
  }

  const p = (h * h) / MU;
  const rp = p / (1 + e);
  const ra = e < 1 ? p / (1 - e) : Infinity;
  return {
    energy,
    h,
    a,
    e,
    periapsis: rp - R_EARTH,
    apoapsis: ra === Infinity ? Infinity : ra - R_EARTH,
  };
}

/** Which requirement shape a mission carries (phase 0, 1 and 2). */
function requirementKind(requirement) {
  if (!requirement) return null;
  if (typeof requirement.altitude === 'number') return 'altitude';
  if (typeof requirement.downrange === 'number') return 'downrange';
  if (requirement.orbit && typeof requirement.orbit.periapsis === 'number') return 'orbit';
  if (requirement.rendezvous && typeof requirement.rendezvous.within === 'number') return 'rendezvous';
  if (requirement.dock) return 'dock';
  return null;
}

/** The two shapes that resolve an orbital phase after insertion (tier 3). */
function needsTarget(kind) {
  return kind === 'rendezvous' || kind === 'dock';
}

/**
 * Delta-v to match a target's orbit from a circular orbit at the target's own
 * periapsis — the orbit the tier 2 requirement in `requiredDeltaV` pays for.
 * Zero for a circular target, which is the common case.
 */
function matchAllowance(target) {
  const rp = R_EARTH + target.periapsis;
  const ra = R_EARTH + target.apoapsis;
  return transferDeltaV(rp, rp, rp, ra);
}

/**
 * Delta-v a mission requires, expressed as a number the shop can compare
 * against. Handles all three requirement shapes; used by tools/balance.mjs as
 * well as by the outcome's `deltaVRequired`.
 *
 * - altitude:  sqrt(2 g0 h) * (1 + LOSS_ALLOWANCE)
 *     the ideal vertical coast to h, plus the game's loss allowance.
 * - downrange: sqrt(g0 d) * (1 + LOSS_ALLOWANCE)
 *     the ideal ballistic launch speed for range d on a flat, airless planet.
 *     Vacuum range is d = v^2 sin(2 theta) / g0, maximal at theta = 45 degrees
 *     where it reduces to d = v^2 / g0, hence v = sqrt(g0 d). The SAME loss
 *     allowance as altitude, because it is the same kind of sub-orbital lob —
 *     only the direction of the throw differs. (Sanity check that the two
 *     agree: the optimal lob for range d peaks at h = d/4, and
 *     sqrt(2 g0 d/4) = sqrt(g0 d / 2) is exactly the vertical component of
 *     sqrt(g0 d) thrown at 45 degrees.)
 * - orbit:     sqrt(mu / (R + peri)) * (1 + ORBIT_LOSS_ALLOWANCE)
 *     circular velocity at the required periapsis, plus the larger orbital
 *     loss allowance.
 * - rendezvous / dock (phase 2): the orbit requirement to the TARGET's
 *     periapsis, plus the orbital phase's own budget —
 *       matchAllowance(target)      matching the target's shape from there
 *     + phasingDeltaV(0) = 0        a perfect launch window costs nothing
 *     + APPROACH_DV                 the final approach
 *     The target is therefore needed to quote the number, and is passed as the
 *     optional second argument. WITHOUT it (a shop or a balance tool pricing a
 *     template with no object in orbit yet) the maneuver terms are unknowable,
 *     so the plain tier 2 orbit requirement is returned instead — quoted at
 *     ORBIT_MIN_ALT, the lowest orbit that counts as one.
 *
 * @param {object} mission
 * @param {object} [target] the object being flown to: { periapsis, apoapsis }
 * @returns {number} m/s
 */
export function requiredDeltaV(mission, target = null) {
  const req = mission?.requirement;
  if (!req) return 0;
  if (typeof req.deltaV === 'number') return req.deltaV;
  if (needsTarget(requirementKind(req))) {
    const peri = target && Number.isFinite(target.periapsis) ? target.periapsis : ORBIT_MIN_ALT;
    const ascent = Math.sqrt(MU / (R_EARTH + peri)) * (1 + ORBIT_LOSS_ALLOWANCE);
    if (!target || !Number.isFinite(target.apoapsis)) return ascent;
    return ascent + matchAllowance(target) + phasingDeltaV(0) + APPROACH_DV;
  }
  if (typeof req.altitude === 'number' && req.altitude > 0) {
    return Math.sqrt(2 * G0 * req.altitude) * (1 + LOSS_ALLOWANCE);
  }
  if (typeof req.downrange === 'number' && req.downrange > 0) {
    return Math.sqrt(G0 * req.downrange) * (1 + LOSS_ALLOWANCE);
  }
  if (req.orbit && typeof req.orbit.periapsis === 'number') {
    return Math.sqrt(MU / (R_EARTH + req.orbit.periapsis)) * (1 + ORBIT_LOSS_ALLOWANCE);
  }
  return 0;
}

/** "620 m" / "62 km" — unsigned distances (altitude reached, downrange). */
function formatAltitude(m) {
  if (m >= 1000) return `${Math.round(m / 1000)} km`;
  return `${Math.round(m)} m`;
}

/**
 * "112 km" / "-1800 km" / "escape" — orbital elements, which are routinely
 * negative (a periapsis under the surface) and are always quoted in km.
 *
 * ARCHITECTURE.md writes the example as "periapsis -1 800 km" with a typeset
 * minus and a digit-group space; that is the document's prose typography.
 * Every readout this module produces is plain ASCII with no grouping ("Short
 * by 410 m/s"), so these match the code, not the prose.
 */
function formatElement(m) {
  if (m === Infinity) return 'escape';
  return `${Math.round(m / 1000)} km`;
}

function failureSentence(failure) {
  const noun = failure.kind === 'ignition'
    ? 'ignition failure'
    : failure.kind === 'separation'
      ? 'separation failure'
      : failure.kind === 'restart'
        ? 'restart failure'
        : 'engine failure';
  return `Stage ${failure.stage} ${noun} at T+${Math.round(failure.t)}s.`;
}

/**
 * "500 m" / "3.2 km" / "14 km" — a separation between two spacecraft, which
 * spans four orders of magnitude across the tier (50 km down to 25 m), so it
 * keeps a decimal where one carries information and drops it where it does not.
 */
function formatRange(m) {
  if (!Number.isFinite(m)) return 'unknown';
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/**
 * Phase error, degrees, in (-180, 180].
 *
 * SIGN CONVENTION, used by the outcome, the readouts and the result screen:
 * `phaseErrorDeg = wrapDeg((loadout.window - target.phase) * 360)`, so it is
 * the vehicle's own orbital phase at insertion MINUS the target's.
 *
 *   positive -> the vehicle is inserted AHEAD of the target by that angle
 *   negative -> the vehicle is BEHIND it, i.e. the target is ahead
 *
 * Example (the one the tests pin): window 0.9 against a target at phase 0.1 is
 * (0.9 - 0.1) * 360 = 288 degrees, which wraps to -72: the vehicle is 72
 * degrees behind the target, and the result screen reads "Target was 72 deg
 * ahead". Only the magnitude is ever charged for (phasing cost, approach
 * degradation); the sign exists so the UI can say which way round they are.
 */
function wrapDeg(deg) {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** "Orbit: 112 × 340 km." — periapsis first, the way a launch report reads. */
function orbitSentence(elements) {
  return `Orbit: ${formatElement(elements.periapsis)} × ${formatElement(elements.apoapsis)}.`;
}

/**
 * Delta-v to raise periapsis from `fromPeri` to `toPeri` (altitudes, m) with a
 * single prograde burn at apoapsis `apo` (altitude, m), by vis-viva:
 *
 *   v^2 = mu (2/r - 1/a),   a = (r_a + r_p) / 2
 *   dv  = v(r_a, r_p = required) - v(r_a, r_p = achieved)
 *
 * Returns 0 when that burn is not defined at all — an unbound (infinite)
 * apoapsis, or an apoapsis below the periapsis being asked for, which cannot
 * be raised into that orbit from there. Callers fall back to the altitude gap
 * in those cases.
 */
function raisePeriapsisDeltaV(apo, fromPeri, toPeri) {
  if (!Number.isFinite(apo)) return 0;
  const ra = R_EARTH + apo;
  const rp0 = R_EARTH + fromPeri;
  const rp1 = R_EARTH + toPeri;
  if (!(ra > 0) || ra < rp1) return 0;
  const speedAt = (rp) => {
    const sum = ra + rp;
    if (!(sum > 0)) return 0;
    const v2 = MU * (2 / ra - 2 / sum);
    return v2 > 0 ? Math.sqrt(v2) : 0;
  };
  return Math.max(0, speedAt(rp1) - speedAt(Math.min(rp0, ra)));
}

/**
 * Resolve the orbital phase: the analytic sequence of burns that turns an
 * insertion into a rendezvous, and a rendezvous into a docking.
 *
 * Nothing here is simulated — nothing is piloted, so there is nothing to fly.
 * The sequence is five steps (ARCHITECTURE.md, phase 2), each of which the
 * vehicle can afford or cannot:
 *
 *   1. budget    the delta-v left in the final stage after insertion cutoff
 *   2. match     transferDeltaV to the target's orbit; 2 restarts, at +P/2, +P
 *   3. phase     phasingDeltaV(|phase error|); 1 restart covering the pair of
 *                burns at +1.5P and +2.5P, and free below PHASE_TOLERANCE_DEG
 *   4. approach  NAV_APPROACH[nav] * (1 + |err|/30), halved by rcs; 1 restart
 *                (none with rcs), at +3P
 *   5. dock      dock missions only: needs a docking adapter and DOCK_RANGE,
 *                then a reliability roll, at +3P + 600 s
 *
 * All times are relative to the achieved orbit's period P, so the map view can
 * play the sequence back at a fixed rate.
 *
 * STOPPING. The sequence stops at the first step it cannot afford (restarts or
 * delta-v) or that fails a roll, and `closestApproach` is the separation at
 * that point:
 *   - stopped in the match step: the gap in MEAN altitude between the two
 *     orbits, plus the phasing arc |err|/360 * 2 pi * a on the vehicle's own
 *     orbit — the two objects are neither co-orbital nor co-located;
 *   - stopped after the match, before the approach completes: the phasing arc
 *     alone. The arc is always quoted from the ORIGINAL phase error, because a
 *     phasing burn does not null the error — it is the approach that closes
 *     the range, and the residual error is what degrades it (the `1 + |err|/30`
 *     term above);
 *   - approach completed: the computed approach range.
 *
 * A separation reached WITHOUT the approach burn is floored at NAV_APPROACH[0]
 * (50 km, the no-navigation bracket). Without that floor a vehicle launched
 * into a perfect window and stopped for want of a restart would report a
 * closest approach of exactly 0 — its phasing arc — and pass a rendezvous it
 * never flew. The approach burn is what closes a range; before it, "the same
 * place on the same orbit" means to within the widest bracket the table knows.
 *
 * RNG DRAW ORDER. The ascent's draw order is untouched (ARCHITECTURE.md: it is
 * the save's replay contract), and the orbital phase draws only after every
 * ascent draw has been made. Within it: one draw per RESTART CONSUMED, in burn
 * order — match burn 1, match burn 2, the phasing pair (one draw for both), the
 * approach (none when the vehicle has `rcs`) — followed, on a dock mission that
 * reaches step 5, by exactly one draw for the docking roll. A step that is
 * never reached, is free, or cannot be afforded draws nothing.
 *
 * @param {object} vehicle
 * @param {object} target    { id, name, periapsis, apoapsis, phase }
 * @param {object} insertion { t, periapsis, apoapsis } — the achieved orbit
 * @param {number} dvAvailable m/s left in the final stage
 * @param {number} phaseErrorDeg (-180, 180]; see wrapDeg for the sign
 * @param {object} rng
 * @param {boolean} wantsDock
 * @returns {{ orbital: object, events: object[], failure: object|null,
 *             readout: string, shortBy: number }}
 */
function resolveOrbitalSequence(vehicle, target, insertion, dvAvailable, phaseErrorDeg, rng, wantsDock) {
  const stages = vehicle?.stages ?? [];
  const finalIndex = stages.length - 1;
  const finalStage = stages[finalIndex];
  const stageNo = finalIndex + 1;
  const reliability = finalStage?.reliability ?? 0;

  const restartsAvailable = Math.max(0, Math.floor(vehicle?.restarts ?? 0));
  const nav = clamp(Math.floor(vehicle?.nav ?? 0), 0, NAV_APPROACH.length - 1);
  const hasDockingAdapter = (vehicle?.docking ?? 0) >= 1;
  const rcs = (vehicle?.rcs ?? 0) >= 1;
  const dockBonus = Number(vehicle?.dockBonus) || 0;

  const rpV = R_EARTH + insertion.periapsis;
  const raV = R_EARTH + insertion.apoapsis;
  const rpT = R_EARTH + target.periapsis;
  const raT = R_EARTH + target.apoapsis;
  const vehicleOrbit = elementsFrom(rpV, raV);
  const targetOrbit = elementsFrom(rpT, raT);
  const period = vehicleOrbit.period;
  const t0 = insertion.t;

  const absErr = Math.abs(phaseErrorDeg);
  const phasingArc = (absErr / 360) * 2 * Math.PI * vehicleOrbit.a;
  const meanAltGap = Math.abs(
    (insertion.periapsis + insertion.apoapsis) / 2 - (target.periapsis + target.apoapsis) / 2,
  );

  const targetElements = { periapsis: target.periapsis, apoapsis: target.apoapsis };
  // The transfer ellipse of the match: it spans the two semi-major axes, which
  // is the orbit transferDeltaV prices the size change against.
  const transferElements = {
    periapsis: Math.min(vehicleOrbit.a, targetOrbit.a) - R_EARTH,
    apoapsis: Math.max(vehicleOrbit.a, targetOrbit.a) - R_EARTH,
  };
  const insertionElements = { periapsis: insertion.periapsis, apoapsis: insertion.apoapsis };

  const dvMatch = transferDeltaV(rpV, raV, rpT, raT);
  const dvPhase = absErr > PHASE_TOLERANCE_DEG ? phasingDeltaV(absErr) : 0;

  let dvLeft = dvAvailable;
  let dvUsed = 0;
  let restartsLeft = restartsAvailable;
  // Nothing is closer than the no-navigation bracket until an approach is
  // actually flown; see the note on the floor above.
  const unapproached = (separation) => Math.max(separation, NAV_APPROACH[0]);
  let closestApproach = unapproached(meanAltGap + phasingArc);
  let docked = false;
  let stoppedAt = null;
  let stoppedStep = null;
  let failure = null;
  let shortBy = 0;
  const burns = [];
  const events = [];

  /** Consume one restart, rolling against the final stage's reliability. */
  const restartOk = (time) => {
    restartsLeft -= 1;
    if (rng.next() < reliability) return true;
    failure = { t: time, stage: stageNo, kind: 'restart' };
    stoppedAt = 'restart-failure';
    events.push({
      t: time, kind: 'restart-failure', text: failureSentence(failure), stage: stageNo,
    });
    return false;
  };

  const spend = (time, kindName, dv, elements, text) => {
    dvLeft -= dv;
    dvUsed += dv;
    burns.push({ t: time, kind: kindName, dv, ok: true, elements });
    events.push({ t: time, kind: 'burn', text });
  };

  const cannotAfford = (step, needed) => {
    stoppedAt = 'deltaV';
    stoppedStep = step;
    shortBy = Math.max(0, needed - dvLeft);
  };

  // --- 2. Match ------------------------------------------------------------
  const tMatch1 = t0 + period / 2;
  const tMatch2 = t0 + period;
  let matched = false;
  if (restartsLeft < 2) {
    stoppedAt = 'restarts';
    stoppedStep = 'orbit match';
  } else if (dvLeft < dvMatch) {
    cannotAfford('orbit match', dvMatch + dvPhase + APPROACH_DV);
  } else {
    // The Hohmann leg does the size change; whatever transferDeltaV charges on
    // top of it (the eccentricity mismatch) is paid on arrival, with burn 2.
    const legs = hohmann(vehicleOrbit.a, targetOrbit.a);
    const dv1 = Math.min(legs.dv1, dvMatch);
    const dv2 = dvMatch - dv1;
    if (restartOk(tMatch1)) {
      spend(tMatch1, 'match', dv1, transferElements,
        `Orbit match burn 1: ${Math.round(dv1)} m/s.`);
      if (restartOk(tMatch2)) {
        spend(tMatch2, 'match', dv2, targetElements,
          `Orbit match burn 2: ${Math.round(dv2)} m/s.`);
        matched = true;
      } else {
        burns.push({ t: tMatch2, kind: 'match', dv: 0, ok: false, elements: transferElements });
      }
    } else {
      burns.push({ t: tMatch1, kind: 'match', dv: 0, ok: false, elements: insertionElements });
    }
  }

  // --- 3. Phase ------------------------------------------------------------
  const tPhase1 = t0 + 1.5 * period;
  const tPhase2 = t0 + 2.5 * period;
  let phased = false;
  if (matched) {
    closestApproach = unapproached(phasingArc);
    if (dvPhase <= 0) {
      phased = true;                      // inside the window: nothing to do
    } else if (restartsLeft < 1) {
      stoppedAt = 'restarts';
      stoppedStep = 'phasing';
    } else if (dvLeft < dvPhase) {
      cannotAfford('phasing', dvPhase + APPROACH_DV);
    } else if (restartOk(tPhase1)) {
      // A phasing orbit differs from the target's by a small semi-major axis
      // change: da = 2 a^2 v dv / mu, and a single burn moves the FAR apsis by
      // 2 da. Ahead of the target (positive error) the vehicle climbs to a
      // slower orbit and lets it catch up; behind, it drops to a faster one.
      const half = dvPhase / 2;
      const vCirc = velocityAt(targetOrbit.a, targetOrbit.a);
      const da = (2 * targetOrbit.a * targetOrbit.a * vCirc * half) / MU;
      const sign = phaseErrorDeg >= 0 ? 1 : -1;
      const phasingElements = {
        periapsis: target.periapsis,
        apoapsis: target.apoapsis + sign * 2 * da,
      };
      spend(tPhase1, 'phase', half, phasingElements,
        `Phasing burn 1: ${Math.round(half)} m/s.`);
      // One restart covers the pair: the second burn is the same relight
      // window, so it costs no further restart and no further roll.
      spend(tPhase2, 'phase', half, targetElements,
        `Phasing burn 2: ${Math.round(half)} m/s.`);
      phased = true;
    }
  }

  // --- 4. Approach ---------------------------------------------------------
  const tApproach = t0 + 3 * period;
  let approached = false;
  if (phased) {
    if (!rcs && restartsLeft < 1) {
      stoppedAt = 'restarts';
      stoppedStep = 'approach';
    } else if (dvLeft < APPROACH_DV) {
      cannotAfford('approach', APPROACH_DV);
    } else if (rcs || restartOk(tApproach)) {
      closestApproach = (NAV_APPROACH[nav] * (1 + absErr / 30)) / (rcs ? 2 : 1);
      spend(tApproach, 'approach', APPROACH_DV, targetElements,
        `Approach burn: ${Math.round(APPROACH_DV)} m/s.`);
      events.push({
        t: tApproach, kind: 'approach', text: `Closest approach ${formatRange(closestApproach)}.`,
      });
      approached = true;
    } else {
      burns.push({ t: tApproach, kind: 'approach', dv: 0, ok: false, elements: targetElements });
    }
  }

  // --- 5. Dock -------------------------------------------------------------
  const tDock = t0 + 3 * period + 600;
  if (approached && wantsDock && hasDockingAdapter && closestApproach <= DOCK_RANGE) {
    const threshold = Math.min(
      DOCK_RELIABILITY_MAX,
      (rcs ? DOCK_RELIABILITY_RCS : DOCK_RELIABILITY) + dockBonus,
    );
    const roll = rng.next();
    docked = roll < threshold;
    burns.push({ t: tDock, kind: 'dock', dv: 0, ok: docked, elements: targetElements });
    if (docked) {
      events.push({ t: tDock, kind: 'dock', text: 'Docked.' });
    } else {
      stoppedAt = 'dock-failure';
      // Flavour telemetry, derived from the roll that was already drawn — no
      // extra draw, so the sequence's draw count does not depend on the text.
      events.push({
        t: tDock,
        kind: 'dock-failure',
        text: `Docking aborted: ${(0.5 + roll).toFixed(1)} m/s closing rate.`,
      });
    }
  }

  let readout;
  if (docked) {
    readout = `Docked to ${target.name ?? target.id ?? 'the target'}.`;
  } else if (stoppedAt === 'dock-failure') {
    readout = 'Docking aborted.';
  } else if (stoppedAt === 'restarts') {
    readout = `No restart available for the ${stoppedStep} burn.`;
  } else if (stoppedAt === 'restart-failure') {
    readout = failureSentence(failure);
  } else if (stoppedAt === 'deltaV') {
    readout = `Closest approach ${formatRange(closestApproach)}. Short by ${Math.round(shortBy)} m/s.`;
  } else {
    readout = `Closest approach ${formatRange(closestApproach)}.`;
  }

  return {
    orbital: {
      target: {
        id: target.id ?? null,
        periapsis: target.periapsis,
        apoapsis: target.apoapsis,
        phase: target.phase ?? 0,
      },
      dvAvailable,
      dvUsed,
      phaseErrorDeg,
      burns,
      closestApproach,
      docked,
      stoppedAt,
    },
    events,
    failure,
    readout,
    shortBy,
  };
}

/**
 * Simulate a launch.
 *
 * @param {object} vehicle  { stages, payloadMass, dragArea, dragCoeff, guidance,
 *                            restarts, nav, docking, rcs, dockBonus }
 * @param {object} mission  requirement is { altitude } | { downrange }
 *                          | { orbit: { periapsis } }
 *                          | { rendezvous: { target, within } } | { dock: { target } }
 * @param {object} loadout  { fuelFraction: 0.5..1.0, turn: 0..1, window: 0..1 }
 * @param {object} rng      from makeRng(seed)
 * @param {object} [opts]
 * @param {number} [opts.dt=0.1]          integrator step, s
 * @param {number} [opts.sampleEvery=0.5] renderer sample spacing, s
 * @param {number} [opts.maxTime=2000]    hard cap on simulated time, s
 * @param {object} [opts.target]          the object in orbit a rendezvous/dock
 *        mission is flown to, from state.findTarget: { id, name, periapsis,
 *        apoapsis, phase }. REQUIRED for those two shapes — resolving one
 *        without it throws, because every number the orbital phase produces is
 *        relative to it.
 * @param {(t: number, alt: number) => number} [opts.pitch]
 *        angle from local vertical, radians. Defaults to
 *        `pitchProgram(vehicle, loadout)`; an explicit function overrides it,
 *        which is how the tests fly a fixed attitude.
 * @returns {object} Outcome (see ARCHITECTURE.md)
 */
export function resolveLaunch(vehicle, mission, loadout = {}, rng, opts = {}) {
  const dt = opts.dt ?? 0.1;
  const sampleEvery = opts.sampleEvery ?? 0.5;
  const maxTime = opts.maxTime ?? 2000;
  const pitch = opts.pitch ?? pitchProgram(vehicle, loadout);

  const fuelFraction = loadout?.fuelFraction ?? 1;
  const stages = vehicle?.stages ?? [];
  const payloadMass = vehicle?.payloadMass ?? 0;
  const dragArea = vehicle?.dragArea ?? 0;
  const dragCoeff = vehicle?.dragCoeff ?? 0;

  const requirement = mission?.requirement;
  const kind = requirementKind(requirement);
  const orbital = needsTarget(kind);

  // ---- The target (tier 3) ------------------------------------------------
  const target = orbital ? (opts.target ?? null) : null;
  if (orbital) {
    if (!target) {
      throw new Error(
        `resolveLaunch: mission '${mission?.id ?? '?'}' is a ${kind} mission and needs opts.target`,
      );
    }
    if (!Number.isFinite(target.periapsis) || !Number.isFinite(target.apoapsis)) {
      throw new Error('resolveLaunch: opts.target needs numeric periapsis and apoapsis');
    }
  }

  const requirementAlt = kind === 'altitude' ? requirement.altitude : null;
  const requirementRange = kind === 'downrange' ? requirement.downrange : null;
  // A rendezvous is flown to the target's own periapsis: that is the orbit the
  // ascent has to reach before anything orbital can happen, and it is what the
  // tier 2 miss below is judged against when the flight never gets there.
  const requirementPeri = kind === 'orbit'
    ? requirement.orbit.periapsis
    : (orbital ? target.periapsis : null);
  const deltaVRequired = requiredDeltaV(mission, target);

  // The ascent's final stage shuts down as soon as it has the orbit it came
  // for, keeping whatever propellant is left for the orbital phase. That is
  // what makes the tree's top-stage propellant reserve worth buying — and it
  // is scoped to target missions, so tier 1 and tier 2 burn to depletion
  // exactly as they always have.
  const cutoffAlt = orbital ? Math.max(target.periapsis, ORBIT_MIN_ALT) : null;

  const timeline = [];
  const samples = [];
  const event = (time, eventKind, text, extra = {}) => {
    timeline.push({ t: time, kind: eventKind, text, ...extra });
  };

  // ---- Nothing to fly -----------------------------------------------------
  const totalMass0 = stages.reduce(
    (m, s) => m + s.dryMass + s.propMass * fuelFraction,
    payloadMass,
  );

  const finish = (o) => {
    timeline.sort((a, b) => a.t - b.t);
    return o;
  };

  // ---- Does it leave the pad at all? --------------------------------------
  // Thrust-to-weight <= 1 at liftoff means the stack never moves. This is the
  // shop's classic mistake (a heavier tank bought before a bigger engine), so
  // it gets its own readout instead of a crash or a silent 0 m flight.
  const liftoffThrust = stages[0]?.thrust ?? 0;
  if (stages.length === 0 || liftoffThrust <= totalMass0 * G0) {
    const readout = 'Insufficient thrust to lift off.';
    event(0, 'end', readout, { alt: 0 });
    samples.push({
      t: 0, alt: 0, vel: 0, mass: totalMass0, stage: 1, x: 0, y: 0, downrange: 0,
    });
    return finish({
      success: false,
      maxAltitude: 0,
      maxSpeed: 0,
      maxDownrange: 0,
      periapsis: null,
      apoapsis: null,
      orbit: false,
      deltaVAchieved: 0,
      deltaVRequired,
      shortBy: Math.max(0, deltaVRequired),
      failure: null,
      readout,
      timeline,
      samples,
      insertion: null,
      orbital: null,
      closestApproach: null,
      docked: false,
    });
  }

  // ---- Flight state -------------------------------------------------------
  let t = 0;
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let mass = totalMass0;

  let stageIndex = 0;          // 0-based index into vehicle.stages
  let thrusting = false;
  let thrustDone = false;      // no further burn is coming (last burnout, or a failure)
  let propRemaining = 0;
  let mdot = 0;
  let burnRollAt = Infinity;   // t of this stage's mid-burn reliability roll
  let burnRollPending = false;

  let maxAltitude = 0;
  let maxSpeed = 0;
  let maxDownrange = 0;
  let deltaVAchieved = 0;
  let failure = null;
  let goalEmitted = false;
  let apogeeEmitted = false;
  let turnEmitted = false;
  let orbitConfirmedAt = null;
  let orbitFlag = false;
  let bestElements = null;     // best (highest-periapsis) orbit after the final burnout
  let impacted = false;
  let ended = false;
  let insertion = null;        // { t, periapsis, apoapsis } once orbit is confirmed
  let reserveProp = 0;         // propellant left in the final stage at its shutdown
  let reserveMass = 0;         // total mass at that moment (stage + payload)

  const stageNo = () => stageIndex + 1;

  // Geometry about the planet centre at world (0, -R_EARTH).
  const radiusOf = (sx, sy) => Math.hypot(sx, sy + R_EARTH);
  const altOf = (sx, sy) => radiusOf(sx, sy) - R_EARTH;
  /** Surface arc from the pad, m — the range a map measures, not |x|. */
  const downrangeOf = (sx, sy) => R_EARTH * Math.abs(Math.atan2(sx, sy + R_EARTH));
  /** Rate of change of altitude: the radial component of velocity. */
  const radialSpeed = (sx, sy, svx, svy) => {
    const rm = radiusOf(sx, sy);
    return rm > 0 ? (sx * svx + (sy + R_EARTH) * svy) / rm : svy;
  };
  const elementsNow = () => orbitElements({ x, y: y + R_EARTH }, { x: vx, y: vy });

  const pushSample = () => {
    const last = samples[samples.length - 1];
    if (last && t <= last.t) return;
    samples.push({
      t,
      alt: altOf(x, y),
      vel: Math.hypot(vx, vy),
      mass,
      stage: stageNo(),
      x,
      y,
      downrange: downrangeOf(x, y),
    });
  };
  let nextSampleAt = 0;

  const cutThrust = (failureKind) => {
    failure = { t, stage: stageNo(), kind: failureKind };
    thrusting = false;
    thrustDone = true;
    burnRollPending = false;
    burnRollAt = Infinity;
    event(t, 'failure', failureSentence(failure), { stage: stageNo(), alt: altOf(x, y) });
  };

  /**
   * Ignite the current stage: reliability roll, then (on success) pick the
   * moment of this stage's single mid-burn roll.
   *
   * rng draw order per ignition: (1) the ignition roll, (2) — only if it
   * passed — the fraction of the burn at which the burn roll happens, and
   * later (3) the burn roll itself. An ignition failure therefore consumes
   * exactly one draw. UNCHANGED from phase 0: the draw order is the save's
   * replay contract.
   */
  const ignite = () => {
    const stage = stages[stageIndex];
    event(t, 'ignition', `Stage ${stageNo()} ignition.`, { stage: stageNo(), alt: altOf(x, y) });

    if (!(rng.next() < stage.reliability)) {
      cutThrust('ignition');
      return;
    }

    propRemaining = stage.propMass * fuelFraction;
    mdot = stage.isp > 0 ? stage.thrust / (stage.isp * G0) : 0;
    if (mdot <= 0 || propRemaining <= 0) {
      // No usable burn: treat as an immediate burnout, not a hang.
      thrusting = true;
      propRemaining = 0;
      burnRollPending = false;
      burnRollAt = Infinity;
      return;
    }
    thrusting = true;
    const burnDuration = propRemaining / mdot;
    burnRollAt = t + rng.next() * burnDuration;
    burnRollPending = true;
  };

  /**
   * Insertion cutoff: the final stage shuts down mid-burn because the orbit it
   * was aiming at is achieved (target missions only, see `cutoffAlt`).
   *
   * Everything still in the tank becomes the orbital phase's budget. The
   * partial burn is credited the same way a mid-burn failure is — Tsiolkovsky
   * over the mass actually spent — and the pending mid-burn reliability roll is
   * cancelled, because the burn is over. No rng draw is made or skipped by
   * this: the roll's fraction was drawn at ignition, and the roll itself simply
   * never comes due, exactly as for a stage that burns out before its roll.
   */
  const cutoff = () => {
    const stage = stages[stageIndex];
    const above = stackMassAbove(vehicle, stageIndex, fuelFraction);
    const mStart = above + stage.dryMass + stage.propMass * fuelFraction;
    deltaVAchieved += stage.isp * G0 * Math.log(mStart / mass);
    reserveProp = propRemaining;
    reserveMass = mass;
    thrusting = false;
    thrustDone = true;
    burnRollPending = false;
    burnRollAt = Infinity;
    event(t, 'burnout', `Stage ${stageNo()} cutoff.`, { stage: stageNo(), alt: altOf(x, y) });
  };

  /** Burnout of the current stage, then separation + next ignition. */
  const burnout = () => {
    const stage = stages[stageIndex];
    thrusting = false;
    burnRollPending = false;
    burnRollAt = Infinity;
    deltaVAchieved += stageDeltaV(vehicle, stageIndex, fuelFraction);
    event(t, 'burnout', `Stage ${stageNo()} burnout.`, { stage: stageNo(), alt: altOf(x, y) });

    if (stageIndex + 1 < stages.length) {
      // Drop the spent stage: its dry mass and whatever propellant is left.
      mass -= stage.dryMass + propRemaining;
      propRemaining = 0;
      event(t, 'separation', `Stage ${stageNo()} separation.`, { stage: stageNo(), alt: altOf(x, y) });
      stageIndex += 1;
      ignite();
    } else {
      thrustDone = true;
    }
  };

  // ---- Derivatives --------------------------------------------------------
  // Central gravity about (0, -R_EARTH); thrust along the pitch program,
  // measured from the local vertical (up = r/|r|) toward the prograde
  // horizontal (up rotated -90 degrees, which is +x on the launch axis); drag
  // opposing velocity through the exponential atmosphere at the true altitude.
  const deriv = (sx, sy, svx, svy, m, tt, thrustN) => {
    const ry = sy + R_EARTH;
    const rmag = Math.hypot(sx, ry) || EPS;
    const alt = rmag - R_EARTH;
    const ux = sx / rmag;
    const uy = ry / rmag;

    const gmag = MU / (rmag * rmag);
    let ax = -gmag * ux;
    let ay = -gmag * uy;

    if (thrustN > 0 && m > 0) {
      const theta = pitch(tt, alt) || 0;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      // cos(theta) * up + sin(theta) * horizontal, with horizontal = (uy, -ux).
      ax += (thrustN / m) * (c * ux + s * uy);
      ay += (thrustN / m) * (c * uy - s * ux);
    }

    const speed = Math.hypot(svx, svy);
    if (speed > 0 && dragArea > 0 && dragCoeff > 0 && m > 0) {
      const drag = 0.5 * densityAt(alt) * speed * speed * dragCoeff * dragArea;
      ax -= (drag / m) * (svx / speed);
      ay -= (drag / m) * (svy / speed);
    }
    return { dx: svx, dy: svy, dvx: ax, dvy: ay };
  };

  // ---- Launch -------------------------------------------------------------
  ignite();
  if (!failure) {
    event(0, 'liftoff', 'Liftoff.', { stage: 1, alt: 0 });
  }
  pushSample();
  nextSampleAt = sampleEvery;

  // ---- Integrate ----------------------------------------------------------
  while (!ended && t < maxTime) {
    // Events that fire exactly at the current instant, before stepping.
    if (thrusting && burnRollPending && t >= burnRollAt - EPS) {
      burnRollPending = false;
      const stage = stages[stageIndex];
      if (!(rng.next() < stage.reliability)) {
        // Partial burn: credit the delta-v actually produced so far.
        const above = stackMassAbove(vehicle, stageIndex, fuelFraction);
        const mStart = above + stage.dryMass + stage.propMass * fuelFraction;
        deltaVAchieved += stage.isp * G0 * Math.log(mStart / mass);
        cutThrust('burn');
      }
      continue;
    }
    if (thrusting && propRemaining <= EPS) {
      burnout();
      continue;
    }

    const altBefore = altOf(x, y);
    if (!turnEmitted && thrusting && pitch(t, altBefore) > 0) {
      turnEmitted = true;
      event(t, 'turn', `Pitchover at ${formatAltitude(altBefore)}.`, { alt: altBefore });
    }

    // Step size: a plain fixed dt, clipped so burnout lands exactly on a step
    // boundary rather than being smeared over one, and so the run stops at
    // maxTime rather than one step past it.
    //
    // Note the mid-burn roll is deliberately NOT clipped to: it is resolved at
    // the first boundary at or after `burnRollAt`, which costs at most one dt of
    // precision on `failure.t` and buys something worth more — the trajectory
    // stays bit-for-bit independent of the rng, so two seeds that both fly a
    // perfectly reliable vehicle produce identical flights.
    let step = dt;
    if (thrusting && mdot > 0) step = Math.min(step, propRemaining / mdot);
    step = Math.min(step, maxTime - t);
    if (step <= EPS) break;

    const thrustN = thrusting ? stages[stageIndex].thrust : 0;

    // RK2 midpoint. Mass at the midpoint accounts for propellant already burnt.
    const k1 = deriv(x, y, vx, vy, mass, t, thrustN);
    const halfMass = thrusting ? mass - mdot * (step / 2) : mass;
    const k2 = deriv(
      x + k1.dx * (step / 2),
      y + k1.dy * (step / 2),
      vx + k1.dvx * (step / 2),
      vy + k1.dvy * (step / 2),
      halfMass,
      t + step / 2,
      thrustN,
    );

    const prevRadial = radialSpeed(x, y, vx, vy);
    x += k2.dx * step;
    y += k2.dy * step;
    vx += k2.dvx * step;
    vy += k2.dvy * step;
    if (thrusting) {
      const burnt = Math.min(mdot * step, propRemaining);
      propRemaining -= burnt;
      mass -= burnt;
    }
    t += step;

    let alt = altOf(x, y);
    if (alt > maxAltitude) maxAltitude = alt;
    const speed = Math.hypot(vx, vy);
    if (speed > maxSpeed) maxSpeed = speed;
    const range = downrangeOf(x, y);
    if (range > maxDownrange) maxDownrange = range;

    if (!goalEmitted && requirementAlt !== null && alt >= requirementAlt) {
      goalEmitted = true;
      event(t, 'goal', `Passed ${formatAltitude(requirementAlt)}.`, { alt });
    }
    if (!goalEmitted && requirementRange !== null && range >= requirementRange) {
      goalEmitted = true;
      event(t, 'goal', `Passed ${formatAltitude(requirementRange)} downrange.`, { alt });
    }

    // Insertion cutoff: on a target mission the last stage stops the instant
    // the orbit is good enough, so the remainder of the tank is the orbital
    // phase's delta-v budget instead of a higher apoapsis nobody asked for.
    if (thrusting && cutoffAlt !== null && stageIndex === stages.length - 1
      && elementsNow().periapsis >= cutoffAlt) {
      cutoff();
    }

    // Orbit is only meaningful once no further burn is coming: mid-ascent the
    // "current orbit" is a number that changes every step and means nothing.
    if (thrustDone) {
      const el = elementsNow();
      if (bestElements === null || el.periapsis > bestElements.periapsis) bestElements = el;
      if (orbitConfirmedAt === null && el.periapsis >= ORBIT_MIN_ALT) {
        orbitFlag = true;
        orbitConfirmedAt = t;
        insertion = { t, periapsis: el.periapsis, apoapsis: el.apoapsis };
        event(t, 'orbit', orbitSentence(el), { alt });
      }
    }

    if (t + EPS >= nextSampleAt) {
      pushSample();
      while (nextSampleAt <= t) nextSampleAt += sampleEvery;
    }

    // Ground. Pull the position back onto the surface along r, so the impact
    // point is on the planet rather than one step under it.
    if (alt <= 0) {
      const rm = radiusOf(x, y) || EPS;
      const k = R_EARTH / rm;
      x *= k;
      y = (y + R_EARTH) * k - R_EARTH;
      alt = 0;
      pushSample();
      // A vehicle that never left the pad (an ignition failure) "impacts" on
      // the first step; that is not an event worth showing.
      if (maxAltitude > 0) {
        impacted = true;
        event(t, 'impact', `Impact ${formatAltitude(downrangeOf(x, y))} downrange.`, { alt: 0 });
      }
      ended = true;
      break;
    }

    // Apogee: first time the altitude rate goes non-positive on the way up.
    if (!apogeeEmitted && prevRadial > 0 && radialSpeed(x, y, vx, vy) <= 0) {
      apogeeEmitted = true;
      event(t, 'apogee', `Apogee at ${formatAltitude(maxAltitude)}.`, { alt: maxAltitude });
      // An ALTITUDE requirement is settled at apogee — nothing after it can
      // change the verdict — so phase 0 stopped there and tier 1 still does.
      // Downrange and orbit flights carry on: their interesting part is later.
      if (!thrusting && (kind === 'altitude' || kind === null)) {
        pushSample();
        ended = true;
        break;
      }
    }

    // Orbit confirmed: an orbit flight coasts a little so the announcement is
    // visible and then stops; a downrange flight is already decided (an orbit
    // trivially passes any range), so it stops immediately.
    if (orbitConfirmedAt !== null) {
      if (kind === 'downrange' || t >= orbitConfirmedAt + ORBIT_CONFIRM_COAST) {
        pushSample();
        ended = true;
        break;
      }
    }
  }

  pushSample();

  // ---- The orbit the flight achieved --------------------------------------
  // `periapsis`/`apoapsis` are the BEST (highest-periapsis) elements seen at or
  // after the final burnout, and null if the vehicle never left the pad.
  //
  // DEVIATION from ARCHITECTURE.md, which words this field as "at end of
  // flight". In vacuum the elements are constant through the coast, so for
  // every flight that ends in orbit or at apogee the two readings are the same
  // number. They diverge only for a flight that ends at IMPACT — and there the
  // end-of-flight reading is worthless: after re-entry drag has killed the
  // horizontal velocity the state vector is very nearly radial, so it reports
  // "Apoapsis 2 km, periapsis -6371 km" for a vehicle that actually coasted to
  // 132 km and flew 4 500 km downrange, and `shortBy`'s vis-viva term collapses
  // with it. Taking the best post-burnout orbit reports the trajectory the
  // player flew, which is also what ARCHITECTURE.md's own example readout shows
  // ("Apoapsis 240 km, periapsis -1 800 km" is a coast ellipse, not an impact
  // state). It is the same rule `orbit` already uses ("at any point after the
  // final burnout"), so the three fields agree with each other by construction.
  const leftPad = maxAltitude > 0;
  // Fallback: a run cut off by maxTime while still under thrust never reaches a
  // final burnout, so read the elements it ended on.
  const endElements = bestElements ?? (leftPad ? elementsNow() : null);
  const periapsis = leftPad && endElements ? endElements.periapsis : null;
  const apoapsis = leftPad && endElements ? endElements.apoapsis : null;

  // ---- The orbital phase (tier 3) -----------------------------------------
  // It runs only on a target mission whose ascent actually got somewhere it can
  // maneuver from: a confirmed orbit that is BOUND. An unbound trajectory can
  // pass the ORBIT_MIN_ALT periapsis test (it is on its way out, not round),
  // and it has no period, so there is no sequence to schedule on it — that
  // falls through to the tier 2 miss below with closestApproach null, as a
  // flight that never reached orbit does.
  let orbitalResult = null;
  let closestApproach = null;
  let docked = false;
  let endT = t;
  if (orbital && insertion !== null && Number.isFinite(insertion.apoapsis)) {
    // The budget: Tsiolkovsky on what the final stage kept back at cutoff.
    const finalStage = stages[stages.length - 1];
    const dvAvailable = reserveProp > 0 && reserveMass > reserveProp
      ? finalStage.isp * G0 * Math.log(reserveMass / (reserveMass - reserveProp))
      : 0;
    const windowValue = clamp(Number(loadout?.window) || 0, 0, 1);
    const phaseErrorDeg = wrapDeg((windowValue - (Number(target.phase) || 0)) * 360);

    orbitalResult = resolveOrbitalSequence(
      vehicle, target, insertion, dvAvailable, phaseErrorDeg, rng, kind === 'dock',
    );
    closestApproach = orbitalResult.orbital.closestApproach;
    docked = orbitalResult.orbital.docked;

    event(insertion.t, 'insertion',
      `Orbit insertion: ${formatElement(insertion.periapsis)} × ${formatElement(insertion.apoapsis)}.`,
      { alt: insertion.periapsis });
    for (const e of orbitalResult.events) {
      const { t: et, kind: ek, text, ...extra } = e;
      event(et, ek, text, extra);
      if (et > endT) endT = et;
    }
    // The outcome carries ONE failure, and it is the first one: an ascent
    // failure that still made orbit is not overwritten by a later restart
    // failure (the orbital phase's own stop is reported by `stoppedAt`).
    if (failure === null && orbitalResult.failure) failure = orbitalResult.failure;
  }

  // ---- Outcome ------------------------------------------------------------
  let success;
  if (kind === 'altitude') {
    success = maxAltitude >= requirementAlt;
  } else if (kind === 'downrange') {
    // Reaching orbit trivially satisfies a range requirement: the vehicle is
    // not coming down, so it passes over every point on the surface.
    success = maxDownrange >= requirementRange || orbitFlag;
  } else if (kind === 'orbit') {
    success = periapsis !== null && periapsis >= requirementPeri;
  } else if (kind === 'rendezvous') {
    success = closestApproach !== null && closestApproach <= requirement.rendezvous.within;
  } else if (kind === 'dock') {
    success = docked;
  } else {
    success = deltaVAchieved >= deltaVRequired;
  }

  // shortBy is `max(0, required - achieved)` (ARCHITECTURE.md), floored per
  // requirement by an IDEAL-DELTA-V GAP that is positive exactly when the
  // requirement was missed. The floor exists because the two sides of the
  // subtraction are not measured the same way (see LOSS_ALLOWANCE): without it
  // a run that visibly fell short can report "Short by 0 m/s", which is both
  // nonsense on the result screen and a contradiction of ARCHITECTURE.md's own
  // rule that shortBy is > 0 whenever the run did not succeed.
  //
  // The orbital phase is judged on its own terms and never floored: a tier 3
  // miss is usually not a delta-v shortfall at all (ARCHITECTURE.md — a
  // restarts stop and an approach that is simply too wide both report 0, and
  // the readout says restarts or navigation instead), so only a stop for want
  // of delta-v reports a number, and it is the delta-v the sequence still
  // needed.
  let shortBy = success ? 0 : Math.max(0, deltaVRequired - deltaVAchieved);
  if (orbitalResult) {
    shortBy = success ? 0 : orbitalResult.shortBy;
  } else if (!success) {
    let floorGap = 0;
    if (kind === 'altitude') {
      // Phase 0, unchanged: the ideal vertical coast gap between asked and reached.
      //   sqrt(2 g0 h_req) - sqrt(2 g0 h_reached)
      floorGap = Math.sqrt(2 * G0 * requirementAlt)
        - Math.sqrt(2 * G0 * Math.max(maxAltitude, 0));
    } else if (kind === 'downrange') {
      // The same shape one dimension over: the ideal 45-degree ballistic launch
      // speed for the range asked, minus the one for the range actually flown.
      //   sqrt(g0 d_req) - sqrt(g0 d_reached)
      floorGap = Math.sqrt(G0 * requirementRange)
        - Math.sqrt(G0 * Math.max(maxDownrange, 0));
    } else if (kind === 'orbit' || orbital) {
      // A target mission that never got to orbit is short of one, and is judged
      // exactly as a tier 2 orbit miss to the target's own periapsis.
      //
      // Two ways to be short of an orbit; the honest number is the bigger:
      //  1. the burn that would raise periapsis to the requirement, made at
      //     the apoapsis actually reached (vis-viva, above);
      //  2. if the flight never even got as high as the required periapsis,
      //     the phase 0 altitude gap to it — which is what is really missing,
      //     and is the only one of the two that is defined for a lob that
      //     never had an apoapsis worth burning at.
      const raise = periapsis === null
        ? 0
        : raisePeriapsisDeltaV(apoapsis, periapsis, requirementPeri);
      const altGap = Math.sqrt(2 * G0 * requirementPeri)
        - Math.sqrt(2 * G0 * Math.max(maxAltitude, 0));
      floorGap = Math.max(raise, altGap);
    }
    shortBy = Math.max(shortBy, floorGap);
    // Last resort, so a miss always reads as a miss: only reachable on shapes
    // where both the budget gap and the ideal gap round to zero (e.g. an
    // unbound trajectory whose periapsis is still under the requirement).
    if (!(shortBy > 0)) shortBy = Math.max(1, deltaVRequired * 0.01);
  }

  let readout;
  if (failure && !success) {
    readout = failureSentence(failure);
  } else if (orbitalResult) {
    // The orbital phase writes its own line: docked, closest approach, or the
    // step it could not perform.
    readout = orbitalResult.readout;
  } else if (kind === 'orbit' || orbital) {
    if (success) {
      // A failure that still made orbit is worth saying — it points the result
      // screen at the reliability branch even though the contract paid out.
      readout = orbitSentence({ periapsis, apoapsis });
      if (failure) readout += ` ${failureSentence(failure)}`;
    } else if (periapsis !== null) {
      readout = `Apoapsis ${formatElement(apoapsis)}, periapsis ${formatElement(periapsis)}.`
        + ` Short by ${Math.round(shortBy)} m/s.`;
    } else {
      readout = `Reached ${formatAltitude(maxAltitude)}. Short by ${Math.round(shortBy)} m/s.`;
    }
  } else if (kind === 'downrange') {
    if (orbitFlag) {
      readout = orbitSentence({ periapsis, apoapsis });
    } else {
      readout = `${impacted ? 'Impact' : 'Reached'} ${formatAltitude(maxDownrange)} downrange.`;
      if (!success) readout += ` Short by ${Math.round(shortBy)} m/s.`;
    }
    if (failure && success) readout += ` ${failureSentence(failure)}`;
  } else if (success) {
    readout = `Reached ${formatAltitude(maxAltitude)}.`;
    if (failure) readout += ` ${failureSentence(failure)}`;
  } else {
    readout = `Reached ${formatAltitude(maxAltitude)}. Short by ${Math.round(shortBy)} m/s.`;
  }

  // The end lands after the last orbital event, so the ticker's final line is
  // still its final line once the timeline is sorted.
  event(endT, 'end', readout, { alt: altOf(x, y) });

  return finish({
    success,
    maxAltitude,
    maxSpeed,
    maxDownrange,
    periapsis,
    apoapsis,
    orbit: orbitFlag,
    deltaVAchieved,
    deltaVRequired,
    shortBy,
    failure,
    readout,
    timeline,
    samples,
    insertion,
    orbital: orbitalResult ? orbitalResult.orbital : null,
    closestApproach,
    docked,
  });
}
