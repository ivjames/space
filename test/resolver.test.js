import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRng } from '../js/core/rng.js';
import { G0, buildVehicle, stageDeltaV, totalDeltaV } from '../js/core/vehicle.js';
import { resolveLaunch, LOSS_ALLOWANCE, gravityAt, densityAt } from '../js/core/resolver.js';

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
  // Draws: ignition roll (pass), burn-roll fraction (halfway), burn roll (fail).
  const o = resolveLaunch(v, MISSION_100KM, FULL, scriptedRng([0.1, 0.5, 0.9]));

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
