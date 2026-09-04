// The surface shot: the last kilometres of a lunar descent, the touchdown, and
// the first kilometres of the ascent that starts the trip home — drawn side-on,
// at EXACTLY the scale the launch was drawn at.
//
// WHY IT EXISTS. js/ui/map.js's close-up is a picture of an ORBIT: the moon at
// true size, a hundred kilometres of altitude stretched x6 so the ring reads,
// and the whole of a descent flown across it. At that fit the moon is about 90
// pixels of radius, so the lander is a marker and the ground it arrives on is
// the edge of a circle. The last kilometre — the part the tier is named for,
// where a landing is a landing rather than a dot reaching a limb — happens
// inside two pixels. So the descent gets a second camera, on the ground, and
// the ascent home gets the same one.
//
// THE SCALE IS THE POINT, and it is not a new one: VIEW_SPAN_M, the tick
// spacing, the ground marks and the screen anchor are imported from
// js/ui/ascent.js, which is the view the player watched the rocket leave the
// planet on. A pixel is the same number of metres here as it was there, the
// ruler up the side is the same ruler, and the marks scrolling past are spaced
// the same. That is the whole claim of this module — the lander comes down at
// the size the rocket went up at — and sharing the constants is how the claim
// is kept true rather than asserted (test/surface.test.js pins it).
//
// WHAT IT DRAWS, AND WHAT IT IS TOLD. Nothing here reads an outcome, a
// timeline, or a resolver: this module is a function of four numbers the caller
// measures off the picture it is already drawing — the altitude above the
// surface, the signed downrange to the site, which leg is under way, and
// whether the engine is lit. It has no clock of its own beyond a real-time
// value used for flicker and dust. The no-leak contract lives in map.js and is
// unaffected: everything passed in is derived from a burn that has already
// happened, the constants in js/core/moon.js, and the playback clock.
//
// TWO THINGS ARE THIS MODULE'S OWN OPINION, both of them about the sprite
// rather than the flight:
//
//   - ATTITUDE is a function of ALTITUDE, not of the velocity direction. The
//     ladder's descent holds one slope the whole way down (map.js's poweredAt:
//     altitude and swept angle are the same quadratic, so the path is a
//     straight line at about ten degrees), and a lander pointed along that
//     would still be lying on its side at contact. A real one pitches upright
//     as it comes in, so the drawn attitude leans back into the braking high up
//     and is level over the last PITCH_UPRIGHT_ALT metres. The ascent is the
//     mirror image: upright off the pad, pitching forward into the direction it
//     is accelerating as it climbs away.
//   - THE GROUND has craters, spaced deterministically in world coordinates so
//     they scroll past rather than crawl with the camera. They are scenery, and
//     the same LCG-from-an-index trick js/ui/ascent.js's cloud layer uses: no
//     rng, no state, the same ground every time.

import {
  GROUND_H, GROUND_MARK_M, MINOR_STEP_M, SCREEN_ANCHOR, TICK_STEP_M, VIEW_SPAN_M,
} from './ascent.js';

/**
 * Altitude, m, at which the shot takes over from the orbital close-up, and at
 * which it hands back on the way up.
 *
 * It is a little under the height the ground first appears at on a canvas this
 * shape — `surfaceView().liftAlt` is about 8 km at 360x480 — so the cut lands
 * on a frame that already has a horizon in it. Any higher and the shot opens on
 * an empty black rectangle with a lander in the middle of it, which is a worse
 * picture than the one it interrupted.
 */
export const SURFACE_ALT = 8000;

/** Lean at SURFACE_ALT, radians from vertical, and the height it is gone by. */
const PITCH_MAX = 0.92;
const PITCH_UPRIGHT_ALT = 800;

/** Lander sprite, px. Fixed on screen, exactly as the rocket's stack is. */
const BODY_W = 15;
const BODY_H = 9;
const CABIN_W = 9;
const CABIN_H = 7;
const LEG_SPAN = 9;
const LEG_DROP = 7;
const NOZZLE_H = 4;

/** Dust starts kicking up below this altitude, m, whenever the engine is lit. */
const DUST_ALT = 140;

/** World spacing of the crater field, m, and the biggest a crater gets, m. */
const CRATER_STEP_M = 700;
const CRATER_MAX_M = 260;
/** Every eighth slot gets a big one — the field needs a few things to notice. */
const BIG_CRATER_EVERY = 8;
const BIG_CRATER_MAX_M = 900;

/** Regolith, lit and shadowed, matching the moon disc map.js draws. */
const REGOLITH = '#4a5058';
const REGOLITH_DARK = '#33373d';
const REGOLITH_RIM = '#8b939d';

const TWO_PI = Math.PI * 2;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** Smoothstep, so the pitch has no corner at either end of its ramp. */
const smooth = (u) => u * u * (3 - 2 * u);

/**
 * The camera, from the canvas box alone — the same arithmetic js/ui/ascent.js
 * does in `resize`, on the same constants, which is what makes the two views
 * one scale. Pure, and exported for the test that pins that.
 *
 * `liftAlt` is the altitude at which the camera stops sitting on the ground and
 * starts following: below it the surface is pinned near the bottom edge and the
 * lander moves down the screen onto it, above it the lander is pinned at
 * `anchorY` and the world scrolls.
 */
export function surfaceView(w, h) {
  const mPerPx = VIEW_SPAN_M / Math.max(h, 1);
  const anchorY = h * (1 - SCREEN_ANCHOR);
  const padY = h - GROUND_H;
  return { w, h, mPerPx, anchorY, padY, liftAlt: Math.max(0, (padY - anchorY) * mPerPx) };
}

/**
 * How far the lander leans from vertical at `alt`, radians. Which WAY it leans
 * is the leg's business (see the header): back on a descent, forward on an
 * ascent. Level on the ground either way, which is the one value that has to be
 * exact — a lander drawn at four degrees on a flat surface reads as a crash.
 */
export function pitchAt(alt) {
  const span = SURFACE_ALT - PITCH_UPRIGHT_ALT;
  return PITCH_MAX * smooth(clamp01((alt - PITCH_UPRIGHT_ALT) / span));
}

/** Deterministic hash of a slot index -> three numbers in 0..1. */
function slot(k) {
  let s = (Math.imul(k | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return [next(), next(), next()];
}

/**
 * Draw one frame of the shot.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view    { w, h, colors } — CSS pixels and the map's palette
 * @param {object} state
 * @param {number} state.alt        altitude above the surface, m
 * @param {number} state.x          signed downrange to the site, m: negative on
 *        the way in, zero on it, positive once an ascent has left it
 * @param {'descent'|'ascent'|'surface'} state.kind  which leg is under way
 * @param {boolean} [state.aborted] the descent was waved off; draw it in the
 *        failure colour, short of a site it never reached
 * @param {boolean} [state.engine]  the engine is lit
 * @param {number} [state.realT]    real seconds, for flicker and dust only
 */
export function drawSurface(ctx, view, state) {
  const { w, h, colors } = view;
  const cam = surfaceView(w, h);
  const alt = Math.max(0, state.alt);
  const x = state.x;
  const kind = state.kind;
  const engine = state.engine === true;
  const realT = Number(state.realT) || 0;
  const color = state.aborted ? colors.fail : colors.accent;

  // The camera: the lander is always at the horizontal centre, and at
  // `anchorY` once it is high enough for the ground to be off the bottom.
  const camAlt = Math.max(alt, cam.liftAlt);
  const altToY = (a) => cam.anchorY - (a - camAlt) / cam.mPerPx;
  const yToAlt = (y) => camAlt - (y - cam.anchorY) * cam.mPerPx;
  const drToX = (dr) => w / 2 + (dr - x) / cam.mPerPx;
  const xToDr = (px) => x + (px - w / 2) * cam.mPerPx;

  const gy = altToY(0);

  drawTicks();
  if (gy < h) {
    drawGround();
    drawCraters();
    drawSite();
    if (engine && alt < DUST_ALT) drawDust();
  }
  drawLander();

  /** The altitude ruler: the launch view's, unlabelled at 1 km, labelled at 5. */
  function drawTicks() {
    const top = yToAlt(0);
    const bottom = Math.max(yToAlt(Math.min(h, gy)), 0);
    ctx.save();
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.16;
    const mFirst = Math.max(1, Math.ceil(bottom / MINOR_STEP_M));
    const mLast = Math.floor(top / MINOR_STEP_M);
    if (mLast - mFirst < 60) {
      for (let k = mFirst; k <= mLast; k += 1) {
        const a = k * MINOR_STEP_M;
        if (a % TICK_STEP_M === 0) continue;
        const y = Math.round(altToY(a)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 0.4;
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const first = Math.max(1, Math.ceil(bottom / TICK_STEP_M));
    const last = Math.floor(top / TICK_STEP_M);
    for (let k = first; k <= last && last - first < 40; k += 1) {
      const a = k * TICK_STEP_M;
      const y = Math.round(altToY(a)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (y > 12) {
        ctx.fillStyle = colors.muted;
        ctx.fillText(`${Math.round(a / 1000)} km`, w - 6, y - 3);
      }
    }
    ctx.restore();
  }

  /**
   * The surface: flat at altitude 0 (the moon's limb curves by a third of a
   * pixel across a canvas this wide at this scale), with the same marks every
   * GROUND_MARK_M the launch view puts on its ground, which are what make the
   * horizontal motion — and the way it dies away into the touchdown — legible.
   */
  function drawGround() {
    ctx.save();
    const g = ctx.createLinearGradient(0, gy, 0, h);
    g.addColorStop(0, REGOLITH);
    g.addColorStop(1, REGOLITH_DARK);
    ctx.fillStyle = g;
    ctx.fillRect(0, gy, w, Math.max(h - gy, 0));
    ctx.strokeStyle = REGOLITH_RIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(w, gy + 0.5);
    ctx.stroke();

    const firstMark = Math.ceil(xToDr(0) / GROUND_MARK_M);
    const lastMark = Math.floor(xToDr(w) / GROUND_MARK_M);
    if (lastMark - firstMark <= 200) {
      ctx.globalAlpha = 0.45;
      for (let k = firstMark; k <= lastMark; k += 1) {
        const mx = Math.round(drToX(k * GROUND_MARK_M)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(mx, gy + 1);
        ctx.lineTo(mx, Math.min(gy + 7, h));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Scenery, deterministic in world coordinates (see the header). */
  function drawCraters() {
    const first = Math.floor(xToDr(-CRATER_MAX_M) / CRATER_STEP_M);
    const last = Math.ceil(xToDr(w + CRATER_MAX_M) / CRATER_STEP_M);
    if (last - first > 400) return;
    ctx.save();
    for (let k = first; k <= last; k += 1) {
      const [jitter, size, depth] = slot(k);
      const big = ((k % BIG_CRATER_EVERY) + BIG_CRATER_EVERY) % BIG_CRATER_EVERY === 0;
      const rM = (big ? BIG_CRATER_MAX_M : CRATER_MAX_M) * (0.35 + 0.65 * size);
      const r = rM / cam.mPerPx;
      if (r < 1.2) continue;
      const cxp = drToX((k + jitter) * CRATER_STEP_M);
      if (cxp < -r || cxp > w + r) continue;
      const ry = r * 0.34;
      const cyp = gy + 2 + ry + depth * 6;
      if (cyp - ry > h) continue;
      // A bowl: shadowed floor, a rim catching the light on the near side.
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = REGOLITH_DARK;
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, r, ry, 0, 0, TWO_PI);
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = REGOLITH_RIM;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, r, ry, 0, Math.PI, TWO_PI);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The site: the point the descent is aimed at, which is also the point an
   * ascent lifts from. It says nothing about whether the lander gets there —
   * an aborted descent stops visibly short of it, which is the one thing the
   * orbital close-up could not show.
   */
  function drawSite() {
    const px = drToX(0);
    if (px < -40 || px > w + 40) return;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px - 16, gy + 0.5);
    ctx.lineTo(px + 16, gy + 0.5);
    ctx.stroke();
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(px + side * 16, gy - 5);
      ctx.lineTo(px + side * 16, gy + 1);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Regolith blown out sideways under the engine, thickening as it settles. */
  function drawDust() {
    const u = 1 - alt / DUST_ALT;
    const px = drToX(x);
    ctx.save();
    ctx.globalAlpha = 0.42 * u;
    ctx.fillStyle = REGOLITH_RIM;
    const spread = 22 + 58 * u;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(px, gy - 1);
      ctx.quadraticCurveTo(px + side * spread * 0.6, gy - 6 - 4 * u, px + side * spread, gy + 1);
      ctx.lineTo(px, gy + 1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The lander, standing on its footpads: the origin is the point the pads
   * touch, so at altitude 0 it sits ON the surface rather than half in it. A
   * descent stage with the engine under it, the cabin on top, four legs drawn
   * as two pairs, and exhaust while the engine is lit.
   */
  function drawLander() {
    const px = drToX(x);
    const py = altToY(alt);
    const lean = pitchAt(alt) * (kind === 'ascent' ? 1 : -1);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(lean);

    const bodyTop = -LEG_DROP - BODY_H;
    if (engine) drawPlume();

    // Legs: struts out to the pads, and a pad under each.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * BODY_W * 0.34, bodyTop + BODY_H);
      ctx.lineTo(side * LEG_SPAN, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(side * (LEG_SPAN - 2.5), 0);
      ctx.lineTo(side * (LEG_SPAN + 2.5), 0);
      ctx.stroke();
    }

    // Descent stage: a squat trapezoid, wider at the base.
    ctx.fillStyle = colors.fg;
    ctx.beginPath();
    ctx.moveTo(-BODY_W / 2, bodyTop + BODY_H);
    ctx.lineTo(BODY_W / 2, bodyTop + BODY_H);
    ctx.lineTo(BODY_W / 2 - 1.5, bodyTop);
    ctx.lineTo(-BODY_W / 2 + 1.5, bodyTop);
    ctx.closePath();
    ctx.fill();

    // Cabin, and the hatch face toward the direction of travel.
    ctx.fillStyle = color;
    ctx.fillRect(-CABIN_W / 2, bodyTop - CABIN_H, CABIN_W, CABIN_H);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(CABIN_W / 2 - 3, bodyTop - CABIN_H + 2, 2, 2);

    // Engine bell under the descent stage.
    ctx.fillStyle = colors.muted;
    ctx.beginPath();
    ctx.moveTo(-2, bodyTop + BODY_H);
    ctx.lineTo(2, bodyTop + BODY_H);
    ctx.lineTo(3.4, bodyTop + BODY_H + NOZZLE_H);
    ctx.lineTo(-3.4, bodyTop + BODY_H + NOZZLE_H);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    function drawPlume() {
      // Flicker is presentation only, exactly as the launch view's is.
      const flick = 0.72 + 0.28 * Math.sin(realT * 28);
      const from = bodyTop + BODY_H + NOZZLE_H;
      const len = (11 + 7 * flick) * (kind === 'ascent' ? 1.25 : 1);
      const grad = ctx.createLinearGradient(0, from, 0, from + len);
      grad.addColorStop(0, 'rgba(255,242,192,0.95)');
      grad.addColorStop(0.45, 'rgba(255,165,60,0.55)');
      grad.addColorStop(1, 'rgba(255,80,40,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(-3.6, from);
      ctx.lineTo(3.6, from);
      ctx.lineTo(0, from + len);
      ctx.closePath();
      ctx.fill();
    }
  }
}
