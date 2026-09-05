import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRng } from '../js/core/rng.js';
import { loadTree, collectEffects } from '../js/core/tree.js';
import { baseVehicle } from '../js/data/components.js';
import { nodes as treeNodes } from '../js/data/tree.js';
import { missions } from '../js/data/missions.js';
import { G0, buildVehicle, stageDeltaV, stackMassAbove, totalDeltaV } from '../js/core/vehicle.js';
import {
  resolveLaunch,
  requiredDeltaV,
  pitchProgram,
  orbitElements,
  orbitPhase,
  LOSS_ALLOWANCE,
  ORBIT_LOSS_ALLOWANCE,
  ORBIT_MIN_ALT,
  MU,
  R_EARTH,
  TURN_START_LAZY,
  TURN_START_HARD,
  TURN_END_LAZY,
  TURN_END_HARD,
  gravityAt,
  densityAt,
  NAV_APPROACH,
  DOCK_RANGE,
  DOCK_RELIABILITY,
  DOCK_RELIABILITY_RCS,
  APPROACH_DV,
  PHASE_TOLERANCE_DEG,
  ENGINE_DEFICIT_MIN,
  ENGINE_DEFICIT_MAX,
  ORBIT_CONFIRM_COAST,
  ESCAPE_DELAY,
  ESCAPE_MIN_ALT,
  LUNAR_PROFILES,
  SURFACE_STAY,
  LANDING_RELIABILITY,
  LANDING_RELIABILITY_MAX,
  requiredLunarStep,
} from '../js/core/resolver.js';
import {
  elementsFrom,
  positionAt,
  radiusOf,
  transferDeltaV,
  phasingDeltaV,
  phaseFor,
  velocityAt,
} from '../js/core/orbit.js';
import {
  A_MOON, ASCENT_TIME, DESCENT_TIME, ENTRY_ALT, ENTRY_TIME, LUNAR_STEPS, LLO_PERIOD,
  RETURN_TOF, lunarLadder,
} from '../js/core/moon.js';

// ---------------------------------------------------------------------------
// Fixtures. Defined here, not imported from js/data, so content changes cannot
// break the resolver's tests. This two-stage sounding rocket flies to roughly
// 108 km straight up on a full load, which brackets the tier 1 goal of 100 km.
// ---------------------------------------------------------------------------

const fixtureBase = () => ({
  stages: [
    { dryMass: 150, propMass: 380, thrust: 20000, isp: 250, reliability: 1 },
    { dryMass: 200, propMass: 105, thrust: 8000, isp: 300, reliability: 1 },
  ],
  payloadMass: 100,
  dragArea: 0.2,
  dragCoeff: 0.3,
});

const fixture = (effects = []) => buildVehicle(fixtureBase(), effects);

const MISSION_100KM = { id: 'goal-1', tier: 1, requirement: { altitude: 100000 } };
const MISSION_20KM = { id: 'sound-1', tier: 1, requirement: { altitude: 20000 } };
const FULL = { fuelFraction: 1 };

/** An rng that plays a fixed script, so a specific failure can be forced. */
function scriptedRng(values, fallback = 0.999999) {
  let i = 0;
  return {
    next: () => (i < values.length ? values[i++] : fallback),
    int(n) { return Math.floor(this.next() * n); },
    seed: 0,
    get draws() { return i; },
  };
}

// ---------------------------------------------------------------------------

test('the fixture flies to roughly 100 km and the numbers are sane', () => {
  const v = fixture();
  const dv = totalDeltaV(v, 1);
  assert.ok(dv > 2000 && dv < 2300, `fixture delta-v drifted: ${dv}`);

  const o = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));
  assert.ok(o.maxAltitude > 100000 && o.maxAltitude < 130000,
    `fixture apogee drifted: ${o.maxAltitude}`);
  assert.ok(o.maxSpeed > 500 && o.maxSpeed < 2000, `maxSpeed: ${o.maxSpeed}`);
  assert.equal(o.failure, null);
  assert.equal(o.success, true);
  assert.match(o.readout, /^Reached \d+ km\.$/);
});

test('deterministic for a seed', () => {
  const v = fixture();
  const a = resolveLaunch(v, MISSION_100KM, { fuelFraction: 0.8 }, makeRng(4242));
  const b = resolveLaunch(v, MISSION_100KM, { fuelFraction: 0.8 }, makeRng(4242));
  assert.deepEqual(a, b);
});

test('a different seed can produce a different run, but only through the rolls', () => {
  // Perfect reliability means no roll ever changes anything: the flight is
  // identical whatever the seed. That is the proof that all the variance in a
  // launch comes from the rng and none from the integrator.
  const v = fixture();
  const a = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));
  const b = resolveLaunch(v, MISSION_100KM, FULL, makeRng(99999));
  assert.deepEqual(a, b);
});

test('samples are strictly monotonic in t and start at zero', () => {
  const v = fixture();
  const { samples } = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));
  assert.ok(samples.length > 10);
  assert.equal(samples[0].t, 0);
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(samples[i].t > samples[i - 1].t,
      `sample ${i} is not after ${i - 1}: ${samples[i].t} <= ${samples[i - 1].t}`);
  }
  for (const s of samples) {
    assert.ok(Number.isFinite(s.alt) && Number.isFinite(s.vel) && Number.isFinite(s.mass));
    assert.ok(s.mass > 0);
    assert.ok(s.stage >= 1 && s.stage <= 2);
  }
});

test('samples are decimated to sampleEvery', () => {
  const v = fixture();
  const coarse = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1), { sampleEvery: 5 });
  const fine = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1), { sampleEvery: 0.5 });
  assert.ok(fine.samples.length > coarse.samples.length * 5);
  assert.ok(Math.abs(fine.maxAltitude - coarse.maxAltitude) < 1,
    'sampling must not affect the physics');
});

test('the timeline is sorted and reports the flight', () => {
  const v = fixture();
  const { timeline } = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));
  for (let i = 1; i < timeline.length; i += 1) {
    assert.ok(timeline[i].t >= timeline[i - 1].t, 'timeline must be sorted by t');
  }
  for (const e of timeline) {
    assert.ok(Number.isFinite(e.t), 'every event has a t');
    assert.equal(typeof e.text, 'string');
    assert.ok(e.text.length > 0, 'every event has text');
  }
  const kinds = timeline.map((e) => e.kind);
  assert.deepEqual(kinds, [
    'ignition', 'liftoff',
    'burnout', 'separation', 'ignition',
    'burnout',
    'goal', 'apogee', 'end',
  ]);
});

test('success iff maxAltitude >= requirement', () => {
  const v = fixture();
  const easy = resolveLaunch(v, MISSION_20KM, FULL, makeRng(1));
  const hard = resolveLaunch(v, { requirement: { altitude: 200000 } }, FULL, makeRng(1));
  const goal = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));

  assert.equal(easy.success, easy.maxAltitude >= 20000);
  assert.equal(hard.success, hard.maxAltitude >= 200000);
  assert.equal(goal.success, goal.maxAltitude >= 100000);
  assert.equal(easy.success, true);
  assert.equal(hard.success, false);
  assert.equal(goal.success, true);

  // A requirement just under and just over the apogee flips the verdict.
  const alt = goal.maxAltitude;
  assert.equal(resolveLaunch(v, { requirement: { altitude: alt - 1 } }, FULL, makeRng(1)).success, true);
  assert.equal(resolveLaunch(v, { requirement: { altitude: alt + 1 } }, FULL, makeRng(1)).success, false);
});

test('shortBy is 0 on success and > 0 otherwise', () => {
  const v = fixture();
  for (const fuelFraction of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1]) {
    const o = resolveLaunch(v, MISSION_100KM, { fuelFraction }, makeRng(1));
    if (o.success) {
      assert.equal(o.shortBy, 0, `ff ${fuelFraction}: success must be shortBy 0`);
    } else {
      assert.ok(o.shortBy > 0, `ff ${fuelFraction}: shortfall must be > 0, got ${o.shortBy}`);
      assert.match(o.readout, /^Reached \d+ km\. Short by \d+ m\/s\.$/);
      assert.ok(!/Short by 0 m\/s/.test(o.readout), 'never "Short by 0 m/s"');
    }
  }
});

test('a bigger shortfall in altitude is a bigger shortfall in delta-v', () => {
  const v = fixture();
  const runs = [0.5, 0.6, 0.7, 0.8, 0.9].map(
    (fuelFraction) => resolveLaunch(v, MISSION_100KM, { fuelFraction }, makeRng(1)),
  );
  for (let i = 1; i < runs.length; i += 1) {
    assert.ok(runs[i].shortBy < runs[i - 1].shortBy,
      `shortBy should shrink as the vehicle gets closer: ${runs[i - 1].shortBy} -> ${runs[i].shortBy}`);
  }
});

test('deltaVRequired is the ideal climb plus the loss allowance', () => {
  const v = fixture();
  const o = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));
  const expected = Math.sqrt(2 * G0 * 100000) * (1 + LOSS_ALLOWANCE);
  assert.ok(Math.abs(o.deltaVRequired - expected) < 1e-9);
});

test('deltaVAchieved is the delta-v of the burns that completed', () => {
  const v = fixture();
  const o = resolveLaunch(v, MISSION_100KM, { fuelFraction: 0.8 }, makeRng(1));
  const expected = stageDeltaV(v, 0, 0.8) + stageDeltaV(v, 1, 0.8);
  assert.ok(Math.abs(o.deltaVAchieved - expected) < 1e-6);
});

test('more propellant goes higher', () => {
  const v = fixture();
  const light = resolveLaunch(v, MISSION_100KM, { fuelFraction: 0.6 }, makeRng(1));
  const heavy = resolveLaunch(v, MISSION_100KM, { fuelFraction: 1 }, makeRng(1));
  assert.ok(heavy.maxAltitude > light.maxAltitude);
  assert.ok(heavy.deltaVAchieved > light.deltaVAchieved);

  // ...and so does a bigger tank bought from the shop, at the same fuel fraction.
  const bigger = fixture([{ stat: 'stages.0.propMass', op: 'add', value: 120 }]);
  const upgraded = resolveLaunch(bigger, MISSION_100KM, FULL, makeRng(1));
  assert.ok(upgraded.maxAltitude > heavy.maxAltitude);
});

test('reliability 0 always fails at ignition', () => {
  const dud = fixture([{ stat: 'stages.0.reliability', op: 'set', value: 0 }]);
  for (const seed of [0, 1, 2, 7, 12345, 0xffffffff]) {
    const o = resolveLaunch(dud, MISSION_100KM, FULL, makeRng(seed));
    assert.equal(o.success, false);
    assert.deepEqual(o.failure, { t: 0, stage: 1, kind: 'ignition' });
    assert.equal(o.maxAltitude, 0);
    assert.equal(o.deltaVAchieved, 0);
    assert.equal(o.readout, 'Stage 1 ignition failure at T+0s.');
    assert.ok(o.timeline.some((e) => e.kind === 'failure'));
    assert.ok(!o.timeline.some((e) => e.kind === 'liftoff'), 'a dud never lifts off');
  }
});

test('reliability 1 never fails', () => {
  const v = fixture();
  for (const seed of [0, 1, 2, 7, 12345, 0xffffffff]) {
    assert.equal(resolveLaunch(v, MISSION_100KM, FULL, makeRng(seed)).failure, null);
  }
});

test('an upper stage that fails to light reads as a stage 2 ignition failure', () => {
  const v = fixture([{ stat: 'stages.1.reliability', op: 'set', value: 0 }]);
  const o = resolveLaunch(v, MISSION_100KM, FULL, makeRng(3));
  assert.equal(o.failure.kind, 'ignition');
  assert.equal(o.failure.stage, 2);
  assert.ok(o.failure.t > 0);
  assert.match(o.readout, /^Stage 2 ignition failure at T\+\d+s\.$/);
  // Stage 1 still did its job, so its delta-v counts.
  assert.ok(Math.abs(o.deltaVAchieved - stageDeltaV(v, 0, 1)) < 1e-6);
});

test('a mid-burn failure credits the partial burn and cuts thrust', () => {
  const v = fixture([
    { stat: 'stages.0.reliability', op: 'set', value: 0.5 },
    { stat: 'stages.1.reliability', op: 'set', value: 0.5 },
  ]);
  // Draws: ignition roll (pass), performance roll (pass), burn-roll fraction
  // (halfway), burn roll (fail).
  const o = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng([0.1, 0.1, 0.5, 0.9]));

  assert.equal(o.failure.kind, 'burn');
  assert.equal(o.failure.stage, 1);
  assert.ok(o.failure.t > 0);
  assert.match(o.readout, /^Stage 1 engine failure at T\+\d+s\.$/);

  const full = stageDeltaV(v, 0, 1);
  assert.ok(o.deltaVAchieved > 0, 'a partial burn is worth something');
  assert.ok(o.deltaVAchieved < full, 'a partial burn is worth less than the whole stage');
  assert.ok(Math.abs(o.deltaVAchieved - full / 2) < full * 0.15,
    `half a burn should be near half the delta-v: ${o.deltaVAchieved} vs ${full}`);

  // Thrust ends immediately: no second stage, and the run coasts to apogee.
  assert.ok(!o.timeline.some((e) => e.kind === 'burnout'));
  assert.ok(o.timeline.some((e) => e.kind === 'apogee'));
  assert.equal(o.timeline.at(-1).kind, 'end');
});

test('a vehicle that cannot lift its own weight says so', () => {
  // The shop's classic mistake: a bigger tank before a bigger engine.
  const overloaded = fixture([{ stat: 'stages.0.propMass', op: 'set', value: 9000 }]);
  const o = resolveLaunch(overloaded, MISSION_100KM, FULL, makeRng(1));

  assert.equal(o.readout, 'Insufficient thrust to lift off.');
  assert.equal(o.maxAltitude, 0);
  assert.equal(o.maxSpeed, 0);
  assert.equal(o.success, false);
  assert.equal(o.failure, null, 'this is not a reliability failure');
  assert.equal(o.deltaVAchieved, 0);
  assert.ok(o.shortBy > 0);
  assert.equal(o.samples.length, 1);
  assert.equal(o.timeline.at(-1).kind, 'end');
});

test('thrust exactly equal to weight still does not lift off', () => {
  const base = fixtureBase();
  const total = base.stages.reduce((m, s) => m + s.dryMass + s.propMass, base.payloadMass);
  const marginal = buildVehicle(base, [
    { stat: 'stages.0.thrust', op: 'set', value: total * G0 },
  ]);
  assert.equal(
    resolveLaunch(marginal, MISSION_100KM, FULL, makeRng(1)).readout,
    'Insufficient thrust to lift off.',
  );
});

test('a vehicle with no stages does not crash the resolver', () => {
  const empty = { stages: [], payloadMass: 100, dragArea: 1, dragCoeff: 0.3 };
  const o = resolveLaunch(empty, MISSION_100KM, FULL, makeRng(1));
  assert.equal(o.readout, 'Insufficient thrust to lift off.');
  assert.equal(o.maxAltitude, 0);
});

test('the goal event fires the moment the requirement is crossed', () => {
  const v = fixture();
  const o = resolveLaunch(v, MISSION_20KM, FULL, makeRng(1));
  const goals = o.timeline.filter((e) => e.kind === 'goal');
  assert.equal(goals.length, 1, 'the goal is announced once');
  assert.ok(goals[0].alt >= 20000);
  assert.ok(goals[0].alt < 20000 + 2000, 'announced on the way past, not later');
  const apogee = o.timeline.find((e) => e.kind === 'apogee');
  assert.ok(goals[0].t < apogee.t);
});

test('a run that never reaches the requirement has no goal event', () => {
  const v = fixture();
  const o = resolveLaunch(v, { requirement: { altitude: 500000 } }, FULL, makeRng(1));
  assert.ok(!o.timeline.some((e) => e.kind === 'goal'));
});

test('the pitch program steers, and defaults to straight up', () => {
  const v = fixture();
  const vertical = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));
  const explicit = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1), { pitch: () => 0 });
  assert.equal(vertical.maxAltitude, explicit.maxAltitude);

  const tilted = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1), { pitch: () => Math.PI / 4 });
  assert.ok(tilted.maxAltitude < vertical.maxAltitude,
    'thrusting 45 degrees off vertical must not go higher than straight up');
  assert.ok(tilted.maxAltitude > 0);
});

test('simulated time is capped', () => {
  const v = fixture();
  const o = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1), { maxTime: 30 });
  assert.ok(o.timeline.at(-1).t <= 30 + 1e-6);
  assert.ok(o.samples.at(-1).t <= 30 + 1e-6);
  assert.ok(!o.timeline.some((e) => e.kind === 'apogee'), 'cut off before apogee');
});

test('the step size changes the answer only a little', () => {
  const v = fixture();
  const coarse = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1), { dt: 0.2 });
  const fine = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1), { dt: 0.02 });
  const rel = Math.abs(coarse.maxAltitude - fine.maxAltitude) / fine.maxAltitude;
  assert.ok(rel < 0.01, `RK2 should converge: ${rel}`);
});

test('gravity and atmosphere fall off with altitude', () => {
  assert.ok(Math.abs(gravityAt(0) - G0) < 1e-12);
  assert.ok(gravityAt(100000) < gravityAt(0));
  assert.ok(Math.abs(gravityAt(100000) - G0 * (6.371e6 / 6.471e6) ** 2) < 1e-12);
  assert.ok(Math.abs(densityAt(0) - 1.225) < 1e-12);
  assert.ok(Math.abs(densityAt(8500) - 1.225 / Math.E) < 1e-12);
  assert.ok(densityAt(100000) < 1e-4);
});

test('drag slows the vehicle down', () => {
  const slippery = fixture([{ stat: 'dragArea', op: 'set', value: 0 }]);
  const draggy = fixture([{ stat: 'dragArea', op: 'set', value: 2 }]);
  const a = resolveLaunch(slippery, MISSION_100KM, FULL, makeRng(1));
  const b = resolveLaunch(draggy, MISSION_100KM, FULL, makeRng(1));
  assert.ok(b.maxAltitude < a.maxAltitude);
  assert.ok(b.maxSpeed < a.maxSpeed);
});

test('a 300 s flight at dt 0.1 resolves well under 50 ms', () => {
  const v = fixture([{ stat: 'stages.0.propMass', op: 'add', value: 200 }]);
  // Warm up, then take the best of a few runs: this is a floor check on the
  // integrator's cost, not a benchmark of the machine's mood.
  for (let i = 0; i < 5; i += 1) resolveLaunch(v, MISSION_100KM, FULL, makeRng(i));

  let best = Infinity;
  let flight = 0;
  for (let i = 0; i < 5; i += 1) {
    const t0 = process.hrtime.bigint();
    const o = resolveLaunch(v, MISSION_100KM, FULL, makeRng(i), { dt: 0.1 });
    const t1 = process.hrtime.bigint();
    best = Math.min(best, Number(t1 - t0) / 1e6);
    flight = o.timeline.at(-1).t;
  }
  assert.ok(flight > 250, `expected a long flight to time, got ${flight}s`);
  assert.ok(best < 50, `resolve took ${best.toFixed(2)} ms`);
});

// ===========================================================================
// Phase 1 — central gravity, the pitch program, downrange and orbit.
//
// More fixtures, again defined here rather than imported from js/data. The
// two below bracket tier 2: `strongFixture` is an orbital launcher, `midFixture`
// is a big sounding rocket that can throw something a long way downrange but
// can never orbit.
// ===========================================================================

/**
 * An orbital launcher: two stages, guidance 1, ~10.4 km/s of ideal delta-v and
 * a liftoff TWR of ~1.4.
 *
 * NOTE on the size. The brief for this fixture said "~9.5 km/s ideal", the
 * figure a real launcher pays. It is not enough here, and that is a property of
 * the pitch program ARCHITECTURE.md specifies rather than of this fixture: the
 * program pitches over LINEARLY WITH ALTITUDE and is not horizontal until
 * `turnEnd` (110 km at turn 0.5), so the vehicle is still thrusting well off
 * prograde high into the flight and pays ~2.5 km/s of gravity and steering
 * losses instead of a real gravity turn's ~1.7. Nothing between 9.4 and 9.9
 * km/s reaches a 100 km periapsis at any `turn`; ~10.4 does, with margin at the
 * middle of the range and a clear failure at the ends, which is what these
 * tests need to assert. Tuning the ladder to it is js/data's job, not this
 * file's.
 */
const strongBase = () => ({
  stages: [
    { dryMass: 16000, propMass: 160000, thrust: 2.9e6, isp: 290, reliability: 1 },
    { dryMass: 4500, propMass: 28000, thrust: 5.0e5, isp: 350, reliability: 1 },
  ],
  payloadMass: 800,
  dragArea: 8,
  dragCoeff: 0.3,
  guidance: 1,
});
const strongFixture = (effects = []) => buildVehicle(strongBase(), effects);

/** Guidance, ~6.2 km/s: it can lob ~1 600 km downrange, and it cannot orbit. */
const midBase = () => ({
  stages: [
    { dryMass: 1200, propMass: 5200, thrust: 160000, isp: 260, reliability: 1 },
    { dryMass: 400, propMass: 1400, thrust: 30000, isp: 300, reliability: 1 },
  ],
  payloadMass: 150,
  dragArea: 1,
  dragCoeff: 0.3,
  guidance: 1,
});
const midFixture = (effects = []) => buildVehicle(midBase(), effects);

const MISSION_ORBIT = { id: 'orb-1', tier: 2, requirement: { orbit: { periapsis: 100000 } } };
const MISSION_DOWNRANGE = { id: 'dr-1', tier: 2, requirement: { downrange: 300000 } };

// ---------------------------------------------------------------------------
// Tier 1 must not move.
// ---------------------------------------------------------------------------

test('tier 1 regression: central gravity does not change a vertical flight', () => {
  // Measured from the PHASE 0 resolver (flat ground, gravity = -y only) before
  // central gravity landed, with `node -e` against this exact fixture:
  //
  //   resolveLaunch(fixture(), MISSION_100KM, { fuelFraction: 1 }, makeRng(1))
  //     .maxAltitude === 108072.676471 m
  //
  // A vertical flight sits on the x = 0 axis, where |r| = y + R and central
  // gravity reduces algebraically to the phase 0 model, so this should agree to
  // floating-point noise (it agrees to ~7e-13 relative). ARCHITECTURE.md asks
  // for 0.5%; the slack is there for a future change to the integrator, not
  // because this one needs it.
  const PHASE_0_MAX_ALTITUDE = 108072.676471;

  const o = resolveLaunch(fixture(), MISSION_100KM, FULL, makeRng(1));
  const rel = Math.abs(o.maxAltitude - PHASE_0_MAX_ALTITUDE) / PHASE_0_MAX_ALTITUDE;
  assert.ok(rel < 0.005,
    `tier 1 apogee moved by ${(rel * 100).toFixed(3)}%: ${o.maxAltitude} vs ${PHASE_0_MAX_ALTITUDE}`);

  // ...and the flight really is vertical: no sideways motion, no turn event.
  assert.equal(o.maxDownrange, 0);
  assert.ok(o.samples.every((s) => s.x === 0));
  assert.ok(!o.timeline.some((e) => e.kind === 'turn'));
});

// ---------------------------------------------------------------------------
// orbitElements
// ---------------------------------------------------------------------------

test('orbitElements on a hand-computed circular orbit', () => {
  // A circular orbit at 200 km: r = R + 200 km, v = sqrt(mu/r) perpendicular
  // to r. Periapsis and apoapsis must both be the 200 km it is already at, and
  // the eccentricity must be zero.
  const r = { x: 0, y: R_EARTH + 200000 };
  const speed = Math.sqrt(MU / (R_EARTH + 200000));
  const el = orbitElements(r, { x: speed, y: 0 });

  assert.ok(Math.abs(el.periapsis - 200000) < 1, `periapsis ${el.periapsis}`);
  assert.ok(Math.abs(el.apoapsis - 200000) < 1, `apoapsis ${el.apoapsis}`);
  assert.ok(el.e < 1e-6, `e ${el.e}`);
  assert.ok(Math.abs(el.a - (R_EARTH + 200000)) < 1, `a ${el.a}`);
  assert.ok(el.energy < 0, 'a circular orbit is bound');
  // Same orbit flown the other way round the planet: identical elements.
  const mirrored = orbitElements(r, { x: -speed, y: 0 });
  assert.ok(Math.abs(mirrored.periapsis - el.periapsis) < 1e-6);
  assert.ok(Math.abs(mirrored.apoapsis - el.apoapsis) < 1e-6);
});

test('orbitElements: eccentric, escaping and straight-up cases', () => {
  const r = { x: 0, y: R_EARTH + 200000 };
  const circular = Math.sqrt(MU / (R_EARTH + 200000));

  // 10% over circular: still bound, periapsis stays put, apoapsis rises.
  const raised = orbitElements(r, { x: circular * 1.1, y: 0 });
  assert.ok(Math.abs(raised.periapsis - 200000) < 1, `periapsis ${raised.periapsis}`);
  assert.ok(raised.apoapsis > 200000 + 400000, `apoapsis ${raised.apoapsis}`);
  assert.ok(raised.e > 0 && raised.e < 1);

  // Escape velocity is sqrt(2) x circular: unbound, so apoapsis is infinite.
  const escaping = orbitElements(r, { x: circular * Math.SQRT2, y: 0 });
  assert.equal(escaping.apoapsis, Infinity);
  assert.ok(escaping.e >= 1);
  assert.ok(escaping.energy >= 0);

  // Straight up: no angular momentum at all, so periapsis is the planet's
  // centre and apoapsis is the altitude it will coast to.
  const vertical = orbitElements({ x: 0, y: R_EARTH }, { x: 0, y: 1000 });
  assert.equal(vertical.h, 0);
  assert.equal(vertical.periapsis, -R_EARTH);
  assert.ok(vertical.apoapsis > 0 && vertical.apoapsis < 100000);
});

// ---------------------------------------------------------------------------
// orbitPhase — the inverse of js/core/orbit.js's positionAt, so it is tested
// against it: every phase that goes into positionAt has to come back out of
// orbitPhase. That round trip is the whole guarantee, because the phase's only
// job is to be the number the schedule and the map feed BACK into positionAt.
// ---------------------------------------------------------------------------

test('orbitPhase round-trips positionAt, on both sides of the orbit', () => {
  const rp = R_EARTH + 80000;
  const ra = R_EARTH + 4381000;      // the eccentric parking orbit tier 4 flies
  const { a, e } = elementsFrom(rp, ra);
  assert.ok(e > 0.2, `this test needs a genuinely eccentric orbit, got e ${e}`);

  for (let i = 0; i < 64; i += 1) {
    const phase = i / 64;
    const p = positionAt(rp, ra, 0, phase, 0);
    // The velocity is differentiated out of positionAt rather than written as
    // a second formula, so the round trip is against orbit.js and nothing
    // else: a centred difference over a millisecond on an orbit this size is
    // good to well under the tolerance below.
    const dt = 0.001;
    const ahead = positionAt(rp, ra, 0, phase, dt);
    const behind = positionAt(rp, ra, 0, phase, -dt);
    const v = { x: (ahead.x - behind.x) / (2 * dt), y: (ahead.y - behind.y) / (2 * dt) };

    const back = orbitPhase({ x: p.x, y: p.y }, v);
    const err = Math.min(Math.abs(back - phase), 1 - Math.abs(back - phase));
    assert.ok(err < 1e-6, `phase ${phase} came back as ${back}`);
    // And the half-orbit trap that made this function necessary: the sign of
    // r.v puts the answer on the right side. Climbing is the first half of the
    // orbit, falling the second.
    const climbing = p.x * v.x + p.y * v.y > 0;
    if (phase > 1e-9 && phase < 0.5) assert.ok(climbing, `phase ${phase} should be climbing`);
    if (phase > 0.5) assert.ok(!climbing, `phase ${phase} should be falling`);
  }

  // The two apsides by hand, since they are the two the schedule cares about.
  const vp = Math.sqrt(MU * (2 / rp - 1 / a));
  const va = Math.sqrt(MU * (2 / ra - 1 / a));
  assert.ok(orbitPhase({ x: rp, y: 0 }, { x: 0, y: vp }) < 1e-9, 'periapsis is phase 0');
  assert.ok(Math.abs(orbitPhase({ x: -ra, y: 0 }, { x: 0, y: -va }) - 0.5) < 1e-9, 'apoapsis is 0.5');
  // Direction round the planet is not the question — phase counts time since
  // periapsis, so flying the same orbit backwards reads the same.
  assert.ok(Math.abs(orbitPhase({ x: -ra, y: 0 }, { x: 0, y: va }) - 0.5) < 1e-9);
});

test('orbitPhase reports 0 rather than NaN for what has no phase', () => {
  const r = { x: 0, y: R_EARTH + 200000 };
  const circular = Math.sqrt(MU / (R_EARTH + 200000));
  // A circular orbit has no periapsis to count from; 0 is the honest answer.
  assert.equal(orbitPhase(r, { x: circular, y: 0 }), 0);
  // Unbound, purely radial, and nowhere at all: the same total-function guard
  // orbitElements keeps, because the ascent asks before it has an orbit.
  assert.equal(orbitPhase(r, { x: circular * Math.SQRT2, y: 0 }), 0);
  assert.equal(orbitPhase({ x: 0, y: R_EARTH }, { x: 0, y: 1000 }), 0);
  assert.equal(orbitPhase({ x: 0, y: 0 }, { x: 0, y: 0 }), 0);
});

// ---------------------------------------------------------------------------
// pitchProgram
// ---------------------------------------------------------------------------

test('pitchProgram is vertical below turnStart, horizontal at turnEnd, monotone between', () => {
  for (const turn of [0, 0.25, 0.5, 0.75, 1]) {
    const turnStart = TURN_START_LAZY + (TURN_START_HARD - TURN_START_LAZY) * turn;
    const turnEnd = TURN_END_LAZY + (TURN_END_HARD - TURN_END_LAZY) * turn;
    const pitch = pitchProgram({ guidance: 1 }, { turn });

    assert.equal(pitch(0, 0), 0, `turn ${turn}: vertical on the pad`);
    assert.equal(pitch(0, turnStart / 2), 0, `turn ${turn}: vertical below turnStart`);
    assert.equal(pitch(0, turnStart), 0, `turn ${turn}: vertical at turnStart`);
    assert.ok(pitch(0, turnStart + 1) > 0, `turn ${turn}: pitching just above turnStart`);
    assert.equal(pitch(0, turnEnd), Math.PI / 2, `turn ${turn}: horizontal at turnEnd`);
    assert.equal(pitch(0, turnEnd * 2), Math.PI / 2, `turn ${turn}: still horizontal above it`);

    let prev = -1;
    for (let alt = 0; alt <= 300000; alt += 250) {
      const a = pitch(0, alt);
      assert.ok(a >= prev, `turn ${turn}: pitch fell back at ${alt} m`);
      assert.ok(a >= 0 && a <= Math.PI / 2, `turn ${turn}: pitch out of range at ${alt} m`);
      prev = a;
    }
    // Time is accepted and ignored: the program is a function of altitude.
    assert.equal(pitch(0, 50000), pitch(9999, 50000));
  }

  // A harder turn is off vertical sooner and horizontal sooner, at every
  // altitude where either is turning at all.
  const lazy = pitchProgram({ guidance: 1 }, { turn: 0 });
  const hard = pitchProgram({ guidance: 1 }, { turn: 1 });
  for (let alt = 1000; alt <= 160000; alt += 1000) {
    assert.ok(hard(0, alt) >= lazy(0, alt), `hard turn lagged the lazy one at ${alt} m`);
  }
});

test('turn is ignored without guidance', () => {
  // pitchProgram: no guidance means no steering, whatever the loadout says.
  for (const guidance of [undefined, 0]) {
    const pitch = pitchProgram({ guidance }, { turn: 1 });
    for (const alt of [0, 5000, 50000, 200000]) assert.equal(pitch(0, alt), 0);
  }

  // ...and resolveLaunch agrees: the tier 1 fixture flies the same vertical
  // flight whatever `turn` is asked for.
  const v = fixture();
  assert.equal(v.guidance, 0, 'buildVehicle defaults guidance to 0');
  const base = resolveLaunch(v, MISSION_100KM, { fuelFraction: 1, turn: 0 }, makeRng(1));
  for (const turn of [0.25, 0.5, 0.75, 1]) {
    const o = resolveLaunch(v, MISSION_100KM, { fuelFraction: 1, turn }, makeRng(1));
    assert.deepEqual(o, base, `turn ${turn} changed a guidance-0 flight`);
  }

  // The same vehicle WITH guidance does respond to it.
  const guided = fixture([{ stat: 'guidance', op: 'set', value: 1 }]);
  const turned = resolveLaunch(guided, MISSION_100KM, { fuelFraction: 1, turn: 1 }, makeRng(1));
  assert.ok(turned.maxDownrange > 0, 'a guided vehicle goes somewhere sideways');
  assert.ok(turned.maxAltitude < base.maxAltitude, 'and pays for it in altitude');
});

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------

test('the strong fixture reaches orbit with a mid-range turn', () => {
  const v = strongFixture();
  const dv = totalDeltaV(v, 1);
  assert.ok(dv > 10000 && dv < 11000, `strong fixture delta-v drifted: ${dv}`);

  const orbited = [0.3, 0.4, 0.5, 0.6, 0.7].filter(
    (turn) => resolveLaunch(v, MISSION_ORBIT, { fuelFraction: 1, turn }, makeRng(1)).orbit,
  );
  assert.ok(orbited.length > 0, 'some turn in [0.3, 0.7] must reach orbit');

  const o = resolveLaunch(v, MISSION_ORBIT, { fuelFraction: 1, turn: 0.5 }, makeRng(1));
  assert.equal(o.orbit, true);
  assert.equal(o.success, true);
  assert.equal(o.shortBy, 0);
  assert.ok(o.periapsis >= 100000, `periapsis ${o.periapsis}`);
  assert.ok(o.periapsis >= ORBIT_MIN_ALT);
  assert.ok(o.apoapsis >= o.periapsis);
  assert.ok(Number.isFinite(o.apoapsis), 'a low orbit is bound, not an escape');
  assert.ok(o.maxDownrange > 0);

  const orbitEvents = o.timeline.filter((e) => e.kind === 'orbit');
  assert.equal(orbitEvents.length, 1, 'orbit is announced once');
  assert.match(orbitEvents[0].text, /^Orbit: /);
  assert.ok(o.timeline.some((e) => e.kind === 'turn'), 'a guided ascent has a turn event');
  assert.match(o.readout, /^Orbit: /);

  // It ends on a short coast after the announcement, not at maxTime.
  const end = o.timeline.at(-1);
  assert.equal(end.kind, 'end');
  assert.ok(end.t > orbitEvents[0].t, 'the flight coasts on past the announcement');
  assert.ok(end.t < orbitEvents[0].t + 31);
});

test('the same vehicle flown vertically does not reach orbit', () => {
  const v = strongFixture();
  const o = resolveLaunch(v, MISSION_ORBIT, { fuelFraction: 1, turn: 0 }, makeRng(1));
  assert.equal(o.orbit, false);
  assert.equal(o.success, false);
  assert.ok(o.periapsis < 100000, `periapsis ${o.periapsis}`);
  assert.ok(o.shortBy > 0);
  assert.ok(!o.timeline.some((e) => e.kind === 'orbit'));
  assert.match(o.readout, /^Apoapsis .+, periapsis .+\. Short by \d+ m\/s\.$/);

  // Delta-v alone is not the answer any more: it carries MORE than the orbit
  // requirement asks for and still fails. That is the whole point of tier 2.
  assert.ok(o.deltaVAchieved > o.deltaVRequired);
});

test('a vehicle with no guidance cannot orbit however it is loaded', () => {
  const v = fixture();
  for (const turn of [0, 0.5, 1]) {
    const o = resolveLaunch(v, MISSION_ORBIT, { fuelFraction: 1, turn }, makeRng(1));
    assert.equal(o.orbit, false);
    assert.equal(o.success, false);
    assert.ok(o.shortBy > 0);
  }
});

// ---------------------------------------------------------------------------
// Downrange
// ---------------------------------------------------------------------------

test('a downrange flight ends at impact', () => {
  const o = resolveLaunch(midFixture(), MISSION_DOWNRANGE, { fuelFraction: 1, turn: 0.5 }, makeRng(1));

  assert.ok(o.maxDownrange > 0, 'it went somewhere');
  assert.equal(o.success, true, '1 600 km clears a 300 km requirement');
  assert.equal(o.shortBy, 0);
  assert.equal(o.orbit, false);

  const impacts = o.timeline.filter((e) => e.kind === 'impact');
  assert.equal(impacts.length, 1, 'impact is announced once');
  assert.equal(impacts[0].alt, 0);
  assert.match(o.readout, /^Impact \d+ km downrange\.$/);

  // The flight really does end on the ground, not at apogee.
  const end = o.timeline.at(-1);
  assert.equal(end.kind, 'end');
  assert.ok(Math.abs(end.t - impacts[0].t) < 1e-9);
  assert.ok(o.samples.at(-1).alt < 1e-6, `last sample alt ${o.samples.at(-1).alt}`);
  assert.ok(o.samples.at(-1).downrange > 0);

  // ...and it flew past its own apogee to get there.
  const apogee = o.timeline.find((e) => e.kind === 'apogee');
  assert.ok(apogee, 'a ballistic lob still reports its apogee');
  assert.ok(apogee.t < impacts[0].t);
  assert.ok(o.maxAltitude > 0);

  const goals = o.timeline.filter((e) => e.kind === 'goal');
  assert.equal(goals.length, 1, 'the range goal is announced once');
});

test('a downrange miss reads as a miss', () => {
  const o = resolveLaunch(
    midFixture(),
    { requirement: { downrange: 4000000 } },
    { fuelFraction: 1, turn: 0.5 },
    makeRng(1),
  );
  assert.equal(o.success, false);
  assert.ok(o.shortBy > 0);
  assert.match(o.readout, /^Impact \d+ km downrange\. Short by \d+ m\/s\.$/);
  assert.ok(!o.timeline.some((e) => e.kind === 'goal'));
});

test('reaching orbit satisfies a downrange requirement', () => {
  // "or at orbit, which trivially satisfies it" — the vehicle is not coming
  // down, so it will pass over every point on the surface.
  const o = resolveLaunch(
    strongFixture(),
    { requirement: { downrange: 9000000 } },
    { fuelFraction: 1, turn: 0.5 },
    makeRng(1),
  );
  assert.equal(o.orbit, true);
  assert.equal(o.success, true);
  assert.equal(o.shortBy, 0);
  assert.ok(o.maxDownrange < 9000000, 'it passes on the orbit, not on the range flown');
  assert.match(o.readout, /^Orbit: /);
  assert.ok(!o.timeline.some((e) => e.kind === 'impact'));
});

// ---------------------------------------------------------------------------
// shortBy and deltaVRequired across all three requirement shapes
// ---------------------------------------------------------------------------

test('shortBy is 0 on every kind of success and > 0 on every kind of miss', () => {
  const weak = fixture();
  const mid = midFixture();
  const strong = strongFixture();
  const LOAD = { fuelFraction: 1, turn: 0.5 };

  const hits = [
    [weak, MISSION_20KM, FULL],
    [weak, { requirement: { altitude: 50000 } }, FULL],
    [mid, MISSION_DOWNRANGE, LOAD],
    [mid, { requirement: { downrange: 1000000 } }, LOAD],
    [strong, MISSION_ORBIT, LOAD],
    [strong, { requirement: { orbit: { periapsis: 150000 } } }, LOAD],
    [strong, { requirement: { downrange: 500000 } }, LOAD],
  ];
  for (const [v, mission, loadout] of hits) {
    const o = resolveLaunch(v, mission, loadout, makeRng(1));
    assert.equal(o.success, true, `expected a hit: ${JSON.stringify(mission.requirement)}`);
    assert.equal(o.shortBy, 0, `a hit must be shortBy 0: ${o.readout}`);
  }

  const misses = [
    [weak, { requirement: { altitude: 400000 } }, FULL],
    [weak, { requirement: { downrange: 100000 } }, FULL],        // vertical: no range at all
    [weak, MISSION_ORBIT, FULL],
    [mid, { requirement: { altitude: 900000 } }, LOAD],
    [mid, { requirement: { downrange: 4000000 } }, LOAD],
    [mid, MISSION_ORBIT, LOAD],
    [strong, { requirement: { orbit: { periapsis: 100000 } } }, { fuelFraction: 1, turn: 0 }],
    [strong, { requirement: { orbit: { periapsis: 3000000 } } }, LOAD],
    [strong, { requirement: { downrange: 9000000 } }, { fuelFraction: 0.5, turn: 0.5 }],
  ];
  for (const [v, mission, loadout] of misses) {
    const o = resolveLaunch(v, mission, loadout, makeRng(1));
    assert.equal(o.success, false, `expected a miss: ${JSON.stringify(mission.requirement)} -> ${o.readout}`);
    assert.ok(o.shortBy > 0,
      `a miss must be shortBy > 0: ${JSON.stringify(mission.requirement)} -> ${o.readout}`);
    assert.ok(!/Short by 0 m\/s/.test(o.readout), `never "Short by 0 m/s": ${o.readout}`);
  }
});

test('requiredDeltaV handles all three requirement shapes', () => {
  const alt = requiredDeltaV({ requirement: { altitude: 100000 } });
  assert.ok(Math.abs(alt - Math.sqrt(2 * G0 * 100000) * (1 + LOSS_ALLOWANCE)) < 1e-9);

  // Flat-planet ballistic: the optimal 45-degree lob for range d needs
  // v = sqrt(g0 * d), plus the same loss allowance as an altitude shot.
  const down = requiredDeltaV({ requirement: { downrange: 400000 } });
  assert.ok(Math.abs(down - Math.sqrt(G0 * 400000) * (1 + LOSS_ALLOWANCE)) < 1e-9);

  // Circular velocity at the required periapsis, plus the orbital allowance.
  const orb = requiredDeltaV({ requirement: { orbit: { periapsis: 100000 } } });
  const circular = Math.sqrt(MU / (R_EARTH + 100000));
  assert.ok(Math.abs(orb - circular * (1 + ORBIT_LOSS_ALLOWANCE)) < 1e-9);
  assert.ok(circular > 7700 && circular < 7900, `circular velocity at 100 km: ${circular}`);

  // The ladder is monotone in difficulty, and orbit is the hardest thing asked.
  assert.ok(orb > down && orb > alt);
  assert.ok(requiredDeltaV({}) === 0);
  assert.ok(requiredDeltaV(undefined) === 0);

  // The resolver quotes exactly this number.
  for (const requirement of [
    { altitude: 100000 }, { downrange: 400000 }, { orbit: { periapsis: 100000 } },
  ]) {
    const o = resolveLaunch(midFixture(), { requirement }, { fuelFraction: 1, turn: 0.5 }, makeRng(1));
    assert.equal(o.deltaVRequired, requiredDeltaV({ requirement }));
  }
});

// ---------------------------------------------------------------------------
// Samples and determinism, phase 1 shape
// ---------------------------------------------------------------------------

test('samples carry x, y and downrange and stay monotonic in t', () => {
  for (const [v, mission, loadout] of [
    [strongFixture(), MISSION_ORBIT, { fuelFraction: 1, turn: 0.5 }],
    [midFixture(), MISSION_DOWNRANGE, { fuelFraction: 1, turn: 0.5 }],
    [fixture(), MISSION_100KM, FULL],
  ]) {
    const { samples } = resolveLaunch(v, mission, loadout, makeRng(1));
    assert.ok(samples.length > 10);
    assert.equal(samples[0].t, 0);
    assert.equal(samples[0].x, 0);
    assert.equal(samples[0].y, 0);
    assert.equal(samples[0].downrange, 0);
    for (let i = 1; i < samples.length; i += 1) {
      const s = samples[i];
      assert.ok(s.t > samples[i - 1].t, `sample ${i} is not after ${i - 1}`);
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.downrange));
      assert.ok(s.downrange >= 0);
      assert.ok(s.mass > 0);
      // alt is the height above the surface, i.e. |r| - R for the world point.
      const alt = Math.hypot(s.x, s.y + R_EARTH) - R_EARTH;
      assert.ok(Math.abs(alt - s.alt) < 1e-6, `sample ${i}: alt disagrees with (x, y)`);
    }
  }
});

test('deterministic for a seed on an orbital flight', () => {
  const v = strongFixture([{ stat: 'stages.1.reliability', op: 'set', value: 0.7 }]);
  const load = { fuelFraction: 0.9, turn: 0.45 };
  for (const seed of [1, 77, 4242, 0xffffffff]) {
    const a = resolveLaunch(v, MISSION_ORBIT, load, makeRng(seed));
    const b = resolveLaunch(v, MISSION_ORBIT, load, makeRng(seed));
    assert.deepEqual(a, b, `seed ${seed} is not reproducible`);
  }
  // And the draw order is unchanged from phase 0: an ignition failure still
  // costs exactly one draw, so a scripted rng lands on the same rolls.
  const scripted = resolveLaunch(
    strongFixture([{ stat: 'stages.0.reliability', op: 'set', value: 0.5 }]),
    MISSION_ORBIT,
    load,
    scriptedRng([0.9]),
  );
  assert.deepEqual(scripted.failure, { t: 0, stage: 1, kind: 'ignition' });
  assert.equal(scripted.periapsis, null, 'a vehicle that never left the pad has no orbit');
  assert.equal(scripted.apoapsis, null);
  assert.equal(scripted.orbit, false);
  assert.ok(scripted.shortBy > 0);
});

test('a long orbital flight at dt 0.1 resolves well under 100 ms', () => {
  const v = midFixture();
  const load = { fuelFraction: 1, turn: 0.5 };
  for (let i = 0; i < 5; i += 1) resolveLaunch(v, MISSION_DOWNRANGE, load, makeRng(i));

  let best = Infinity;
  let flight = 0;
  for (let i = 0; i < 5; i += 1) {
    const t0 = process.hrtime.bigint();
    const o = resolveLaunch(v, MISSION_DOWNRANGE, load, makeRng(i), { dt: 0.1 });
    const t1 = process.hrtime.bigint();
    best = Math.min(best, Number(t1 - t0) / 1e6);
    flight = o.timeline.at(-1).t;
  }
  assert.ok(flight > 600, `expected a 600 s+ flight, got ${flight}s`);
  assert.ok(best < 100, `resolve took ${best.toFixed(2)} ms`);
});

test('loadout.vertical flies straight up even with guidance, unlike turn 0', () => {
  const vehicle = { stages: [{ dryMass: 150, propMass: 380, thrust: 20000, isp: 250, reliability: 1 }, { dryMass: 200, propMass: 105, thrust: 8000, isp: 300, reliability: 1 }], payloadMass: 100, dragArea: 0.2, dragCoeff: 0.3, guidance: 1 };
  const mission = { requirement: { altitude: 100000 } };
  const lazy = resolveLaunch(vehicle, mission, { fuelFraction: 1, turn: 0 }, makeRng(1), {});
  const up = resolveLaunch(vehicle, mission, { fuelFraction: 1, turn: 0.5, vertical: true }, makeRng(1), {});
  assert.ok(lazy.maxDownrange > 0, 'turn 0 with guidance is a lazy turn, not vertical');
  assert.equal(up.maxDownrange, 0);
  assert.ok(up.samples.every((s) => s.x === 0));
});

// ===========================================================================
// Stage abort systems — `vehicle.escape` (ARCHITECTURE.md, tier 2 addition).
//
// `escape` is how many stages, from the bottom, can fail in flight and have the
// stack above them separate and fly on. The two-stage fixture has reliability 1
// throughout, so a failure is forced by lowering one stage's reliability to 0.5
// and scripting the rng; an unscripted draw falls back to 0.999999, which passes
// a reliability-1 roll and fails a 0.5 one.
// ===========================================================================

const ESCAPE = (n) => ({ stat: 'escape', op: 'set', value: n });
const FLAKY_STAGE_1 = { stat: 'stages.0.reliability', op: 'set', value: 0.5 };
const FLAKY_STAGE_2 = { stat: 'stages.1.reliability', op: 'set', value: 0.5 };
// Draws: stage 1 ignition (pass), performance (pass, so the stage runs to
// spec), burn-roll fraction (halfway), burn roll (fail). The performance roll
// is the anomalies work's addition to the per-ignition draw order; it sits
// between the ignition roll and the burn-roll fraction, so every script here
// carries one more value per ignition than it did before that landed.
const STAGE_1_MID_BURN_FAILURE = [0.1, 0.1, 0.5, 0.9];
// Stage 1 flies clean (ignition, performance, fraction, burn roll all pass),
// stage 2 fails halfway through its burn.
const STAGE_2_MID_BURN_FAILURE = [0.1, 0.1, 0.5, 0.1, 0.1, 0.1, 0.5, 0.9];

test('escape 0: a mid-burn failure is terminal exactly as before', () => {
  const v = fixture([FLAKY_STAGE_1]);
  assert.equal(v.escape, 0, 'buildVehicle seeds escape at 0');
  const o = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng(STAGE_1_MID_BURN_FAILURE));

  assert.deepEqual(Object.keys(o.failure).sort(), ['kind', 'stage', 't']);
  assert.equal(o.failure.kind, 'burn');
  assert.equal(o.failure.stage, 1);
  assert.equal(o.escapes, 0);
  assert.equal(o.success, false);
  assert.match(o.readout, /^Stage 1 engine failure at T\+\d+s\.$/);
  assert.ok(!o.timeline.some((e) => e.kind === 'separation'), 'no stage ever separates');
  assert.ok(!o.timeline.some((e) => e.escaped || e.abort), 'nothing escaped');
});

test('escape 1: a stage 1 mid-burn failure is escaped and stage 2 flies on', () => {
  const base = resolveLaunch(fixture([FLAKY_STAGE_1]), MISSION_100KM, FULL,
    scriptedRng(STAGE_1_MID_BURN_FAILURE));
  const o = resolveLaunch(fixture([FLAKY_STAGE_1, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng(STAGE_1_MID_BURN_FAILURE));

  // The outcome names the escaped failure, since nothing terminal followed.
  assert.equal(o.failure.kind, 'burn');
  assert.equal(o.failure.stage, 1);
  assert.equal(o.failure.escaped, true);
  assert.ok(o.failure.t > 0);
  assert.equal(o.escapes, 1);

  // Timeline: failure (escaped), abort separation naming the FAILED stage at
  // the same instant, then stage 2 lights exactly ESCAPE_DELAY later.
  const fail = o.timeline.find((e) => e.kind === 'failure');
  assert.equal(fail.escaped, true);
  assert.equal(fail.stage, 1);
  assert.equal(fail.text, `Stage 1 engine failure at T+${Math.round(fail.t)}s.`);
  const sep = o.timeline.find((e) => e.kind === 'separation');
  assert.equal(sep.abort, true);
  assert.equal(sep.stage, 1);
  assert.equal(sep.t, fail.t);
  assert.equal(sep.text, 'Abort: stage 2 separates from stage 1.');
  const relight = o.timeline.find((e) => e.kind === 'ignition' && e.stage === 2);
  assert.equal(relight.text, 'Stage 2 ignition.');
  assert.ok(Math.abs(relight.t - (fail.t + ESCAPE_DELAY)) < 1e-6,
    `stage 2 lit at ${relight.t}, expected ${fail.t + ESCAPE_DELAY}`);
  assert.ok(o.timeline.indexOf(fail) < o.timeline.indexOf(sep));
  assert.ok(o.timeline.indexOf(sep) < o.timeline.indexOf(relight));
  // Stage 2 then burns out normally: the abort did not end powered flight.
  assert.ok(o.timeline.some((e) => e.kind === 'burnout' && e.stage === 2));
  assert.ok(o.timeline.some((e) => e.kind === 'apogee'));
  assert.equal(o.timeline.at(-1).kind, 'end');

  // Samples after the relight carry stage 2.
  const after = o.samples.filter((s) => s.t >= relight.t);
  assert.ok(after.length > 0);
  assert.ok(after.every((s) => s.stage === 2));
  assert.ok(o.samples.filter((s) => s.t < fail.t).every((s) => s.stage === 1));

  // Flying on is worth something.
  assert.ok(o.maxAltitude > base.maxAltitude, `${o.maxAltitude} vs ${base.maxAltitude}`);
  assert.ok(o.deltaVAchieved > base.deltaVAchieved);
  assert.ok(o.deltaVAchieved < stageDeltaV(fixture(), 0, 1) + stageDeltaV(fixture(), 1, 1),
    'half a first stage plus a whole second stage is less than both stages');

  assert.match(o.readout, /; stage 2 escaped clear\.$/);
  assert.match(o.readout, /^Reached \d+ km\./);
  assert.ok(o.readout.includes(`Stage 1 engine failure at T+${Math.round(fail.t)}s; stage 2 escaped clear.`));
  assert.equal(o.timeline.at(-1).text, o.readout);
});

test('escape 1: a failure of the final stage is not escaped', () => {
  const base = resolveLaunch(fixture([FLAKY_STAGE_2]), MISSION_100KM, FULL,
    scriptedRng(STAGE_2_MID_BURN_FAILURE));
  const o = resolveLaunch(fixture([FLAKY_STAGE_2, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng(STAGE_2_MID_BURN_FAILURE));

  assert.equal(base.failure.stage, 2, 'the script must reach stage 2');
  assert.equal(base.failure.kind, 'burn');
  assert.equal(o.escapes, 0);
  assert.ok(!('escaped' in o.failure));
  assert.deepEqual(o, base);
});

test('a pad ignition failure at T+0 is never escaped', () => {
  const o = resolveLaunch(fixture([FLAKY_STAGE_1, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng([0.9]));
  assert.deepEqual(o.failure, { t: 0, stage: 1, kind: 'ignition' });
  assert.equal(o.escapes, 0);
  assert.equal(o.maxAltitude, 0);
  assert.equal(o.readout, 'Stage 1 ignition failure at T+0s.');
  assert.ok(!o.timeline.some((e) => e.kind === 'separation'));
});

test('coverage counts from the bottom: a stage 2 failure needs escape 2', () => {
  const third = { addStage: { dryMass: 50, propMass: 40, thrust: 3000, isp: 300, reliability: 1 } };
  const covered1 = resolveLaunch(fixture([third, FLAKY_STAGE_2, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng(STAGE_2_MID_BURN_FAILURE));
  const covered2 = resolveLaunch(fixture([third, FLAKY_STAGE_2, ESCAPE(2)]), MISSION_100KM, FULL,
    scriptedRng(STAGE_2_MID_BURN_FAILURE));
  assert.equal(fixture([third]).stages.length, 3);

  // escape 1 covers the booster only: stage 2 is terminal, stage 3 never lights.
  assert.deepEqual(Object.keys(covered1.failure).sort(), ['kind', 'stage', 't']);
  assert.equal(covered1.failure.stage, 2);
  assert.equal(covered1.failure.kind, 'burn');
  assert.equal(covered1.escapes, 0);
  assert.ok(!covered1.timeline.some((e) => e.kind === 'ignition' && e.stage === 3));

  // escape 2 covers it: stage 3 separates and lights.
  assert.equal(covered2.failure.stage, 2);
  assert.equal(covered2.failure.escaped, true);
  assert.equal(covered2.escapes, 1);
  const sep = covered2.timeline.find((e) => e.kind === 'separation' && e.abort);
  assert.equal(sep.stage, 2);
  assert.equal(sep.text, 'Abort: stage 3 separates from stage 2.');
  const relight = covered2.timeline.find((e) => e.kind === 'ignition' && e.stage === 3);
  assert.equal(relight.text, 'Stage 3 ignition.');
  assert.ok(Math.abs(relight.t - (sep.t + ESCAPE_DELAY)) < 1e-6);
  assert.ok(covered2.timeline.some((e) => e.kind === 'burnout' && e.stage === 3));
  assert.ok(covered2.maxAltitude > covered1.maxAltitude);
  assert.match(covered2.readout, /Stage 2 engine failure at T\+\d+s; stage 3 escaped clear\.$/);
});

test('an escape followed by a terminal failure names the terminal one', () => {
  // Stage 1 fails mid-burn and is escaped; stage 2's ignition roll (0.9 against
  // 0.5) then fails, and with nothing above it that ends the flight. Draws:
  // stage 1 ignition, performance, burn-roll fraction, burn roll; stage 2
  // ignition (an ignition failure still costs exactly one draw).
  const o = resolveLaunch(fixture([FLAKY_STAGE_1, FLAKY_STAGE_2, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng([0.1, 0.1, 0.5, 0.9, 0.9]));

  assert.deepEqual(Object.keys(o.failure).sort(), ['kind', 'stage', 't']);
  assert.equal(o.failure.kind, 'ignition');
  assert.equal(o.failure.stage, 2);
  assert.equal(o.escapes, 1);
  assert.equal(o.success, false);

  const escapedFail = o.timeline.find((e) => e.kind === 'failure' && e.escaped);
  assert.equal(escapedFail.stage, 1);
  assert.ok(Math.abs(o.failure.t - (escapedFail.t + ESCAPE_DELAY)) < 1e-6);
  const failures = o.timeline.filter((e) => e.kind === 'failure');
  assert.equal(failures.length, 2);
  assert.ok(!failures[1].escaped);

  assert.match(o.readout, /^Stage 2 ignition failure at T\+\d+s\. /);
  assert.ok(o.readout.includes('stage 2 escaped clear'));
  assert.equal(o.readout,
    `Stage 2 ignition failure at T+${Math.round(o.failure.t)}s. `
    + `Stage 1 engine failure at T+${Math.round(escapedFail.t)}s; stage 2 escaped clear.`);
});

test('an abort system changes nothing on a flight with no failure', () => {
  const plain = resolveLaunch(fixture(), MISSION_100KM, FULL, makeRng(1));
  const covered = resolveLaunch(fixture([ESCAPE(2)]), MISSION_100KM, FULL, makeRng(1));
  assert.deepEqual(covered, plain);
  assert.equal(plain.escapes, 0);
  assert.equal(plain.failure, null);
});

test('escapes is present and 0 when the vehicle never leaves the pad', () => {
  const overloaded = fixture([{ stat: 'stages.0.propMass', op: 'set', value: 9000 }, ESCAPE(2)]);
  const o = resolveLaunch(overloaded, MISSION_100KM, FULL, makeRng(1));
  assert.equal(o.readout, 'Insufficient thrust to lift off.');
  assert.ok('escapes' in o);
  assert.equal(o.escapes, 0);
});

test('an escaped IGNITION failure drops the unlit stage with its full propellant load', () => {
  // Three stages, escape 2. Stage 1 flies clean (ignition, performance,
  // burn-roll fraction, burn roll); stage 2's ignition roll (0.9 against 0.5)
  // fails at separation and is escaped; stage 3 (reliability 1, unscripted
  // draws pass) lights ESCAPE_DELAY later and burns out normally.
  const third = { addStage: { dryMass: 50, propMass: 40, thrust: 3000, isp: 300, reliability: 1 } };
  const v = fixture([third, FLAKY_STAGE_2, ESCAPE(2)]);
  const o = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng([0.1, 0.1, 0.5, 0.1, 0.9]));

  const fail = o.timeline.find((e) => e.kind === 'failure');
  assert.equal(fail.kind, 'failure');
  assert.equal(fail.stage, 2);
  assert.equal(fail.escaped, true);
  assert.equal(o.failure.kind, 'ignition');
  assert.equal(o.escapes, 1);
  const relight = o.timeline.find((e) => e.kind === 'ignition' && e.stage === 3);
  assert.ok(Math.abs(relight.t - (fail.t + ESCAPE_DELAY)) < 1e-6);

  // The stage that never lit still had its whole load aboard, and it left with
  // it: the first sample after the abort weighs exactly the stack above stage 2.
  const after = o.samples.find((s) => s.t > fail.t);
  assert.ok(after, 'a sample follows the abort');
  assert.equal(after.stage, 3);
  assert.ok(Math.abs(after.mass - stackMassAbove(v, 1, 1)) < 1e-6,
    `${after.mass} vs ${stackMassAbove(v, 1, 1)}`);

  // Delta-v credited: the whole of stage 1 and the whole of stage 3, none of
  // stage 2 (it never burned).
  const expected = stageDeltaV(v, 0) + stageDeltaV(v, 2);
  assert.ok(Math.abs(o.deltaVAchieved - expected) < 1e-6, `${o.deltaVAchieved} vs ${expected}`);
  assert.match(o.readout, /Stage 2 ignition failure at T\+\d+s; stage 3 escaped clear\.$/);
});

test('an escape on a SUCCESSFUL flight reads as a success with the escape clause', () => {
  // Stage 1 lights, runs to spec, and fails at 90% of its burn (late enough
  // that stage 2 still carries the stack well past 20 km); the mission is the
  // tier 1 sounding rocket.
  const o = resolveLaunch(fixture([FLAKY_STAGE_1, ESCAPE(1)]), MISSION_20KM, FULL,
    scriptedRng([0.1, 0.1, 0.9, 0.9]));
  assert.equal(o.success, true);
  assert.equal(o.shortBy, 0);
  assert.equal(o.escapes, 1);
  assert.equal(o.failure.escaped, true);
  assert.match(o.readout, /^Reached \d+ km\. Stage 1 engine failure at T\+\d+s; stage 2 escaped clear\.$/);
});

test('an escape at fuelFraction 0.8 coasts at the partial-load stack mass and relights on time', () => {
  const v = fixture([FLAKY_STAGE_1, ESCAPE(1)]);
  const o = resolveLaunch(v, MISSION_100KM, { fuelFraction: 0.8 }, scriptedRng(STAGE_1_MID_BURN_FAILURE));

  const fail = o.timeline.find((e) => e.kind === 'failure');
  assert.equal(fail.escaped, true);
  const relight = o.timeline.find((e) => e.kind === 'ignition' && e.stage === 2);
  assert.ok(Math.abs(relight.t - (fail.t + ESCAPE_DELAY)) < 1e-6,
    `relit at ${relight.t}, expected ${fail.t + ESCAPE_DELAY}`);

  const after = o.samples.filter((s) => s.t > fail.t);
  assert.ok(after.length > 0);
  assert.ok(after.every((s) => s.stage === 2), 'every sample after the abort carries stage 2');
  // During the coast nothing burns, so the mass is the stack above stage 1 at
  // this load — stage 2's dry mass, 80% of its propellant, and the payload.
  const coast = after.filter((s) => s.t < relight.t);
  assert.ok(coast.length > 0, 'the coast is sampled');
  for (const s of coast) {
    assert.ok(Math.abs(s.mass - stackMassAbove(v, 0, 0.8)) < 1e-6,
      `coast mass ${s.mass} vs ${stackMassAbove(v, 0, 0.8)}`);
  }
});

test('pad guard: a burn failure below ESCAPE_MIN_ALT is terminal, the same failure later is escaped', () => {
  // The fixture's stage 1 climbs past 100 m about 4.5 s into a 47 s burn, so a
  // burn roll placed at fraction 0.001 resolves on the first step (T+0.1, a few
  // centimetres up) and one at 0.5 resolves at ~23 s, tens of km up.
  const early = resolveLaunch(fixture([FLAKY_STAGE_1, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng([0.1, 0.1, 0.001, 0.9]));
  assert.equal(early.failure.kind, 'burn');
  assert.equal(early.failure.stage, 1);
  assert.ok(!('escaped' in early.failure), 'a failure on the pad is not escaped');
  assert.equal(early.escapes, 0);
  assert.ok(early.maxAltitude < ESCAPE_MIN_ALT, `failed at ${early.maxAltitude} m`);
  assert.match(early.readout, /^Stage 1 engine failure at T\+\d+s\.$/);
  assert.ok(!early.timeline.some((e) => e.kind === 'separation'), 'the stack goes down together');
  assert.ok(!early.timeline.some((e) => e.kind === 'ignition' && e.stage === 2));

  const late = resolveLaunch(fixture([FLAKY_STAGE_1, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng([0.1, 0.1, 0.5, 0.9]));
  assert.equal(late.failure.escaped, true);
  assert.equal(late.escapes, 1);
  const fail = late.timeline.find((e) => e.kind === 'failure');
  assert.ok(fail.alt >= ESCAPE_MIN_ALT, `escaped at ${fail.alt} m`);
  assert.match(late.readout, /; stage 2 escaped clear\.$/);
});

test('an apogee inside the abort coast is reported when the relight fails, and an altitude flight ends there', () => {
  // A weak second stage (TWR well under 1: 1200 N against ~5.6 kN of weight)
  // that is already decelerating when it fails. Reliabilities: stage 1 is 1,
  // stages 2 and 3 are 0.5, so the script reads: stage 1 ignition 0.1 pass,
  // performance 0.1 pass, burn-roll fraction 0.5, burn roll 0.1 pass; stage 2
  // ignition 0.1 pass, performance 0.1 pass, burn-roll fraction 0.120 (early in
  // a ~490 s burn, about T+105 s), burn roll 0.9 FAIL — escaped, since escape
  // is 2; stage 3 ignition 0.9 FAIL — terminal, it is the top stage. The
  // altitude rate turns over during the 2 s coast, so without deferral no
  // 'apogee' event would ever fire and the flight would run to impact.
  const base = {
    stages: [
      { dryMass: 150, propMass: 380, thrust: 20000, isp: 250, reliability: 1 },
      { dryMass: 200, propMass: 200, thrust: 1200, isp: 300, reliability: 0.5 },
      { dryMass: 40, propMass: 30, thrust: 2000, isp: 300, reliability: 0.5 },
    ],
    payloadMass: 100,
    dragArea: 0.2,
    dragCoeff: 0.3,
  };
  const v = buildVehicle(base, [ESCAPE(2)]);
  const o = resolveLaunch(v, MISSION_100KM, FULL,
    scriptedRng([0.1, 0.1, 0.5, 0.1, 0.1, 0.1, 0.120, 0.9, 0.9]));

  const failures = o.timeline.filter((e) => e.kind === 'failure');
  assert.equal(failures.length, 2, 'the script must produce an escape then a terminal failure');
  assert.equal(failures[0].escaped, true);
  assert.equal(failures[0].stage, 2);
  assert.ok(!failures[1].escaped);
  assert.equal(failures[1].stage, 3);
  assert.equal(o.escapes, 1);
  assert.equal(o.failure.kind, 'ignition', 'the terminal failure is the top stage failing to light');
  assert.equal(o.failure.stage, 3);

  const apogee = o.timeline.find((e) => e.kind === 'apogee');
  assert.ok(apogee, 'an apogee event is emitted');
  // The turnover happened inside the coast: the apogee is reported at the
  // relight (which failed), not before it.
  assert.ok(apogee.t >= failures[1].t - 1e-6, `apogee at ${apogee.t}, relight at ${failures[1].t}`);
  assert.ok(apogee.t < failures[1].t + 1, 'and within a step of it');
  assert.ok(Math.abs(apogee.alt - o.maxAltitude) < 1e-6);
  assert.ok(!o.timeline.some((e) => e.kind === 'impact'), 'an altitude flight does not run to impact');
  assert.ok(Math.abs(o.samples.at(-1).t - apogee.t) < 0.1 + 1e-6,
    `flight ends at apogee: last sample ${o.samples.at(-1).t}, apogee ${apogee.t}`);
  assert.equal(o.timeline.at(-1).kind, 'end');
  assert.match(o.readout, /^Stage 3 ignition failure at T\+\d+s\. Stage 2 engine failure at T\+\d+s; stage 3 escaped clear\.$/);
});

test('an orbital restart failure replaces an escaped ascent failure in outcome.failure', () => {
  // The strong fixture on a rendezvous, with 2 restarts. Stage 1 fails at 99%
  // of its burn (0.9 against 0.5) and is escaped; stage 2 lights, passes its
  // burn roll, and cuts off at the target's periapsis with propellant in
  // reserve; the orbital phase's first restart roll (0.9 against stage 2's
  // 0.5) fails. The ascent is decided by physics, so this is deterministic.
  //
  // Draws, in order: stage 1 ignition, performance, burn-roll fraction; the
  // guidance roll (the strong fixture is guided and declares no
  // guidanceReliability, so it never fails, but it is drawn); stage 1 burn
  // roll (fails, escaped); stage 2 ignition, performance, burn-roll fraction,
  // burn roll; then the orbital phase's first restart roll (fails, so no
  // performance roll follows it).
  const RESTARTS = { stat: 'restarts', op: 'set', value: 2 };
  const MISSION_RDV = { id: 'rdv-1', tier: 3, requirement: { rendezvous: { target: 'core', within: 5000 } } };
  const target = { periapsis: 100000, apoapsis: 100000, phase: 0 };
  const v = strongFixture([FLAKY_STAGE_1, FLAKY_STAGE_2, RESTARTS, ESCAPE(1)]);
  const rng = scriptedRng([0.1, 0.1, 0.99, 0.1, 0.9, 0.1, 0.1, 0.5, 0.1, 0.9]);
  const o = resolveLaunch(v, MISSION_RDV, { fuelFraction: 1, turn: 0.5, window: 0 }, rng, { target });

  assert.equal(rng.draws, 10, 'the script is consumed exactly: four ascent rolls per stage, one guidance roll, one restart');
  assert.equal(o.orbit, true);
  assert.ok(o.insertion, 'the ascent inserted despite the escape');
  assert.equal(o.escapes, 1);
  assert.equal(o.failure.kind, 'restart');
  assert.equal(o.failure.stage, 2);
  assert.ok(!('escaped' in o.failure), 'the terminal failure is the one named');
  assert.ok(o.failure.t > o.insertion.t);
  const escaped = o.timeline.find((e) => e.kind === 'failure' && e.escaped);
  assert.equal(escaped.stage, 1);
  assert.ok(o.timeline.some((e) => e.kind === 'restart-failure'));
  assert.equal(o.success, false);
  assert.match(o.readout, /^Stage 2 restart failure at T\+\d+s\. Stage 1 engine failure at T\+\d+s; stage 2 escaped clear\.$/);
});

// ---------------------------------------------------------------------------
// Anomalies: guidance failure, engine underperformance (ARCHITECTURE.md,
// "Anomalies"). Neither ends the flight; both put it off target.
// ---------------------------------------------------------------------------

test('every outcome carries an anomalies array, empty on a clean flight', () => {
  const o = resolveLaunch(fixture(), MISSION_100KM, FULL, makeRng(1));
  assert.deepEqual(o.anomalies, []);
  const grounded = resolveLaunch(
    fixture([{ stat: 'stages.0.propMass', op: 'set', value: 9000 }]), MISSION_100KM, FULL, makeRng(1),
  );
  assert.deepEqual(grounded.anomalies, []);
});

test('an unguided flight never rolls for guidance, whatever guidanceReliability says', () => {
  // Tier 1 must not move: no guidance, no guidance roll, no extra draw.
  const v = { ...fixture(), guidanceReliability: 0 };
  for (const seed of [0, 1, 7, 12345]) {
    const o = resolveLaunch(v, MISSION_100KM, FULL, makeRng(seed));
    assert.deepEqual(o.anomalies, []);
    assert.equal(o.failure, null);
  }
  // Nor does a sounding flight on a guided vehicle: `vertical` means there is
  // no program to drop off.
  const guided = { ...strongFixture(), guidanceReliability: 0 };
  const up = resolveLaunch(guided, MISSION_100KM, { fuelFraction: 1, turn: 0.5, vertical: true }, makeRng(1));
  assert.deepEqual(up.anomalies, []);
  assert.ok(up.samples.every((s) => s.x === 0));
});

test('a vehicle that does not declare guidanceReliability never fails guidance', () => {
  const v = strongFixture();
  assert.equal(v.guidanceReliability, undefined);
  for (const seed of [1, 77, 4242]) {
    const o = resolveLaunch(v, MISSION_ORBIT, { fuelFraction: 0.9, turn: 0.45 }, makeRng(seed));
    assert.deepEqual(o.anomalies, []);
  }
});

test('guidanceReliability 0 on a guided flight always drops off the program and drifts off target', () => {
  const load = { fuelFraction: 1, turn: 0.5 };
  const clean = resolveLaunch(strongFixture(), MISSION_ORBIT, load, makeRng(1));
  assert.equal(clean.success, true, 'the strong fixture orbits when nothing goes wrong');

  const v = { ...strongFixture(), guidanceReliability: 0 };
  let changed = 0;
  for (const seed of [0, 1, 2, 3, 5, 8, 13, 21]) {
    const o = resolveLaunch(v, MISSION_ORBIT, load, makeRng(seed));
    assert.equal(o.anomalies.length, 1, `seed ${seed}: exactly one guidance anomaly`);
    const [a] = o.anomalies;
    assert.equal(a.kind, 'guidance');
    assert.ok(a.t >= 0 && Number.isFinite(a.t));
    assert.ok(a.direction === 1 || a.direction === -1);
    assert.ok(a.stage >= 1);
    // Not a failure: the engines kept running, so the burns all completed.
    assert.equal(o.failure, null);
    assert.ok(o.timeline.filter((e) => e.kind === 'burnout').length === 2, 'both stages burnt out');
    // Announced on the timeline, and in the readout whatever the verdict.
    const ev = o.timeline.find((e) => e.kind === 'anomaly');
    assert.ok(ev, 'an anomaly event');
    assert.equal(ev.t, a.t);
    assert.match(ev.text, /^Guidance failure at T\+\d+s\.$/);
    assert.match(o.readout, /Guidance failure at T\+\d+s\.$/);
    // Off target: the orbit it ended in is not the clean flight's.
    if (Math.abs(o.periapsis - clean.periapsis) > 1000) changed += 1;
  }
  assert.ok(changed >= 6, `a guidance failure should move the orbit almost every time: ${changed}/8`);
});

test('a guidance failure drawn after the last burnout never happens', () => {
  // Scripted: stage 1 ignition ok, to spec, burn roll fraction; guidance roll
  // fails, moment at the very END of the nominal powered flight (fraction ~1),
  // direction; then stage 1's burn roll passes and stage 2's draws... but the
  // stage 2 ignition fails, so the powered flight ends early and the drawn
  // moment falls in the coast — where there is no program to drop off.
  const v = {
    ...strongFixture([{ stat: 'stages.1.reliability', op: 'set', value: 0.5 }]),
    guidanceReliability: 0.5,
  };
  const o = resolveLaunch(v, MISSION_ORBIT, { fuelFraction: 1, turn: 0.45 }, scriptedRng([
    0.1,      // stage 1 ignition: pass
    0.1,      // stage 1 performance: to spec
    0.5,      // stage 1 burn-roll fraction
    0.9,      // guidance roll: fail (>= 0.5)
    0.999999, // moment: end of the nominal powered flight
    0.2,      // direction: -1
    0.1,      // stage 1 burn roll: pass
    0.9999,   // stage 2 ignition: fail
  ]));
  assert.deepEqual(o.failure, { t: o.failure.t, stage: 2, kind: 'ignition' });
  assert.deepEqual(o.anomalies, []);
  assert.ok(!o.timeline.some((e) => e.kind === 'anomaly'));
});

test('a guidance moment inside the last step of powered flight is still announced', () => {
  // Codex finding on PR #6: the last burnout lands on the integrator boundary
  // BEFORE the guidance check runs, so a moment drawn inside that final step
  // used to be dropped as "after the burn". It is powered flight by the draw,
  // so it is reported — at the burn's end, where it can no longer steer.
  const v = { ...strongFixture(), guidanceReliability: 0.5 };
  const load = { fuelFraction: 1, turn: 0.45 };
  const o = resolveLaunch(v, MISSION_ORBIT, load, scriptedRng([
    0.1, 0.1, 0.5,    // stage 1: ignition, performance, burn-roll fraction
    0.9,              // guidance roll: fail
    0.999999,         // moment: the very end of the nominal powered flight
    0.8,              // direction: +1
    0.1,              // stage 1 burn roll
    0.1, 0.1, 0.5, 0.1, // stage 2: ignition, performance, fraction, burn roll
  ]));
  const lastBurnout = o.timeline.filter((e) => e.kind === 'burnout').at(-1);
  assert.equal(o.anomalies.length, 1);
  assert.equal(o.anomalies[0].kind, 'guidance');
  assert.ok(Math.abs(o.anomalies[0].t - lastBurnout.t) < 1e-6,
    `announced at the burn's end: ${o.anomalies[0].t} vs ${lastBurnout.t}`);
  assert.match(o.readout, /Guidance failure at T\+\d+s\.$/);
  // With no thrust left to steer, the flight itself is the clean one.
  const clean = resolveLaunch(strongFixture(), MISSION_ORBIT, load, makeRng(1));
  assert.deepEqual(o.samples, clean.samples);
  assert.equal(o.periapsis, clean.periapsis);
});

test('an engine that fails its performance roll runs the whole burn below spec', () => {
  // Draws: ignition (pass), performance (fail at reliability 0.5), deficit
  // (u = 0.5 -> 7.5%), burn-roll fraction, burn roll (pass, 0.1) — then the
  // second stage: ignition pass, performance pass, fraction, burn roll pass.
  const v = fixture([{ stat: 'stages.0.reliability', op: 'set', value: 0.5 }]);
  const o = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng([
    0.1, 0.9, 0.5, 0.5, 0.1,
    0.1, 0.1, 0.5, 0.1,
  ]));
  const clean = resolveLaunch(fixture(), MISSION_100KM, FULL, makeRng(1));

  assert.equal(o.failure, null, 'underperformance is not a failure');
  assert.equal(o.anomalies.length, 1);
  const [a] = o.anomalies;
  assert.equal(a.kind, 'underperform');
  assert.equal(a.stage, 1);
  assert.equal(a.t, 0, 'decided at ignition');
  assert.ok(Math.abs(a.factor - (1 - 0.075)) < 1e-9, `factor ${a.factor}`);
  assert.match(o.readout, /Stage 1 engine underperforming: 93% thrust\.$/);
  assert.ok(o.timeline.some((e) => e.kind === 'anomaly' && e.t === 0 && e.stage === 1));

  // Both stages still burnt out; the weak one just did less.
  assert.equal(o.timeline.filter((e) => e.kind === 'burnout').length, 2);
  const stage1Burnout = o.timeline.find((e) => e.kind === 'burnout');
  const cleanBurnout = clean.timeline.find((e) => e.kind === 'burnout');
  assert.ok(stage1Burnout.t > cleanBurnout.t, 'less thrust: a longer burn');
  // Isp × (1 - deficit/2): stage 1's delta-v is credited at the isp it ran at.
  const expected = stageDeltaV(v, 0, 1) * (1 - 0.075 / 2) + stageDeltaV(v, 1, 1);
  assert.ok(Math.abs(o.deltaVAchieved - expected) < 1e-6,
    `deltaVAchieved ${o.deltaVAchieved} vs ${expected}`);
  assert.ok(o.deltaVAchieved < clean.deltaVAchieved);
  assert.ok(o.maxAltitude < clean.maxAltitude, 'and it does not get as high');
});

test('the deficit spans ENGINE_DEFICIT_MIN..MAX and a reliability-1 stage never underperforms', () => {
  const v = fixture([{ stat: 'stages.0.reliability', op: 'set', value: 0.5 }]);
  const lo = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng([0.1, 0.9, 0, 0.5, 0.1, 0.1, 0.1, 0.5, 0.1]));
  const hi = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng([0.1, 0.9, 0.999999, 0.5, 0.1, 0.1, 0.1, 0.5, 0.1]));
  assert.ok(Math.abs(lo.anomalies[0].factor - (1 - ENGINE_DEFICIT_MIN)) < 1e-9);
  assert.ok(Math.abs(hi.anomalies[0].factor - (1 - ENGINE_DEFICIT_MAX)) < 1e-5);
  assert.ok(hi.maxAltitude < lo.maxAltitude);

  for (const seed of [0, 1, 2, 7, 12345]) {
    assert.deepEqual(resolveLaunch(fixture(), MISSION_100KM, FULL, makeRng(seed)).anomalies, []);
  }
});

test('an ignition failure still costs exactly one draw; a to-spec ignition costs three', () => {
  // Stage 1 fails to light on the first draw: nothing else is drawn.
  const dud = fixture([{ stat: 'stages.0.reliability', op: 'set', value: 0.5 }]);
  const rng = scriptedRng([0.9]);
  const o = resolveLaunch(dud, MISSION_100KM, FULL, rng);
  assert.deepEqual(o.failure, { t: 0, stage: 1, kind: 'ignition' });
  assert.equal(rng.draws, 1);

  // Clean single-stage flight: ignition, performance, burn-roll fraction, burn
  // roll — four draws, and no guidance draw on an unguided vehicle.
  const single = buildVehicle({ ...fixtureBase(), stages: [fixtureBase().stages[0]] });
  const counted = makeRng(1);
  resolveLaunch(single, MISSION_20KM, FULL, counted);
  assert.equal(counted.draws, 4);

  // Guided and clean: one more, the guidance roll, right after liftoff.
  const guided = { ...single, guidance: 1, guidanceReliability: 1 };
  const countedGuided = makeRng(1);
  resolveLaunch(guided, MISSION_20KM, { fuelFraction: 1, turn: 0.5 }, countedGuided);
  assert.equal(countedGuided.draws, 5);
});

test('a relight is an ignition: it can underperform, and then the burn costs more of the budget', () => {
  // The full tree flying a rendezvous at the core's template orbit, with the
  // window set to the target's own phase so the phasing step is free. That
  // leaves exactly two relights (the match pair) and an rcs approach, so the
  // orbital phase draws four times when everything passes: restart roll and
  // performance roll, twice. The probe run counts the flight's draws so the
  // script below can land on the first relight without hand-counting the
  // ascent's.
  const tree = loadTree(treeNodes);
  const vehicle = buildVehicle(baseVehicle, collectEffects(tree, { owned: treeNodes.map((n) => n.id) }));
  assert.ok((vehicle.rcs ?? 0) >= 1, 'the full tree has rcs, so the approach is not a relight');
  const core = missions.find((m) => m.id === 'core');
  const target = {
    id: 'core-1', name: 'Station core',
    periapsis: core.requirement.orbit.periapsis, apoapsis: core.requirement.orbit.periapsis,
    phase: phaseFor('core-1'),
  };
  const mission = missions.find((m) => m.requirement.rendezvous !== undefined);
  // turn 0.1 is inside the band the full tree reaches this orbit from.
  const load = { fuelFraction: 1, turn: 0.1, window: target.phase };
  const probeRng = (() => { let i = 0; return { next: () => { i += 1; return 0.1; }, int: () => 0, get draws() { return i; } }; })();
  const clean = resolveLaunch(vehicle, mission, load, probeRng, { target });
  assert.ok(clean.orbital, 'the probe flight reached orbit and ran the sequence');
  assert.ok(Math.abs(clean.orbital.phaseErrorDeg) <= PHASE_TOLERANCE_DEG, 'phasing is free');
  assert.deepEqual(clean.orbital.burns.map((b) => b.kind), ['match', 'match', 'approach']);
  assert.deepEqual(clean.anomalies, []);
  const cleanDv = clean.orbital.burns.reduce((sum, b) => sum + b.dv, 0);
  assert.ok(Math.abs(clean.orbital.dvUsed - cleanDv) < 1e-9, 'to spec, a burn costs what it delivers');
  const ascentDraws = probeRng.draws - 4;

  // Same flight; the first relight passes its restart roll and fails its
  // performance roll (the top stage's reliability is under 0.999), deficit
  // at u = 0.5 -> 7.5%; the second relight is to spec.
  const reliability = vehicle.stages.at(-1).reliability;
  assert.ok(reliability < 0.999 && reliability > 0.1);
  let i = 0;
  const script = [0.1, 0.999, 0.5, 0.1, 0.1];
  const scripted = { next: () => (i++ < ascentDraws ? 0.1 : (script.shift() ?? 0.1)), int: () => 0 };
  const o = resolveLaunch(vehicle, mission, load, scripted, { target });
  assert.deepEqual(o.samples, clean.samples, 'the ascent is the same flight');
  assert.equal(o.anomalies.length, 1);
  const [a] = o.anomalies;
  assert.equal(a.kind, 'underperform');
  assert.equal(a.stage, vehicle.stages.length);
  assert.equal(a.t, o.orbital.burns[0].t, 'decided at the relight');
  assert.ok(Math.abs(a.factor - 0.925) < 1e-9);
  assert.equal(o.failure, null);
  assert.deepEqual(o.orbital.burns.map((b) => b.dv), clean.orbital.burns.map((b) => b.dv),
    'the burns deliver what they were asked for');
  // ...but the first one cost dv / (1 - 0.075 / 2) of the budget.
  const expectedUsed = clean.orbital.burns[0].dv / (1 - 0.075 / 2)
    + clean.orbital.burns[1].dv + clean.orbital.burns[2].dv;
  assert.ok(Math.abs(o.orbital.dvUsed - expectedUsed) < 1e-6, `dvUsed ${o.orbital.dvUsed} vs ${expectedUsed}`);
  assert.ok(o.timeline.some((e) => e.kind === 'anomaly' && e.t === a.t));
  assert.match(o.readout, /Stage \d engine underperforming: 93% thrust\.$/);
});

// ---------------------------------------------------------------------------
// Aborts and anomalies together. An abort exists to throw the stack clear of a
// stage that has physically failed; an anomaly is not that (the engines are
// still running), so nothing here is escapable and the two features compose
// additively — in the outcome, in the timeline, and in the readout.
// ---------------------------------------------------------------------------

test('an underperforming stage can still fail and be escaped, and the readout carries both', () => {
  // Draws: stage 1 ignition 0.1 pass; performance 0.9 FAIL against 0.5, so it
  // underperforms; deficit u = 0.5 -> 7.5%, factor 0.925; burn-roll fraction
  // 0.5; burn roll 0.9 FAIL -> escaped, since escape is 1 and the stack is
  // tens of km up by then. Stage 2 (reliability 1) then flies on unscripted.
  const o = resolveLaunch(fixture([FLAKY_STAGE_1, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng([0.1, 0.9, 0.5, 0.5, 0.9]));

  assert.equal(o.escapes, 1);
  assert.equal(o.failure.kind, 'burn');
  assert.equal(o.failure.stage, 1);
  assert.equal(o.failure.escaped, true, 'underperforming does not make the failure terminal');
  assert.equal(o.anomalies.length, 1);
  assert.equal(o.anomalies[0].kind, 'underperform');
  assert.equal(o.anomalies[0].stage, 1);
  assert.ok(Math.abs(o.anomalies[0].factor - 0.925) < 1e-9);

  // The stage still separated and stage 2 still lit ESCAPE_DELAY later.
  const fail = o.timeline.find((e) => e.kind === 'failure');
  const sep = o.timeline.find((e) => e.kind === 'separation' && e.abort);
  const relight = o.timeline.find((e) => e.kind === 'ignition' && e.stage === 2);
  assert.equal(sep.t, fail.t);
  assert.ok(Math.abs(relight.t - (fail.t + ESCAPE_DELAY)) < 1e-6);
  assert.ok(o.timeline.some((e) => e.kind === 'burnout' && e.stage === 2));

  // Readout order: what ended or was survived first, then what merely went
  // wrong on the way — the escape clause, then the anomaly sentence.
  const clause = `Stage 1 engine failure at T+${Math.round(fail.t)}s; stage 2 escaped clear.`;
  const sentence = 'Stage 1 engine underperforming: 93% thrust.';
  assert.ok(o.readout.includes(clause), o.readout);
  assert.ok(o.readout.endsWith(sentence), o.readout);
  assert.ok(o.readout.indexOf(clause) < o.readout.indexOf(sentence));
});

test('a post-abort ignition is an ignition: the relit stage rolls for performance too', () => {
  // Draws: stage 1 ignition, performance (to spec), fraction, burn roll FAIL
  // -> escaped; then stage 2's relight at t + ESCAPE_DELAY: ignition 0.1 pass,
  // performance 0.9 FAIL against 0.5, deficit u = 0.5, fraction, burn roll pass.
  const o = resolveLaunch(fixture([FLAKY_STAGE_1, FLAKY_STAGE_2, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng([0.1, 0.1, 0.5, 0.9, 0.1, 0.9, 0.5, 0.5, 0.1]));

  assert.equal(o.escapes, 1);
  assert.equal(o.failure.escaped, true);
  const relight = o.timeline.find((e) => e.kind === 'ignition' && e.stage === 2);
  assert.equal(o.anomalies.length, 1);
  const [a] = o.anomalies;
  assert.equal(a.kind, 'underperform');
  assert.equal(a.stage, 2, 'the relit stage, not the one that failed');
  assert.ok(Math.abs(a.t - relight.t) < 1e-6, 'decided at the relight');
  assert.ok(Math.abs(a.factor - 0.925) < 1e-9);
  assert.ok(o.timeline.some((e) => e.kind === 'anomaly' && Math.abs(e.t - relight.t) < 1e-6));
  assert.ok(o.timeline.some((e) => e.kind === 'burnout' && e.stage === 2),
    'a weaker relight is still a burn that runs to burnout');

  // The relight burning below spec costs delta-v, so it does not get as far as
  // the same flight with a to-spec relight.
  const toSpec = resolveLaunch(fixture([FLAKY_STAGE_1, FLAKY_STAGE_2, ESCAPE(1)]), MISSION_100KM, FULL,
    scriptedRng([0.1, 0.1, 0.5, 0.9, 0.1, 0.1, 0.5, 0.1]));
  assert.deepEqual(toSpec.anomalies, []);
  assert.ok(o.deltaVAchieved < toSpec.deltaVAchieved);
  assert.ok(o.maxAltitude < toSpec.maxAltitude);
});

test('a guidance failure is never escaped: abort coverage changes nothing about it', () => {
  // Every stage is reliable, so nothing ever calls cutThrust — the only place
  // an abort is decided. A guidance failure leaves the engines healthy, and
  // dropping a working stage would not give the vehicle its program back.
  const load = { fuelFraction: 1, turn: 0.45 };
  const uncovered = { ...strongFixture(), guidanceReliability: 0 };
  const covered = { ...strongFixture([ESCAPE(2)]), guidanceReliability: 0 };
  for (const seed of [1, 2, 3, 5, 8]) {
    const bare = resolveLaunch(uncovered, MISSION_ORBIT, load, makeRng(seed));
    const o = resolveLaunch(covered, MISSION_ORBIT, load, makeRng(seed));
    assert.equal(o.anomalies.length, 1);
    assert.equal(o.anomalies[0].kind, 'guidance');
    assert.equal(o.escapes, 0, 'a guidance failure is not an escapable failure');
    assert.equal(o.failure, null, 'and it is not a failure at all');
    assert.ok(!o.timeline.some((e) => e.kind === 'separation' && e.abort));
    assert.ok(!o.timeline.some((e) => e.kind === 'failure'));
    // Bit for bit the same flight as the vehicle without an abort system.
    assert.deepEqual(o, bare);
  }
});

// ---------------------------------------------------------------------------
// Sample delta-v remaining (`sample.dv`) — what the ascent view's telemetry
// card shows live. It is the delta-v still ABOARD at that instant, which is
// neither `deltaVAchieved` (spent) nor `deltaVRequired` (the budget).
// ---------------------------------------------------------------------------

test('the first sample carries the whole vehicle delta-v, and it only falls', () => {
  const v = fixture();
  const { samples } = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1));
  const full = totalDeltaV(v, 1);
  // Stage 1 has just lit with a full load at its nominal isp (reliability 1,
  // so no underperformance), so the sum is exactly the brochure figure.
  assert.ok(Math.abs(samples[0].dv - full) < 1e-6, `${samples[0].dv} vs ${full}`);
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(samples[i].dv <= samples[i - 1].dv + 1e-9,
      `dv rose at sample ${i}: ${samples[i - 1].dv} -> ${samples[i].dv}`);
    assert.ok(samples[i].dv >= 0);
  }
  // The flight burns both stages to depletion, so it ends with nothing left.
  assert.ok(samples.at(-1).dv < 1e-6, `ended with ${samples.at(-1).dv} m/s aboard`);
});

test('a lighter fuel load is less delta-v aboard from the first sample on', () => {
  const v = fixture();
  const full = resolveLaunch(v, MISSION_100KM, FULL, makeRng(1)).samples[0].dv;
  const half = resolveLaunch(v, MISSION_100KM, { fuelFraction: 0.5 }, makeRng(1)).samples[0].dv;
  assert.ok(half < full, `${half} is not below ${full}`);
  assert.ok(Math.abs(half - totalDeltaV(v, 0.5)) < 1e-6);
});

test('a terminal failure leaves nothing to spend, whatever is in the tanks', () => {
  // Stage 1 fails mid-burn with no abort system: the upper stage is still
  // there, full, and is never going to light.
  const o = resolveLaunch(fixture([FLAKY_STAGE_1]), MISSION_100KM, FULL,
    scriptedRng(STAGE_1_MID_BURN_FAILURE));
  assert.ok(o.failure && !o.failure.escaped);
  const at = o.samples.filter((s) => s.t >= o.failure.t);
  assert.ok(at.length > 0);
  for (const s of at) assert.equal(s.dv, 0, `dv ${s.dv} at T+${s.t} after the failure`);
});

test('an escaped failure keeps the escaping stage delta-v, and drops the failed one', () => {
  const v = fixture([FLAKY_STAGE_1, ESCAPE(1)]);
  const o = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng(STAGE_1_MID_BURN_FAILURE));
  assert.equal(o.escapes, 1);
  const abort = o.timeline.find((e) => e.kind === 'separation' && e.abort);
  // Through the abort coast the stack still carries stage 2's full load: the
  // stage has not lit, so what it has is its ideal delta-v.
  const coasting = o.samples.find((s) => s.t > abort.t);
  const stage2 = stageDeltaV(v, 1, 1);
  assert.ok(Math.abs(coasting.dv - stage2) < 1e-6, `${coasting.dv} vs ${stage2}`);
  // And the failed stage's own delta-v went down with it.
  assert.ok(coasting.dv < o.samples[0].dv);
});

test('a vehicle that cannot lift off is short of thrust, not of delta-v', () => {
  const overloaded = fixture([{ stat: 'stages.0.propMass', op: 'set', value: 9000 }]);
  const o = resolveLaunch(overloaded, MISSION_100KM, FULL, makeRng(1));
  assert.equal(o.samples.length, 1);
  const full = totalDeltaV(overloaded, 1);
  assert.ok(Math.abs(o.samples[0].dv - full) < 1e-6, `${o.samples[0].dv} vs ${full}`);
  assert.ok(o.samples[0].dv > 0);
});

// ===========================================================================
// Phase 3 — tier 4, the moon.
//
// The moon is not a second attractor (ARCHITECTURE.md, phase 3): the ascent is
// the same integrator flying the same planet, and everything past insertion is
// an analytic ladder of burns priced by js/core/moon.js. So the tests below are
// about the two things this phase actually changes — what budget the ladder is
// spent out of, and what stops a vehicle climbing it.
//
// The fixture is the strong two-stage launcher, scaled up until its payload IS
// a lunar upper stack: a cryogenic departure stage and a small lander/ascent
// stage, plus the payload. Scaling preserves every mass ratio, so stages 1 and
// 2 fly exactly the ascent `strongFixture` flies, with the same TWR and the
// same good-turn window — the ascent is a solved problem here and the point is
// what happens after it. Only the top stage is unreliable, and it is the one
// stage that never lights during the ascent, so the lunar rolls can be scripted
// without touching the ascent's draw order at all.
// ===========================================================================

const MOON_SCALE = 15;
const moonBase = () => ({
  stages: [
    {
      dryMass: 16000 * MOON_SCALE,
      propMass: 160000 * MOON_SCALE,
      thrust: 2.9e6 * MOON_SCALE,
      isp: 290,
      reliability: 1,
    },
    {
      dryMass: 4500 * MOON_SCALE,
      propMass: 28000 * MOON_SCALE,
      thrust: 5.0e5 * MOON_SCALE,
      isp: 350,
      reliability: 1,
    },
    // Departure: high isp, low thrust, and never lit until the ascent is nearly
    // over — this is the stage the insertion cutoff catches mid-burn.
    { dryMass: 900, propMass: 9000, thrust: 1.2e5, isp: 450, reliability: 1 },
    // Lander/ascent: never lit on the ascent at all, so its reliability is the
    // lunar sequence's and nothing else's.
    { dryMass: 400, propMass: 1200, thrust: 2.0e4, isp: 320, reliability: 0.98 },
  ],
  payloadMass: 500,
  dragArea: 8 * Math.cbrt(MOON_SCALE * MOON_SCALE),
  dragCoeff: 0.3,
  guidance: 1,
  restarts: 5,
  lander: 1,
  shield: 1,
});
const moonFixture = (effects = []) => buildVehicle(moonBase(), effects);

/** Take `kg` of propellant out of the departure stage: a thinner margin. */
const LEAN = (kg) => ({ stat: 'stages.2.propMass', op: 'add', value: -kg });

const MOON_MISSION = (profile) => ({ id: `moon-${profile}`, tier: 4, requirement: { moon: { profile } } });
/** The turn the scaled fixture reaches its parking orbit on. */
const MOON_LOAD = { fuelFraction: 1, turn: 0.15 };

// ---------------------------------------------------------------------------
// The budget: dvAvailable becomes the remaining stack.
//
// The claim ARCHITECTURE.md makes is that this is a NO-OP for tiers 1 to 3, and
// it is a claim about arithmetic, so it is pinned as arithmetic: the old
// formula is reconstructed from the outcome itself and has to come back the
// same number. Everything after cutoff is frozen — no stage burns again — so
// any sample past it reads exactly the mass the cutoff saw, and the reserve
// propellant follows from the stack mass above.
// ---------------------------------------------------------------------------

/** The old, one-stage budget: Tsiolkovsky on what the cutting stage kept back. */
function cuttingStageReserveDeltaV(vehicle, outcome, fuelFraction = 1) {
  const last = outcome.samples.at(-1);
  const i = last.stage - 1;
  const above = stackMassAbove(vehicle, i, fuelFraction);
  const reserveMass = last.mass;
  const reserveProp = reserveMass - above - vehicle.stages[i].dryMass;
  return {
    index: i,
    dv: vehicle.stages[i].isp * G0 * Math.log(reserveMass / (reserveMass - reserveProp)),
  };
}

test('a vehicle that inserts on its last stage gets exactly the old one-stage budget', () => {
  // Tier 3, unchanged: two stages, so the stage that cuts off is the top one
  // and there is nothing above it to add. This is the no-op, stated as the
  // identity it has to be rather than as a number that might drift.
  const v = strongFixture([{ stat: 'restarts', op: 'set', value: 2 }]);
  const mission = { id: 'rdv-1', tier: 3, requirement: { rendezvous: { target: 'core', within: 5000 } } };
  const target = { periapsis: 100000, apoapsis: 100000, phase: 0 };
  const o = resolveLaunch(v, mission, { fuelFraction: 1, turn: 0.5, window: 0 }, makeRng(3), { target });

  assert.ok(o.orbital, 'the ascent inserted and the orbital phase ran');
  const old = cuttingStageReserveDeltaV(v, o);
  assert.equal(old.index, v.stages.length - 1, 'it cut off on its last stage');
  assert.ok(Math.abs(o.orbital.dvAvailable - old.dv) < 1e-9,
    `budget moved: ${o.orbital.dvAvailable} vs ${old.dv}`);
  // And it really is a reserve — part of one stage, not the whole of it.
  assert.ok(o.orbital.dvAvailable > 0);
  assert.ok(o.orbital.dvAvailable < stageDeltaV(v, v.stages.length - 1, 1));
});

test('dvAvailable adds every stage that had not lit when the ascent cut off', () => {
  // Tier 4, the case the change exists for. The cutoff catches the DEPARTURE
  // stage mid-burn, so the lander above it is still full — and a full stage is
  // exactly its brochure delta-v, which is the rule the sample stream's
  // "delta-v aboard" has always used.
  const v = moonFixture();
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, makeRng(7));

  assert.ok(o.lunar, 'the lunar phase ran');
  const old = cuttingStageReserveDeltaV(v, o);
  assert.equal(old.index, v.stages.length - 2, 'the cutting stage is not the top one');
  let unlit = 0;
  for (let j = old.index + 1; j < v.stages.length; j += 1) unlit += stageDeltaV(v, j, 1);
  assert.ok(unlit > 2000, 'there is a real stage up there');
  // 1e-6, not 1e-9: the reserve is reconstructed here by subtracting two stack
  // masses of a quarter of a million kg, and that cancellation is worth about
  // 3e-8 m/s of it. The resolver itself never does that subtraction.
  assert.ok(Math.abs(o.lunar.dvAvailable - (old.dv + unlit)) < 1e-6,
    `${o.lunar.dvAvailable} is not ${old.dv} + ${unlit}`);
  // No single stage carries what the return profile needs; the stack does.
  assert.ok(o.lunar.dvAvailable > 8000);
  assert.ok(o.lunar.dvAvailable > stageDeltaV(v, old.index, 1));
});

test('the sample stream and the lunar budget agree about what is still aboard', () => {
  // dvRemaining() and dvAvailable are the same arithmetic at the same instant,
  // and after an insertion cutoff nothing burns again, so the last sample of
  // the flight has to read the budget the sequence was handed. Before phase 3
  // the cutting stage was always the top one and `thrustDone` was enough to say
  // "nothing left above"; it is not any more.
  const v = moonFixture();
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, makeRng(7));
  assert.ok(Math.abs(o.samples.at(-1).dv - o.lunar.dvAvailable) < 1e-9,
    `sample says ${o.samples.at(-1).dv}, the sequence was given ${o.lunar.dvAvailable}`);
  assert.ok(o.samples.at(-1).dv > 0, 'a stack with a full stage aboard is not out of delta-v');
});

// ---------------------------------------------------------------------------
// The requirement shape, and the orbit a lunar flight parks in.
// ---------------------------------------------------------------------------

test('a lunar mission needs no target and parks in the lowest orbit that counts', () => {
  const v = moonFixture();
  // No opts.target: the moon is a constant, not an entry in state.objects, so
  // unlike a rendezvous this resolves without one and must not throw.
  const o = resolveLaunch(v, MOON_MISSION('orbit'), MOON_LOAD, makeRng(7));
  assert.ok(o.insertion, 'it inserted');
  assert.ok(o.insertion.periapsis >= ORBIT_MIN_ALT);
  // Every metre of altitude bought on the ascent is delta-v not spent on the
  // transfer, so the cutoff fires at ORBIT_MIN_ALT and not a target's orbit.
  assert.ok(o.insertion.periapsis < ORBIT_MIN_ALT + 10000,
    `parked at ${o.insertion.periapsis} m, which is not the lowest orbit it could`);
  assert.equal(o.orbital, null, 'a lunar flight has no orbital rendezvous phase');
  assert.equal(o.closestApproach, null);
  assert.equal(o.docked, false);
});

test('an unknown lunar profile is not a lunar mission at all', () => {
  // requirementKind only recognises a profile the ladder knows: an unknown one
  // has no steps to fly and no step to be judged on, so it falls through like
  // any other malformed requirement rather than resolving as a flight to
  // nowhere that reports success.
  const v = moonFixture();
  const o = resolveLaunch(v, MOON_MISSION('picnic'), MOON_LOAD, makeRng(7));
  assert.equal(o.lunar, null);
  assert.equal(requiredLunarStep('picnic'), -1);
});

test('requiredDeltaV prices a lunar mission as the parking orbit plus the profile', () => {
  const rPark = R_EARTH + ORBIT_MIN_ALT;
  const ascent = Math.sqrt(MU / rPark) * (1 + ORBIT_LOSS_ALLOWANCE);
  const ladder = lunarLadder(rPark, rPark);
  for (const profile of Object.keys(LUNAR_PROFILES)) {
    const expected = ascent + LUNAR_PROFILES[profile].reduce((s, step) => s + ladder[step], 0);
    assert.ok(Math.abs(requiredDeltaV(MOON_MISSION(profile)) - expected) < 1e-9, profile);
  }
  // The ladder is an escalation, and the goal is the dearest rung on it.
  const price = (p) => requiredDeltaV(MOON_MISSION(p));
  assert.ok(price('flyby') < price('orbit'));
  assert.ok(price('orbit') < price('land'));
  assert.ok(price('land') < price('return'));
  assert.ok(price('return') > 18000, `the goal costs ${price('return')} m/s all told`);
});

// ---------------------------------------------------------------------------
// The four profiles. They are strictly nested, so one vehicle flies all four
// and each is judged only on the step it is about.
// ---------------------------------------------------------------------------

test('the four profiles fly the nested ladders LUNAR_PROFILES names', () => {
  const v = moonFixture();
  for (const profile of ['flyby', 'orbit', 'land', 'return']) {
    const o = resolveLaunch(v, MOON_MISSION(profile), MOON_LOAD, makeRng(7));
    assert.equal(o.success, true, `${profile}: ${o.readout}`);
    assert.deepEqual(o.lunar.burns.map((b) => b.kind), LUNAR_PROFILES[profile], profile);
    assert.equal(o.lunar.reached, requiredLunarStep(profile), profile);
    assert.equal(o.lunar.stoppedAt, null, profile);
    assert.equal(o.lunar.shortBy, 0, profile);
    assert.equal(o.shortBy, 0, profile);
    assert.equal(o.lunar.profile, profile);
    // `landed` is the touchdown, not the profile: only the two that go down.
    assert.equal(o.lunar.landed, profile === 'land' || profile === 'return', profile);
  }
  // A flown profile says what it achieved, and the outcome takes the
  // sequence's line as its own.
  const line = (profile) => resolveLaunch(v, MOON_MISSION(profile), MOON_LOAD, makeRng(7)).readout;
  assert.equal(line('flyby'), 'Lunar flyby.');
  assert.equal(line('orbit'), 'In lunar orbit.');
  assert.equal(line('land'), 'Landed on the moon.');
  assert.equal(line('return'), 'Landed on the moon and returned.');
});

test('a deeper profile costs strictly more of the same budget', () => {
  const v = moonFixture();
  const used = {};
  let budget = null;
  for (const profile of ['flyby', 'orbit', 'land', 'return']) {
    const o = resolveLaunch(v, MOON_MISSION(profile), MOON_LOAD, makeRng(7));
    used[profile] = o.lunar.dvUsed;
    // The profile changes nothing about the ascent — there is no loadout
    // control for it — so it cannot change what the ascent left over. Every
    // rung is spent out of the same budget, which is what makes the ladder a
    // decision about hardware rather than about flying.
    if (budget === null) budget = o.lunar.dvAvailable;
    assert.equal(o.lunar.dvAvailable, budget, profile);
  }
  assert.ok(used.flyby < used.orbit && used.orbit < used.land && used.land < used.return);
  // The return profile is the one that needs the whole stack: about 8 km/s.
  assert.ok(used.return > 7500 && used.return < 8500, `return profile spent ${used.return}`);
  assert.ok(used.return < budget, 'and this vehicle can just afford it');
});

test('the burns are scheduled on the transfer, and a return flight takes days', () => {
  const v = moonFixture();
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, makeRng(7));
  const at = Object.fromEntries(o.lunar.burns.map((b) => [b.kind, b.t]));
  const ladder = lunarLadder(R_EARTH + o.insertion.periapsis, R_EARTH + o.insertion.apoapsis);

  // tli at the parking orbit's next PERIAPSIS passage after insertion — the
  // place the ladder prices the burn at — and loi one transfer later. It used
  // to be pinned at half an orbit after insertion, which is where the vehicle
  // is NOT: half an orbit from a cutoff partway up the ascent is nowhere in
  // particular, and half an orbit from periapsis is apoapsis, the most
  // expensive place there is to leave from.
  const period = elementsFrom(R_EARTH + o.insertion.periapsis, R_EARTH + o.insertion.apoapsis).period;
  const coast = at.tli - o.insertion.t;
  assert.ok(Math.abs(coast - (1 - o.insertion.phase) * period) < 1e-6, `coast ${coast}s`);
  assert.ok(coast > 0 && coast <= period + 1e-6, 'a coast, never an instant burn');
  assert.ok(Math.abs(at.loi - (at.tli + ladder.tof)) < 1e-6);
  // Descent a quarter of a lunar orbit after arrival; the ascent a surface
  // stay after the TOUCHDOWN the descent takes DESCENT_TIME to reach; the
  // return burn a quarter orbit after the ascent has finished.
  assert.ok(Math.abs(at.descent - (at.loi + LLO_PERIOD / 4)) < 1e-6);
  assert.equal(at.ascent - at.descent, DESCENT_TIME + SURFACE_STAY);
  assert.ok(Math.abs(at.tei - (at.ascent + ASCENT_TIME + LLO_PERIOD / 4)) < 1e-6);

  // And the touchdown is announced where it happens, which is not where the
  // burn that starts the descent is: twelve minutes of falling separate them,
  // and that gap is the whole of what the map has to fly the vehicle down in.
  const touchdown = o.timeline.find((e) => e.kind === 'landing');
  assert.ok(touchdown, 'a return flight lands');
  assert.equal(touchdown.t, at.descent + DESCENT_TIME);

  // AND IT COMES HOME. The coast back is free — the atmosphere does the
  // braking and entry is not a step — but free is not the same as eventless:
  // the burn for home is 380 000 km from home, and a timeline that ended there
  // ended with the vehicle at the moon on the flight the contract pays for
  // returning from. So the return leg carries the two moments it is made of,
  // out of the same schedule and the same time of flight the way out used.
  const entry = o.timeline.find((e) => e.kind === 'entry');
  const home = o.timeline.find((e) => e.kind === 'recovery');
  assert.ok(entry && home, 'a return flight reaches the atmosphere and the ground');
  assert.ok(Math.abs(entry.t - (at.tei + RETURN_TOF)) < 1e-6, 'entry one transfer after the burn');
  assert.equal(home.t - entry.t, ENTRY_TIME);
  // AIMED AT THE ATMOSPHERE. The leg home is not the outbound ellipse handed
  // back: a trans-earth injection targets an entry corridor, so the conic the
  // map is given for it has its periapsis at the interface, and RETURN_TOF is
  // that conic's own half-period. Otherwise the coast is drawn down to the
  // parking orbit's periapsis, 40 km under the altitude the entry view opens
  // at, and the interface is announced a minute and a half late.
  const teiBurn = o.lunar.burns.find((b) => b.kind === 'tei');
  const tliBurn = o.lunar.burns.find((b) => b.kind === 'tli');
  assert.equal(teiBurn.elements.periapsis, ENTRY_ALT);
  assert.equal(tliBurn.elements.periapsis, o.insertion.periapsis);

  // The whole thing is a week and a half of simulated seconds — five days out,
  // a day on the surface, five days back — and the timeline is still sorted and
  // still ends on the 'end' event, now at the moment the vehicle is down.
  const days = o.timeline.at(-1).t / 86400;
  assert.ok(days > 10 && days < 12, `a return flight took ${days} days`);
  assert.equal(o.timeline.at(-1).t, home.t, 'the last thing that happens is the landing');
  assert.equal(o.timeline.at(-1).kind, 'end');
  for (let i = 1; i < o.timeline.length; i += 1) {
    assert.ok(o.timeline[i].t >= o.timeline[i - 1].t, 'the timeline is sorted');
  }
});

test('a flyby flies to the moon: the pass is the last event, not the injection', () => {
  // THE PICTURE THE MISSION PAID FOR. `flyby` is the one profile whose ladder
  // ends with a burn made at the PLANET — it rounds the moon on the transfer
  // the injection bought and makes no burn there — so its timeline used to end
  // in the parking orbit, five days and 380 000 km short of the moon, and the
  // map (which plays the timeline and stops at its last event) stopped there
  // with it. The arrival is an event for exactly that reason.
  const v = moonFixture();
  const o = resolveLaunch(v, MOON_MISSION('flyby'), MOON_LOAD, makeRng(7));
  assert.equal(o.success, true, o.readout);

  const ladder = lunarLadder(R_EARTH + o.insertion.periapsis, R_EARTH + o.insertion.apoapsis);
  const tli = o.lunar.burns.find((b) => b.kind === 'tli');
  const pass = o.timeline.filter((e) => e.kind === 'flyby');
  assert.equal(pass.length, 1, 'one pass, at the moon');
  // Arrival is the transfer's own: the same instant the schedule calls `loi`
  // and the map places the moon at, so the craft is drawn AT it and not beside
  // it. Five days after the injection, and the flight ends on it.
  assert.ok(Math.abs(pass[0].t - (tli.t + ladder.tof)) < 1e-6, `pass at ${pass[0].t}`);
  const days = (pass[0].t - tli.t) / 86400;
  assert.ok(days > 4 && days < 6, `the coast took ${days} days`);
  assert.equal(o.timeline.at(-1).kind, 'end');
  assert.equal(o.timeline.at(-1).t, pass[0].t, 'the flight ends at the moon');
  assert.equal(o.timeline.at(-1).text, o.readout);
  for (let i = 1; i < o.timeline.length; i += 1) {
    assert.ok(o.timeline[i].t >= o.timeline[i - 1].t, 'the timeline is sorted');
  }

  // And it is an event, not a rung: nothing is spent on it, no restart is
  // used, and the profile is still judged on the injection alone.
  assert.deepEqual(o.lunar.burns.map((b) => b.kind), ['tli']);
  assert.equal(o.lunar.reached, LUNAR_STEPS.indexOf('tli'));
  assert.ok(Math.abs(o.lunar.dvUsed - ladder.tli) < 1e-6, `spent ${o.lunar.dvUsed}`);

  // A flight that never made the injection never made the pass either: there
  // is nothing to coast on, and an event drawn anyway would fly a vehicle that
  // is still in its parking orbit to the moon.
  const stranded = resolveLaunch(
    moonFixture([{ stat: 'restarts', op: 'set', value: 0 }]),
    MOON_MISSION('flyby'), MOON_LOAD, makeRng(7),
  );
  assert.equal(stranded.success, false);
  assert.equal(stranded.lunar.reached, -1);
  assert.ok(!stranded.timeline.some((e) => e.kind === 'flyby'));
});

test('the TLI happens at the periapsis it is priced at, and is charged for it', () => {
  // THE REGRESSION GUARD. The ladder prices TLI as a burn made at the parking
  // orbit's periapsis (the Oberth-efficient place, and hundreds of m/s cheaper
  // than anywhere else on an eccentric orbit). The schedule used to put it at
  // insertion + P/2, which is a different place entirely — so the mission was
  // charged one burn and flew another, and the difference was 983 m/s of
  // delta-v the vehicle did not have. Pinning the TIME alone cannot catch that
  // coming back; pinning the RADIUS the vehicle is at when it burns can, and
  // pinning the delta-v that radius implies closes it.
  const v = moonFixture();
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, makeRng(7));
  const rp = R_EARTH + o.insertion.periapsis;
  const ra = R_EARTH + o.insertion.apoapsis;
  const park = elementsFrom(rp, ra);
  // The ascent really does leave an eccentric orbit, or none of this bites.
  assert.ok(park.e > 0.05, `parking orbit is too circular to test with: e ${park.e}`);
  // And it really does cut off away from periapsis, which is the fact the old
  // schedule could not see: the vehicle is a few hundred km up and climbing.
  assert.ok(o.insertion.phase > 0.01 && o.insertion.phase < 0.5,
    `insertion phase ${o.insertion.phase} — cutoff is on the way up, not at an apsis`);

  const tli = o.lunar.burns.find((b) => b.kind === 'tli');
  const where = positionAt(rp, ra, 0, o.insertion.phase, tli.t - o.insertion.t);
  assert.ok(Math.abs(where.r - rp) < 1,
    `TLI at r ${where.r} m; the ladder priced it at periapsis, r ${rp} m`);

  // The same thing said in m/s: the burn the resolver charged is the burn a
  // departure from where the vehicle actually is would cost.
  const costHere = Math.abs(
    velocityAt(elementsFrom(where.r, A_MOON).a, where.r) - velocityAt(park.a, where.r),
  );
  assert.ok(Math.abs(tli.dv - costHere) < 1, `charged ${tli.dv} m/s, burn costs ${costHere} m/s`);
  // What it would have cost half an orbit later, at apoapsis — the old
  // schedule's departure point, and why this is a P1 and not a cosmetic one.
  const costAtApoapsis = Math.abs(
    velocityAt(elementsFrom(ra, A_MOON).a, ra) - velocityAt(park.a, ra),
  );
  assert.ok(costAtApoapsis - tli.dv > 300,
    `departing at apoapsis would cost ${costAtApoapsis - tli.dv} m/s more, which was going unpaid`);
});

// ---------------------------------------------------------------------------
// The hardware gates. Both stop the sequence having drawn nothing and spent
// nothing, because a vehicle without the part does not attempt the step.
// ---------------------------------------------------------------------------

test('a vehicle with no lander cannot descend, and says which branch to buy', () => {
  const v = moonFixture([{ stat: 'lander', op: 'set', value: 0 }]);
  const o = resolveLaunch(v, MOON_MISSION('land'), MOON_LOAD, makeRng(7));
  assert.equal(o.success, false);
  assert.equal(o.lunar.stoppedAt, 'lander');
  assert.equal(o.lunar.reached, LUNAR_STEPS.indexOf('loi'), 'it is in lunar orbit, and stays there');
  assert.equal(o.lunar.landed, false);
  assert.equal(o.lunar.shortBy, 0, 'this is not a delta-v shortfall and must not read as one');
  assert.equal(o.shortBy, 0);
  assert.match(o.readout, /^No lander aboard/);
  // The same vehicle still flies the two profiles that never go down.
  for (const profile of ['flyby', 'orbit']) {
    assert.equal(resolveLaunch(v, MOON_MISSION(profile), MOON_LOAD, makeRng(7)).success, true, profile);
  }
});

test('a vehicle with no heat shield gets home no further than lunar orbit', () => {
  // ARCHITECTURE.md: the shield blocks the return leg. The gate sits in FRONT
  // of the trans-earth burn — a burn nobody survives the end of is not one to
  // fly, and `reached` has to stay under the return profile's step or the
  // flight would raise best.lunarStep to "landed and returned" for a crew still
  // in orbit round the moon.
  const v = moonFixture([{ stat: 'shield', op: 'set', value: 0 }]);
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, makeRng(7));
  assert.equal(o.success, false);
  assert.equal(o.lunar.stoppedAt, 'shield');
  assert.equal(o.lunar.landed, true, 'it landed; it just cannot come home');
  assert.equal(o.lunar.reached, LUNAR_STEPS.indexOf('ascent'));
  assert.ok(o.lunar.reached < requiredLunarStep('return'));
  assert.deepEqual(o.lunar.burns.map((b) => b.kind), ['tli', 'loi', 'descent', 'ascent']);
  assert.match(o.readout, /^No heat shield aboard/);
  // Landing without one is still landing: the shield is only about the return.
  assert.equal(resolveLaunch(v, MOON_MISSION('land'), MOON_LOAD, makeRng(7)).success, true);

  // And the flight does not end on the frame the ascent lights. The three
  // pre-burn stops at `tei` — no shield, no restart, not enough delta-v — all
  // break before the step pushes anything, so the ascent's own arrival at
  // `stepTime.orbited` is the last thing on the timeline. Without it the map,
  // which plays the timeline and stops at its last event, held the vehicle on
  // the surface at the start of a climb this outcome says it completed.
  const at = Object.fromEntries(o.lunar.burns.map((b) => [b.kind, b.t]));
  const last = o.timeline.at(-1);
  assert.equal(last.kind, 'end');
  assert.equal(last.t, at.ascent + ASCENT_TIME, 'the timeline runs to the top of the climb');
  assert.ok(
    o.timeline.some((e) => e.kind === 'lunar-orbit' && e.t === at.ascent + ASCENT_TIME),
    'the ascent arrives somewhere',
  );
});

// ---------------------------------------------------------------------------
// Restarts. Five is what the deepest profile needs, which is what puts the
// propulsion branch back in the shop for a tier.
// ---------------------------------------------------------------------------

test('every lunar burn is a relight, so the profile needs one restart per step', () => {
  for (const profile of ['flyby', 'orbit', 'land', 'return']) {
    const need = LUNAR_PROFILES[profile].length;
    const enough = moonFixture([{ stat: 'restarts', op: 'set', value: need }]);
    const short = moonFixture([{ stat: 'restarts', op: 'set', value: need - 1 }]);
    assert.equal(resolveLaunch(enough, MOON_MISSION(profile), MOON_LOAD, makeRng(7)).success,
      true, `${profile} with ${need}`);

    const o = resolveLaunch(short, MOON_MISSION(profile), MOON_LOAD, makeRng(7));
    assert.equal(o.success, false, `${profile} with ${need - 1}`);
    assert.equal(o.lunar.stoppedAt, 'restarts');
    assert.equal(o.lunar.reached, need - 2, `${profile} stopped one step short`);
    assert.equal(o.lunar.shortBy, 0, 'a restarts stop is not a delta-v shortfall');
    assert.match(o.readout, /^No restart available for the .+ burn\.$/);
  }
  assert.equal(LUNAR_PROFILES.return.length, 5, 'five restarts is the deepest requirement');
});

// ---------------------------------------------------------------------------
// Shortfall. `shortBy` is this step's cost PLUS everything the profile still
// needs after it — which is what lets the result screen name the step.
// ---------------------------------------------------------------------------

test('a shortfall names the step it stopped before and prices the rest of the profile', () => {
  // 3.5 t of departure propellant short: it lands, and then cannot afford to
  // leave. What it is short of is the ascent AND the return burn behind it, not
  // the ascent alone — the difference is the whole point of threading restAfter.
  const v = moonFixture([LEAN(3500)]);
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, makeRng(7));
  assert.equal(o.success, false);
  assert.equal(o.lunar.stoppedAt, 'deltaV');
  assert.equal(o.lunar.reached, LUNAR_STEPS.indexOf('descent'));
  assert.equal(o.lunar.landed, true);

  const ladder = lunarLadder(R_EARTH + o.insertion.periapsis, R_EARTH + o.insertion.apoapsis);
  const left = o.lunar.dvAvailable - o.lunar.dvUsed;
  const expected = ladder.ascent + ladder.tei - left;
  assert.ok(Math.abs(o.lunar.shortBy - expected) < 1e-6,
    `shortBy ${o.lunar.shortBy} is not ascent + return - ${left}`);
  // Without the rest of the profile it would have read a tenth of that, and a
  // player would have bought a stage a tenth too small.
  assert.ok(o.lunar.shortBy > 10 * (ladder.ascent - left));
  assert.match(o.readout, /^Short by \d+ m\/s for the ascent burn\.$/);
  // The outcome takes the sequence's number unfloored, as tier 3 already does.
  assert.equal(o.shortBy, o.lunar.shortBy);
});

test('a return flight stopped at the last burn reads as short for the return burn', () => {
  // The readout ARCHITECTURE.md quotes, produced rather than written: this
  // fixture lands, gets back to lunar orbit, and is 640 m/s short of home.
  const v = moonFixture([LEAN(3000)]);
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, makeRng(7));
  assert.equal(o.lunar.stoppedAt, 'deltaV');
  assert.equal(o.lunar.reached, LUNAR_STEPS.indexOf('ascent'));
  assert.match(o.readout, /^Short by \d+ m\/s for the return burn\.$/);
  assert.ok(o.lunar.shortBy > 500 && o.lunar.shortBy < 800, `short by ${o.lunar.shortBy}`);
  // Nothing after the last step, so this one is the step's own price less what
  // is left — there is no rest of the profile to add.
  const ladder = lunarLadder(R_EARTH + o.insertion.periapsis, R_EARTH + o.insertion.apoapsis);
  const left = o.lunar.dvAvailable - o.lunar.dvUsed;
  assert.ok(Math.abs(o.lunar.shortBy - (ladder.tei - left)) < 1e-6);
  // The same vehicle flies the shallower profiles it can afford.
  assert.equal(resolveLaunch(v, MOON_MISSION('land'), MOON_LOAD, makeRng(7)).success, true);
});

// ---------------------------------------------------------------------------
// The landing roll: one draw, shaped exactly like the docking roll.
// ---------------------------------------------------------------------------

test('the landing roll decides the touchdown, and landerBonus raises the threshold', () => {
  // The scripts below are the lunar sequence's draws only; the ascent's are
  // counted off a probe run first, because the ascent's count is a property of
  // the fixture and not of this test.
  const v = moonFixture();
  const probe = (() => { let i = 0; return { next: () => { i += 1; return 0.1; }, int: () => 0, get draws() { return i; } }; })();
  const clean = resolveLaunch(v, MOON_MISSION('land'), MOON_LOAD, probe);
  assert.equal(clean.lunar.landed, true);
  // Three steps at two draws each (restart roll, performance roll — the top
  // stage's 0.98 passes at 0.1), then the landing roll.
  const ascentDraws = probe.draws - 7;

  const script = (values) => {
    let i = 0;
    const rest = [...values];
    return { next: () => (i++ < ascentDraws ? 0.1 : (rest.shift() ?? 0.1)), int: () => 0 };
  };
  // Six sequence draws pass, then the landing roll comes up at 0.95 — over the
  // bare 0.9 threshold, so the landing is aborted.
  const missed = resolveLaunch(v, MOON_MISSION('land'), MOON_LOAD,
    script([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.95]));
  assert.equal(missed.success, false);
  assert.equal(missed.lunar.landed, false);
  assert.equal(missed.lunar.stoppedAt, 'landing-failure');
  assert.equal(missed.lunar.reached, LUNAR_STEPS.indexOf('loi'),
    'the descent burn was made; the touchdown was not');
  assert.deepEqual(missed.lunar.burns.map((b) => b.kind), ['tli', 'loi', 'descent']);
  assert.equal(missed.lunar.shortBy, 0, 'a botched landing is not a delta-v shortfall');
  assert.equal(missed.readout, 'Landing aborted.');
  assert.ok(missed.timeline.some((e) => e.kind === 'landing-failure' && /lateral drift/.test(e.text)),
    'the flavour line is derived from the roll already drawn');

  // The same roll, with the rehearsal node bought: the threshold moves up past
  // it and the same flight lands.
  const better = moonFixture([{ stat: 'landerBonus', op: 'add', value: 0.06 }]);
  const saved = resolveLaunch(better, MOON_MISSION('land'), MOON_LOAD,
    script([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.95]));
  assert.equal(saved.lunar.landed, true);
  assert.equal(saved.success, true);

  // And it is capped, exactly as the docking roll is: no amount of bonus buys
  // a certainty.
  const absurd = moonFixture([{ stat: 'landerBonus', op: 'add', value: 5 }]);
  const capped = resolveLaunch(absurd, MOON_MISSION('land'), MOON_LOAD,
    script([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.995]));
  assert.equal(capped.lunar.landed, false, `capped at ${LANDING_RELIABILITY_MAX}`);
  assert.ok(LANDING_RELIABILITY_MAX < 1);
  assert.equal(LANDING_RELIABILITY, DOCK_RELIABILITY, 'the two rolls are the same shape');
});

// ---------------------------------------------------------------------------
// The relight coupling: a burn that underperforms charges the pool more than it
// delivers, and the bill arrives days later at a step the vehicle could have
// afforded. This is the same machinery the orbital sequence uses, and it has to
// keep working across a ladder five steps long.
// ---------------------------------------------------------------------------

test('an underperforming relight makes a later lunar step unaffordable', () => {
  // 3 t of departure propellant short leaves ~90 m/s of margin over the whole
  // return profile — enough to fly it to spec, and not enough to fly it with a
  // translunar injection that charged 6% more than it delivered.
  const v = moonFixture([LEAN(1200)]);
  const probe = (() => { let i = 0; return { next: () => { i += 1; return 0.1; }, int: () => 0, get draws() { return i; } }; })();
  const clean = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, probe);
  assert.equal(clean.success, true, `the clean flight makes it: ${clean.readout}`);
  assert.deepEqual(clean.anomalies, []);
  const margin = clean.lunar.dvAvailable - clean.lunar.dvUsed;
  assert.ok(margin > 0 && margin < 200, `margin to spec is ${margin} m/s`);
  // Five steps, two draws each (restart roll, performance roll), plus the
  // landing roll: eleven.
  const ascentDraws = probe.draws - 11;

  // The same flight, with the first relight passing its restart roll and
  // failing its performance roll (0.999 against the top stage's 0.98), deficit
  // drawn at u = 1 -> 12%. Every later relight is to spec.
  let i = 0;
  const rest = [0.1, 0.999, 1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  const scripted = { next: () => (i++ < ascentDraws ? 0.1 : (rest.shift() ?? 0.1)), int: () => 0 };
  const o = resolveLaunch(v, MOON_MISSION('return'), MOON_LOAD, scripted);

  assert.deepEqual(o.samples, clean.samples, 'the ascent is the same flight');
  assert.equal(o.anomalies.length, 1);
  const [a] = o.anomalies;
  assert.equal(a.kind, 'underperform');
  assert.equal(a.stage, v.stages.length, 'the sequence relights the top of the stack');
  assert.equal(a.t, o.lunar.burns[0].t, 'decided at the translunar injection');
  assert.ok(Math.abs(a.factor - 0.88) < 1e-9);

  // The burn delivered what it was asked for; it just cost more of the pool.
  assert.ok(Math.abs(o.lunar.burns[0].dv - clean.lunar.burns[0].dv) < 1e-9);
  const overcharge = clean.lunar.burns[0].dv * (1 / (1 - 0.12 / 2) - 1);
  assert.ok(overcharge > margin, `an overcharge of ${overcharge} has to break a ${margin} margin`);

  // ...and the bill arrives at the return burn, four days and four burns later.
  assert.equal(o.success, false);
  assert.equal(o.lunar.stoppedAt, 'deltaV');
  assert.equal(o.lunar.reached, LUNAR_STEPS.indexOf('ascent'));
  assert.match(o.readout, /^Short by \d+ m\/s for the return burn\. Stage \d engine underperforming: 88% thrust\.$/);
});

test('a restart failure in the lunar phase is the failure the outcome names', () => {
  const v = moonFixture();
  const probe = (() => { let i = 0; return { next: () => { i += 1; return 0.1; }, int: () => 0, get draws() { return i; } }; })();
  resolveLaunch(v, MOON_MISSION('flyby'), MOON_LOAD, probe);
  const ascentDraws = probe.draws - 2;   // one step: restart roll, performance roll

  // The translunar injection's restart roll fails (0.99 against 0.98). One
  // draw: a failed restart rolls for nothing else.
  let i = 0;
  const rest = [0.99];
  const rng = { next: () => (i++ < ascentDraws ? 0.1 : (rest.shift() ?? 0.1)), int: () => 0 };
  const o = resolveLaunch(v, MOON_MISSION('flyby'), MOON_LOAD, rng);
  assert.equal(o.success, false);
  assert.equal(o.lunar.stoppedAt, 'restart-failure');
  assert.equal(o.lunar.reached, -1, 'nothing was completed');
  assert.equal(o.failure.kind, 'restart');
  assert.equal(o.failure.stage, v.stages.length);
  assert.ok(o.failure.t > o.insertion.t);
  assert.deepEqual(o.lunar.burns, [
    { t: o.lunar.burns[0].t, kind: 'tli', dv: 0, ok: false, elements: o.lunar.burns[0].elements },
  ]);
  assert.equal(o.lunar.dvUsed, 0);
  assert.match(o.readout, /^Stage \d restart failure at T\+\d+s\.$/);
});

// ---------------------------------------------------------------------------
// A lunar flight that never gets to orbit is a tier 2 orbit miss, judged the
// way one always has been — there is no ladder to climb, so there is no lunar
// result at all.
// ---------------------------------------------------------------------------

test('a lunar flight that never reaches orbit reads as an orbit miss', () => {
  // The scaled fixture flown straight up: it lobs, it does not insert.
  const v = moonFixture();
  const o = resolveLaunch(v, MOON_MISSION('return'), { fuelFraction: 1, vertical: true }, makeRng(7));
  assert.equal(o.success, false);
  assert.equal(o.lunar, null, 'no insertion, no ladder');
  assert.equal(o.insertion, null);
  assert.ok(o.shortBy > 0, 'and it is short of an orbit, not short by nothing');
  assert.match(o.readout, /Short by \d+ m\/s\.$/);
});

test('tiers 1 and 2 never cut off, so nothing above changes them', () => {
  // The cutoff is scoped to missions with a phase after insertion. An altitude
  // or orbit mission burns to depletion exactly as it always has, whatever is
  // stacked on top of it.
  const v = moonFixture();
  const o = resolveLaunch(v, MISSION_ORBIT, { fuelFraction: 1, turn: 0.15 }, makeRng(7), { maxTime: 4000 });
  assert.equal(o.lunar, null);
  assert.ok(!o.timeline.some((e) => e.kind === 'burnout' && /cutoff/.test(e.text)),
    'no stage cut off: there was nothing to save propellant for');
  assert.equal(o.samples.at(-1).dv, 0, 'it burned everything it had');
});
