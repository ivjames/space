// Planet-centred orbital map. Plays back the tier 3 orbital phase — the
// analytic burn sequence js/core/resolver.js resolved after insertion — on the
// SAME canvas the ascent view has just finished with (ARCHITECTURE.md, phase
// 2: "the SAME `canvas#ascent` element is handed to the map view").
//
// Like js/ui/ascent.js it renders and nothing else: every position it draws
// comes from js/core/orbit.js's Kepler solve, and every orbit it draws comes
// either from the state (the target's) or from something the outcome says has
// ALREADY happened (the insertion, then each burn as its time arrives).
//
// NO-LEAK CONTRACT. Nothing on this screen may reveal how the sequence ends
// before the sequence shows it. Concretely, during playback this module reads:
//
//   - `outcome.insertion` — the orbit the vehicle is in. The ascent view has
//     just played up to that event, so it is in the past from the first frame,
//     and it is what the vehicle's orbit is drawn from.
//   - `orbital.target` / `opts.target` and `orbital.phaseErrorDeg` — the
//     target's orbit and where the two are relative to each other AT
//     INSERTION. The target is persistent state (state.objects), so its orbit
//     and its phase are drawable from the very first frame; the phase error is
//     the launch window the player themselves chose.
//   - `orbital.burns[i]` and the timeline events, one at a time, only once sim
//     time has reached them — exactly the way ascent.js flushes its timeline.
//     A burn's `elements` become the vehicle's drawn orbit AT the burn's
//     instant and not one frame before, and a burn's `ok: false` is a red
//     flash at that instant, not a marker that was always on screen.
//
// It never reads `orbital.closestApproach`, `orbital.docked`,
// `orbital.stoppedAt`, `orbital.dvUsed`, `outcome.success`, `outcome.readout`,
// or any burn or event still in the future. The closest-approach line is drawn
// from the two positions on screen once the `approach` event has passed (or,
// at the very end, as the separation the flight actually finished with), never
// from the outcome's number ahead of time — the label quotes the event's own
// text, which is by then already in the ticker.
//
// The single look-ahead is the same one ascent.js allows itself: the time of
// the LAST timeline event, used solely to know when to stop. The playback rate
// is a constant (MAP_RATE), never sequence-length / fixed-duration, which
// would play a short sequence slowly and a long one fast.
//
// SCALE. Orbital altitudes are tiny against the planet — a 200 km orbit is 3%
// of a 6 371 km radius, which draws as a line inside the planet's own outline.
// So altitude (and only altitude: the planet keeps its true size) is
// multiplied by ALT_EXAGGERATION, and the view says so in a corner. The fit is
// computed from the target's orbit and the insertion orbit, both of which are
// known at the first frame; a later burn that needs more room widens it AT
// that burn's instant.
//
// PHASE. An object's place on its orbit is its mean anomaly fraction (see
// js/core/orbit.js), which is what state.objects store and what a launch
// window is quoted against. The vehicle's phase at insertion is the target's
// plus `phaseErrorDeg`, so the angular gap on screen at the first frame IS the
// phase error the result screen reports. Across a burn the mean phase is
// carried over unchanged (these orbits are near-circular — e is a few
// thousandths — so mean phase and drawn angle agree to well under a pixel),
// with two exceptions that are what the burns MEAN rather than a fudge: the
// second phasing burn ends the phasing, so it puts the vehicle at the target's
// phase, and a successful docking merges the two.

import { R, altitudeOf, elementsFrom, positionAt, radiusOf } from '../core/orbit.js';

/**
 * How much altitude is stretched relative to the planet's own radius. A 200 km
 * orbit sits 3% above the surface; at x6 it sits 19% above it, which is a
 * legible ring. Exported because the note drawn in the corner, the tests and
 * anything else that has to agree with the picture all read it from here.
 */
export const ALT_EXAGGERATION = 6;

/**
 * Playback rate, simulated seconds per real second. Fixed for every sequence
 * (see the no-leak note above): a ~5 400 s orbit plays in 9 s, so the three
 * periods plus the docking coast that the sequence spans run about 25 s.
 */
export const MAP_RATE = 600;

/** Sub-pixel margin left around the widest drawn orbit, px. */
const FIT_MARGIN_PX = 34;
/** Extra room kept beyond the widest orbit so its marker and label fit. */
const FIT_SLACK = 1.06;
/** Segments used to trace one orbit. */
const ORBIT_STEPS = 128;
/** How long a burn flash lasts, in real seconds. */
const FLASH_S = 1.2;
/** Radius a burn flash expands to, px. */
const FLASH_PX = 26;
/** Stars in the field. */
const STAR_COUNT = 120;
/**
 * A tap that skipped the ascent view also emits a `click` a moment later, and
 * this view is mounted in between — so pointer input is ignored for this long
 * after mounting, or the handoff would skip the map before it drew a frame.
 */
const SKIP_GRACE_MS = 250;

const TWO_PI = Math.PI * 2;

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** Deterministic little LCG so the starfield does not sparkle between frames. */
function makeStars(count, w, h) {
  let s = 0x71a3c5f;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    stars.push({ x: rand() * w, y: rand() * h, r: 0.4 + rand() * 0.9, a: 0.25 + rand() * 0.6 });
  }
  return stars;
}

/** "500 m" / "3.2 km" / "14 km" — the same shape resolver.js's readouts use. */
function formatRange(m) {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** Elapsed time as T+1:42:00 — an orbital sequence runs to hours. */
function formatClock(t) {
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `T+${h}:${two(m)}:${two(sec)}` : `T+${m}:${two(sec)}`;
}

/** An orbit the renderer can position and trace: apsis radii + orientation. */
function makeOrbit(periapsisAlt, apoapsisAlt, arg, phase0, tRef) {
  const lo = Math.min(periapsisAlt, apoapsisAlt);
  const hi = Math.max(periapsisAlt, apoapsisAlt);
  const rp = radiusOf(lo);
  const ra = radiusOf(hi);
  const { a, e, period } = elementsFrom(rp, ra);
  return { rp, ra, a, e, period, arg, phase0, tRef };
}

/** Mean phase (orbit fractions since periapsis) of `orbit` at time `t`. */
function meanPhaseAt(orbit, t) {
  if (!(orbit.period > 0)) return orbit.phase0;
  return orbit.phase0 + (t - orbit.tRef) / orbit.period;
}

/** Planet-centred position (m) of `orbit` at time `t`. */
function stateAt(orbit, t) {
  return positionAt(orbit.rp, orbit.ra, orbit.arg, meanPhaseAt(orbit, t), 0);
}

/**
 * Play the orbital phase of an outcome on a canvas.
 *
 * @param {HTMLCanvasElement} canvas  the same element the ascent view used
 * @param {object} outcome  from resolveLaunch; needs `insertion` and `orbital`
 * @param {object} [opts]
 * @param {object} [opts.target]  the state object being rendezvoused with
 *        (state.objects entry). Falls back to `outcome.orbital.target`.
 * @param {(event: object) => void} [opts.onEvent] called at the playback time
 *        each timeline event happens, so the ticker fills in as it plays
 * @param {() => void} [opts.onDone] called once, when playback finishes
 * @param {number} [opts.speed] simulated seconds per real second; defaults to
 *        MAP_RATE. Gameplay never sets it; tests do.
 * @returns {{ done: boolean, skip(): void, stop(): void }}
 */
export function playOrbital(canvas, outcome, opts = {}) {
  const insertion = outcome?.insertion ?? null;
  const orbital = outcome?.orbital ?? null;
  const targetInfo = opts.target ?? orbital?.target ?? null;

  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : () => {};
  const rate = opts.speed ?? MAP_RATE;

  const handle = { done: false, skip, stop };
  let stopped = false;

  // Without an insertion and a target there is no map to draw: hand control
  // straight back rather than rendering half a picture.
  if (!insertion || !targetInfo || !Number.isFinite(insertion.apoapsis)) {
    requestAnimationFrame(() => {
      if (stopped || handle.done) return;
      handle.done = true;
      onDone();
    });
    return handle;
  }

  const t0 = insertion.t;
  // Events the ascent view has NOT already emitted: it played up to and
  // including the insertion event, so this view owns everything after it.
  const events = [...(outcome.timeline ?? [])]
    .filter((ev) => ev.t > t0)
    .sort((a, b) => a.t - b.t);
  // The one look-ahead: when to stop.
  const finalT = events.length ? events[events.length - 1].t : t0;
  const burns = [...(orbital?.burns ?? [])].sort((a, b) => a.t - b.t);

  const phaseErrorDeg = Number(orbital?.phaseErrorDeg) || 0;
  const targetPhase = Number(targetInfo.phase) || 0;
  // The vehicle's own phase at insertion: the target's, plus the error the
  // launch window bought. Both are known at the first frame.
  const windowPhase = targetPhase + phaseErrorDeg / 360;

  const target = makeOrbit(targetInfo.periapsis, targetInfo.apoapsis, 0, targetPhase, t0);
  let vehicle = makeOrbit(
    insertion.periapsis, insertion.apoapsis, TWO_PI * windowPhase, 0, t0,
  );
  const targetName = String(targetInfo.name ?? targetInfo.id ?? 'Target').toUpperCase();

  const ctx = canvas.getContext('2d');
  const colors = {
    bg: '#05060a',
    fg: '#e8e8e8',
    muted: '#7c8794',
    accent: cssVar(canvas, '--accent', '#00d4ff'),
    fail: cssVar(canvas, '--fail', '#ff6b6b'),
    land: '#2b3a4a',
    lit: '#4d6b86',
  };

  let w = 0;
  let h = 0;
  let cx = 0;
  let cy = 0;
  let pxPerM = 1;
  let stars = [];

  // Drawn radius: the planet keeps its true size, altitude is exaggerated.
  const drawRadius = (r) => R + (r - R) * ALT_EXAGGERATION;
  // The widest drawn radius the view has had to hold so far. Seeded from the
  // target's orbit (state) and the insertion orbit (already happened); a burn
  // that needs more room widens it at that burn's instant, never before.
  let fit = Math.max(drawRadius(target.ra), drawRadius(vehicle.ra)) * FIT_SLACK;

  let raf = 0;
  let lastNow = 0;
  let realT = 0;
  let simT = t0;
  let emitted = 0;
  let burnsApplied = 0;
  let skipped = false;

  // What has actually happened, in playback time. Nothing here is set from
  // the outcome ahead of the instant it occurs.
  let phaseBurns = 0;
  let docked = false;
  let dockFailed = false;
  let failed = false;
  let approachText = null;          // the approach event's own line, once past
  const flashes = [];               // { x, y, at, ok }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || Math.round(cssW * 4 / 3);
    const nextW = Math.max(1, Math.round(cssW * dpr));
    const nextH = Math.max(1, Math.round(cssH * dpr));
    const changed = canvas.width !== nextW || canvas.height !== nextH;
    if (changed) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    w = cssW;
    h = cssH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2;
    cy = h / 2;
    const half = Math.max(1, Math.min(w, h) / 2 - FIT_MARGIN_PX);
    pxPerM = half / fit;
    if (changed || stars.length === 0) stars = makeStars(STAR_COUNT, w, h);
  }

  /** World metres (planet-centred) -> screen pixels, with y up. */
  const sx = (x) => cx + x * pxPerM;
  const sy = (y) => cy - y * pxPerM;
  /** Radial stretch applied to a point at radius r, so altitude exaggerates. */
  const scaleOf = (r) => (r > 0 ? drawRadius(r) / r : 1);
  const screenOf = (p) => ({ x: sx(p.x * scaleOf(p.r)), y: sy(p.y * scaleOf(p.r)) });

  function widen(orbit) {
    const need = drawRadius(orbit.ra) * FIT_SLACK;
    if (need > fit) fit = need;
  }

  // ---- drawing -----------------------------------------------------------

  function drawSpace() {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = colors.fg;
    for (const s of stars) {
      ctx.globalAlpha = s.a;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The planet: a disc lit from the upper left, its terminator implied by the
   * gradient rather than drawn as a line, with a thin atmosphere halo.
   */
  function drawPlanet() {
    const rp = R * pxPerM;
    const g = ctx.createRadialGradient(
      cx - rp * 0.45, cy - rp * 0.5, rp * 0.05,
      cx, cy, rp,
    );
    g.addColorStop(0, colors.lit);
    g.addColorStop(0.45, colors.land);
    g.addColorStop(0.82, '#141d27');
    g.addColorStop(1, '#080c12');
    ctx.beginPath();
    ctx.arc(cx, cy, rp, 0, TWO_PI);
    ctx.fillStyle = g;
    ctx.fill();

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#5aa0d6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, rp + 1, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Trace an orbit. Exaggerating altitude means the drawn curve is not an
   * ellipse any more (each point is pushed out from the surface, not from the
   * focus), so it is walked in true anomaly and plotted point by point.
   */
  function drawOrbit(orbit, stroke, dash, alpha) {
    if (!(orbit.a > 0)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash);
    ctx.beginPath();
    const p = orbit.a * (1 - orbit.e * orbit.e);
    for (let i = 0; i <= ORBIT_STEPS; i += 1) {
      const nu = (i / ORBIT_STEPS) * TWO_PI;
      const r = p / (1 + orbit.e * Math.cos(nu));
      const k = scaleOf(r);
      const ang = nu + orbit.arg;
      const x = sx(r * Math.cos(ang) * k);
      const y = sy(r * Math.sin(ang) * k);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawMarker(pt, color, label, filled) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.5, 0, TWO_PI);
    if (filled) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    if (label) {
      ctx.fillStyle = color;
      ctx.font = '9px "Courier New", monospace';
      ctx.textBaseline = 'middle';
      // The craft travel right round the view, so a label pinned to one side
      // runs off the edge for half of every orbit: it flips to whichever side
      // it fits on.
      // 11 px clears the docked marker's ring as well as the dot.
      const gap = 11;
      const width = ctx.measureText(label).width;
      if (pt.x + gap + width > w - 4) {
        ctx.textAlign = 'right';
        ctx.fillText(label, pt.x - gap, pt.y);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(label, pt.x + gap, pt.y);
      }
    }
    ctx.restore();
  }

  /** The line between the two craft, once there is a reason to draw it. */
  function drawSeparation(a, b, text) {
    ctx.save();
    ctx.strokeStyle = colors.fg;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.fg;
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    ctx.fillText(text, Math.min(Math.max(mx, 44), w - 44), my - 7);
    ctx.restore();
  }

  /**
   * Burn flashes. A flash is drawn at the vehicle's CURRENT position rather
   * than at the spot the burn happened: at 600x the vehicle covers 40 degrees
   * of orbit in the time a flash fades, so a ring left behind at the burn
   * point reads as a second object rather than as an engine firing.
   */
  function drawFlashes(pt) {
    for (const f of flashes) {
      const age = skipped ? FLASH_S : realT - f.at;
      if (age < 0 || age > FLASH_S) continue;
      const u = age / FLASH_S;
      ctx.save();
      ctx.globalAlpha = (1 - u) * 0.9;
      ctx.strokeStyle = f.ok ? colors.accent : colors.fail;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4 + u * FLASH_PX, 0, TWO_PI);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Clock, the exaggeration note, and whatever has already happened. */
  function drawChrome() {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.muted;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(formatClock(simT - t0), 6, 6);
    ctx.fillStyle = colors.accent;
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillText('ORBITAL PHASE', 6, 20);

    ctx.fillStyle = colors.muted;
    ctx.font = '9px "Courier New", monospace';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`altitude ×${ALT_EXAGGERATION}`, 6, h - 6);

    if (docked || dockFailed || failed) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.fillStyle = docked ? colors.accent : colors.fail;
      const word = docked ? 'DOCKED' : dockFailed ? 'DOCKING ABORTED' : 'BURN FAILED';
      ctx.fillText(word, w - 6, 6);
    }
    ctx.restore();
  }

  function frame() {
    resize();
    const tp = stateAt(target, simT);
    const vp = stateAt(vehicle, simT);
    const tpt = screenOf(tp);
    const vpt = screenOf(vp);

    drawSpace();
    drawPlanet();
    drawOrbit(target, colors.muted, [4, 4], 0.85);
    drawOrbit(vehicle, failed ? colors.fail : colors.accent, [], 0.95);

    // The separation line: once the approach event has been read out, and
    // again on the final frame, which is where a sequence that stopped early
    // shows how far apart the two actually finished.
    const ended = handle.done || simT >= finalT;
    if (docked) {
      // Merged: one marker, ringed. The corner already says DOCKED.
      drawMarker(tpt, colors.accent, targetName, true);
      ctx.save();
      ctx.strokeStyle = colors.accent;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tpt.x, tpt.y, 9, 0, TWO_PI);
      ctx.stroke();
      ctx.restore();
    } else {
      if (approachText || ended) {
        // At the approach event the line quotes that event's own line, which
        // the ticker has just printed. On the final frame of a sequence that
        // never got that far it quotes the plain geometric gap between the two
        // craft right now — a measurement off the picture, not a number read
        // out of the outcome.
        const metres = Math.hypot(tp.x - vp.x, tp.y - vp.y);
        drawSeparation(vpt, tpt, approachText ?? `separation ${formatRange(metres)}`);
      }
      drawMarker(tpt, colors.muted, targetName, true);
      drawMarker(vpt, dockFailed || failed ? colors.fail : colors.accent, 'VEHICLE', false);
    }

    drawFlashes(vpt);
    drawChrome();
  }

  // ---- playback ----------------------------------------------------------

  /**
   * The vehicle's mean phase that puts it where the TARGET is at time `t`.
   *
   * Mean phase is measured from each orbit's own periapsis, and the two orbits
   * do not share one (the vehicle's is the point it inserted at, the target's
   * is +x), so copying the target's phase across would place the vehicle a
   * whole argument-of-periapsis away from it. The offset is the difference
   * between the two arguments; once the orbits have the same shape — which
   * they do by the time anything wants to be aligned — this puts the two
   * markers exactly on top of each other.
   */
  function alignedPhase(t) {
    return meanPhaseAt(target, t) + (target.arg - vehicle.arg) / TWO_PI;
  }

  function applyBurn(burn) {
    flashes.push({ at: realT, ok: burn.ok !== false });
    if (burn.ok === false) {
      // The burn did not happen: the orbit is unchanged, and the vehicle is
      // flagged from this instant on.
      failed = true;
      if (burn.kind === 'dock') dockFailed = true;
      return;
    }
    const el = burn.elements;
    if (burn.kind === 'dock') {
      // Merged. Aligning here matters when the phasing step was skipped
      // altogether (a launch window inside the tolerance leaves a few degrees
      // that the approach itself closes).
      vehicle = makeOrbit(
        altitudeOf(vehicle.rp), altitudeOf(vehicle.ra),
        vehicle.arg, alignedPhase(burn.t), burn.t,
      );
      docked = true;
      return;
    }
    if (!el || !Number.isFinite(el.periapsis) || !Number.isFinite(el.apoapsis)) return;
    let phase = meanPhaseAt(vehicle, burn.t);
    if (burn.kind === 'phase') {
      phaseBurns += 1;
      // The second burn of the pair is what ENDS the phasing: from here the
      // vehicle is where the target is, which is what "rendezvous" means.
      if (phaseBurns >= 2) phase = alignedPhase(burn.t);
    } else if (burn.kind === 'approach') {
      // The approach closes the last of the distance — tens of kilometres down
      // to tens of metres, which at this scale is zero.
      phase = alignedPhase(burn.t);
    }
    vehicle = makeOrbit(el.periapsis, el.apoapsis, vehicle.arg, phase, burn.t);
    widen(vehicle);
  }

  function flushTo(t) {
    while (burnsApplied < burns.length && burns[burnsApplied].t <= t + 1e-9) {
      const burn = burns[burnsApplied];
      burnsApplied += 1;
      applyBurn(burn);
    }
    while (emitted < events.length && events[emitted].t <= t + 1e-9) {
      const ev = events[emitted];
      emitted += 1;
      if (ev.kind === 'approach') approachText = ev.text;
      try {
        onEvent(ev);
      } catch (err) {
        // A broken ticker must not stop the playback.
        console.error('map onEvent threw:', err);
      }
    }
  }

  function finish() {
    if (handle.done) return;
    handle.done = true;
    simT = finalT;
    flushTo(finalT);
    frame();
    detach();
    onDone();
  }

  function tick(now) {
    if (stopped) return;
    if (!lastNow) lastNow = now;
    const dt = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    realT += dt;
    simT += dt * rate;
    if (simT >= finalT) {
      finish();
      return;
    }
    flushTo(simT);
    frame();
    raf = requestAnimationFrame(tick);
  }

  function skip() {
    if (stopped || handle.done) return;
    cancelAnimationFrame(raf);
    skipped = true;
    finish();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    detach();
  }

  const mountedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function onPointer(ev) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - mountedAt < SKIP_GRACE_MS) return;   // see SKIP_GRACE_MS
    ev.preventDefault();
    skip();
  }

  function onResize() {
    if (stopped) return;
    frame();
  }

  function detach() {
    canvas.removeEventListener('pointerdown', onPointer);
    canvas.removeEventListener('click', onPointer);
    window.removeEventListener('resize', onResize);
  }

  canvas.addEventListener('pointerdown', onPointer);
  canvas.addEventListener('click', onPointer);
  window.addEventListener('resize', onResize);

  resize();
  frame();

  if (finalT <= t0) {
    requestAnimationFrame(() => finish());
  } else {
    raf = requestAnimationFrame(tick);
  }

  return handle;
}
