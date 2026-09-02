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

/** Planet radius, m. Earth-like and unnamed (DESIGN.md: real physics, fictional setting). */
export const R_EARTH = 6.371e6;
/** Standard gravitational parameter, m^3/s^2: mu = g0 * R^2. */
export const MU = G0 * R_EARTH * R_EARTH;
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

/** Which of the three requirement shapes a mission carries. */
function requirementKind(requirement) {
  if (!requirement) return null;
  if (typeof requirement.altitude === 'number') return 'altitude';
  if (typeof requirement.downrange === 'number') return 'downrange';
  if (requirement.orbit && typeof requirement.orbit.periapsis === 'number') return 'orbit';
  return null;
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
 */
export function requiredDeltaV(mission) {
  const req = mission?.requirement;
  if (!req) return 0;
  if (typeof req.deltaV === 'number') return req.deltaV;
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
      : 'engine failure';
  return `Stage ${failure.stage} ${noun} at T+${Math.round(failure.t)}s.`;
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
 * Simulate a launch.
 *
 * @param {object} vehicle  { stages, payloadMass, dragArea, dragCoeff, guidance }
 * @param {object} mission  requirement is { altitude } | { downrange } | { orbit: { periapsis } }
 * @param {object} loadout  { fuelFraction: 0.5..1.0, turn: 0..1 }
 * @param {object} rng      from makeRng(seed)
 * @param {object} [opts]
 * @param {number} [opts.dt=0.1]          integrator step, s
 * @param {number} [opts.sampleEvery=0.5] renderer sample spacing, s
 * @param {number} [opts.maxTime=2000]    hard cap on simulated time, s
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
  const requirementAlt = kind === 'altitude' ? requirement.altitude : null;
  const requirementRange = kind === 'downrange' ? requirement.downrange : null;
  const requirementPeri = kind === 'orbit' ? requirement.orbit.periapsis : null;
  const deltaVRequired = requiredDeltaV(mission);

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

    // Orbit is only meaningful once no further burn is coming: mid-ascent the
    // "current orbit" is a number that changes every step and means nothing.
    if (thrustDone) {
      const el = elementsNow();
      if (bestElements === null || el.periapsis > bestElements.periapsis) bestElements = el;
      if (orbitConfirmedAt === null && el.periapsis >= ORBIT_MIN_ALT) {
        orbitFlag = true;
        orbitConfirmedAt = t;
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
  let shortBy = success ? 0 : Math.max(0, deltaVRequired - deltaVAchieved);
  if (!success) {
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
    } else if (kind === 'orbit') {
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
  } else if (kind === 'orbit') {
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

  event(t, 'end', readout, { alt: altOf(x, y) });

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
  });
}
