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

// ---- playback -------------------------------------------------------------
// playOutcome needs a browser: a canvas with a 2D context, a window, a frame
// callback and getComputedStyle. None of it draws anything here — the context
// records the few calls the assertions read and swallows the rest.

/** A 2D context stub: every method is a no-op unless a test needs its calls. */
function stubContext(record) {
  const gradient = {
    addColorStop(_stop, color) {
      // The exhaust plume is the only linear gradient in the module with this
      // stop colour, so it marks the frames in which a stage was drawn firing.
      if (color === '#ffa53c') record.flame = true;
    },
  };
  const own = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText(text) {
      // drawReadout stamps T+<simT>s once per frame, after everything the
      // frame drew, so it closes the frame the record is accumulating.
      const m = /^T\+(\d+)s$/.exec(String(text));
      if (!m) return;
      record.frames.push({ t: Number(m[1]), flame: record.flame });
      record.flame = false;
    },
  };
  return new Proxy(own, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol') return undefined;
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

/**
 * Run `fn(canvas, pump)` with the browser globals playOutcome needs.
 * `pump(n)` advances up to n animation frames, 100 ms of real time each, and
 * stops early once the queue drains. Every global is restored afterwards.
 */
function withBrowser(fn) {
  const record = { frames: [], flame: false };
  const ctx = stubContext(record);
  const canvas = {
    clientWidth: 360,
    clientHeight: 480,
    width: 0,
    height: 0,
    isConnected: true,
    getContext: () => ctx,
    addEventListener() {},
    removeEventListener() {},
  };
  const saved = {
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  let queue = [];
  let now = 0;
  globalThis.window = {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = (cb) => queue.push(cb);
  globalThis.cancelAnimationFrame = () => { queue = []; };
  const pump = (max) => {
    for (let i = 0; i < max && queue.length; i += 1) {
      const due = queue;
      queue = [];
      now += 100;
      for (const cb of due) cb(now);
    }
  };
  try {
    return fn(canvas, pump, record);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

/** A straight-up flight: 40 s of samples, stage 2 from the abort instant on. */
function abortSamples() {
  const samples = [];
  for (let t = 0; t <= 40; t += 1) {
    const alt = t <= 30 ? 30 * t * t : 27000 - 500 * (t - 30);
    samples.push({ t, alt, vel: Math.min(60 * t, 1800), downrange: 0, stage: t < 10 ? 1 : 2 });
  }
  return samples;
}

// Stage 1 fails at T+10, the abort throws stage 2 clear, and it lights at
// T+12 (resolver.js ESCAPE_DELAY) — exactly the timeline shape the resolver
// emits for an escaped failure.
const escapedTimeline = [
  { t: 0, kind: 'ignition', stage: 1, alt: 0, text: 'Stage 1 ignition.' },
  { t: 10, kind: 'failure', stage: 1, alt: 3000, escaped: true, text: 'Stage 1 engine failure at T+10s.' },
  { t: 10, kind: 'separation', stage: 1, alt: 3000, abort: true, text: 'Abort: stage 2 separates from stage 1.' },
  { t: 12, kind: 'ignition', stage: 2, alt: 4320, text: 'Stage 2 ignition.' },
  { t: 30, kind: 'burnout', stage: 2, alt: 27000, text: 'Stage 2 burnout.' },
  { t: 40, kind: 'end', alt: 22000, text: 'Flight ends.' },
];

const abortVehicle = {
  stages: [{ dryMass: 40, propMass: 30 }, { dryMass: 15, propMass: 20 }],
  escape: 1,
};

test('playOutcome: an escaped failure plays through to the end of the flight', async () => {
  const { playOutcome } = await import('../js/ui/ascent.js');
  withBrowser((canvas, pump, record) => {
    const seen = [];
    let done = 0;
    const handle = playOutcome(canvas, {
      samples: abortSamples(),
      timeline: escapedTimeline,
      failure: { t: 10, stage: 1, kind: 'failure', escaped: true },
      escapes: 1,
      success: false,
    }, {
      vehicle: abortVehicle,
      speed: 1,
      onEvent: (ev) => seen.push(ev),
      onDone: () => { done += 1; },
    });
    pump(4000);
    handle.stop();

    // It reached the end rather than stopping at the bang, and said so once.
    assert.equal(done, 1);
    assert.equal(handle.done, true);
    // Every event was reported, in order, including both halves of the abort.
    assert.deepEqual(seen.map((e) => e.kind), escapedTimeline.map((e) => e.kind));
    assert.equal(seen[1].escaped, true);
    assert.equal(seen[2].abort, true);

    // The escaped stage coasts unpowered for the two seconds between the
    // failure and its own ignition, then burns again. A flame can only be
    // drawn as part of the flying stack (the wreck is drawn engine-out, and
    // once a TERMINAL failure has passed the rocket is not drawn at all), so
    // its return at T+12 is also the proof that the escaped failure did not
    // end the flight on screen.
    const at = (t) => record.frames.filter((f) => f.t === t);
    assert.ok(at(11).length > 0, 'frames during the abort coast');
    assert.ok(at(11).every((f) => !f.flame), 'no exhaust while coasting to the relight');
    for (const t of [15, 20, 25]) {
      assert.ok(at(t).length > 0, `frames at T+${t}`);
      assert.ok(at(t).some((f) => f.flame), `stage 2 burning at T+${t}`);
    }
    // And it is out again after burnout.
    assert.ok(at(35).every((f) => !f.flame), 'no exhaust after burnout');
  });
});

test('playOutcome: a terminal failure still ends the flight where it happens', async () => {
  const { playOutcome } = await import('../js/ui/ascent.js');
  withBrowser((canvas, pump, record) => {
    const timeline = [
      { t: 0, kind: 'ignition', stage: 1, alt: 0, text: 'Stage 1 ignition.' },
      { t: 10, kind: 'failure', stage: 1, alt: 3000, text: 'Stage 1 engine failure at T+10s.' },
      { t: 40, kind: 'end', alt: 0, text: 'Flight ends.' },
    ];
    let done = 0;
    const handle = playOutcome(canvas, {
      samples: abortSamples(),
      timeline,
      failure: { t: 10, stage: 1, kind: 'failure' },
      escapes: 0,
      success: false,
    }, { vehicle: abortVehicle, speed: 1, onDone: () => { done += 1; } });
    pump(4000);
    handle.stop();

    assert.equal(done, 1);
    // Nothing is lit again: the stack that failed coasts as a wreck.
    const after = record.frames.filter((f) => f.t > 10);
    assert.ok(after.length > 0, 'frames after the failure');
    assert.ok(after.every((f) => !f.flame), 'no exhaust after a terminal failure');
  });
});

test('playOutcome: several escaped failures each play their own bang', async () => {
  const { playOutcome } = await import('../js/ui/ascent.js');
  withBrowser((canvas, pump) => {
    // Two aborts in one flight: stage 1 at T+10, stage 2 at T+16, stage 3
    // carrying on to the end. Nothing must look ahead to "the" failure.
    const samples = abortSamples().map((s) => ({
      ...s,
      stage: s.t < 10 ? 1 : s.t < 16 ? 2 : 3,
    }));
    const timeline = [
      { t: 0, kind: 'ignition', stage: 1, alt: 0, text: 'Stage 1 ignition.' },
      { t: 10, kind: 'failure', stage: 1, alt: 3000, escaped: true, text: 'Stage 1 engine failure at T+10s.' },
      { t: 10, kind: 'separation', stage: 1, alt: 3000, abort: true, text: 'Abort: stage 2 separates from stage 1.' },
      { t: 12, kind: 'ignition', stage: 2, alt: 4320, text: 'Stage 2 ignition.' },
      { t: 16, kind: 'failure', stage: 2, alt: 7680, escaped: true, text: 'Stage 2 engine failure at T+16s.' },
      { t: 16, kind: 'separation', stage: 2, alt: 7680, abort: true, text: 'Abort: stage 3 separates from stage 2.' },
      { t: 18, kind: 'ignition', stage: 3, alt: 9720, text: 'Stage 3 ignition.' },
      { t: 30, kind: 'burnout', stage: 3, alt: 27000, text: 'Stage 3 burnout.' },
      { t: 40, kind: 'end', alt: 22000, text: 'Flight ends.' },
    ];
    let done = 0;
    const seen = [];
    const handle = playOutcome(canvas, {
      samples,
      timeline,
      failure: { t: 10, stage: 1, kind: 'failure', escaped: true },
      escapes: 2,
      success: false,
    }, {
      vehicle: { ...abortVehicle, stages: [...abortVehicle.stages, { dryMass: 8, propMass: 60 }], escape: 2 },
      speed: 1,
      onEvent: (ev) => seen.push(ev),
      onDone: () => { done += 1; },
    });
    pump(4000);
    handle.stop();
    assert.equal(done, 1);
    assert.equal(seen.filter((e) => e.kind === 'failure').length, 2);
    assert.equal(seen.filter((e) => e.kind === 'separation').length, 2);
  });
});
