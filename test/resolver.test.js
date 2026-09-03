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
} from '../js/core/resolver.js';
import {
  elementsFrom,
  radiusOf,
  transferDeltaV,
  phasingDeltaV,
  phaseFor,
} from '../js/core/orbit.js';

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
