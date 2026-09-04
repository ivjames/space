// The surface shot (js/ui/surface.js): the camera on the ground at the moon.
//
// The claim the whole module exists to make is that it draws the landing and
// the liftoff at the scale the launch was drawn at, so that is what most of
// this file pins — not "a similar scale", the same constant, shared with
// js/ui/ascent.js rather than copied from it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GROUND_H, SCREEN_ANCHOR, VIEW_SPAN_M } from '../js/ui/ascent.js';
import { SURFACE_ALT, drawSurface, pitchAt, surfaceView } from '../js/ui/surface.js';

test('surfaceView: a pixel is the same number of metres it is at launch', () => {
  // js/ui/ascent.js sets its own mPerPx to viewSpan / canvas height, from this
  // same exported constant. Anything else here — a rounded number, a span of
  // its own — and the two views would be at scales that merely look alike.
  for (const [w, h] of [[360, 480], [320, 568], [412, 732]]) {
    const view = surfaceView(w, h);
    assert.equal(view.mPerPx, VIEW_SPAN_M / h);
    assert.equal(view.anchorY, h * (1 - SCREEN_ANCHOR));
    assert.equal(view.padY, h - GROUND_H);
  }
});

test('surfaceView: the shot opens with the ground already in frame', () => {
  // SURFACE_ALT is where js/ui/map.js cuts to this view. Above liftAlt the
  // camera is following the vehicle and the surface is off the bottom edge, so
  // a cut made up there would open on an empty rectangle.
  for (const [w, h] of [[360, 480], [320, 568], [412, 732]]) {
    const { liftAlt } = surfaceView(w, h);
    assert.ok(SURFACE_ALT <= liftAlt, `${w}x${h}: cut at ${SURFACE_ALT}, ground at ${liftAlt}`);
  }
});

test('pitchAt: level on the ground, leaning at the top of the shot', () => {
  assert.equal(pitchAt(0), 0);
  assert.equal(pitchAt(-50), 0);
  // Upright for the last stretch: a lander drawn at even a few degrees on a
  // flat surface reads as a crash, and the descent holds one slope all the way
  // down, so the attitude cannot be taken from the velocity direction.
  assert.equal(pitchAt(400), 0);
  const high = pitchAt(SURFACE_ALT);
  assert.ok(high > 0.8, `lean at the top of the shot: ${high}`);
  // Monotone in between, with no step in it.
  let prev = 0;
  for (let a = 0; a <= SURFACE_ALT; a += 200) {
    const p = pitchAt(a);
    assert.ok(p >= prev - 1e-12, `pitch fell at ${a} m`);
    assert.ok(p - prev < 0.12, `pitch jumped at ${a} m`);
    prev = p;
  }
  assert.equal(pitchAt(SURFACE_ALT * 3), high);
});

/** A canvas context that records the two things these tests measure. */
function stubContext(record) {
  const own = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: (t) => ({ width: String(t).length * 5 }),
    fillRect(x, y, w) { record.fills.push({ x, y, w }); },
    translate(x, y) { record.translates.push({ x, y }); },
  };
  return new Proxy(own, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol') return undefined;
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

const COLORS = {
  bg: '#05060a', fg: '#e8e8e8', muted: '#a4adb9', accent: '#00d4ff', fail: '#ff6b6b',
};

/** Draw one frame and report where the ground and the lander were put. */
function draw(state, w = 360, h = 480) {
  const record = { fills: [], translates: [] };
  drawSurface(stubContext(record), { w, h, colors: COLORS }, state);
  const ground = record.fills.find((f) => f.x === 0 && f.w === w);
  return { groundY: ground ? ground.y : null, lander: record.translates[0] ?? null };
}

test('drawSurface: the lander stands on the surface, not in it', () => {
  const { groundY, lander } = draw({ alt: 0, x: 0, kind: 'surface' });
  assert.ok(groundY !== null, 'the surface is drawn');
  assert.equal(lander.x, 180);
  // The sprite's origin is its footpads, so a landed vehicle sits exactly on
  // the line the surface is drawn at.
  assert.equal(lander.y, groundY);
});

test('drawSurface: altitude is the gap between the lander and the ground', () => {
  const { mPerPx, anchorY, liftAlt } = surfaceView(360, 480);
  const low = draw({ alt: 3000, x: -6000, kind: 'descent', engine: true });
  assert.ok(Math.abs((low.groundY - low.lander.y) - 3000 / mPerPx) < 0.01, 'three km up');

  // Above liftAlt the camera follows: the vehicle is pinned at the anchor and
  // the ground has left the bottom of the canvas.
  const high = draw({ alt: liftAlt + 2000, x: -40000, kind: 'descent', engine: true });
  assert.equal(high.lander.y, anchorY);
  assert.equal(high.groundY, null, 'the surface is below the canvas and is not drawn');
});

test('drawSurface: an ascent is the same shot the other way up', () => {
  const { mPerPx } = surfaceView(360, 480);
  const up = draw({ alt: 1200, x: 900, kind: 'ascent', engine: true });
  assert.ok(Math.abs((up.groundY - up.lander.y) - 1200 / mPerPx) < 0.01);
  // The camera is on the vehicle in both directions, so a climb away from the
  // site scrolls the site off the left rather than moving the lander.
  assert.equal(up.lander.x, 180);
});
