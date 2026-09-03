// Side-view ascent renderer with a follow camera. Plays an outcome's samples
// and timeline on a canvas; it never simulates anything itself
// (ARCHITECTURE.md: the resolver never renders, and the renderer never
// decides).
//
// NO-LEAK CONTRACT. Nothing on this screen may reveal how the flight ends
// before the flight shows it. So during playback this module reads exactly
// two things out of the outcome: the samples whose t <= the current sim time
// (the point the rocket is at now, and the path it has already flown — that
// path is the trail), and the timeline events whose t <= the current sim
// time (to emit onEvent, to know which stages have ignited or burnt out, and
// to know that a stage has blown up, where, and whether the flight survived
// it). It never reads outcome.failure, outcome.escapes, outcome.maxAltitude,
// outcome.maxDownrange, outcome.periapsis, outcome.apoapsis, outcome.orbit,
// outcome.success, outcome.shortBy, outcome.readout, samples.length, the
// last sample's t, or any timeline event still in the future.
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
// The single thing taken from the far end of the timeline is the time
// playback ENDS at, used only to know when to stop. Nothing drawn or timed
// before that instant depends on it. That is normally the last event ('end',
// which the resolver always emits); on a tier 3 target mission the caller
// passes `opts.stopAtKind = 'insertion'` and it is the first event of that
// kind instead, because the flight continues on another view from there
// (js/ui/map.js plays the orbital phase on this same canvas). Stopping at an
// event leaks nothing either: the screen changes at the instant the player
// reads that event in the ticker, never before it, and a flight that never
// inserts has no such event and plays to its end exactly as it always did.
//
// What it shows, and why: DESIGN.md §5 says readable failure is the point —
// the animation has to show *why* the run ended where it did. So altitude is
// legible from the world itself (km ticks and a dashed target line, drawn in
// world space so they scroll past), the ground carries marks that scroll
// sideways so downrange is legible the same way, exhaust burns only while a
// stage is actually producing thrust, a flash marks each failure instant, and
// a spent stage drops away at separation — including the one an abort throws
// clear, which is a separation like any other. The sprite is stage-accurate:
// one segment per stage of the BUILT vehicle (stackGeometry, sized by each stage's
// mass), each with its own engine nozzle, an interstage band between every
// pair, and at separation the segment that actually dropped is what falls.
//
// SKY. The sky is a pure function of the CURRENT altitude — day blue at the
// pad, darkening on an eased ramp from 10 km, near-black by 60 km, black by
// 100 km, with the bottom (horizon) band holding its blue on a slower ramp out
// to 120 km, the way the real atmosphere looks seen edge-on. Stars fade in
// with that same darkness, and a deterministic world-space cloud layer sits at
// 1.5-9 km. Nothing in it reads the outcome: no apogee, no target, no rng.
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
// ---- sky model ------------------------------------------------------------
// All of it is a function of the rocket's current altitude and these
// constants; none of it may touch the outcome (see the SKY note above).
/** Below this altitude, m, the sky is fully daytime blue. */
const SKY_DAY_ALT = 10000;
/** Altitude, m, at which the top of the sky is near-black (SKY_NEAR_DARK). */
const SKY_DARK_ALT = 60000;
/** Altitude, m, at which the top of the sky is fully night. */
const SKY_BLACK_ALT = 100000;
/** Same two altitudes for the horizon band, which keeps its blue longer. */
const SKY_HORIZON_DARK_ALT = 90000;
const SKY_HORIZON_BLACK_ALT = 120000;
/** Darkness reached at the *_DARK_ALT knee; the last sliver runs to *_BLACK_ALT. */
const SKY_NEAR_DARK = 0.92;
/** Ease exponent of the ramp: <2 darkens quickly at first, then eases in. */
const SKY_EASE = 1.6;
/** Darkness at which stars start to show, and at which they are at full alpha. */
const STAR_ON_DARK = 0.50;
const STAR_FULL_DARK = 0.96;
/** Stars in the field; the CSS-pixel canvas is ~360x480 so this is dense but not noisy. */
const STAR_COUNT = 260;

/** Daytime sky, top of view -> horizon. */
const DAY_TOP = [47, 127, 214];        // #2f7fd6
const DAY_HORIZON = [159, 208, 255];   // #9fd0ff
/** Night sky, the palette this screen has always ended on. */
const NIGHT_TOP = [5, 6, 10];          // #05060a
const NIGHT_HORIZON = [14, 23, 39];    // #0e1727
/** Ink for lines and text drawn over a bright sky. */
const DAY_INK = [16, 34, 56];
/** Accent (target line, trail, nose) darkened for a bright sky. */
const DAY_ACCENT = [0, 86, 122];
/** Ground under a day sky: muted green-brown land, and its surface marks. */
const DAY_GROUND = [92, 104, 66];
const DAY_GROUND_LINE = [140, 152, 104];

// ---- clouds ---------------------------------------------------------------
/** Downrange band the cloud layer covers before it repeats, m. */
const CLOUD_BAND_START_M = -40000;
const CLOUD_BAND_END_M = 200000;
/** Nominal downrange spacing of cloud slots, m (each one is jittered). */
const CLOUD_SPACING_M = 2200;
/** Altitude band the clouds live in, m. */
const CLOUD_MIN_ALT_M = 1500;
const CLOUD_MAX_ALT_M = 9000;
/** Cloud width in world metres. */
const CLOUD_MIN_W_M = 800;
const CLOUD_MAX_W_M = 3000;
/** Hard cap on clouds evaluated per frame. */
const CLOUD_MAX_DRAWN = 40;
/** Fixed seed: every launch sees the same clouds. NOT the outcome's rng. */
const CLOUD_SEED = 0x5bf03635;
/** Number of cloud slots in the band; beyond it, slot shapes repeat. */
const CLOUD_SLOTS = Math.round((CLOUD_BAND_END_M - CLOUD_BAND_START_M) / CLOUD_SPACING_M);

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

// ---- sprite geometry ------------------------------------------------------
// The rocket is drawn as one segment per stage of the built vehicle. Every
// number here is a function of the vehicle alone (its stages' masses), which
// is known before the flight: nothing in the sprite may read the outcome.
/** Body px per cube-root-kilogram of a stage's dry + propellant mass. */
const PX_PER_CBRT_KG = 4;
/** No segment shorter than this, so a light upper stage stays legible. */
const MIN_SEG_H = 9;
/** Bottom stage width, px; each stage above is TAPER of the one below. */
const BOTTOM_W = 10;
const TAPER = 0.85;
const MIN_W = 5;

// Failure effect, in real seconds of playback and screen pixels (scaled by
// the failed stage's width / 8). Lives are how long each part is on screen.
const FIREBALL_LIFE = 1.1;
const SMOKE_LIFE = 2.8;
const SHOCK_LIFE = 0.7;
const SHAKE_LIFE = 0.45;
const FRAG_LIFE = 1.9;
const FRAG_COUNT = 14;
const FRAG_GRAVITY = 150;   // px/s^2, screen-space like the debris fall
const SPARK_COUNT = 26;
const SPARK_GRAVITY = 220;
const WRECK_PUFFS = 6;
const WRECK_FIRE = 7;       // the wreck burns this long
/** Nose cone height above the topmost attached segment, px. */
const NOSE_H = 8;
/** Engine nozzle poking out below each segment, px. */
const NOZZLE_H = 3;
/** Interstage band at the top of a lower segment, px. */
const BAND_H = 2;
/**
 * Real seconds the stack above a spent stage takes to settle onto the sample
 * point after a separation. The nozzle of the new bottom stage would otherwise
 * re-anchor on the point and drop the whole stack by the spent stage's height
 * in one frame, while the trajectory itself is continuous.
 */
const SEPARATION_SETTLE_S = 1.2;
/** What a stage counts as when only a stage COUNT is given: the starter. */
const NOMINAL_STAGE = { dryMass: 40, propMass: 30 };

/**
 * Sprite geometry of the vehicle's stack, for the part still attached.
 *
 * @param {Array<{dryMass:number, propMass:number}>|number} stages the built
 *        vehicle's stages, bottom first (only `dryMass` and `propMass` are
 *        read), or a plain count N meaning N equal starter-sized stages.
 * @param {number} [currentStage] 1-based stage currently flying; every stage
 *        below it has separated and is left out.
 * @returns {{ segments: Array<{height:number, width:number, fins:boolean}>,
 *             bodyHeight: number, noseHeight: number, height: number,
 *             count: number }}
 *   `segments` is bottom first. A segment's height grows with its stage's
 *   total mass as its cube root (PX_PER_CBRT_KG per cbrt(kg), never below
 *   MIN_SEG_H); widths start at BOTTOM_W and taper by TAPER per stage up, never
 *   below MIN_W; `fins` is true only on the bottom stage of the FULL vehicle.
 *   `bodyHeight` is the attached segments summed, `height` adds the nose cone,
 *   `count` is the full vehicle's stage count. Pure and deterministic: it
 *   reads the vehicle, never the outcome.
 */
export function stackGeometry(stages, currentStage = 1) {
  let list;
  if (typeof stages === 'number') {
    const n = Math.max(1, Math.floor(stages));
    list = Array.from({ length: n }, () => NOMINAL_STAGE);
  } else if (Array.isArray(stages) && stages.length > 0) {
    list = stages;
  } else {
    list = [NOMINAL_STAGE];
  }
  let width = BOTTOM_W;
  const all = list.map((s, i) => {
    const mass = Math.max(0, (Number(s?.dryMass) || 0) + (Number(s?.propMass) || 0));
    const height = Math.max(MIN_SEG_H, Math.round(Math.cbrt(mass) * PX_PER_CBRT_KG));
    const seg = { height, width: Math.max(MIN_W, Math.round(width)), fins: i === 0 };
    width *= TAPER;
    return seg;
  });
  const first = Math.min(Math.max(Math.floor(currentStage ?? 1) - 1, 0), all.length - 1);
  const segments = all.slice(first);
  const bodyHeight = segments.reduce((sum, seg) => sum + seg.height, 0);
  return {
    segments,
    bodyHeight,
    noseHeight: NOSE_H,
    height: bodyHeight + NOSE_H,
    count: all.length,
  };
}

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Linear blend of two [r,g,b] triples. */
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

/** '#rgb' / '#rrggbb' -> [r,g,b]; anything else falls back. */
function parseHex(hex, fallback) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return fallback;
  const s = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/**
 * How dark the sky is at altitude `alt`: 0 = full daylight, 1 = night.
 *
 * Flat at 0 below SKY_DAY_ALT, then an eased ramp (fast at first, easing in)
 * to SKY_NEAR_DARK at `darkAlt`, then the last sliver linearly to 1 at
 * `blackAlt`. Two altitudes are passed because the horizon band runs the same
 * shape on a slower schedule — the atmosphere is thickest seen edge-on, so the
 * bottom of the view keeps its blue long after the top has gone black.
 */
function darknessAt(alt, darkAlt, blackAlt) {
  const k = clamp01((alt - SKY_DAY_ALT) / (darkAlt - SKY_DAY_ALT));
  const knee = SKY_NEAR_DARK * (1 - Math.pow(1 - k, SKY_EASE));
  const rest = (1 - SKY_NEAR_DARK) * clamp01((alt - darkAlt) / (blackAlt - darkAlt));
  return clamp01(knee + rest);
}

/**
 * Deterministic hash of (slot, salt) -> [0,1). A fixed seed, so the cloud
 * layer is identical on every launch of every flight — it is scenery, not an
 * outcome, and must never be able to hint at one.
 */
function cloudRand(slot, salt) {
  let x = (Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b) ^ CLOUD_SEED) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2545f491) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0x27d4eb2f) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
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
    // Skewed toward many faint pinpricks with a few bright ones, so density
    // reads as depth rather than noise.
    const k = rand() ** 2.2;
    stars.push({ x: rand() * w, y: rand() * h, r: 0.3 + k * 1.3, a: 0.18 + k * 0.72 });
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
 * something the player has not been told yet. That handles an abort without
 * knowing anything about one: the failure puts the engine out, and the
 * escaped stage's ignition a couple of seconds later lights it again.
 * (Precomputing the intervals would give the same answer, but this way the
 * no-leak property is visible in the code rather than argued about in a
 * comment.)
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
 * @param {object} [opts.vehicle] the built vehicle (js/core/vehicle.js), so
 *        the sprite can be drawn as the actual stack — one segment per stage,
 *        sized by mass (stackGeometry) — and so the segment that drops at a
 *        separation is the stage that separated. From the vehicle, never the
 *        outcome.
 * @param {number} [opts.stages] older form: a stage COUNT, drawn as that many
 *        equal segments. Used only when `opts.vehicle` is absent. Defaults
 *        to 1.
 * @param {string} [opts.stopAtKind] stop at the FIRST timeline event of this
 *        kind instead of at the last event, so another view can take the
 *        canvas over from there (phase 2: 'insertion' hands off to
 *        js/ui/map.js). Ignored when the timeline has no such event.
 * @returns {{ skip(): void, stop(): void, done: boolean }}
 */
export function playOutcome(canvas, outcome, opts = {}) {
  const samples = outcome?.samples ?? [];
  const timeline = [...(outcome?.timeline ?? [])].sort((a, b) => a.t - b.t);

  // The only look-ahead in the module: when to stop. The resolver always ends
  // the timeline with an 'end' event at the final simulated instant; a caller
  // handing the canvas on at a mid-flight event (opts.stopAtKind) ends there
  // instead. Either way it is one instant, used for nothing but the stop.
  const handoff = opts.stopAtKind
    ? (timeline.find((ev) => ev.kind === opts.stopAtKind) ?? null)
    : null;
  const finalT = handoff
    ? Math.max(handoff.t, 0)
    : (timeline.length ? Math.max(timeline[timeline.length - 1].t, 0) : 0);

  const target = normalizeRequirement(opts.requirement);
  // Sprite geometry from the vehicle (or a bare count), fixed for the flight;
  // the stage flying now picks which of its segments are still attached.
  const fullStack = stackGeometry(opts.vehicle?.stages ?? opts.stages ?? 1, 1).segments;
  const attachedAt = (stage) => fullStack.slice(
    Math.min(Math.max(Math.floor(stage ?? 1) - 1, 0), fullStack.length - 1),
  );
  const tickStep = TICK_STEP_M;
  const viewSpan = VIEW_SPAN_M;

  const baseRate = opts.speed ?? BURN_RATE;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : () => {};

  const ctx = canvas.getContext('2d');

  // The flight scene runs its own palette in either colour scheme (a light
  // theme's near-black --fg would vanish against the night half of the climb);
  // only the two signal colours come from the stylesheet, and they are
  // theme-independent. Everything that has to stay legible against both a
  // bright day sky and a black one is blended between a day and a night value
  // by `sky.dark` — see updateSky().
  const colors = {
    bg: '#0a0f18',
    fg: '#e8e8e8',
    muted: '#a4adb9',
    border: '#3a4350',
    accent: cssVar(canvas, '--accent', '#00d4ff'),
    fail: cssVar(canvas, '--fail', '#ff6b6b'),
  };
  const rgbFg = parseHex(colors.fg, [232, 232, 232]);
  const rgbMuted = parseHex(colors.muted, [164, 173, 185]);
  const rgbBorder = parseHex(colors.border, [58, 67, 80]);
  const rgbAccent = parseHex(colors.accent, [0, 212, 255]);

  // Per-frame sky state, recomputed by updateSky(alt) at the top of frame().
  // `top`/`horizon` are the darkness at the top and bottom of the view,
  // `dark` the mid-screen value every foreground colour blends by.
  const sky = { top: 1, horizon: 1, dark: 1, day: 0, stars: 1, accent: rgbAccent };

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
    if (changed || stars.length === 0) stars = makeStars(STAR_COUNT, w, h);
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
  /**
   * Recompute the sky state for the rocket's current altitude. Every number
   * here is a function of `alt` and the SKY_* constants alone — never the
   * scale, the target, or anything in the outcome.
   */
  function updateSky(alt) {
    const a = Math.max(alt, 0);
    sky.top = darknessAt(a, SKY_DARK_ALT, SKY_BLACK_ALT);
    sky.horizon = darknessAt(a, SKY_HORIZON_DARK_ALT, SKY_HORIZON_BLACK_ALT);
    // What foreground colours blend by: the darkness partway down the view,
    // where most of the ticks, labels and the rocket actually sit.
    sky.dark = sky.top + (sky.horizon - sky.top) * 0.5;
    sky.day = 1 - sky.dark;
    // Stars ride the same darkness value the sky does: nothing at the pad,
    // first ones around 30 km, full by ~80 km.
    sky.stars = clamp01((sky.top - STAR_ON_DARK) / (STAR_FULL_DARK - STAR_ON_DARK));
    sky.accent = mix(DAY_ACCENT, rgbAccent, sky.dark);
  }

  /** Sky colour at screen fraction `f` (0 = top of view, 1 = bottom). */
  function skyColorAt(f) {
    // Day gradient deepens toward the top; the pale band is squeezed to the
    // bottom of the view, which is where the horizon is.
    const day = mix(DAY_TOP, DAY_HORIZON, Math.pow(f, 1.35));
    const night = mix(NIGHT_TOP, NIGHT_HORIZON, f);
    // The horizon's slower darkening only takes over near the bottom.
    const d = sky.top + (sky.horizon - sky.top) * Math.pow(f, 2);
    return mix(day, night, d);
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    // Enough stops that the horizon's separate falloff reads as a gradient
    // rather than as bands.
    for (const f of [0, 0.25, 0.45, 0.62, 0.76, 0.86, 0.94, 1]) {
      g.addColorStop(f, rgba(skyColorAt(f), 1));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Stars fade in with the sky's darkness and drift with the camera in both
    // axes — slowly, so they read as far away.
    if (sky.stars <= 0.01) return;
    const scrollY = ((camAlt - liftAlt) / mPerPx) * 0.12;
    const scrollX = (camX / mPerPx) * 0.04;
    ctx.fillStyle = colors.fg;
    for (const s of stars) {
      const y = ((s.y + scrollY) % h + h) % h;
      const x = ((s.x - scrollX) % w + w) % w;
      ctx.globalAlpha = s.a * sky.stars;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * A cloud layer in world space, so it scrolls in both axes with everything
   * else. Slots are laid out every CLOUD_SPACING_M of downrange and only the
   * ones on screen are evaluated (capped at CLOUD_MAX_DRAWN); each slot's
   * jitter, altitude, size and puffs come from cloudRand's fixed seed, so the
   * clouds are identical on every launch. Past the band the slot index wraps,
   * so a long downrange flight keeps meeting clouds instead of an edge.
   */
  function drawClouds() {
    const fade = sky.day;
    if (fade <= 0.02) return;
    // Vertical cull: is any of the 1.5-9 km band in view?
    if (yToAlt(h) > CLOUD_MAX_ALT_M || yToAlt(0) < CLOUD_MIN_ALT_M) return;

    const margin = CLOUD_MAX_W_M;
    const left = xToDr(0) - margin;
    const right = xToDr(w) + margin;
    const i0 = Math.floor((left - CLOUD_BAND_START_M) / CLOUD_SPACING_M);
    const i1 = Math.min(
      Math.ceil((right - CLOUD_BAND_START_M) / CLOUD_SPACING_M),
      i0 + CLOUD_MAX_DRAWN,
    );

    ctx.save();
    for (let i = i0; i <= i1; i += 1) {
      const slot = ((i % CLOUD_SLOTS) + CLOUD_SLOTS) % CLOUD_SLOTS;
      const dr = CLOUD_BAND_START_M
        + i * CLOUD_SPACING_M
        + (cloudRand(slot, 1) - 0.5) * CLOUD_SPACING_M * 0.8;
      const alt = CLOUD_MIN_ALT_M + cloudRand(slot, 2) * (CLOUD_MAX_ALT_M - CLOUD_MIN_ALT_M);
      const widthPx = (CLOUD_MIN_W_M + cloudRand(slot, 3) * (CLOUD_MAX_W_M - CLOUD_MIN_W_M)) / mPerPx;
      const x = drToX(dr);
      const y = altToY(alt);
      if (x + widthPx < 0 || x - widthPx > w || y + widthPx < 0 || y - widthPx > h) continue;

      const alpha = (0.55 + cloudRand(slot, 4) * 0.30) * fade;
      const puffs = cloudRand(slot, 5) < 0.45 ? 2 : 3;
      for (let p = 0; p < puffs; p += 1) {
        const px = x + (cloudRand(slot, 10 + p) - 0.5) * widthPx * 0.72;
        const py = y - cloudRand(slot, 20 + p) * widthPx * 0.12;
        const rx = widthPx * (0.30 + cloudRand(slot, 30 + p) * 0.22);
        const ry = rx * (0.40 + cloudRand(slot, 40 + p) * 0.20);
        // A radial fade gives the soft edge a flat ellipse cannot; squashing
        // the whole thing vertically keeps that softness in both axes.
        const r = Math.max(rx, 1);
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(1, Math.max(ry / r, 0.05));
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
        grad.addColorStop(0.55, `rgba(252,254,255,${alpha * 0.80})`);
        grad.addColorStop(1, 'rgba(248,252,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** Horizontal km ticks in world space, so altitude reads off the world. */
  function drawTicks() {
    const first = Math.max(1, Math.ceil(Math.max(yToAlt(h), 0) / tickStep));
    const last = Math.floor(yToAlt(0) / tickStep);
    if (last < first || last - first > 60) return;

    ctx.save();
    // Ink follows the sky: dark and semi-transparent over daylight, the muted
    // grey of the night palette once it is dark.
    const lineCol = mix(DAY_INK, rgbBorder, sky.dark);
    // The labels reach their night grey sooner than the lines do: a linear
    // crossfade bottoms out around 40 km, where dark ink and the dark sky are
    // both too close together to read.
    const labelCol = mix(DAY_INK, rgbMuted, Math.min(1, sky.dark * 1.6));
    // Minor ticks first, faint and unlabelled, so the labelled ones sit on top.
    const mFirst = Math.max(1, Math.ceil(Math.max(yToAlt(h), 0) / MINOR_STEP_M));
    const mLast = Math.floor(yToAlt(0) / MINOR_STEP_M);
    ctx.strokeStyle = rgba(lineCol, 0.38 - 0.03 * sky.dark);
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
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (let k = first; k <= last; k += 1) {
      const alt = k * tickStep;
      const y = Math.round(altToY(alt)) + 0.5;
      ctx.strokeStyle = rgba(lineCol, 0.55 + 0.45 * sky.dark);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      // A label whose line is right against the top edge would be clipped;
      // the line alone still reads.
      if (y > 12) {
        ctx.fillStyle = rgba(labelCol, 1);
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
    // Land under a day sky, fading to the night strip on the same curve the
    // sky's horizon band uses, so the palette stays coherent all the way up.
    const groundCol = mix(DAY_GROUND, rgbBorder, sky.horizon);
    const groundLine = mix(DAY_GROUND_LINE, rgbMuted, sky.horizon);
    ctx.fillStyle = rgba(groundCol, 1);
    ctx.fillRect(0, gy, w, Math.max(h - gy, 0));
    ctx.strokeStyle = rgba(groundLine, 1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(w, gy + 0.5);
    ctx.stroke();

    // Surface marks every GROUND_MARK_M of downrange.
    const firstMark = Math.ceil(xToDr(0) / GROUND_MARK_M);
    const lastMark = Math.floor(xToDr(w) / GROUND_MARK_M);
    if (lastMark - firstMark <= 200) {
      ctx.strokeStyle = rgba(groundLine, 1);
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
      ctx.fillStyle = rgba(mix(DAY_INK, rgbMuted, sky.horizon), 1);
      ctx.fillRect(px - 14, gy - 4, 28, 4);
    }
  }

  /** The dashed marker for what the mission asks for. */
  function drawTargetLine() {
    if (!target || !(target.value > 0)) return;
    ctx.save();
    ctx.setLineDash([6, 5]);
    // Cyan on cyan-ish daylight is unreadable, so the accent deepens toward a
    // dark teal as the sky brightens (sky.accent), and back to --accent at night.
    ctx.strokeStyle = rgba(sky.accent, 1);
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
        ctx.fillStyle = rgba(sky.accent, 1);
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

    ctx.fillStyle = rgba(sky.accent, 1);
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
    ctx.strokeStyle = rgba(sky.accent, 1);
    ctx.globalAlpha = 0.28 + 0.24 * sky.day;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(drToX(curDr), altToY(curAlt));
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.stroke();
    ctx.restore();
  }

  // ---- the vehicle ---------------------------------------------------------
  // Everything below draws in the sprite's local frame: x across the body, y
  // down it, the ATTACHED body (nose excluded) centred on the origin. `segs`
  // is bottom first, as stackGeometry returns it. Colours: the body is the
  // night palette's foreground; bands, fins, panel line and nozzles an ink
  // that is dark over daylight and the muted grey at night (the grey alone
  // would vanish against a pale sky, and reads under 2:1 against the near-
  // white tubes); the nose the accent.

  /** Ink colour for the current sky: dark by day, muted grey by night. */
  const inkRgb = () => mix(DAY_INK, rgbMuted, sky.dark);
  const inkColor = () => rgba(inkRgb(), 1);

  /** One stage's tube, with a darker panel line down one side so it reads as a cylinder. */
  function drawSegment(seg, top) {
    const { width: sw, height: sh } = seg;
    ctx.fillStyle = colors.fg;
    ctx.fillRect(-sw / 2, top, sw, sh);
    const panel = Math.max(1, Math.round(sw * 0.22));
    ctx.fillStyle = rgba(inkRgb(), 0.45);
    ctx.fillRect(sw / 2 - panel, top, panel, sh);
    // A near-white sprite disappears against a pale sky, so on a bright one
    // it gets a dark outline. It fades out entirely as the sky goes black.
    if (sky.day > 0.05) {
      ctx.strokeStyle = rgba(DAY_INK, 0.65 * sky.day);
      ctx.lineWidth = 1;
      ctx.strokeRect(-sw / 2 - 0.5, top - 0.5, sw + 1, sh + 1);
    }
  }

  /** The engine bell under a segment whose bottom edge is at `bottom`. */
  function drawNozzle(seg, bottom) {
    const throat = seg.width * 0.26;
    const bell = seg.width * 0.42;
    ctx.fillStyle = inkColor();
    ctx.beginPath();
    ctx.moveTo(-throat, bottom);
    ctx.lineTo(throat, bottom);
    ctx.lineTo(bell, bottom + NOZZLE_H);
    ctx.lineTo(-bell, bottom + NOZZLE_H);
    ctx.closePath();
    ctx.fill();
  }

  /** Fins either side of the bottom stage. */
  function drawFins(seg, bottom) {
    const hw = seg.width / 2;
    ctx.fillStyle = inkColor();
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * hw, bottom - 6);
      ctx.lineTo(side * (hw + 5), bottom + 2);
      ctx.lineTo(side * hw, bottom);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Nose cone on the segment whose top edge is at `top`. */
  function drawNose(seg, top) {
    const hw = seg.width / 2;
    ctx.fillStyle = rgba(sky.accent, 1);
    ctx.beginPath();
    ctx.moveTo(-hw, top);
    ctx.lineTo(hw, top);
    ctx.lineTo(0, top - NOSE_H);
    ctx.closePath();
    ctx.fill();
    if (sky.day > 0.05) {
      ctx.strokeStyle = rgba(DAY_INK, 0.65 * sky.day);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-hw, top);
      ctx.lineTo(0, top - NOSE_H);
      ctx.lineTo(hw, top);
      ctx.stroke();
    }
  }

  /** Exhaust from a nozzle whose bell ends at `from`, scaled to the stage's width. */
  function drawFlame(seg, from) {
    // Flicker is presentation only — nothing here feeds back into state.
    const flick = 0.7 + 0.3 * Math.sin(performance.now() / 35);
    const len = seg.width * 2 * flick;
    const hw = seg.width / 2 + 1;
    const grad = ctx.createLinearGradient(0, from, 0, from + len);
    grad.addColorStop(0, '#fff2c0');
    grad.addColorStop(0.4, '#ffa53c');
    grad.addColorStop(1, 'rgba(255,80,40,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-hw, from);
    ctx.lineTo(hw, from);
    ctx.lineTo(0, from + len);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * The attached stack: every segment's tube, an interstage band between
   * each pair, a nozzle under every segment (each stage has its own engine),
   * fins on the vehicle's bottom stage if it is still attached, the nose on
   * whatever is topmost, and exhaust from the bottom-most nozzle if burning.
   */
  function drawStack(segs, burning) {
    if (segs.length === 0) return;
    // The stack stands on the origin: the bottom nozzle's lip is at y = 0 and
    // the body rises into negative y. The origin is the sample's (downrange,
    // altitude), so a rocket at altitude 0 sits ON the pad; centring it there
    // instead would bury half of it, and the taller the stack the deeper.
    const bottoms = [];
    let y = -NOZZLE_H;
    for (const seg of segs) {
      bottoms.push(y);
      y -= seg.height;
    }
    if (burning) drawFlame(segs[0], bottoms[0] + NOZZLE_H);
    if (segs[0].fins) drawFins(segs[0], bottoms[0]);
    segs.forEach((seg, j) => drawSegment(seg, bottoms[j] - seg.height));
    // Bands and nozzles go on top of the tubes: the band is the top of the
    // lower stage, the upper stage's bell sits over it.
    segs.forEach((seg, j) => {
      if (j > 0) {
        const lower = segs[j - 1];
        ctx.fillStyle = inkColor();
        ctx.fillRect(-lower.width / 2, bottoms[j], lower.width, BAND_H);
      }
      drawNozzle(seg, bottoms[j]);
    });
    const top = segs.length - 1;
    drawNose(segs[top], bottoms[top] - segs[top].height);
  }

  function drawRocket(dr, alt, stage, burning, heading) {
    const x = drToX(dr);
    const y = altToY(alt);
    ctx.save();
    ctx.translate(x, y);
    // Nose along the velocity direction: vertical on the pad, pitching over
    // as the gravity turn takes hold, nose-down again on the way back in.
    ctx.rotate(heading);
    // Which segments are attached comes from the vehicle and the stage flying
    // now — never from a separation that has not happened yet.
    const segs = attachedAt(stage);
    // The point the sprite pivots on slides along its axis with the heading:
    // the engine while the nose is up (a rocket at altitude 0 stands on the
    // pad), the nose once it is down (a rocket back at altitude 0 has hit the
    // ground nose first, and lies on the line rather than under it), and the
    // middle in between. Continuous in the heading, so the pivot never jumps
    // — and it is exactly at the two altitudes where the ground is in frame
    // that it matters. On top of that, for the moment after a separation the
    // stack is still settling down onto the point (separationLift).
    const pivot = (1 - Math.cos(heading)) / 2;
    ctx.translate(0, stackHeight(segs) * pivot - separationLift(pivot));
    drawStack(segs, burning);
    ctx.restore();
  }

  /** Full drawn height of a stack, nozzle lip to nose tip, px. */
  function stackHeight(segs) {
    return segs.reduce((sum, seg) => sum + seg.height, 0) + NOSE_H + NOZZLE_H;
  }

  /** A spent stage tumbling away: the actual segment that dropped. */
  function drawDroppedStage(seg, x, y, age, fade) {
    if (y > h + 30 || y < -30 || x < -30 || x > w + 30) return;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x, y);
    ctx.rotate(age * 2.4);
    if (seg.fins) drawFins(seg, seg.height / 2);
    drawSegment(seg, -seg.height / 2);
    drawNozzle(seg, seg.height / 2);
    ctx.restore();
  }

  /** The full-vehicle segment of a 1-based stage number, clamped into range. */
  function stageSeg(stageNo) {
    return fullStack[Math.min(Math.max((stageNo ?? 1) - 1, 0), fullStack.length - 1)];
  }

  /**
   * How far toward its nose the attached stack is still drawn, px along the
   * body axis, from every stage dropped within the last SEPARATION_SETTLE_S
   * real seconds, fading to zero: the stack stays where it was at the instant
   * of separation and eases onto its new anchor instead of snapping.
   *
   * `pivot` is where on the stack the anchor sits, 0 at the nozzle lip to 1
   * at the nose tip (drawRocket slides it with the heading, the wreck uses
   * the middle). Dropping a segment of height h moves the stack's own anchor
   * by h * pivot toward the nose, so the retained stages jump only by the
   * remaining h * (1 - pivot) — that is the lift that keeps them still.
   * Reads only separations already passed; a skipped playback (age 1e9) has
   * settled completely.
   */
  function separationLift(pivot) {
    let lift = 0;
    for (const ev of timeline) {
      if (ev.kind !== 'separation') continue;
      if (simT < ev.t) break;
      const age = ageOf(stamps.get(ev));
      if (age >= SEPARATION_SETTLE_S) continue;
      lift += stageSeg(ev.stage).height * (1 - pivot) * (1 - age / SEPARATION_SETTLE_S);
    }
    return lift;
  }

  /**
   * The stage flying at simT. Normally the sample's; but a separation that
   * falls between two samples leaves the interpolated sample on the old stage
   * until the next one (sampleAt keeps the earlier sample's stage), during
   * which the spent stage would be drawn still attached — and lifted by
   * separationLift — while it also tumbles away as debris. So the count of
   * separations already passed wins when it is ahead. Reads only events at
   * or before simT.
   */
  function stageAt(sample) {
    let passed = 0;
    for (const ev of timeline) {
      if (ev.t > simT) break;
      if (ev.kind === 'separation') passed += 1;
    }
    return Math.max(sample.stage ?? 1, passed + 1);
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
      // The event names the stage that separated (1-based, from the resolver).
      drawDroppedStage(stageSeg(ev.stage), drToX(at.downrange ?? 0) + age * 14, y, age, fade);
    }
  }

  // ---- failure -------------------------------------------------------------
  // A flight can have MORE THAN ONE failure. A vehicle carrying an abort
  // system (vehicle.escape) survives a failure in one of its bottom stages:
  // the stack above separates clear and lights its own engine a couple of
  // seconds later, and the flight carries on. Such an ESCAPED failure is a
  // 'failure' event carrying `escaped: true`; the TERMINAL one — the one that
  // ends powered flight, at most one per flight and not necessarily there at
  // all — carries no such key.
  //
  // So every 'failure' event already passed draws its own bang, at its own
  // place, at its own age, with its own shrapnel; and only the terminal one
  // leaves a tumbling wreck behind it and stops the rocket being drawn. The
  // stage each event names sets its scale: a booster going up is a bigger
  // bang than an upper stage's. Which event is which is read off the events
  // themselves, and only ever off ones already passed (simT >= ev.t) — never
  // off outcome.failure, which would say that a failure is coming before the
  // flight has shown one.
  //
  // Everything transient here runs on real seconds since the event was passed
  // (ageOf), so it plays at one speed however fast the sim is running by then,
  // and is already over on a skipped playback, which keeps only the scorch
  // marks.

  /** Every 'failure' event at or before simT, in time order. */
  function passedFailures() {
    const out = [];
    for (const ev of timeline) {
      if (ev.t > simT) break;
      if (ev.kind === 'failure') out.push(ev);
    }
    return out;
  }

  /**
   * The terminal failure once simT has reached it, else null. An escaped
   * failure is never terminal: the flight goes on, so the rocket goes on
   * being drawn.
   */
  function terminalFailure() {
    for (const ev of timeline) {
      if (ev.t > simT) break;
      if (ev.kind === 'failure' && !ev.escaped) return ev;
    }
    return null;
  }

  /**
   * Age of the MOST RECENT failure the flight has passed, Infinity if it has
   * passed none. The shake, the linger and the end-of-playback hold all run
   * off this, so each bang plays out in full — including one on a flight that
   * escapes it and carries on.
   */
  const failureAge = () => {
    const passed = passedFailures();
    return passed.length ? ageOf(stamps.get(passed[passed.length - 1])) : Infinity;
  };

  /**
   * Fragments and sparks for one failure, rolled from that failure's own time
   * so they fly the same way every frame. Angles in radians, speeds in px/s.
   *
   * Built the first time the event is DRAWN and kept against the event object:
   * rolling them all up front would mean reading the times of failures that
   * have not happened yet, which the no-leak contract forbids.
   */
  const shrapnelCache = new Map();
  function shrapnelFor(ev) {
    const cached = shrapnelCache.get(ev);
    if (cached) return cached;
    let sd = (0x51ed27 ^ Math.round((ev?.t ?? 0) * 1000)) >>> 0;
    const rand = () => {
      sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0;
      return sd / 4294967296;
    };
    const fragments = Array.from({ length: FRAG_COUNT }, () => ({
      a: rand() * Math.PI * 2,
      v: 60 + rand() * 170,
      len: 3 + rand() * 5,
      w: 1.5 + rand() * 1.5,
      spin: (rand() - 0.5) * 16,
      tint: rand(),
    }));
    const sparks = Array.from({ length: SPARK_COUNT }, () => ({
      a: rand() * Math.PI * 2,
      v: 130 + rand() * 280,
      life: 0.4 + rand() * 0.6,
    }));
    const rolled = { fragments, sparks };
    shrapnelCache.set(ev, rolled);
    return rolled;
  }

  const onScreen = (x, y, pad) => x > -pad && x < w + pad && y > -pad && y < h + pad;

  /** Distance flown by something thrown at `v` and slowed by drag, after `t` seconds. */
  const thrown = (v, t) => v * (1 - Math.exp(-t * 2.2)) / 2.2;

  /** The fireball: white-hot core, orange body, red edge, out fast and gone. */
  function drawFireball(x, y, age, size) {
    const f = age / FIREBALL_LIFE;
    const flick = 0.94 + 0.06 * Math.sin(performance.now() / 23);
    const r = size * (10 + 46 * Math.sqrt(f)) * flick;
    const a = 1 - f * f;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,250,225,${a})`);
    g.addColorStop(0.35, `rgba(255,190,70,${a})`);
    g.addColorStop(0.75, `rgba(255,90,40,${a * 0.7})`);
    g.addColorStop(1, 'rgba(255,60,30,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The smoke the fireball leaves: bigger, slower, rising, and ink-coloured for the sky it is on. */
  function drawSmokeBall(x, y, age, size) {
    const f = age / SMOKE_LIFE;
    const r = size * (12 + 54 * Math.sqrt(f));
    const cy = y - age * 9 * size;
    const col = mix(DAY_INK, rgbMuted, sky.dark);
    const g = ctx.createRadialGradient(x, cy, 0, x, cy, r);
    g.addColorStop(0, rgba(col, 0.55 * (1 - f)));
    g.addColorStop(0.6, rgba(col, 0.32 * (1 - f)));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Two rings racing outward: a pale pressure front and the fail colour behind it. */
  function drawShockwave(x, y, age, size) {
    const f = age / SHOCK_LIFE;
    const r = size * (12 + 110 * f ** 0.6);
    ctx.save();
    ctx.globalAlpha = 1 - f;
    ctx.strokeStyle = 'rgba(255,225,190,1)';
    ctx.lineWidth = 0.5 + 3 * (1 - f);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = colors.fail;
    ctx.lineWidth = 0.5 + 2 * (1 - f);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Bits of the vehicle, thrown out and falling, in the sprite's own colours. */
  function drawFragments(x, y, age, size, shrapnel) {
    if (age >= FRAG_LIFE) return;
    const fade = 1 - (age / FRAG_LIFE) ** 2;
    for (const p of shrapnel.fragments) {
      const d = thrown(p.v, age) * size;
      const px = x + Math.cos(p.a) * d;
      const py = y + Math.sin(p.a) * d + FRAG_GRAVITY * age * age;
      if (!onScreen(px, py, 10)) continue;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(px, py);
      // Hot pieces glow for the first moments.
      if (p.tint > 0.7 && age < 0.6) {
        ctx.fillStyle = colors.fail;
        ctx.beginPath();
        ctx.arc(0, 0, 2.5 * (1 - age / 0.6) + 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.rotate(p.a + p.spin * age);
      ctx.fillStyle = p.tint < 0.55 ? colors.fg : p.tint < 0.85 ? inkColor() : colors.accent;
      ctx.fillRect(-p.len / 2, -p.w / 2, p.len, p.w);
      ctx.restore();
    }
  }

  /** Sparks: short bright streaks, fast, and gone within the second. */
  function drawSparks(x, y, age, size, shrapnel) {
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (const p of shrapnel.sparks) {
      if (age >= p.life) continue;
      const d1 = thrown(p.v, age) * size;
      const d0 = thrown(p.v, Math.max(0, age - 0.04)) * size;
      const px = x + Math.cos(p.a) * d1;
      const py = y + Math.sin(p.a) * d1 + SPARK_GRAVITY * age * age;
      const qx = x + Math.cos(p.a) * d0;
      const qy = y + Math.sin(p.a) * d0 + SPARK_GRAVITY * Math.max(0, age - 0.04) ** 2;
      if (!onScreen(px, py, 10)) continue;
      ctx.strokeStyle = `rgba(255,214,120,${1 - age / p.life})`;
      ctx.beginPath();
      ctx.moveTo(qx, qy);
      ctx.lineTo(px, py);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Smoke streaming off the wreck, back along the way it is moving. */
  function drawWreckSmoke(wx, wy, age, size) {
    const hd = headingAt(simT);
    const bx = -Math.sin(hd);
    const by = Math.cos(hd);
    const col = mix(DAY_INK, rgbMuted, sky.dark);
    for (let k = 1; k <= WRECK_PUFFS; k += 1) {
      const d = k * (7 + 3 * size);
      const wob = Math.sin(realT * 9 + k * 2.1) * (1 + k * 0.4);
      const px = wx + bx * d + by * wob;
      const py = wy + by * d - bx * wob;
      ctx.fillStyle = rgba(col, 0.4 * (1 - k / (WRECK_PUFFS + 1)));
      ctx.beginPath();
      ctx.arc(px, py, (2 + k * 1.3) * size, 0, Math.PI * 2);
      ctx.fill();
    }
    // The broken end still burns for a while.
    if (age < WRECK_FIRE) {
      const f = 1 - age / WRECK_FIRE;
      const flick = 0.75 + 0.25 * Math.sin(performance.now() / 31);
      const r = (5 + 4 * f) * size * flick;
      const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, r);
      g.addColorStop(0, `rgba(255,235,180,${0.9 * f})`);
      g.addColorStop(0.5, `rgba(255,140,50,${0.6 * f})`);
      g.addColorStop(1, 'rgba(255,80,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * One failure's bang, at the point it happened and at its own age: smoke
   * under fire under the shock front, shrapnel over all of it, and a scorch
   * mark that outlasts them so a skipped playback still shows where it went
   * wrong. Drawn for every failure the flight has passed, escaped or not.
   */
  function drawBang(ev) {
    const age = ageOf(stamps.get(ev));
    const at = sampleAt(samples, ev.t);
    const x = drToX(at.downrange ?? 0);
    const y = altToY(at.alt);
    // The stage comes from the event itself, not the sample at ev.t: an upper
    // stage that fails at ignition does so at the same instant as the
    // separation below it, before any sample carries the new stage number, so
    // the sample would still say the booster was attached while drawDebris()
    // shows it falling away. For an escaped booster failure that stack is the
    // whole vehicle, which is right — it is the booster's bang.
    const stack = attachedAt(ev.stage ?? at.stage ?? 1);
    const size = Math.max(6, stack[0]?.width ?? 8) / 8;
    const shrapnel = shrapnelFor(ev);

    if (age < SMOKE_LIFE) drawSmokeBall(x, y, age, size);
    if (age < FIREBALL_LIFE) drawFireball(x, y, age, size);
    if (age < SHOCK_LIFE) drawShockwave(x, y, age, size);
    drawFragments(x, y, age, size, shrapnel);
    drawSparks(x, y, age, size, shrapnel);

    if (!onScreen(x, y, 20)) return;
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

  /**
   * The stack that the TERMINAL failure left: it keeps coasting, so the
   * camera still has something to follow — whatever was attached when it
   * failed, tumbling, engine out, on fire, trailing smoke. Only the terminal
   * failure gets one; an escaped stage flies on under its own engine and is
   * drawn by drawRocket like any other flying stack.
   */
  function drawWreck(dr, alt, ev) {
    const age = ageOf(stamps.get(ev));
    const at = sampleAt(samples, ev.t);
    const wreck = attachedAt(ev.stage ?? at.stage ?? 1);
    const size = Math.max(6, wreck[0]?.width ?? 8) / 8;
    const wx = drToX(dr);
    const wy = altToY(alt);
    if (!onScreen(wx, wy, 60)) return;
    drawWreckSmoke(wx, wy, age, size);
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.translate(wx, wy);
    // The wreck starts exactly where and how the rocket was drawn the frame
    // before — same heading, same pivot along the body — and from there
    // tumbles, with the pivot easing to its middle so that on the ground it
    // is never more than half buried whichever way up it has landed.
    const heading = headingAt(ev.t);
    const flightPivot = (1 - Math.cos(heading)) / 2;
    const pivot = flightPivot + (0.5 - flightPivot) * Math.min(age / SEPARATION_SETTLE_S, 1);
    ctx.rotate(heading + age * 2.4);
    ctx.translate(0, stackHeight(wreck) * pivot - separationLift(pivot));
    drawStack(wreck, false);
    ctx.restore();
  }

  /**
   * Everything the failures already passed put on screen: the terminal one's
   * wreck first, so the bangs sit over it, then a bang each.
   */
  function drawFailure(dr, alt) {
    const terminal = terminalFailure();
    if (terminal) drawWreck(dr, alt, terminal);
    for (const ev of passedFailures()) drawBang(ev);
  }

  /** T+ clock, live altitude, speed and downrange in the top-left of the sky. */
  function drawReadout(alt, vel, dr) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // The readout is light type throughout, so it keeps a dark backing plate
    // that fades in exactly as far as the sky is bright: at night it is the
    // bare night sky as before, on a blue sky a soft dark card behind the
    // numbers. (Crossfading the type itself to dark ink instead reads worst
    // exactly in the middle, around 20-30 km, where neither end has contrast.)
    if (sky.day > 0.03) {
      ctx.fillStyle = rgba([6, 14, 26], 0.5 * sky.day);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(2, 2, 132, 74, 6);
      else ctx.rect(2, 2, 132, 74);
      ctx.fill();
    }
    const labelCol = rgba(mix(rgbMuted, [206, 214, 224], sky.day), 1);
    const valueCol = rgba(rgbFg, 1);
    ctx.fillStyle = labelCol;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(`T+${Math.round(simT)}s`, 6, 6);

    const line = (label, text, top) => {
      ctx.font = '9px "Courier New", monospace';
      ctx.fillStyle = labelCol;
      ctx.fillText(label, 6, top + 3);
      ctx.fillStyle = valueCol;
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
    updateSky(alt);
    drawSky();
    // The bang shakes the world for a moment: everything between the sky
    // and the readout jolts, decaying to still. Presentation only.
    const fa = failureAge();
    const shake = fa < SHAKE_LIFE ? 1 - fa / SHAKE_LIFE : 0;
    ctx.save();
    if (shake > 0) {
      ctx.translate(Math.sin(realT * 71) * 7 * shake, Math.cos(realT * 53) * 5 * shake);
    }
    drawTicks();
    drawClouds();
    drawTargetLine();
    drawGround();
    drawTrail(dr, alt);
    drawDebris();
    // The rocket keeps being drawn through an escaped failure — the stack
    // above separates clear and relights, and the camera follows it — and
    // stops only once the terminal failure has been passed.
    if (!terminalFailure()) {
      drawRocket(dr, alt, stageAt(s), burningAt(timeline, simT), headingAt(simT));
    }
    drawFailure(dr, alt);
    ctx.restore();
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
    // A flight that ends on the bang (an ignition failure ends at T+0, on
    // the first frame) would otherwise freeze the fireball mid-burst. Sim
    // time is over; the effect plays out on real time until it is spent.
    if (!skipped && failureAge() < SMOKE_LIFE) raf = requestAnimationFrame(linger);
  }

  function linger(now) {
    // The caller has already been told the flight is done and may have let
    // go of the handle, so this loop also ends itself the moment the canvas
    // leaves the document: a screen change must not leave a detached canvas
    // painting gradients on every frame.
    if (stopped || !canvas.isConnected) return;
    realT += Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    frame();
    if (failureAge() < SMOKE_LIFE) raf = requestAnimationFrame(linger);
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
    requestAnimationFrame((now) => { lastNow = now; finish(); });
  } else {
    raf = requestAnimationFrame(tick);
  }

  return handle;
}
