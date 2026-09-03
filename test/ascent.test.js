import { test } from 'node:test';
import assert from 'node:assert/strict';
// Importing the renderer must not touch window/document at module load: the
// browser globals are only reached inside playOutcome.
import { stackGeometry } from '../js/ui/ascent.js';

// Starter booster, tier 1 second stage, tier 3 third stage (js/data/tree.js).
const threeStage = [
  { dryMass: 40, propMass: 30 },
  { dryMass: 15, propMass: 20 },
  { dryMass: 8, propMass: 60 },
];

test('stackGeometry: three stages -> three segments before any separation', () => {
  const g = stackGeometry(threeStage, 1);
  assert.equal(g.segments.length, 3);
  assert.equal(g.count, 3);
  assert.equal(g.bodyHeight, g.segments.reduce((s, x) => s + x.height, 0));
  assert.equal(g.height, g.bodyHeight + g.noseHeight);
  // A full three-stage stack lands in the 48-56 px band, nose included.
  assert.ok(g.height >= 48 && g.height <= 56, `height ${g.height}`);
});

test('stackGeometry: separations peel segments off the bottom', () => {
  const full = stackGeometry(threeStage, 1).segments;
  const afterOne = stackGeometry(threeStage, 2);
  const afterTwo = stackGeometry(threeStage, 3);
  assert.equal(afterOne.segments.length, 2);
  assert.equal(afterTwo.segments.length, 1);
  // What stays attached keeps the same dimensions it had in the full stack.
  assert.deepEqual(afterOne.segments, full.slice(1));
  assert.deepEqual(afterTwo.segments, full.slice(2));
  // The fins went with the booster.
  assert.equal(afterOne.segments[0].fins, false);
  assert.equal(afterTwo.segments[0].fins, false);
  // Out-of-range stage numbers clamp rather than empty the stack.
  assert.equal(stackGeometry(threeStage, 9).segments.length, 1);
  assert.equal(stackGeometry(threeStage, 0).segments.length, 3);
});

test('stackGeometry: only the bottom stage has fins, and it is the widest', () => {
  const { segments } = stackGeometry(threeStage, 1);
  assert.deepEqual(segments.map((s) => s.fins), [true, false, false]);
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].width < segments[i - 1].width, `stage ${i + 1} narrower than ${i}`);
    assert.ok(segments[i].width >= 5);
  }
  assert.ok(segments[0].width >= 10 && segments[0].width <= 11);
});

test('stackGeometry: segment height is monotone in stage mass', () => {
  const stages = [
    { dryMass: 100, propMass: 100 },
    { dryMass: 20, propMass: 30 },
    { dryMass: 5, propMass: 5 },
  ];
  const { segments } = stackGeometry(stages, 1);
  assert.ok(segments[0].height > segments[1].height);
  assert.ok(segments[1].height > segments[2].height);
  // Sub-linear: doubling the mass adds well under double the height.
  const one = stackGeometry([{ dryMass: 50, propMass: 50 }], 1).segments[0].height;
  const two = stackGeometry([{ dryMass: 100, propMass: 100 }], 1).segments[0].height;
  assert.ok(two > one && two < 2 * one);
});

test('stackGeometry: a number means that many equal starter-sized stages', () => {
  const g = stackGeometry(3, 1);
  assert.equal(g.segments.length, 3);
  assert.equal(g.segments[0].height, g.segments[1].height);
  assert.equal(g.segments[1].height, g.segments[2].height);
  assert.equal(g.segments[0].height, stackGeometry([threeStage[0]], 1).segments[0].height);
  // A single starter stage is 22-26 px tall with its nose.
  const single = stackGeometry(1, 1);
  assert.equal(single.segments.length, 1);
  assert.ok(single.height >= 22 && single.height <= 26, `height ${single.height}`);
});

test('stackGeometry: minimum segment height holds for a tiny stage', () => {
  const g = stackGeometry([{ dryMass: 40, propMass: 30 }, { dryMass: 1, propMass: 0 }], 1);
  assert.equal(g.segments[1].height, 9);
  assert.ok(stackGeometry([{ dryMass: 0, propMass: 0 }], 1).segments[0].height >= 9);
  // Missing masses count as zero rather than NaN.
  assert.equal(stackGeometry([{}], 1).segments[0].height, 9);
});

test('stackGeometry: deterministic', () => {
  assert.deepEqual(stackGeometry(threeStage, 2), stackGeometry(threeStage, 2));
});
