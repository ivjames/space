// Planet-centred orbital map. Plays back the analytic phase js/core/resolver.js
// resolved after insertion — the tier 3 rendezvous sequence, or the tier 4
// lunar one — on the SAME canvas the ascent view has just finished with
// (ARCHITECTURE.md, phase 2: "the SAME `canvas#ascent` element is handed to
// the map view").
//
// Like js/ui/ascent.js it renders and nothing else: every position it draws
// comes from js/core/orbit.js's Kepler solve, and every orbit it draws comes
// either from the state (the target's) or from something the outcome says has
// ALREADY happened (the insertion, then each burn as its time arrives).
//
// NO-LEAK CONTRACT. Nothing on this screen may reveal how the sequence ends
// before the sequence shows it. Concretely, during playback this module reads:
//
//   - `outcome.insertion` — the orbit the vehicle is in, and (`phase`) where on
//     it the ascent left it. The ascent view has just played up to that event,
//     so it is in the past from the first frame, and it is what the vehicle's
//     orbit is drawn from.
//   - `orbital.target` / `opts.target` and `orbital.phaseErrorDeg` — the
//     target's orbit and where the two are relative to each other AT
//     INSERTION. The target is persistent state (state.objects), so its orbit
//     and its phase are drawable from the very first frame; the phase error is
//     the launch window the player themselves chose.
//   - `orbital.burns[i]` / `lunar.burns[i]` and the timeline events, one at a
//     time, only once sim time has reached them — exactly the way ascent.js
//     flushes its timeline. A burn's `elements` become the vehicle's drawn
//     orbit AT the burn's instant and not one frame before, and a burn's
//     `ok: false` is a red flash at that instant, not a marker that was always
//     on screen. On a lunar flight the same rule carries the vehicle to the
//     moon and onto the surface: the ring is drawn when the `loi` burn happens
//     and the landed dot when the `landing` event says so, which is the frame
//     the ticker prints it on.
//
// THE FLOWN PATH, in the cislunar frame. A closed ellipse drawn the instant the
// TLI lights is a route diagram: the whole way to the moon is on screen before
// the vehicle has gone anywhere, and the only thing that moves after that is a
// 4 px ring sliding along a line that was already there. So the vehicle's orbit
// is drawn TWICE — once faint and dashed for the whole conic, which is where it
// is going and is the same information the single curve used to carry, and once
// bright over the arc it has actually flown since the burn that put it on that
// conic, fading out behind it. The bright arc is the only part that grows, and
// growing is what "approaching" looks like. It reads the drawn orbit and the
// playback clock and nothing else — strictly less than the closed curve it
// replaces, so the contract above is unaffected — and it is exactly the trail
// js/ui/ascent.js draws behind the rocket, on a curve instead of a line.
//
// It is a trail rather than a second orbit, so it stops when the vehicle does:
// once a capture has put the vehicle AT the moon there is no planet-centred
// motion left to trace, and the arc holds at the arrival point until a
// departure burn starts a new one.
//
// It never reads `orbital.closestApproach`, `orbital.docked`,
// `orbital.stoppedAt`, `orbital.dvUsed`, `lunar.reached`, `lunar.landed`,
// `lunar.stoppedAt`, `lunar.shortBy`, `lunar.dvUsed`, `outcome.success`,
// `outcome.readout`, or any burn or event still in the future. The
// closest-approach line is drawn from the two positions on screen once the
// `approach` event has passed (or, at the very end, as the separation the
// flight actually finished with), never from the outcome's number ahead of
// time — the label quotes the event's own text, which is by then already in
// the ticker. The ONE thing read out of `outcome.lunar` up front is that it is
// there at all, which picks the frame below: that is the mission's requirement
// shape, which the player chose off the board, not something the flight did.
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
// TWO FRAMES (phase 3). That one is planet-centred and stretched, and it is
// the only frame a tier 3 flight needs. A lunar outcome selects the CISLUNAR
// frame instead, because the stretched one cannot express a body 60 planetary
// radii out: at x6 the exaggeration would put the moon 360 radii away, which
// is not a picture of anything, and a fit wide enough to include the moon
// collapses a parking orbit to a sub-pixel dot whether it is stretched or not.
// So the cislunar frame drops the exaggeration entirely (scaleOf is
// identically 1, altitudes are honest), fits to A_MOON, and draws BOTH bodies
// at max(true radius, MIN_BODY_PX) — at that fit the planet is 2 px across and
// the moon is under one, so both bottom out on the floor and the corner note
// changes with them, from "altitude x6" to "bodies not to scale". Exactly one
// of the two lies in either frame, and the note says which.
//
// Everything else is reused. The transfer is a planet-centred Hohmann ellipse
// — that is the point of resolving the lunar leg as one (js/core/moon.js) —
// so makeOrbit, drawOrbit and stateAt apply unchanged and there is no
// hyperbola to trace. The three steps AT the moon have no planet-centred orbit
// worth drawing and the resolver hands them `elements: null` for that reason,
// so they are drawn at the moon marker instead: a ring for lunar orbit, a dot
// on the limb for a landing.
//
// THE MOON'S POSITION is drawable from the first frame for the same reason the
// target's orbit is — it is a constant, not an outcome. Its circle is A_MOON,
// and its phase is set so that it is at the transfer's apoapsis at the moment
// a vehicle leaving THIS parking orbit would arrive there. Both halves of that
// come from the insertion orbit (already in the past when this view mounts)
// and js/core/moon.js's own ladder, never from the burns: the schedule is
// recomputed here rather than read off `lunar.burns`, because a burn that
// never happened has no entry and the moon has to be somewhere before the
// first one does. It is the same arithmetic the resolver does from the same
// two inputs, which is why the LOI flash lands on the moon marker rather than
// beside it.
//
// RATE, in the cislunar frame. MAP_RATE would play a five-day transfer for
// twenty minutes; a constant fast enough for the transfer would flash the
// parking orbit past in a twentieth of a second, and the parking orbit is the
// whole of a `flyby`. So the cislunar rate is scaled by the vehicle's CURRENT
// radius: CISLUNAR_RATE at lunar distance, about a sixtieth of it down in the
// parking orbit, which is roughly constant motion across the screen. That is
// still outcome-independent — it depends on where the vehicle is drawn right
// now and on nothing about how the sequence ends — and it is the same idea as
// ascent.js's burn and coast rates, keyed on a different observable.
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
//
// A LUNAR flight has no target to phase against, so its phase is not a window
// but a MEASUREMENT: `insertion.phase` is where on the parking orbit the ascent
// actually cut off, which is a few hundred km up and still climbing, never
// periapsis. The picture is oriented by putting periapsis at +x instead, and
// the vehicle starts wherever that phase says. It has to: the TLI is priced at
// periapsis and scheduled at the next periapsis passage (js/core/moon.js), so a
// vehicle drawn anywhere else would jump across the frame when it lit.

import { R, altitudeOf, elementsFrom, positionAt, radiusOf } from '../core/orbit.js';
import { A_MOON, R_MOON, lunarLadder, lunarSchedule } from '../core/moon.js';

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

/**
 * Cislunar playback rate, simulated seconds per real second AT LUNAR DISTANCE.
 * Scaled down with the vehicle's radius (see the header): at this value the
 * ~5-day translunar coast plays in about eight seconds and the parking orbit
 * it leaves from takes about three, which is the ratio the picture wants —
 * the coast is the part with nothing happening in it.
 */
export const CISLUNAR_RATE = 54000;

/**
 * Floor on that scaling, as a fraction of A_MOON. Nothing the map draws sits
 * below it (a parking orbit is 0.017 of lunar distance), so it exists only so
 * that a degenerate radius cannot stall the playback at zero.
 */
const CISLUNAR_MIN_FRAC = 0.01;

/**
 * Smallest a body may be drawn, px. In the cislunar frame the planet is 2 px
 * across and the moon is 0.6, which is a dust speck and a missing one; both
 * are floored here and the corner note says the bodies are not to scale.
 * A no-op in the planet-centred frame, where the planet fills a third of the
 * view by construction.
 */
const MIN_BODY_PX = 10;

/** Sub-pixel margin left around the widest drawn orbit, px. */
const FIT_MARGIN_PX = 34;
/** Extra room kept beyond the widest orbit so its marker and label fit. */
const FIT_SLACK = 1.06;
/** Segments used to trace one orbit. */
const ORBIT_STEPS = 128;
/**
 * Segments used to trace the flown arc. Fewer than a whole orbit's because the
 * arc is at most one revolution (a coast to the next periapsis) and usually
 * half of one (a Hohmann leg), and because each segment is its own stroke —
 * the alpha ramps along it, which one path cannot do.
 */
const TRAIL_STEPS = 48;
/**
 * Alpha at the oldest end of the flown arc, and at the newest. The floor sits
 * ABOVE PROJECTION_ALPHA on purpose: the faintest part of what has been flown
 * still has to read as brighter than what has not.
 */
const TRAIL_MIN_ALPHA = 0.38;
const TRAIL_MAX_ALPHA = 1;
/** Alpha the unflown remainder of the vehicle's own conic is drawn at. */
const PROJECTION_ALPHA = 0.2;
/** Nose-to-tail length of the craft glyph, px, and its half-width. */
const CRAFT_LEN = 9;
const CRAFT_HALF_W = 2.8;
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

/**
 * "842 km" / "384 400 km" — cislunar distances, which are five and six digits
 * of kilometres where `formatRange` above is quoting metres and tens of
 * kilometres. Grouped in threes so the closing range is readable as it counts
 * down; never metres, because a metre is a hundred-thousandth of a pixel here.
 */
export function formatFarRange(m) {
  if (!Number.isFinite(m)) return '—';
  const km = Math.round(m / 1000);
  return `${String(km).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} km`;
}

/**
 * Elapsed time as T+1:42:00 — an orbital sequence runs to hours.
 *
 * A lunar one runs to days, where six digits of seconds carried into an
 * hours field ("T+264:00:00") stop being a duration anyone reads, so past a
 * day it is quoted as days and hours. Tier 3 never reaches that branch: the
 * longest orbital sequence is three orbits and a coast.
 */
function formatClock(t) {
  const s = Math.max(0, Math.round(t));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    return `T+${d}d ${Math.floor((s % 86400) / 3600)}h`;
  }
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
 * @param {object} outcome  from resolveLaunch; needs `insertion` and either
 *        `orbital` (with a target) or `lunar`, which picks the cislunar frame
 * @param {object} [opts]
 * @param {object} [opts.target]  the state object being rendezvoused with
 *        (state.objects entry). Falls back to `outcome.orbital.target`.
 *        A lunar flight has none: the moon is a constant, not an object.
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
  const lunar = outcome?.lunar ?? null;
  const targetInfo = opts.target ?? orbital?.target ?? null;
  // Which frame (see the header). The mission's shape, not the flight's.
  const cislunar = lunar !== null;

  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : () => {};
  const rate = opts.speed ?? (cislunar ? CISLUNAR_RATE : MAP_RATE);

  const handle = { done: false, skip, stop };
  let stopped = false;

  // Without an insertion there is no map to draw, and a rendezvous without its
  // target is half a picture: hand control straight back rather than drawing
  // one. A lunar flight needs no target — the moon is a constant.
  if (!insertion || !Number.isFinite(insertion.apoapsis) || (!cislunar && !targetInfo)) {
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
  const burns = [...((cislunar ? lunar.burns : orbital?.burns) ?? [])]
    .sort((a, b) => a.t - b.t);

  const phaseErrorDeg = Number(orbital?.phaseErrorDeg) || 0;
  const targetPhase = Number(targetInfo?.phase) || 0;
  // The vehicle's own phase at insertion: the target's, plus the error the
  // launch window bought. Both are known at the first frame. A lunar flight
  // has neither — there is nothing to phase against — so the picture is
  // oriented by putting the parking orbit's periapsis at +x instead.
  const windowPhase = cislunar ? 0 : targetPhase + phaseErrorDeg / 360;
  // WHERE ON THAT ORBIT it inserted, which for a lunar flight is not periapsis
  // and is not something the two apsides can say: cutoff fires partway up the
  // ascent, still climbing, so the vehicle is a few hundred km up and some way
  // round from periapsis. The resolver measures it and hands it over on
  // `insertion` (which has already happened — the no-leak contract above), and
  // it matters twice: it is the phase `lunarSchedule` counts the coast to
  // periapsis from, so the burn is DRAWN where the ladder priced it, and it is
  // what stops the TLI teleporting the vehicle from apoapsis to periapsis at
  // the instant it lights. A tier 3 rendezvous keeps its own phase, which is
  // the launch window and not a measurement.
  const insertionPhase = cislunar ? (Number(insertion.phase) || 0) : 0;

  const target = targetInfo
    ? makeOrbit(targetInfo.periapsis, targetInfo.apoapsis, 0, targetPhase, t0)
    : null;
  let vehicle = makeOrbit(
    insertion.periapsis, insertion.apoapsis, TWO_PI * windowPhase, insertionPhase, t0,
  );
  const targetName = String(targetInfo?.name ?? targetInfo?.id ?? 'Target').toUpperCase();

  // The moon's own circle, and the phase that puts it where the transfer
  // arrives when the transfer arrives (see the header: constants and the
  // insertion orbit, no burns).
  let moon = null;
  if (cislunar) {
    const moonPeriod = elementsFrom(A_MOON, A_MOON).period;
    // The resolver's own schedule, from the resolver's own inputs. It is a
    // shared function rather than a second copy of the arithmetic precisely
    // because the two have to agree: a departure time only the resolver knew
    // about would leave the capture burn flashing beside the moon instead of
    // at it. It reads the parking orbit, its phase and the constants — never a
    // burn — so the no-leak contract above still holds (js/core/moon.js).
    const { tli: tliT, loi: arriveT } = lunarSchedule(
      t0, vehicle.period, lunarLadder(vehicle.rp, vehicle.ra), insertionPhase,
    );
    const depart = stateAt(vehicle, tliT);
    // A Hohmann departure leaves from the transfer's periapsis, so the moon
    // has to be half a turn round from wherever that is.
    const arriveAngle = Math.atan2(depart.y, depart.x) + Math.PI;
    const moonPhase0 = arriveAngle / TWO_PI - (arriveT - t0) / moonPeriod;
    moon = makeOrbit(altitudeOf(A_MOON), altitudeOf(A_MOON), 0, moonPhase0, t0);
  }

  const ctx = canvas.getContext('2d');
  const colors = {
    bg: '#05060a',
    fg: '#e8e8e8',
    muted: '#a4adb9',
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

  // Drawn radius: the planet keeps its true size, altitude is exaggerated —
  // and in the cislunar frame nothing is exaggerated at all, because at lunar
  // distance the stretch is the thing that stops making sense.
  const drawRadius = (r) => (cislunar ? r : R + (r - R) * ALT_EXAGGERATION);
  // The widest drawn radius the view has had to hold so far. Seeded from the
  // target's orbit (state) and the insertion orbit (already happened); a burn
  // that needs more room widens it at that burn's instant, never before. The
  // cislunar frame is seeded from A_MOON and never widens after that: the
  // moon's orbit is the widest thing in it and the transfer only reaches out
  // to touch it. The insertion orbit is in the max for the degenerate case
  // only — an ascent that parks in an orbit wider than the moon's would
  // otherwise draw off the canvas — and is known at the first frame either way.
  let fit = cislunar
    ? Math.max(A_MOON, vehicle.ra) * FIT_SLACK
    : Math.max(drawRadius(target.ra), drawRadius(vehicle.ra)) * FIT_SLACK;

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
  // Where the vehicle is in the cislunar frame, once a burn or an event has
  // said so: null while it is on a planet-centred orbit of its own, 'orbit'
  // once captured at the moon, 'surface' once the landing event lands.
  let atMoon = null;
  let landingAborted = false;
  let returning = false;
  // The flown arc's two ends, in SIM time. It starts at the burn that put the
  // vehicle on the conic it is drawn on — t0 for the parking orbit the ascent
  // left it in — and runs to now, except while the vehicle is at the moon,
  // where there is no planet-centred motion left to trace and the arc holds at
  // the instant it arrived.
  let trailFrom = t0;
  let trailTo = null;

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
    // MIN_BODY_PX is a no-op in the stretched frame and the whole of the
    // planet in the cislunar one, where its true size is two pixels.
    const rp = Math.max(R * pxPerM, MIN_BODY_PX);
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
   * The moon: the same disc lit from the same side, in grey and with no halo,
   * because it has no air. Floored at MIN_BODY_PX like the planet — it is
   * 0.6 px across at this fit — which is what the corner note is about.
   */
  function drawMoon(pt) {
    const rm = Math.max(R_MOON * pxPerM, MIN_BODY_PX);
    const g = ctx.createRadialGradient(
      pt.x - rm * 0.45, pt.y - rm * 0.5, rm * 0.05,
      pt.x, pt.y, rm,
    );
    g.addColorStop(0, '#9aa3ad');
    g.addColorStop(0.5, '#6d757f');
    g.addColorStop(1, '#2a2f36');
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rm, 0, TWO_PI);
    ctx.fillStyle = g;
    ctx.fill();
    return rm;
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

  /**
   * The arc of `orbit` actually flown between two times, brightest at the
   * near end. Walked in TIME rather than in true anomaly (which is what
   * drawOrbit does) because the two ends of it are two instants — the burn
   * that put the vehicle on this conic, and now — and because stepping a
   * transfer ellipse evenly in time puts most of the samples where the vehicle
   * spends most of its coast, which is out at the far end where the picture
   * needs them.
   *
   * Both ends come from the drawn orbit and the playback clock; nothing here
   * knows how the sequence ends (see the header).
   */
  function drawTrail(orbit, fromT, toT, stroke) {
    if (!(orbit.a > 0) || !(toT > fromT)) return;
    // At most one revolution: a coast to the next periapsis is one, a Hohmann
    // leg is half. The clamp is for a degenerate orbit, not a live path.
    const span = Math.min(toT - fromT, orbit.period > 0 ? orbit.period : toT - fromT);
    const start = toT - span;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    let prev = screenOf(stateAt(orbit, start));
    for (let i = 1; i <= TRAIL_STEPS; i += 1) {
      const u = i / TRAIL_STEPS;
      const pt = screenOf(stateAt(orbit, start + span * u));
      ctx.globalAlpha = TRAIL_MIN_ALPHA + (TRAIL_MAX_ALPHA - TRAIL_MIN_ALPHA) * u;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      prev = pt;
    }
    ctx.restore();
  }

  /**
   * Which way the vehicle is pointing, in SCREEN radians: the direction it
   * moved over the last sliver of its own period. Screen rather than world
   * because the y axis is flipped on the way out, and a glyph rotated by a
   * world angle would fly backwards down the left half of every orbit.
   */
  function headingAt(orbit, t) {
    const dt = orbit.period > 0 ? orbit.period / 2048 : 1;
    const a = screenOf(stateAt(orbit, t - dt));
    const b = screenOf(stateAt(orbit, t));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (!dx && !dy) return 0;
    return Math.atan2(dy, dx);
  }

  /**
   * The vehicle as a craft rather than as a ring: a hull pointed along its
   * heading. Nine pixels of it, which is as much as a frame fitted to lunar
   * distance can spare and enough to say which way it is going — and which way
   * it is going is the whole of what a transfer looks like from out here. The
   * ring marker stays the tier 3 frame's, where two craft on near-identical
   * orbits have no heading worth telling apart.
   */
  function drawCraft(pt, angle, color, label) {
    const L = CRAFT_LEN;
    const W = CRAFT_HALF_W;
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    // A dart: nose at +x, swept back to two tips, with the tail notched in
    // between. One filled path — an outlined engine bell drawn over the top of
    // it turns to mush at nine pixels.
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0);
    ctx.lineTo(-L * 0.5, W);
    ctx.lineTo(-L * 0.28, 0);
    ctx.lineTo(-L * 0.5, -W);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Clear of the nose, which reaches half the hull's length ahead of `pt`.
    if (label) drawLabel(pt, color, label, L * 0.5 + 8);
  }

  /**
   * A label beside a marker. The craft travel right round the view, so a label
   * pinned to one side runs off the edge for half of every orbit: it flips to
   * whichever side it fits on. `gap` clears whatever it is labelling — 11 px
   * clears the docked marker's ring as well as the dot, and the moon asks for
   * its own drawn radius.
   *
   * `prefer` picks the side to try first (1 right, -1 left), and is what keeps
   * MOON and VEHICLE off each other once the vehicle is AT the moon: the two
   * markers are then within a few pixels, so the only thing that separates
   * their labels is putting them on opposite sides. It is a preference, not an
   * instruction — a label that would fall off the canvas on the side asked for
   * goes on the other one, which is the behaviour every label had before.
   */
  function drawLabel(pt, color, label, gap, prefer = 1) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '9px "Courier New", monospace';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(label).width;
    let right = prefer >= 0;
    if (right && pt.x + gap + width > w - 4) right = false;
    else if (!right && pt.x - gap - width < 4) right = true;
    if (right) {
      ctx.textAlign = 'left';
      ctx.fillText(label, pt.x + gap, pt.y);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(label, pt.x - gap, pt.y);
    }
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
    ctx.restore();
    if (label) drawLabel(pt, color, label, 11);
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

  /**
   * Clock, the exaggeration note, and whatever has already happened.
   *
   * `toMoon`, when the cislunar frame passes one, is the gap between the two
   * markers on screen right now — a measurement off the picture, like the
   * separation line in the other frame, not a number read out of the outcome.
   */
  function drawChrome(toMoon = null) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.muted;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(formatClock(simT - t0), 6, 6);
    ctx.fillStyle = colors.accent;
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillText(cislunar ? 'CISLUNAR PHASE' : 'ORBITAL PHASE', 6, 20);

    if (Number.isFinite(toMoon)) {
      ctx.fillStyle = colors.muted;
      ctx.font = '10px "Courier New", monospace';
      ctx.fillText(`TO MOON ${formatFarRange(toMoon)}`, 6, 34);
    }

    ctx.fillStyle = colors.muted;
    ctx.font = '9px "Courier New", monospace';
    ctx.textBaseline = 'bottom';
    // Exactly one of the two is a lie in either frame, and this says which:
    // the stretched frame's altitudes, the cislunar frame's bodies.
    ctx.fillText(cislunar ? 'bodies not to scale' : `altitude ×${ALT_EXAGGERATION}`, 6, h - 6);

    // The word in the corner is only ever something that has already been read
    // out in the ticker.
    const word = cislunar
      ? (failed ? 'BURN FAILED'
        : landingAborted ? 'LANDING ABORTED'
          : returning ? 'RETURNING'
            : atMoon === 'surface' ? 'LANDED' : null)
      : (docked ? 'DOCKED' : dockFailed ? 'DOCKING ABORTED' : failed ? 'BURN FAILED' : null);
    if (word) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 11px "Courier New", monospace';
      const good = cislunar ? (word === 'LANDED' || word === 'RETURNING') : word === 'DOCKED';
      ctx.fillStyle = good ? colors.accent : colors.fail;
      ctx.fillText(word, w - 6, 6);
    }
    ctx.restore();
  }

  /** The planet-centred frame: the two craft, and the gap between them. */
  function frameOrbital() {
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

  /**
   * The cislunar frame: two bodies, the moon's circle, and whichever of the
   * three lunar states the sequence has reached — coasting on a planet-centred
   * ellipse of its own, ringed in lunar orbit, or sat on the limb.
   *
   * The moon is drawn from the first frame; everything about the vehicle comes
   * from a burn or an event that has already happened (see the header).
   */
  function frameCislunar() {
    const mp = stateAt(moon, simT);
    const mpt = screenOf(mp);
    // At the moon the vehicle IS the moon as far as this scale can tell: a
    // 100 km lunar orbit is a third of a pixel across here.
    const vp = stateAt(vehicle, simT);
    const vpt = atMoon ? mpt : screenOf(vp);

    const track = failed ? colors.fail : colors.accent;

    drawSpace();
    drawPlanet();
    drawOrbit(moon, colors.muted, [4, 4], 0.5);
    // Where it is going, and then — over the top of it — how much of that it
    // has actually flown. Two curves rather than one: see the header.
    drawOrbit(vehicle, track, [3, 5], PROJECTION_ALPHA);
    drawTrail(vehicle, trailFrom, trailTo ?? simT, track);
    const rm = drawMoon(mpt);
    // Which side of the moon to put the vehicle on: the one facing home, which
    // is the only direction this frame has an opinion about. Its label goes a
    // line ABOVE the moon's rather than beside it — at this scale the two
    // markers are a few pixels apart, and no horizontal rule keeps two labels
    // off each other once the moon is near an edge and both flip the same way.
    const dx = cx - mpt.x;
    const dy = cy - mpt.y;
    const len = Math.hypot(dx, dy) || 1;
    const moonSide = dx > 0 ? -1 : 1;
    drawLabel(mpt, colors.muted, 'MOON', rm + 7, moonSide);

    if (atMoon) {
      const color = failed || landingAborted ? colors.fail : colors.accent;
      if (atMoon === 'orbit') {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mpt.x, mpt.y, rm + 5, 0, TWO_PI);
        ctx.stroke();
        ctx.restore();
      }
      // On the ring in orbit, on the limb once landed.
      const d = atMoon === 'surface' ? rm : rm + 5;
      const pt = { x: mpt.x + (dx / len) * d, y: mpt.y + (dy / len) * d };
      drawMarker(pt, color, null, atMoon === 'surface');
      drawLabel({ x: mpt.x, y: mpt.y - rm - 11 }, color, 'VEHICLE', rm + 7, moonSide);
      drawFlashes(mpt);
    } else {
      drawCraft(vpt, headingAt(vehicle, simT), track, 'VEHICLE');
      drawFlashes(vpt);
    }

    // How far there is still to go, measured off the two positions on screen
    // exactly as the tier 3 frame's separation line is. It is the one number
    // that says "approaching" rather than "en route", and it says nothing
    // about whether the vehicle gets there.
    drawChrome(atMoon ? null : Math.hypot(mp.x - vp.x, mp.y - vp.y));
  }

  function frame() {
    resize();
    if (cislunar) frameCislunar();
    else frameOrbital();
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

  /**
   * A lunar burn. Two of the five put the vehicle on a planet-centred ellipse;
   * the other three happen AT the moon, where this frame has no orbit to draw
   * and the resolver hands `elements: null` for exactly that reason.
   *
   * The two that do are one Hohmann transfer flown in opposite directions, and
   * neither carries the vehicle's mean phase over the way an orbital burn
   * does: a TLI departs from the transfer's PERIAPSIS, which is wherever the
   * vehicle is when it lights, and a TEI leaves from its APOAPSIS, which is
   * wherever the moon is. Carrying the parking orbit's phase across instead
   * would teleport the vehicle to lunar distance the instant it burned.
   */
  function applyLunarBurn(burn) {
    const el = burn.elements;
    if (burn.kind === 'tli' && el) {
      const p = stateAt(vehicle, burn.t);
      vehicle = makeOrbit(el.periapsis, el.apoapsis, Math.atan2(p.y, p.x), 0, burn.t);
      atMoon = null;
      trailFrom = burn.t;
      trailTo = null;
      return;
    }
    if (burn.kind === 'tei' && el) {
      const mp = stateAt(moon, burn.t);
      vehicle = makeOrbit(
        el.periapsis, el.apoapsis, Math.atan2(mp.y, mp.x) + Math.PI, 0.5, burn.t,
      );
      atMoon = null;
      returning = true;
      trailFrom = burn.t;
      trailTo = null;
      return;
    }
    // The capture puts it in lunar orbit and the ascent puts it back; whether
    // the descent between them ended on the surface is the landing event's to
    // say, not the burn's (the burn can succeed and the touchdown still fail).
    if (burn.kind === 'loi' || burn.kind === 'ascent') {
      atMoon = 'orbit';
      // Arrived: the trail stops where the capture happened rather than
      // carrying on round the transfer the vehicle is no longer flying.
      if (trailTo === null) trailTo = burn.t;
    }
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
    if (cislunar) {
      applyLunarBurn(burn);
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
      // The touchdown, and the touchdown that did not happen: the vehicle
      // reaches the surface on the frame the ticker says it did.
      else if (ev.kind === 'landing') atMoon = 'surface';
      else if (ev.kind === 'landing-failure') landingAborted = true;
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

  /**
   * Simulated seconds per real second, right now. A constant in the
   * planet-centred frame; in the cislunar one it is scaled by the radius the
   * vehicle is CURRENTLY drawn at (see the header), so a parking orbit is not
   * a blink and a five-day coast is not a wait. It reads the position already
   * on the screen and nothing else, so it is outcome-independent exactly as a
   * constant is.
   */
  function rateNow() {
    if (!cislunar) return rate;
    const r = atMoon ? A_MOON : stateAt(vehicle, simT).r;
    return rate * Math.min(1, Math.max(CISLUNAR_MIN_FRAC, r / A_MOON));
  }

  function tick(now) {
    if (stopped) return;
    if (!lastNow) lastNow = now;
    const dt = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    realT += dt;
    simT += dt * rateNow();
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
