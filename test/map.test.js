import { test } from 'node:test';
import assert from 'node:assert/strict';
// Importing the renderer must not touch window/document at module load: the
// browser globals are only reached inside playOrbital.
import { LUNAR_DWELL_S, formatFarRange } from '../js/ui/map.js';
import { A_MOON, lunarLadder, lunarSchedule } from '../js/core/moon.js';
import { R, elementsFrom, radiusOf } from '../js/core/orbit.js';

test('formatFarRange: cislunar distances, grouped in threes', () => {
  assert.equal(formatFarRange(A_MOON), '384 400 km');
  assert.equal(formatFarRange(842_000), '842 km');
  assert.equal(formatFarRange(0), '0 km');
  assert.equal(formatFarRange(NaN), '—');
});

// ---- playback -------------------------------------------------------------
// playOrbital needs a browser, exactly as playOutcome does (test/ascent.test.js
// has the same three stubs for the same reason). Nothing draws: the context
// records the handful of calls the assertions read and swallows the rest.

/**
 * A 2D context stub that measures the flown arc.
 *
 * The arc is the only thing on the canvas drawn as a run of TWO-POINT strokes
 * at lineWidth 2 — an orbit is one 129-point path at 1.5, a marker and a burn
 * flash are arcs, and the craft glyph is filled rather than stroked — so
 * summing the length of those segments is the drawn arc's length in pixels,
 * read off the picture rather than out of the module.
 *
 * The clock is the first thing drawChrome draws and drawChrome is the last
 * thing in a frame, so a "T+..." fillText closes the frame being accumulated.
 */
function stubContext(record) {
  const state = { lineWidth: 1, pts: [], arcs: 0 };
  const own = {
    lineWidth: 1,
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: String(text).length * 5 }),
    beginPath() { state.pts = []; state.arcs = 0; },
    moveTo(x, y) { state.pts.push({ x, y }); },
    lineTo(x, y) { state.pts.push({ x, y }); },
    // The widest circle drawn in a frame, which is how the camera is measured:
    // wide, the biggest thing on the canvas is a floored ten-pixel body or a
    // burn flash; in the close-up it is the moon itself and the orbit round it.
    arc(x, y, r) {
      state.arcs += 1;
      if (r > record.arcR) record.arcR = r;
    },
    stroke() {
      if (state.arcs || state.pts.length !== 2 || own.lineWidth !== 2) return;
      const [a, b] = state.pts;
      record.trail += Math.hypot(b.x - a.x, b.y - a.y);
    },
    fillText(text) {
      const s = String(text);
      // drawChrome draws the clock first and the range two lines later, so the
      // range belongs to the frame the clock has just closed.
      if (s.startsWith('TO MOON')) {
        const last = record.frames.at(-1);
        if (last) last.toMoon = s;
        return;
      }
      // The close-up's readout, drawn in the same slot and belonging to the
      // same just-closed frame: the range to the moon gives way to it once the
      // vehicle is at the moon.
      if (s.startsWith('ALTITUDE')) {
        const last = record.frames.at(-1);
        if (last) last.alt = s;
        return;
      }
      if (!s.startsWith('T+')) return;
      record.frames.push({ clock: s, trail: record.trail, arcR: record.arcR });
      record.trail = 0;
      record.arcR = 0;
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

/** Run `fn(canvas, pump, record)` with the browser globals playOrbital needs. */
function withBrowser(fn) {
  const record = { frames: [], trail: 0, arcR: 0 };
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

/**
 * A landing outcome, built the way js/core/resolver.js builds one: the ladder
 * and the schedule come from the same two functions the resolver calls, so the
 * times and the transfer the map plays back are the real ones.
 */
function lunarOutcome() {
  const alt = 80000;
  const t0 = 500;
  const phase = 0.31;
  const r = radiusOf(alt);
  const period = elementsFrom(r, r).period;
  const s = lunarSchedule(t0, period, lunarLadder(r, r), phase);
  const transfer = { periapsis: alt, apoapsis: A_MOON - R };
  return {
    steps: s,
    outcome: {
      insertion: { t: t0, periapsis: alt, apoapsis: alt, phase },
      lunar: {
        profile: 'land',
        burns: [
          { t: s.tli, kind: 'tli', dv: 3100, ok: true, elements: transfer },
          { t: s.loi, kind: 'loi', dv: 800, ok: true, elements: null },
          { t: s.descent, kind: 'descent', dv: 1900, ok: true, elements: null },
        ],
      },
      timeline: [
        { t: s.tli, kind: 'burn', text: 'Translunar injection burn.' },
        { t: s.loi, kind: 'burn', text: 'Lunar orbit insertion.' },
        { t: s.descent, kind: 'burn', text: 'Powered descent.' },
        // The touchdown is the far end of the descent, not the burn that
        // starts it (js/core/moon.js, DESCENT_TIME) — which is what the map
        // has to fly the vehicle down in.
        { t: s.touchdown, kind: 'landing', text: 'Touchdown.' },
        { t: s.touchdown + 120, kind: 'end', text: 'Flight ends.' },
      ],
    },
  };
}

/**
 * A flyby outcome: one burn, made at the planet, and the pass the resolver
 * emits as an event because there is no burn at the moon to carry the picture
 * there (js/core/resolver.js).
 */
function flybyOutcome() {
  const alt = 80000;
  const t0 = 500;
  const phase = 0.31;
  const r = radiusOf(alt);
  const period = elementsFrom(r, r).period;
  const s = lunarSchedule(t0, period, lunarLadder(r, r), phase);
  const transfer = { periapsis: alt, apoapsis: A_MOON - R };
  return {
    steps: s,
    outcome: {
      insertion: { t: t0, periapsis: alt, apoapsis: alt, phase },
      lunar: {
        profile: 'flyby',
        burns: [{ t: s.tli, kind: 'tli', dv: 3100, ok: true, elements: transfer }],
      },
      timeline: [
        { t: s.tli, kind: 'burn', text: 'Translunar injection burn.' },
        { t: s.loi, kind: 'flyby', text: 'Closest approach: rounding the moon.' },
        { t: s.loi, kind: 'end', text: 'Lunar flyby.' },
      ],
    },
  };
}

/**
 * Simulated seconds per real second AT LUNAR DISTANCE, for these tests. Well
 * under CISLUNAR_RATE so that the frames either side of the arrival are both
 * sampled: the map runs at the full rate once the vehicle is at the moon (the
 * scaling is by radius), and the stay there is half an hour of sim time.
 */
const TEST_RATE = 4000;

/** Milliseconds `pump` advances the clock by per frame. */
const FRAME_MS = 100;

test('playOrbital: the flown arc grows across the transfer and stops at the moon', async () => {
  const { playOrbital } = await import('../js/ui/map.js');
  withBrowser((canvas, pump, record) => {
    const { outcome } = lunarOutcome();
    const seen = [];
    let done = 0;
    // The capture ends the transfer, and the camera leaves the planet-centred
    // picture shortly after it (LUNAR_DWELL_S), so the arc this test is about
    // is the one drawn up to that point.
    let arrivedAt = -1;
    const handle = playOrbital(canvas, outcome, {
      speed: TEST_RATE,
      onEvent: (ev) => {
        seen.push(ev);
        if (ev.text === 'Lunar orbit insertion.') arrivedAt = record.frames.length;
      },
      onDone: () => { done += 1; },
    });
    pump(20000);
    handle.stop();

    assert.equal(done, 1);
    assert.deepEqual(seen.map((e) => e.kind), ['burn', 'burn', 'burn', 'landing', 'end']);
    assert.ok(record.frames.length > 20, `frames drawn: ${record.frames.length}`);
    assert.ok(arrivedAt > 0, `capture seen at frame ${arrivedAt}`);

    // The arc is drawn at all, and it is not the whole conic from the first
    // frame: what the vehicle has flown by the time it is a third of the way
    // is a fraction of what it has flown by the end of the coast.
    const coast = record.frames.slice(0, arrivedAt + 1).map((f) => f.trail).filter((v) => v > 0);
    assert.ok(coast.length > 20, 'the flown arc is drawn on most frames');
    const peak = Math.max(...coast);
    assert.ok(coast[Math.floor(coast.length / 3)] < peak * 0.9, 'the arc starts short');

    // And it only ever grows while the vehicle is flying: no frame's arc is
    // shorter than the one before it, except across the two burns that put it
    // on a new conic (the departure, which restarts the arc at periapsis).
    let drops = 0;
    for (let i = 1; i < coast.length; i += 1) {
      if (coast[i] < coast[i - 1] - 0.5) drops += 1;
    }
    assert.ok(drops <= 1, `arc shortened ${drops} times; at most the TLI restart`);
  });
});

test('playOrbital: a flyby is flown all the way to the moon', async () => {
  // The regression this is about is a picture, so it is asserted as one: the
  // range to the moon drawn in the corner starts at most of a lunar distance
  // and finishes at nothing, which is the flight the mission was paid for. It
  // used to finish in the parking orbit, because the timeline ended with the
  // injection burn and the playback stops at the last event.
  const { playOrbital } = await import('../js/ui/map.js');
  withBrowser((canvas, pump, record) => {
    const { outcome } = flybyOutcome();
    const seen = [];
    // The departure is the frame the coast starts on: before it the range is
    // the moon's own motion around a vehicle going nowhere.
    let departedAt = -1;
    const handle = playOrbital(canvas, outcome, {
      speed: TEST_RATE,
      onEvent: (ev) => {
        seen.push(ev);
        if (ev.kind === 'burn') departedAt = record.frames.length;
      },
    });
    pump(20000);
    handle.stop();

    assert.deepEqual(seen.map((e) => e.kind), ['burn', 'flyby', 'end']);
    assert.ok(departedAt > 0, `departure seen at frame ${departedAt}`);
    const ranged = record.frames.filter((f) => f.toMoon);
    assert.ok(ranged.length > 20, `frames with a range: ${ranged.length}`);
    // Out of the parking orbit it is the better part of a lunar distance...
    assert.match(ranged[0].toMoon, /^TO MOON 3\d\d \d\d\d km$/);
    // ...and at the pass the two are one point, which is what this frame can
    // say about a flyby and what the whole coast was for.
    assert.equal(ranged.at(-1).toMoon, 'TO MOON 0 km');
    // In between the range only closes: the coast flies AT the moon, because
    // the transfer's apoapsis is where the moon is.
    const km = (f) => Number(f.toMoon.replace(/\D/g, ''));
    const coasting = record.frames.slice(departedAt).filter((f) => f.toMoon);
    assert.ok(coasting.length > 10, `frames on the coast: ${coasting.length}`);
    for (let i = 1; i < coasting.length; i += 1) {
      assert.ok(km(coasting[i]) <= km(coasting[i - 1]), `range grew at frame ${i}`);
    }

    // And the arc is still growing on the last frame — nothing holds it, the
    // way a capture holds the landing flight's.
    const coast = record.frames.map((f) => f.trail).filter((v) => v > 0);
    assert.ok(coast.at(-1) > 0, 'the flown arc reaches the moon');
  });
});

test('playOrbital: at the moon the flown arc holds where it arrived', async () => {
  const { playOrbital } = await import('../js/ui/map.js');
  withBrowser((canvas, pump, record) => {
    const { outcome } = lunarOutcome();
    // The capture is the frame the vehicle stops moving planet-centred, and
    // the ticker reads it out on that frame, so the event marks the boundary.
    let arrivedAt = -1;
    const handle = playOrbital(canvas, outcome, {
      speed: TEST_RATE,
      onEvent: (ev) => {
        if (ev.text === 'Lunar orbit insertion.') arrivedAt = record.frames.length;
      },
    });
    pump(20000);
    handle.stop();

    assert.ok(arrivedAt > 0, `capture seen at frame ${arrivedAt}`);
    // Every frame from the capture until the camera starts moving draws the
    // same arc: the transfer as flown, not one that carries on round an
    // ellipse the vehicle has left. The dwell is what bounds it — after that
    // the planet-centred picture is being left behind, and an arc scaled to
    // lunar distance is not a measurement of anything (js/ui/map.js).
    const dwellFrames = Math.floor((LUNAR_DWELL_S * 1000) / FRAME_MS) - 1;
    const tail = record.frames.slice(arrivedAt, arrivedAt + dwellFrames).map((f) => f.trail);
    assert.ok(tail.length >= 3, `frames at the moon: ${tail.length}`);
    assert.ok(tail[0] > 0, 'the flown transfer is still drawn at the moon');
    for (const v of tail) assert.ok(Math.abs(v - tail[0]) < 0.5, `held at ${tail[0]}, saw ${v}`);
  });
});

test('playOrbital: the descent is flown, and the altitude counts down to nothing', async () => {
  // The regression this is about is the picture the tier is named for, so it
  // is asserted as one: at the moon the corner reads the vehicle's altitude
  // above the surface, and over a landing that number goes from the orbit the
  // ladder is priced against to zero without ever going back up. It used to
  // read nothing at all — a capture put the vehicle ON the moon marker, and
  // the descent, the touchdown and the stay all happened inside ten pixels.
  const { playOrbital } = await import('../js/ui/map.js');
  withBrowser((canvas, pump, record) => {
    const { outcome } = lunarOutcome();
    const seen = [];
    const handle = playOrbital(canvas, outcome, {
      speed: TEST_RATE,
      onEvent: (ev) => seen.push(ev),
    });
    pump(40000);
    handle.stop();

    assert.deepEqual(seen.map((e) => e.kind), ['burn', 'burn', 'burn', 'landing', 'end']);
    const alts = record.frames.filter((f) => f.alt);
    assert.ok(alts.length > 20, `frames with an altitude: ${alts.length}`);
    // In lunar orbit it is the orbit js/core/moon.js prices everything from.
    assert.equal(alts[0].alt, 'ALTITUDE 100 km');
    // And it finishes on the ground, in metres, because a landing does.
    assert.equal(alts.at(-1).alt, 'ALTITUDE 0 m');
    // Never upwards: a coast at 100 km, then a descent, then the surface.
    const metres = (f) => {
      const [, n, unit] = f.alt.match(/^ALTITUDE ([\d.]+) (m|km)$/);
      return Number(n) * (unit === 'km' ? 1000 : 1);
    };
    for (let i = 1; i < alts.length; i += 1) {
      assert.ok(metres(alts[i]) <= metres(alts[i - 1]), `altitude rose at frame ${i}`);
    }
    // The descent is a trip and not a cut: the frames strictly between the
    // orbit and the ground are most of what is drawn at the moon.
    const falling = alts.filter((f) => metres(f) > 0 && metres(f) < 100000);
    assert.ok(falling.length > 10, `frames on the way down: ${falling.length}`);

    // And the camera went in to show it. Out at the transfer the widest circle
    // on the canvas is a body floored to ten pixels or a burn flash expanding
    // off one; at the moon it is the moon, drawn at its own size, and the orbit
    // around it.
    const wide = Math.max(...record.frames.slice(0, 5).map((f) => f.arcR));
    const near = record.frames.at(-1).arcR;
    assert.ok(wide < 40, `widest circle in the cislunar picture: ${wide}px`);
    assert.ok(near > wide * 2, `widest circle in the close-up: ${near}px`);
  });
});
