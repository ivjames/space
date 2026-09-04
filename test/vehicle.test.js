import test from 'node:test';
import assert from 'node:assert/strict';

import {
  G0,
  buildVehicle,
  stackMassAbove,
  stageDeltaV,
  totalDeltaV,
} from '../js/core/vehicle.js';

// Fixtures are defined inline on purpose: js/data/components.js is content and
// will change, these numbers are the contract.

/** Single stage, mass ratio exactly 10, Isp 300 s. */
const oneStage = () => ({
  stages: [{ dryMass: 1000, propMass: 9000, thrust: 200000, isp: 300, reliability: 0.95 }],
  payloadMass: 0,
  dragArea: 1,
  dragCoeff: 0.3,
});

const twoStage = () => ({
  stages: [
    { dryMass: 150, propMass: 380, thrust: 20000, isp: 250, reliability: 0.98 },
    { dryMass: 200, propMass: 105, thrust: 8000, isp: 300, reliability: 0.97 },
  ],
  payloadMass: 100,
  dragArea: 0.2,
  dragCoeff: 0.3,
});

test('Tsiolkovsky against a hand-computed case', () => {
  const v = buildVehicle(oneStage(), []);
  // m0 = 10000, mf = 1000, ratio 10.
  // dv = 300 * 9.80665 * ln(10) = 6774.193831 m/s
  assert.equal(G0, 9.80665);
  assert.ok(Math.abs(stageDeltaV(v, 0) - 6774.193831) < 1e-4);
  assert.ok(Math.abs(totalDeltaV(v) - 6774.193831) < 1e-4);
});

test('half the propellant is not half the delta-v', () => {
  const v = buildVehicle(oneStage(), []);
  // m0 = 5500, mf = 1000 -> dv = 300 * g0 * ln(5.5)
  const expected = 300 * G0 * Math.log(5.5);
  assert.ok(Math.abs(stageDeltaV(v, 0, 0.5) - expected) < 1e-9);
  assert.ok(stageDeltaV(v, 0, 0.5) > totalDeltaV(v) / 2);
});

test('stackMassAbove is every stage above plus payload', () => {
  const v = buildVehicle(twoStage(), []);
  // Above stage 0: stage 1 (200 + 105) + payload 100 = 405.
  assert.equal(stackMassAbove(v, 0), 405);
  // Above the top stage: payload only.
  assert.equal(stackMassAbove(v, 1), 100);
  // A fuel fraction scales the propellant of the stages above too.
  assert.equal(stackMassAbove(v, 0, 0.5), 200 + 52.5 + 100);
});

test('a lower stage carries the stack above it', () => {
  const v = buildVehicle(twoStage(), []);
  const s = v.stages[0];
  const mf = 405 + s.dryMass;
  const expected = s.isp * G0 * Math.log((mf + s.propMass) / mf);
  assert.ok(Math.abs(stageDeltaV(v, 0) - expected) < 1e-9);
});

test('totalDeltaV sums the stages', () => {
  const v = buildVehicle(twoStage(), []);
  assert.ok(Math.abs(totalDeltaV(v) - (stageDeltaV(v, 0) + stageDeltaV(v, 1))) < 1e-9);
  assert.ok(totalDeltaV(v) > 2000 && totalDeltaV(v) < 2500);
});

test('stageDeltaV throws for a stage that is not there', () => {
  const v = buildVehicle(twoStage(), []);
  assert.throws(() => stageDeltaV(v, 2), /no stage 2/);
});

test('effects apply add, mul and set', () => {
  const v = buildVehicle(twoStage(), [
    { stat: 'stages.0.thrust', op: 'add', value: 5000 },
    { stat: 'stages.1.isp', op: 'mul', value: 1.1 },
    { stat: 'payloadMass', op: 'set', value: 250 },
    { stat: 'dragCoeff', op: 'mul', value: 0.5 },
  ]);
  assert.equal(v.stages[0].thrust, 25000);
  assert.ok(Math.abs(v.stages[1].isp - 330) < 1e-9);
  assert.equal(v.payloadMass, 250);
  assert.ok(Math.abs(v.dragCoeff - 0.15) < 1e-9);
});

test('effects apply in order', () => {
  const addThenMul = buildVehicle(twoStage(), [
    { stat: 'stages.0.thrust', op: 'add', value: 10000 },
    { stat: 'stages.0.thrust', op: 'mul', value: 2 },
  ]);
  const mulThenAdd = buildVehicle(twoStage(), [
    { stat: 'stages.0.thrust', op: 'mul', value: 2 },
    { stat: 'stages.0.thrust', op: 'add', value: 10000 },
  ]);
  assert.equal(addThenMul.stages[0].thrust, 60000);
  assert.equal(mulThenAdd.stages[0].thrust, 50000);
});

test('addStage appends a stage on top, and later effects can target it', () => {
  const upper = { dryMass: 80, propMass: 300, thrust: 4000, isp: 320, reliability: 0.9 };
  const v = buildVehicle(twoStage(), [
    { addStage: upper },
    { stat: 'stages.2.propMass', op: 'add', value: 100 },
  ]);
  assert.equal(v.stages.length, 3);
  assert.equal(v.stages[2].isp, 320);
  assert.equal(v.stages[2].propMass, 400);
  // Appending on top increases what the bottom stage has to lift.
  assert.equal(stackMassAbove(v, 0), 405 + 80 + 400);
  assert.ok(stageDeltaV(v, 0) < stageDeltaV(buildVehicle(twoStage(), []), 0));
});

test('addStage rejects an incomplete stage', () => {
  assert.throws(
    () => buildVehicle(twoStage(), [{ addStage: { dryMass: 10, propMass: 20 } }]),
    /numeric 'thrust'/,
  );
});

test('an unknown stat path throws', () => {
  const base = twoStage();
  assert.throws(() => buildVehicle(base, [{ stat: 'stages.9.thrust', op: 'add', value: 1 }]), /unknown stat path/);
  assert.throws(() => buildVehicle(base, [{ stat: 'stages.0.thrist', op: 'add', value: 1 }]), /unknown stat path/);
  assert.throws(() => buildVehicle(base, [{ stat: 'nope', op: 'set', value: 1 }]), /unknown stat path/);
  assert.throws(() => buildVehicle(base, [{ stat: 'stages', op: 'set', value: 1 }]), /unknown stat path/);
  assert.throws(() => buildVehicle(base, [{ stat: '', op: 'set', value: 1 }]), /invalid stat path/);
});

test('an unknown op throws', () => {
  assert.throws(
    () => buildVehicle(twoStage(), [{ stat: 'payloadMass', op: 'increment', value: 1 }]),
    /unknown op 'increment'/,
  );
});

test('buildVehicle deep-copies: the base and the effects are untouched', () => {
  const base = twoStage();
  const snapshot = JSON.parse(JSON.stringify(base));
  const upper = { dryMass: 80, propMass: 300, thrust: 4000, isp: 320, reliability: 0.9 };
  const v = buildVehicle(base, [
    { stat: 'stages.0.thrust', op: 'mul', value: 3 },
    { addStage: upper },
  ]);
  assert.deepEqual(base, snapshot, 'base components must not be mutated');
  assert.equal(upper.propMass, 300, 'the effect payload must not be mutated');
  v.stages[2].propMass = 1;
  assert.equal(upper.propMass, 300, 'the built vehicle must not share structure with the effect');
});

// ---------------------------------------------------------------------------
// Phase 1: extra top-level stats (ARCHITECTURE.md — `vehicle.guidance`).
// ---------------------------------------------------------------------------

test('guidance defaults to 0 when the base does not mention it', () => {
  const v = buildVehicle(twoStage(), []);
  assert.equal(v.guidance, 0);
  // A phase 0 base is untouched by the default: nothing is added to it.
  assert.ok(!('guidance' in twoStage()));
});

test('an unknown top-level numeric stat comes through from the base', () => {
  // This is the whole point: adding `guidance: 0` to js/data/components.js is a
  // DATA change, with no edit to this module.
  const base = { ...twoStage(), guidance: 0, restarts: 2 };
  const v = buildVehicle(base, []);
  assert.equal(v.guidance, 0);
  assert.equal(v.restarts, 2);

  // The base's own value wins over the default.
  assert.equal(buildVehicle({ ...twoStage(), guidance: 3 }, []).guidance, 3);

  // Non-numeric extras are not stats and are dropped, not copied or thrown on.
  const tagged = buildVehicle({ ...twoStage(), name: 'Kestrel', broken: null }, []);
  assert.ok(!('name' in tagged));
  assert.ok(!('broken' in tagged));
});

test('set, add and mul all work on an extra top-level stat', () => {
  const base = { ...twoStage(), guidance: 0 };
  assert.equal(buildVehicle(base, [{ stat: 'guidance', op: 'set', value: 1 }]).guidance, 1);
  assert.equal(buildVehicle(base, [{ stat: 'guidance', op: 'add', value: 2 }]).guidance, 2);
  assert.equal(
    buildVehicle({ ...twoStage(), guidance: 2 }, [{ stat: 'guidance', op: 'mul', value: 3 }]).guidance,
    6,
  );
  // Effects still apply in order on an extra stat, like any other.
  assert.equal(
    buildVehicle(base, [
      { stat: 'guidance', op: 'set', value: 1 },
      { stat: 'guidance', op: 'add', value: 1 },
    ]).guidance,
    2,
  );
  // The tree can set guidance even on a base that never declared it, because
  // buildVehicle always seeds the default.
  assert.equal(buildVehicle(twoStage(), [{ stat: 'guidance', op: 'set', value: 1 }]).guidance, 1);
});

test('extra stats do not open the door to arbitrary stat paths', () => {
  const base = { ...twoStage(), guidance: 0 };
  assert.throws(
    () => buildVehicle(base, [{ stat: 'guidence', op: 'set', value: 1 }]),
    /unknown stat path/,
    'a typo is still a typo',
  );
  assert.throws(
    () => buildVehicle(base, [{ stat: 'guidance', op: 'set', value: 'yes' }]),
    /non-numeric value/,
  );
  assert.throws(
    () => buildVehicle(base, [{ stat: 'guidance', op: 'toggle', value: 1 }]),
    /unknown op 'toggle'/,
  );
});

// ---------------------------------------------------------------------------
// Phase 3: the lunar capability stats. They are seeded here for the same reason
// the phase 2 ones are — a tree node can only target a stat that already
// exists, so seeding them is what makes "the tree turns the lander on" a data
// change rather than an edit to this module.
// ---------------------------------------------------------------------------

test('lander, shield and landerBonus are seeded to 0 on every vehicle', () => {
  const v = buildVehicle(twoStage(), []);
  assert.equal(v.lander, 0);
  assert.equal(v.shield, 0);
  assert.equal(v.landerBonus, 0);
  // A phase 0 base is untouched by the defaults: nothing is added to it.
  assert.ok(!('lander' in twoStage()));
});

test('the tree can turn the lunar stats on against a base that never declared them', () => {
  // Exactly the effects ARCHITECTURE.md's tier 4 structure and reliability
  // branches are written as: two `set`s and an `add`.
  const v = buildVehicle(twoStage(), [
    { stat: 'lander', op: 'set', value: 1 },
    { stat: 'shield', op: 'set', value: 1 },
    { stat: 'landerBonus', op: 'add', value: 0.05 },
  ]);
  assert.equal(v.lander, 1);
  assert.equal(v.shield, 1);
  assert.ok(Math.abs(v.landerBonus - 0.05) < 1e-12);
  // And the base's own value still wins over the seeded default, as for every
  // other capability stat.
  assert.equal(buildVehicle({ ...twoStage(), lander: 1 }, []).lander, 1);
});
