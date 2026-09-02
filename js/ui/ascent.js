// Side-view ascent renderer with a follow camera. Plays an outcome's samples
// and timeline on a canvas; it never simulates anything itself
// (ARCHITECTURE.md: the resolver never renders, and the renderer never
// decides).
//
// NO-LEAK CONTRACT. Nothing on this screen may reveal how the flight ends
// before the flight shows it. So during playback this module reads exactly
// three things out of the outcome: the samples whose t <= the current sim
// time (the point the rocket is at now, and the path it has already flown —
// that path is the trail), the timeline events whose t <= the current sim
// time (to emit onEvent, and to know which stages have ignited or burnt
// out), and outcome.failure once simT has reached failure.t. It never reads
// outcome.maxAltitude, outcome.maxDownrange, outcome.periapsis,
// outcome.apoapsis, outcome.orbit, outcome.success, outcome.shortBy,
// outcome.readout, samples.length, the last sample's t, or any timeline
// event still in the future.
//
// That closes the two ways this screen used to give the game away:
//   - SCALE. Metres-per-pixel is ONE CONSTANT for the whole game
//     (VIEW_SPAN_M per canvas height, and the SAME number of metres per
//     pixel horizontally) — not the apogee, not the downrange, not the
//     target. A gauge scaled to the apogee announces the result in the
//     first second; one that grows when the rocket nears the top announces
//     it just as loudly, and by not growing announces the opposite; and one
//     scaled to the target still tells the player how a flight compares to
//     what is asked before it has finished. The camera follows the rocket in
//     BOTH axes (phase 1: tier 2 flies sideways, so a vertical-only follow
//     would lose it off the edge), so a fixed zoom works at any altitude and
//     any downrange.
//   - TIMING. The playback rate is a constant — 8x real time while a stage is
//     burning, 24x once the last burnout or a failure has passed, both events
//     the player has already read in the ticker. Never flightLength/duration,
//     which plays a long flight slowly and a short one fast.
// The single thing taken from the far end of the timeline is the time of its
// last event ('end', which the resolver always emits), used only to know when
// to stop. Nothing drawn or timed before that instant depends on it.
//
// What it shows, and why: DESIGN.md §5 says readable failure is the point —
// the animation has to show *why* the run ended where it did. So altitude is
// legible from the world itself (km ticks and a dashed target line, drawn in
// world space so they scroll past), the ground carries marks that scroll
// sideways so downrange is legible the same way, exhaust burns only while a
// stage is actually producing thrust, a flash marks the failure instant, and
// a spent stage drops away at separation.
//
// WORLD COORDINATES. The renderer's world is (downrange, altitude) in metres,
// both straight off the sample. It is deliberately NOT the resolver's (x, y),
// which curve around the planet centre: at 900 km downrange the resolver's y
// is tens of kilometres below the pad while the rocket is 170 km UP. Plotting
// (downrange, alt) is exactly "the planet stays drawn flat" (ARCHITECTURE.md,
// phase 1) — curvature is not shown at this scale.

/** Sim seconds per real second while a stage is burning. */
const BURN_RATE = 8;
/** Multiplier applied once nothing is burning any more: 8 -> 24. */
const COAST_MULT = 3;
// World metres shown per canvas height, and per canvas width at the same
// metres-per-pixel. Fixed for every flight of every mission; the follow
// camera makes altitude and downrange a matter of scrolling, not zoom.
const VIEW_SPAN_M = 15000;
// Labelled tick spacing and unlabelled minor spacing, also fixed.
const TICK_STEP_M = 5000;
const MINOR_STEP_M = 1000;
/** Downrange spacing of the ground's surface marks, m. */
const GROUND_MARK_M = 2000;
/** Rocket's resting height on screen, as a fraction up from the bottom. */
const SCREEN_ANCHOR = 0.58;
/** Altitude, m, at which the sky is fully open (stars at full brightness). */
const SKY_OPEN_ALT = 60000;
/** Ground strip height, px. */
const GROUND_H = 22;
/**
 * How far back the heading is measured, in simulated seconds. The sprite
 * points along the velocity direction, taken as the displacement from the
 * sample this far BEHIND sim time to the sample at sim time — look-behind
 * only, so it cannot leak (a sample's own `vel` is a speed, not a direction).
 */
const HEADING_LOOKBACK = 1;
/** Displacement below which the vehicle counts as not yet moving, m. */
const HEADING_MIN_M = 1;

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

/** Index of the last sample at or before `t`; -1 when there is none. */
function indexAt(samples, t) {
  if (samples.length === 0 || t < samples[0].t) return -1;
  let lo = 0;
  let hi = samples.length - 1;
  if (t >= samples[hi].t) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The flight state at simulated time `t`, linearly interpolated between the
 * two samples that bracket it. Clamping at either end is part of "the sample
 * at the current sim time" — nothing here looks ahead of `t`.
 */
function sampleAt(samples, t) {
  if (samples.length === 0) return { t, alt: 0, vel: 0, stage: 1, downrange: 0 };
  if (t <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (t >= last.t) return last;
  const lo = indexAt(samples, t);
  const a = samples[lo];
  const b = samples[lo + 1];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return {
    t,
    alt: a.alt + (b.alt - a.alt) * f,
    vel: a.vel + (b.vel - a.vel) * f,
    downrange: (a.downrange ?? 0) + ((b.downrange ?? 0) - (a.downrange ?? 0)) * f,
    stage: a.stage,
  };
}

/**
 * Is a stage producing thrust at time `t`?
 *
 * Scans only events at or before `t` — an 'ignition' starts a burn, a
 * 'burnout' or 'failure' ends it — so the answer can never depend on
 * something the player has not been told yet. (Precomputing the intervals
 * would give the same answer, but this way the no-leak property is visible
 * in the code rather than argued about in a comment.)
 */
function burningAt(timeline, t) {
  let burning = false;
  for (const ev of timeline) {
    if (ev.t > t) break;
    if (ev.kind === 'ignition') burning = true;
    else if (ev.kind === 'burnout' || ev.kind === 'failure') burning = false;
  }
  return burning;
}

/**
 * Normalise `opts.requirement` into what the target marker needs.
 *
 * Accepts a bare number (phase 0's altitude in metres) or a mission
 * requirement object — `{ altitude }`, `{ downrange }` or
 * `{ orbit: { periapsis } }` (ARCHITECTURE.md, phase 1). The requirement is
 * known before the flight starts, so drawing it leaks nothing.
 */
function normalizeRequirement(req) {
  if (typeof req === 'number') {
    return req > 0 ? { kind: 'altitude', value: req } : null;
  }
  if (!req || typeof req !== 'object') return null;
  if (typeof req.altitude === 'number') return { kind: 'altitude', value: req.altitude };
  if (typeof req.downrange === 'number') return { kind: 'downrange', value: req.downrange };
  if (req.orbit && typeof req.orbit.periapsis === 'number') {
    return { kind: 'orbit', value: req.orbit.periapsis };
  }
  return null;
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
 * @param {number} [opts.speed] base rate, simulated seconds per real second
 *        while burning; the coast rate is COAST_MULT times it. Tests use this
 *        to run a flight quickly; gameplay never sets it.
 * @param {number|object} [opts.requirement] the mission requirement — a bare
 *        altitude in metres (phase 0) or a requirement object (phase 1). Drawn
 *        as the dashed target marker; it is NOT an input to the scale.
 * @param {number} [opts.stages] how many stages the vehicle has (from the
 *        vehicle, not the outcome) so the sprite can be drawn as a stack
 *        before the first separation. Defaults to 1.
 * @returns {{ skip(): void, stop(): void, done: boolean }}
 */
export function playOutcome(canvas, outcome, opts = {}) {
  const samples = outcome?.samples ?? [];
  const timeline = [...(outcome?.timeline ?? [])].sort((a, b) => a.t - b.t);
  const failure = outcome?.failure ?? null;

  // The only look-ahead in the module: when to stop. The resolver always ends
  // the timeline with an 'end' event at the final simulated instant.
  const finalT = timeline.length ? Math.max(timeline[timeline.length - 1].t, 0) : 0;

  const target = normalizeRequirement(opts.requirement);
  const stageCount = Math.max(opts.stages ?? 1, 1);
  const tickStep = TICK_STEP_M;
  const viewSpan = VIEW_SPAN_M;

  const baseRate = opts.speed ?? BURN_RATE;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : () => {};

  const ctx = canvas.getContext('2d');

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
  let mPerPx = 1;     // world metres per CSS pixel — fixed for the flight,
                      // and the same in both axes
  let anchorY = 0;    // screen y the rocket rests at once it has climbed
  let padY = 0;       // screen y of the ground while the camera is on the pad
  let liftAlt = 0;    // altitude at which the camera starts following
  let camAlt = 0;     // world altitude currently at anchorY
  let camX = 0;       // world downrange currently at the horizontal centre
  let stars = [];

  let raf = 0;
  let lastNow = 0;
  let realT = 0;      // real seconds of playback elapsed (for debris ages)
  let simT = 0;
  let emitted = 0;
  let stopped = false;
  let skipped = false;
  const stamps = new Map();   // timeline event -> realT when it was passed
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
    mPerPx = viewSpan / Math.max(h, 1);
    anchorY = h * (1 - SCREEN_ANCHOR);
    padY = h - GROUND_H;
    liftAlt = Math.max(0, (padY - anchorY) * mPerPx);
    // Only when the box actually changed: the starfield is fixed for a flight.
    if (changed || stars.length === 0) stars = makeStars(48, w, h);
  }

  // ---- camera ------------------------------------------------------------
  // World is (downrange, altitude) in metres, screen is pixels. Below liftAlt
  // the camera sits on the pad and the rocket climbs the screen; above it the
  // rocket is pinned at anchorY and the world scrolls down past it.
  // Horizontally the rocket is always at the centre, so the pad and the
  // ground marks slide left as it flies downrange.
  const altToY = (alt) => anchorY - (alt - camAlt) / mPerPx;
  const yToAlt = (y) => camAlt - (y - anchorY) * mPerPx;
  const drToX = (dr) => w / 2 + (dr - camX) / mPerPx;
  const xToDr = (x) => camX + (x - w / 2) * mPerPx;
  const ageOf = (stamp) => (skipped || stamp === undefined ? 1e9 : realT - stamp);

  /**
   * Heading at sim time `t`: the angle of the velocity direction from
   * straight up, radians, clockwise (downrange-positive). Measured from the
   * displacement over the last HEADING_LOOKBACK simulated seconds, so it
   * only ever reads samples at or before `t`.
   */
  function headingAt(t) {
    const now = sampleAt(samples, t);
    const then = sampleAt(samples, Math.max(0, t - HEADING_LOOKBACK));
    const dDr = (now.downrange ?? 0) - (then.downrange ?? 0);
    const dAlt = now.alt - then.alt;
    if (Math.hypot(dDr, dAlt) < HEADING_MIN_M) return 0;
    return Math.atan2(dDr, dAlt);
  }

  // ---- drawing -----------------------------------------------------------
  function drawSky(alt) {
    // Openness is a function of altitude against a fixed constant, never of
    // the scale or the outcome.
    const openness = Math.min(1, Math.max(alt, 0) / SKY_OPEN_ALT);

    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);
    // A little atmospheric glow near the bottom that thins out as you climb.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(10,15,24,0)');
    g.addColorStop(1, `rgba(16,26,44,${0.85 * (1 - openness)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Stars fade in with altitude and drift with the camera in both axes —
    // slowly, so they read as far away.
    const scrollY = ((camAlt - liftAlt) / mPerPx) * 0.12;
    const scrollX = (camX / mPerPx) * 0.04;
    ctx.fillStyle = colors.fg;
    for (const s of stars) {
      const y = ((s.y + scrollY) % h + h) % h;
      const x = ((s.x - scrollX) % w + w) % w;
      ctx.globalAlpha = s.a * openness;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Horizontal km ticks in world space, so altitude reads off the world. */
  function drawTicks() {
    const first = Math.max(1, Math.ceil(Math.max(yToAlt(h), 0) / tickStep));
    const last = Math.floor(yToAlt(0) / tickStep);
    if (last < first || last - first > 60) return;

    ctx.save();
    // Minor ticks first, faint and unlabelled, so the labelled ones sit on top.
    const mFirst = Math.max(1, Math.ceil(Math.max(yToAlt(h), 0) / MINOR_STEP_M));
    const mLast = Math.floor(yToAlt(0) / MINOR_STEP_M);
    ctx.strokeStyle = colors.border;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    for (let k = mFirst; k <= mLast; k += 1) {
      const alt = k * MINOR_STEP_M;
      if (alt % tickStep === 0) continue;
      const y = Math.round(altToY(alt)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (let k = first; k <= last; k += 1) {
      const alt = k * tickStep;
      const y = Math.round(altToY(alt)) + 0.5;
      ctx.strokeStyle = colors.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      // A label whose line is right against the top edge would be clipped;
      // the line alone still reads.
      if (y > 12) {
        ctx.fillStyle = colors.muted;
        ctx.fillText(`${Math.round(alt / 1000)} km`, w - 6, y - 3);
      }
    }
    ctx.restore();
  }

  /**
   * The ground: flat, at altitude 0, across the whole width however far
   * downrange the camera has panned (it extends for ever in both
   * directions). The pad sits at downrange 0 and scrolls away behind the
   * rocket; the surface marks are what make the horizontal motion legible.
   */
  function drawGround() {
    const gy = altToY(0);
    if (gy > h) return;
    ctx.fillStyle = colors.border;
    ctx.fillRect(0, gy, w, Math.max(h - gy, 0));
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(w, gy + 0.5);
    ctx.stroke();

    // Surface marks every GROUND_MARK_M of downrange.
    const firstMark = Math.ceil(xToDr(0) / GROUND_MARK_M);
    const lastMark = Math.floor(xToDr(w) / GROUND_MARK_M);
    if (lastMark - firstMark <= 200) {
      ctx.strokeStyle = colors.muted;
      ctx.globalAlpha = 0.5;
      for (let k = firstMark; k <= lastMark; k += 1) {
        const mx = Math.round(drToX(k * GROUND_MARK_M)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(mx, gy + 1);
        ctx.lineTo(mx, Math.min(gy + 7, h));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Pad, at downrange 0.
    const px = drToX(0);
    if (px > -30 && px < w + 30) {
      ctx.fillStyle = colors.muted;
      ctx.fillRect(px - 14, gy - 4, 28, 4);
    }
  }

  /** The dashed marker for what the mission asks for. */
  function drawTargetLine() {
    if (!target || !(target.value > 0)) return;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = colors.accent;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;

    if (target.kind === 'downrange') {
      // A vertical line standing at the required downrange.
      const x = drToX(target.value);
      if (x > -60 && x < w + 60) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = colors.accent;
        ctx.font = '10px "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`TARGET ${formatAlt(target.value)} DR`, Math.min(x + 4, w - 110), 6);
        return;
      }
      ctx.restore();
      return;
    }

    const y = altToY(target.value);
    if (y < -20 || y > h + 20) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = colors.accent;
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = target.kind === 'orbit'
      ? `TARGET ORBIT ${formatAlt(target.value)}`
      : `TARGET ${formatAlt(target.value)}`;
    ctx.fillText(label, 6, y - 3);
  }

  /**
   * The path already flown. Only samples at or before sim time are read —
   * the trail can never run ahead of the rocket, which is the whole reason
   * it is safe to draw at all.
   */
  function drawTrail(curDr, curAlt) {
    const end = indexAt(samples, simT);
    if (end < 1) return;
    const pts = [];
    for (let i = end; i >= 0; i -= 1) {
      const px = drToX(samples[i].downrange ?? 0);
      const py = altToY(samples[i].alt);
      pts.push([px, py]);
      // Stop once the trail has left the viewport: the segment that crosses
      // the edge is included, everything past it is clipped away anyway.
      if (px < -w || px > 2 * w || py < -h || py > 2 * h) break;
    }
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = colors.accent;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(drToX(curDr), altToY(curAlt));
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.stroke();
    ctx.restore();
  }

  function drawRocket(dr, alt, stage, burning, heading) {
    const x = drToX(dr);
    const y = altToY(alt);
    // Sprite shape comes from the vehicle (how many stages it has) and the
    // stage flying now — never from a separation that has not happened yet.
    const stacked = stageCount > 1 && stage <= 1;
    const bodyH = stacked ? 26 : 17;
    const bodyW = 7;

    ctx.save();
    ctx.translate(x, y);
    // Nose along the velocity direction: vertical on the pad, pitching over
    // as the gravity turn takes hold, nose-down again on the way back in.
    ctx.rotate(heading);

    if (burning) {
      // Flicker is presentation only — nothing here feeds back into state.
      const flick = 0.7 + 0.3 * Math.sin(performance.now() / 35);
      const len = (stacked ? 20 : 15) * flick;
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
    // Interstage band on a stacked vehicle
    if (stacked) {
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

  /** A tumbling chunk: a spent stage, or the vehicle itself after a failure. */
  function drawChunk(x, y, age, fade) {
    if (y > h + 20 || y < -20 || x < -20 || x > w + 20) return;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x, y);
    ctx.rotate(age * 2.4);
    ctx.fillStyle = colors.muted;
    ctx.fillRect(-3, -5, 6, 10);
    ctx.restore();
  }

  function drawDebris() {
    // A spent stage drops away and falls behind. Its world position is the
    // position at separation (a past event); the fall itself is a screen-space
    // offset, because at these scales a real ballistic drop is sub-pixel.
    for (const ev of timeline) {
      if (ev.kind !== 'separation') continue;
      if (simT < ev.t) break;
      const age = ageOf(stamps.get(ev));
      const fade = Math.max(0, 1 - age / 3);
      if (fade <= 0) continue;
      const at = sampleAt(samples, ev.t);
      const y = altToY(at.alt) + age * age * 90 + age * 12;
      drawChunk(drToX(at.downrange ?? 0) + age * 14, y, age, fade);
    }
  }

  function drawFailure(dr, alt) {
    if (!failure || simT < failure.t) return;
    const at = sampleAt(samples, failure.t);
    const x = drToX(at.downrange ?? 0);
    const y = altToY(at.alt);
    const age = ageOf(stamps.get(timeline.find((e) => e.kind === 'failure')));

    // The wreck keeps coasting, so the camera still has something to follow.
    drawChunk(drToX(dr), altToY(alt), age, 0.9);

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
    if (y < -20 || y > h + 20 || x < -20 || x > w + 20) return;
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

  /** T+ clock, live altitude, speed and downrange in the top-left of the sky. */
  function drawReadout(alt, vel, dr) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.muted;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(`T+${Math.round(simT)}s`, 6, 6);

    const line = (label, text, top) => {
      ctx.font = '9px "Courier New", monospace';
      ctx.fillStyle = colors.muted;
      ctx.fillText(label, 6, top + 3);
      ctx.fillStyle = colors.fg;
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.fillText(text, 30, top);
    };
    line('ALT', formatAlt(alt), 20);
    line('SPD', `${Math.round(vel)} m/s`, 38);
    line('DR', formatAlt(dr), 56);
    ctx.restore();
  }

  function frame() {
    resize();
    const s = sampleAt(samples, simT);
    const alt = Math.max(s.alt, 0);
    const dr = Math.max(s.downrange ?? 0, 0);
    camAlt = Math.max(alt, liftAlt);
    camX = dr;

    ctx.clearRect(0, 0, w, h);
    drawSky(alt);
    drawTicks();
    drawTargetLine();
    drawGround();
    drawTrail(dr, alt);
    drawDebris();
    if (!failure || simT < failure.t) {
      drawRocket(dr, alt, s.stage ?? 1, burningAt(timeline, simT), headingAt(simT));
    }
    drawFailure(dr, alt);
    drawReadout(alt, s.vel ?? 0, dr);
  }

  function flushEventsTo(t) {
    while (emitted < timeline.length && timeline[emitted].t <= t + 1e-9) {
      const ev = timeline[emitted];
      emitted += 1;
      stamps.set(ev, realT);
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
    simT = finalT;
    flushEventsTo(finalT);
    frame();
    detach();
    onDone();
  }

  function tick(now) {
    if (stopped) return;
    if (!lastNow) lastNow = now;
    // Cap the step so a backgrounded tab does not teleport the rocket.
    const dt = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    realT += dt;
    // Fixed rates, chosen by what the player has already been shown: full
    // speed while an engine is lit, faster once it is not.
    const rate = burningAt(timeline, simT) ? baseRate : baseRate * COAST_MULT;
    simT += dt * rate;
    if (simT >= finalT) {
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
    skipped = true;
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

  if (finalT <= 0) {
    // Nothing to animate (e.g. "insufficient thrust to lift off"): show the
    // static frame, then hand control straight back.
    requestAnimationFrame(() => finish());
  } else {
    raf = requestAnimationFrame(tick);
  }

  return handle;
}
