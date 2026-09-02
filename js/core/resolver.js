// Launch resolver: vehicle + mission + loadout + rng -> outcome + timeline.
// Pure: no DOM, no Date.now, no Math.random. The resolver never renders —
// js/ui/ascent.js plays `outcome.samples` and `outcome.timeline`.
//
// Physics is a 2D point mass from day one even though phase 0 flies straight
// up, so tier 2 is a data change (a pitch program and a velocity requirement)
// and not a rewrite. See DESIGN.md §14 and ARCHITECTURE.md §js/core/resolver.js.
//
// STAGE NUMBERING: every `stage` field in the outcome (events, samples,
// `failure.stage`) is 1-BASED — "Stage 1" is vehicle.stages[0]. It matches the
// readouts the player sees ("Stage 2 ignition failure at T+142s."). Subtract 1
// to index vehicle.stages. ARCHITECTURE.md does not pin this down; this is the
// module's documented choice and it is consistent across the whole outcome.

import { G0, stageDeltaV, stackMassAbove } from './vehicle.js';

/** Earth radius, m — gravity falls off as (R/(R+h))^2. */
export const R_EARTH = 6.371e6;
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

const EPS = 1e-9;

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

/** Delta-v a mission requires, expressed as a number the shop can compare against. */
export function requiredDeltaV(mission) {
  const req = mission?.requirement;
  if (!req) return 0;
  if (typeof req.deltaV === 'number') return req.deltaV;
  if (typeof req.altitude === 'number' && req.altitude > 0) {
    return Math.sqrt(2 * G0 * req.altitude) * (1 + LOSS_ALLOWANCE);
  }
  return 0;
}

function formatAltitude(m) {
  if (m >= 1000) return `${Math.round(m / 1000)} km`;
  return `${Math.round(m)} m`;
}

function failureSentence(failure) {
  const noun = failure.kind === 'ignition'
    ? 'ignition failure'
    : failure.kind === 'separation'
      ? 'separation failure'
      : 'engine failure';
  return `Stage ${failure.stage} ${noun} at T+${Math.round(failure.t)}s.`;
}

/**
 * Simulate a launch.
 *
 * @param {object} vehicle  { stages, payloadMass, dragArea, dragCoeff }
 * @param {object} mission  { requirement: { altitude } , ... }
 * @param {object} loadout  { fuelFraction: 0.5..1.0 }
 * @param {object} rng      from makeRng(seed)
 * @param {object} [opts]
 * @param {number} [opts.dt=0.1]          integrator step, s
 * @param {number} [opts.sampleEvery=0.5] renderer sample spacing, s
 * @param {number} [opts.maxTime=2000]    hard cap on simulated time, s
 * @param {(t: number, alt: number) => number} [opts.pitch]
 *        angle from vertical in radians. Phase 0 default is () => 0 (straight
 *        up); tier 2 supplies a real pitch program without touching this file.
 * @returns {object} Outcome (see ARCHITECTURE.md)
 */
export function resolveLaunch(vehicle, mission, loadout = {}, rng, opts = {}) {
  const dt = opts.dt ?? 0.1;
  const sampleEvery = opts.sampleEvery ?? 0.5;
  const maxTime = opts.maxTime ?? 2000;
  const pitch = opts.pitch ?? (() => 0);

  const fuelFraction = loadout?.fuelFraction ?? 1;
  const stages = vehicle?.stages ?? [];
  const payloadMass = vehicle?.payloadMass ?? 0;
  const dragArea = vehicle?.dragArea ?? 0;
  const dragCoeff = vehicle?.dragCoeff ?? 0;

  const requirementAlt = mission?.requirement?.altitude;
  const deltaVRequired = requiredDeltaV(mission);

  const timeline = [];
  const samples = [];
  const event = (t, kind, text, extra = {}) => {
    timeline.push({ t, kind, text, ...extra });
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
    samples.push({ t: 0, alt: 0, vel: 0, mass: totalMass0, stage: 1 });
    return finish({
      success: false,
      maxAltitude: 0,
      maxSpeed: 0,
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
  let propRemaining = 0;
  let mdot = 0;
  let burnRollAt = Infinity;   // t of this stage's mid-burn reliability roll
  let burnRollPending = false;

  let maxAltitude = 0;
  let maxSpeed = 0;
  let deltaVAchieved = 0;
  let failure = null;
  let goalEmitted = false;
  let apogeeEmitted = false;
  let ended = false;

  const stageNo = () => stageIndex + 1;

  const pushSample = () => {
    const last = samples[samples.length - 1];
    if (last && t <= last.t) return;
    samples.push({
      t,
      alt: y,
      vel: Math.hypot(vx, vy),
      mass,
      stage: stageNo(),
    });
  };
  let nextSampleAt = 0;

  const cutThrust = (kind) => {
    failure = { t, stage: stageNo(), kind };
    thrusting = false;
    burnRollPending = false;
    burnRollAt = Infinity;
    event(t, 'failure', failureSentence(failure), { stage: stageNo(), alt: y });
  };

  /**
   * Ignite the current stage: reliability roll, then (on success) pick the
   * moment of this stage's single mid-burn roll.
   *
   * rng draw order per ignition: (1) the ignition roll, (2) — only if it
   * passed — the fraction of the burn at which the burn roll happens, and
   * later (3) the burn roll itself. An ignition failure therefore consumes
   * exactly one draw.
   */
  const ignite = () => {
    const stage = stages[stageIndex];
    event(t, 'ignition', `Stage ${stageNo()} ignition.`, { stage: stageNo(), alt: y });

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
    event(t, 'burnout', `Stage ${stageNo()} burnout.`, { stage: stageNo(), alt: y });

    if (stageIndex + 1 < stages.length) {
      // Drop the spent stage: its dry mass and whatever propellant is left.
      mass -= stage.dryMass + propRemaining;
      propRemaining = 0;
      event(t, 'separation', `Stage ${stageNo()} separation.`, { stage: stageNo(), alt: y });
      stageIndex += 1;
      ignite();
    }
  };

  // ---- Derivatives --------------------------------------------------------
  // Gravity is -y only (flat-ground 2D): over a phase 0 sounding flight the
  // curvature of the Earth is not worth the extra term, and tier 2 can add it
  // here without changing the outcome shape.
  const deriv = (sx, sy, svx, svy, m, tt, thrustN) => {
    const g = gravityAt(sy);
    let ax = 0;
    let ay = -g;

    if (thrustN > 0 && m > 0) {
      const theta = pitch(tt, sy) || 0;
      ax += (thrustN / m) * Math.sin(theta);
      ay += (thrustN / m) * Math.cos(theta);
    }

    const speed = Math.hypot(svx, svy);
    if (speed > 0 && dragArea > 0 && dragCoeff > 0 && m > 0) {
      const drag = 0.5 * densityAt(sy) * speed * speed * dragCoeff * dragArea;
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

    const prevVy = vy;
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

    if (y > maxAltitude) maxAltitude = y;
    const speed = Math.hypot(vx, vy);
    if (speed > maxSpeed) maxSpeed = speed;

    if (!goalEmitted && typeof requirementAlt === 'number' && y >= requirementAlt) {
      goalEmitted = true;
      event(t, 'goal', `Passed ${formatAltitude(requirementAlt)}.`, { alt: y });
    }

    if (t + EPS >= nextSampleAt) {
      pushSample();
      while (nextSampleAt <= t) nextSampleAt += sampleEvery;
    }

    // Ground.
    if (y <= 0) {
      y = 0;
      pushSample();
      ended = true;
      break;
    }

    // Apogee: first time vertical speed goes non-positive on the way up.
    if (!apogeeEmitted && prevVy > 0 && vy <= 0) {
      apogeeEmitted = true;
      event(t, 'apogee', `Apogee at ${formatAltitude(maxAltitude)}.`, { alt: maxAltitude });
      if (!thrusting) {
        pushSample();
        ended = true;
        break;
      }
    }
  }

  pushSample();

  // ---- Outcome ------------------------------------------------------------
  const success = typeof requirementAlt === 'number'
    ? maxAltitude >= requirementAlt
    : deltaVAchieved >= deltaVRequired;

  // shortBy is `max(0, required - achieved)` (ARCHITECTURE.md), floored by the
  // ideal delta-v gap between the altitude reached and the altitude asked for.
  // The floor exists because the two sides of the subtraction are not measured
  // the same way (see LOSS_ALLOWANCE): without it a run that visibly fell short
  // can report "Short by 0 m/s", which is both nonsense on the result screen and
  // a contradiction of ARCHITECTURE.md's own rule that shortBy is > 0 whenever
  // the run did not succeed. The gap is zero exactly when the requirement was
  // met, so it never fires on a successful run.
  let shortBy = success ? 0 : Math.max(0, deltaVRequired - deltaVAchieved);
  if (!success && typeof requirementAlt === 'number') {
    const idealGap = Math.sqrt(2 * G0 * requirementAlt)
      - Math.sqrt(2 * G0 * Math.max(maxAltitude, 0));
    shortBy = Math.max(shortBy, idealGap);
  }

  let readout;
  if (success) {
    readout = `Reached ${formatAltitude(maxAltitude)}.`;
    if (failure) readout += ` ${failureSentence(failure)}`;
  } else if (failure) {
    readout = failureSentence(failure);
  } else {
    readout = `Reached ${formatAltitude(maxAltitude)}. Short by ${Math.round(shortBy)} m/s.`;
  }

  event(t, 'end', readout, { alt: y });

  return finish({
    success,
    maxAltitude,
    maxSpeed,
    deltaVAchieved,
    deltaVRequired,
    shortBy,
    failure,
    readout,
    timeline,
    samples,
  });
}
