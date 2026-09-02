// Side-view ascent renderer. Plays an outcome's samples + timeline on a
// canvas; it never simulates anything itself (ARCHITECTURE.md: the resolver
// never renders, and the renderer never decides).
//
// What it shows, and why: DESIGN.md §5 says readable failure is the point —
// the animation has to show *why* the run ended where it did. So the flight
// area draws the requirement altitude as a dashed line (did we get there?),
// exhaust only while a stage is actually burning (is it still under power?),
// a flash at the failure instant (that is where it broke), and a dropped
// piece at separation. The right-hand gauge repeats the same two numbers as
// text for anyone who blinked.

const PLAYBACK_SECONDS = 8; // a whole flight, however long, plays in ~8s

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** Deterministic little LCG so the starfield does not sparkle between frames. */
function makeStars(count, w, h) {
  let s = 0x2f6e2b1;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    stars.push({ x: rand() * w, y: rand() * h, r: 0.4 + rand() * 0.9, a: 0.25 + rand() * 0.5 });
  }
  return stars;
}

function formatAlt(m) {
  if (m >= 10000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

/**
 * Altitude at simulated time `t`, linearly interpolated between samples.
 */
function sampleAt(samples, t) {
  if (samples.length === 0) return { alt: 0, vel: 0, stage: 1 };
  if (t <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (t >= last.t) return last;
  // Samples are evenly spaced in t (resolver decimates to sampleEvery), but
  // do not rely on it: binary search.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return {
    t,
    alt: a.alt + (b.alt - a.alt) * f,
    vel: a.vel + (b.vel - a.vel) * f,
    stage: a.stage,
  };
}

/**
 * Intervals during which a stage is producing thrust, derived from the
 * timeline: an 'ignition' opens one, the next 'burnout' or 'failure' closes it.
 */
function burnIntervals(timeline) {
  const out = [];
  let open = null;
  for (const ev of timeline) {
    if (ev.kind === 'ignition') {
      if (open) open.end = ev.t;
      open = { start: ev.t, end: Infinity, stage: ev.stage };
      out.push(open);
    } else if (ev.kind === 'burnout' || ev.kind === 'failure') {
      if (open) {
        open.end = ev.t;
        open = null;
      }
    }
  }
  return out;
}

/**
 * Play an outcome on a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} outcome  from resolveLaunch
 * @param {object} [opts]
 * @param {(event: object) => void} [opts.onEvent] called at the playback time
 *        the timeline event happens (so the ticker fills in as it flies)
 * @param {() => void} [opts.onDone]  called once, when playback finishes
 * @param {number} [opts.speed] simulated seconds per real second; default is
 *        totalT / 8, i.e. any flight plays in about eight seconds
 * @param {number} [opts.requirement] mission requirement altitude, m — drawn
 *        as the dashed line and folded into the vertical scale
 * @returns {{ skip(): void, stop(): void, done: boolean }}
 */
export function playOutcome(canvas, outcome, opts = {}) {
  const samples = outcome?.samples ?? [];
  const timeline = [...(outcome?.timeline ?? [])].sort((a, b) => a.t - b.t);
  const failure = outcome?.failure ?? null;

  const lastSampleT = samples.length ? samples[samples.length - 1].t : 0;
  const lastEventT = timeline.length ? timeline[timeline.length - 1].t : 0;
  const totalT = Math.max(lastSampleT, lastEventT, 0);

  const requirement = Math.max(opts.requirement ?? 0, 0);
  // The scale is set from the target only, never from the outcome: the top
  // of the gauge must not tell the player the apogee before the flight
  // does. If the rocket climbs past the headroom, the scale grows with it.
  let scaleAlt = Math.max(requirement, 1000) * 1.25;
  function growScale(alt) {
    if (alt > scaleAlt * 0.9) scaleAlt = alt / 0.9;
  }

  const speed = opts.speed ?? (totalT > 0 ? totalT / PLAYBACK_SECONDS : 1);
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : () => {};

  const ctx = canvas.getContext('2d');
  const burns = burnIntervals(timeline);
  const separations = timeline.filter((e) => e.kind === 'separation');

  // The flight scene is always a night sky, in either colour scheme: a light
  // theme's near-black --fg would vanish against it. Only the two signal
  // colours are taken from the stylesheet, and they are theme-independent.
  const colors = {
    bg: '#0a0f18',
    fg: '#e8e8e8',
    muted: '#6b7280',
    border: '#242a33',
    accent: cssVar(canvas, '--accent', '#00d4ff'),
    fail: cssVar(canvas, '--fail', '#ff6b6b'),
  };

  let w = 0;
  let h = 0;
  let stars = [];
  let raf = 0;
  let startedAt = 0;
  let simT = 0;
  let emitted = 0;
  let stopped = false;
  const handle = { done: false, skip, stop };

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
    // Only when the box actually changed: the starfield is fixed for a flight.
    if (changed || stars.length === 0) stars = makeStars(48, w, h);
  }

  // ---- geometry ----------------------------------------------------------
  const GAUGE_W = 58;
  const TOP_PAD = 18;
  const GROUND_H = 22;

  const flightW = () => w - GAUGE_W;
  const groundY = () => h - GROUND_H;
  const altToY = (alt) => {
    const top = TOP_PAD;
    const bottom = groundY();
    const f = Math.min(Math.max(alt / scaleAlt, 0), 1);
    return bottom - f * (bottom - top);
  };

  function isBurning(t) {
    return burns.some((b) => t >= b.start && t < b.end);
  }

  // ---- drawing -----------------------------------------------------------
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, groundY());
    g.addColorStop(0, '#05060a');
    g.addColorStop(1, colors.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Stars fade in with altitude: the sky "opens up" as the rocket climbs.
    const openness = Math.min(1, simAlt() / Math.max(scaleAlt * 0.5, 1));
    ctx.fillStyle = colors.fg;
    for (const s of stars) {
      if (s.y > groundY()) continue;
      ctx.globalAlpha = s.a * openness;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawGround() {
    ctx.fillStyle = colors.border;
    ctx.fillRect(0, groundY(), w, h - groundY());
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groundY() + 0.5);
    ctx.lineTo(w, groundY() + 0.5);
    ctx.stroke();
    // Pad
    ctx.fillStyle = colors.muted;
    ctx.fillRect(flightW() / 2 - 14, groundY() - 4, 28, 4);
  }

  function drawRequirementLine() {
    if (requirement <= 0) return;
    const y = altToY(requirement);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = colors.accent;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(flightW(), y + 0.5);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = colors.accent;
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`TARGET ${formatAlt(requirement)}`, 6, y - 3);
  }

  function drawRocket(alt, stage, burning) {
    const x = flightW() / 2;
    const y = altToY(alt);
    const twoStage = separations.length > 0 && stage <= 1;
    const bodyH = twoStage ? 26 : 17;
    const bodyW = 7;

    ctx.save();
    ctx.translate(x, y);

    if (burning) {
      // Flicker is presentation only — nothing here feeds back into state.
      const flick = 0.7 + 0.3 * Math.sin(performance.now() / 35);
      const len = (twoStage ? 20 : 15) * flick;
      const grad = ctx.createLinearGradient(0, bodyH / 2, 0, bodyH / 2 + len);
      grad.addColorStop(0, '#fff2c0');
      grad.addColorStop(0.4, '#ffa53c');
      grad.addColorStop(1, 'rgba(255,80,40,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(-bodyW / 2 - 1, bodyH / 2);
      ctx.lineTo(bodyW / 2 + 1, bodyH / 2);
      ctx.lineTo(0, bodyH / 2 + len);
      ctx.closePath();
      ctx.fill();
    }

    // Body
    ctx.fillStyle = colors.fg;
    ctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
    // Interstage band on a two-stage stack
    if (twoStage) {
      ctx.fillStyle = colors.muted;
      ctx.fillRect(-bodyW / 2, -bodyH / 2 + bodyH * 0.42, bodyW, 2);
    }
    // Nose
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(-bodyW / 2, -bodyH / 2);
    ctx.lineTo(bodyW / 2, -bodyH / 2);
    ctx.lineTo(0, -bodyH / 2 - 8);
    ctx.closePath();
    ctx.fill();
    // Fins
    ctx.fillStyle = colors.muted;
    ctx.beginPath();
    ctx.moveTo(-bodyW / 2, bodyH / 2 - 5);
    ctx.lineTo(-bodyW / 2 - 5, bodyH / 2 + 2);
    ctx.lineTo(-bodyW / 2, bodyH / 2);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bodyW / 2, bodyH / 2 - 5);
    ctx.lineTo(bodyW / 2 + 5, bodyH / 2 + 2);
    ctx.lineTo(bodyW / 2, bodyH / 2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawDebris() {
    // A spent stage drops away and falls behind. Screen-space, deliberately:
    // the point is that the player sees something leave the vehicle.
    for (const sep of separations) {
      if (simT < sep.t) continue;
      const age = (simT - sep.t) / Math.max(speed, 0.0001); // real seconds since
      const alt = sampleAt(samples, sep.t).alt;
      const x = flightW() / 2 + age * 14;
      const y = altToY(alt) + age * age * 90 + age * 12;
      if (y > h) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - age / 3);
      ctx.translate(x, y);
      ctx.rotate(age * 2.4);
      ctx.fillStyle = colors.muted;
      ctx.fillRect(-3, -5, 6, 10);
      ctx.restore();
    }
  }

  function drawFailure() {
    if (!failure || simT < failure.t) return;
    const alt = sampleAt(samples, failure.t).alt;
    const x = flightW() / 2;
    const y = altToY(alt);
    const age = (simT - failure.t) / Math.max(speed, 0.0001);

    // A bright flash right at the moment, then a lingering scorch mark so a
    // skipped playback still shows where it went wrong.
    if (age < 0.6) {
      const f = 1 - age / 0.6;
      ctx.save();
      ctx.globalAlpha = f;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 6 + 26 * (1 - f), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colors.fail;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 10 + 40 * (1 - f), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = colors.fail;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 7, y - 7);
    ctx.lineTo(x + 7, y + 7);
    ctx.moveTo(x + 7, y - 7);
    ctx.lineTo(x - 7, y + 7);
    ctx.stroke();
    ctx.restore();
  }

  function drawGauge(alt) {
    const x = w - GAUGE_W;
    const top = TOP_PAD;
    const bottom = groundY();

    // Bar hard against the right edge, every label right-aligned to its left:
    // the labels then grow leftwards into the panel instead of off-screen.
    const barW = 7;
    const barX = w - barW - 7;
    const labelRight = barX - 6;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x, 0, GAUGE_W, h);
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();

    ctx.fillStyle = colors.border;
    ctx.fillRect(barX, top, barW, bottom - top);

    const f = Math.min(Math.max(alt / scaleAlt, 0), 1);
    const fillH = f * (bottom - top);
    ctx.fillStyle = colors.accent;
    ctx.fillRect(barX, bottom - fillH, barW, fillH);

    // Top of scale
    ctx.fillStyle = colors.muted;
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(formatAlt(scaleAlt), labelRight, top - 12);

    // Requirement tick
    if (requirement > 0) {
      const ry = altToY(requirement);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barX - 4, ry);
      ctx.lineTo(barX + barW, ry);
      ctx.stroke();
      ctx.fillStyle = colors.accent;
      ctx.font = '9px "Courier New", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(formatAlt(requirement), labelRight, ry - 3);
    }
    ctx.restore();
  }

  /** T+ clock and the live altitude, in the empty top-left of the sky. */
  function drawClock(alt) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.muted;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(`T+${Math.round(simT)}s`, 6, 6);
    ctx.font = '9px "Courier New", monospace';
    ctx.fillText('ALT', 6, 23);
    ctx.fillStyle = colors.fg;
    ctx.font = 'bold 13px "Courier New", monospace';
    ctx.fillText(formatAlt(alt), 30, 20);
    ctx.restore();
  }

  function simAlt() {
    return sampleAt(samples, simT).alt;
  }

  function frame() {
    const s = sampleAt(samples, simT);
    growScale(s.alt);
    resize();
    ctx.clearRect(0, 0, w, h);
    drawSky();
    drawRequirementLine();
    drawGround();
    drawDebris();
    if (!failure || simT < failure.t) {
      drawRocket(s.alt, s.stage ?? 1, isBurning(simT));
    }
    drawFailure();
    drawGauge(s.alt);
    drawClock(s.alt);
  }

  function flushEventsTo(t) {
    while (emitted < timeline.length && timeline[emitted].t <= t + 1e-9) {
      const ev = timeline[emitted];
      emitted += 1;
      try {
        onEvent(ev);
      } catch (err) {
        // A broken ticker must not stop the flight.
        console.error('ascent onEvent threw:', err);
      }
    }
  }

  function finish() {
    if (handle.done) return;
    handle.done = true;
    simT = totalT;
    flushEventsTo(totalT);
    frame();
    detach();
    onDone();
  }

  function tick(now) {
    if (stopped) return;
    if (!startedAt) startedAt = now;
    simT = ((now - startedAt) / 1000) * speed;
    if (simT >= totalT) {
      finish();
      return;
    }
    flushEventsTo(simT);
    frame();
    raf = requestAnimationFrame(tick);
  }

  function skip() {
    if (stopped || handle.done) return;
    cancelAnimationFrame(raf);
    finish();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    detach();
  }

  function onPointer(ev) {
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
  // Belt and braces: a synthetic click (tests, keyboard activation) that never
  // produces a pointerdown still skips.
  canvas.addEventListener('click', onPointer);
  window.addEventListener('resize', onResize);

  resize();
  flushEventsTo(0);
  frame();

  if (totalT <= 0) {
    // Nothing to animate (e.g. "insufficient thrust to lift off"): show the
    // static frame, then hand control straight back.
    requestAnimationFrame(() => finish());
  } else {
    raf = requestAnimationFrame(tick);
  }

  return handle;
}
