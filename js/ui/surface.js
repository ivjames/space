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
// TWO BODIES, ONE SHOT. The moon is where it started — a descent, a touchdown,
// a stay and a liftoff on grey ground under a black sky — and the planet is
// where a `return` profile finishes, with the capsule coming down through the
// atmosphere it launched through. Both are the same picture: the same ruler,
// the same camera, the same ground marks, the same site under it. What differs
// is what is overhead and what is falling, so `state.body` picks between them
// and nothing else in here is duplicated.
//
// The sky, the starfield and the cloud layer of the planet's half are the
// LAUNCH VIEW'S OWN (js/ui/ascent.js: skyAt, paintSky, drawStarField,
// drawCloudLayer). Not a second sky that looks like it: the same functions,
// the same constants, so 40 km looks the way 40 km looked on the way up and
// the capsule comes down through the weather the rocket climbed through.
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
  drawCloudLayer, drawStarField, groundOver, inkOver, lineOver, paintSky, rgba, skyAt,
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

// ---- coming home ----------------------------------------------------------
/** Capsule sprite, px: the body, the heat shield's bulge under it, and the
 * angle it lies at once it is down. */
const CAP_W = 13;
const CAP_H = 9;
const SHIELD_BULGE = 4.5;
const LANDED_TILT = 0.42;
/** Canopy: full width and height, px, and the risers' length. */
const CHUTE_W = 30;
const CHUTE_H = 15;
const RISER_H = 15;
/**
 * Altitude the canopy comes out at, m, and the drop it takes to fill.
 *
 * Drogues out at about 8 km and the mains at 3 is the real sequence; one
 * canopy at 6 km is that sequence at the resolution a fifteen-kilometre view
 * has, which is 190 pixels for the whole of it.
 */
const CHUTE_ALT = 6000;
const CHUTE_FILL_M = 900;
/**
 * The plasma sheath: full between these altitudes, m, and faded out either
 * side of them. Peak heating on a lunar return is around 60 km, and it is over
 * well before the canopy — a capsule is a meteor and then it is a parachute,
 * and the picture should not show both at once.
 */
const PLASMA_TOP_M = 100000;
const PLASMA_HOT_M = 70000;
const PLASMA_COOL_M = 40000;
const PLASMA_OUT_M = 25000;

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

/**
 * How far a landed capsule has to be RAISED so that it rests on the surface
 * rather than in it, px.
 *
 * The sprite's origin is the point its shield touches the ground, which is
 * exactly right while it is coming down and exactly wrong the moment it tips
 * over: rotating about that point swings the downhill corner — and the
 * shield's belly, which reaches further still — below the origin, and the
 * sprite is drawn after the terrain, so a capsule meant to be lying on the
 * ground reads as one half-buried in it. So the lowest point of the tilted
 * shield is measured off the curve itself, and the sprite is lifted by it.
 * Sampled rather than derived so that it stays right if the sprite's numbers
 * move.
 */
export function landedLift(tilt = LANDED_TILT) {
  const sin = Math.sin(tilt);
  const cos = Math.cos(tilt);
  let low = 0;
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    // The shield: a quadratic from (-CAP_W/2, 0) to (CAP_W/2, 0), belly down.
    const x = -(CAP_W / 2) * (1 - t) * (1 - t) + (CAP_W / 2) * t * t;
    const y = 2 * t * (1 - t) * SHIELD_BULGE;
    low = Math.max(low, x * sin + y * cos);
  }
  return low;
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
 * @param {object} view    { w, h, colors, stars } — CSS pixels, the map's
 *        palette, and its starfield (makeStars): the shot paints its own
 *        background, because at the planet that background is a sky.
 * @param {object} state
 * @param {'moon'|'earth'} [state.body]  which surface this is; 'moon' default
 * @param {number} state.alt        altitude above the surface, m
 * @param {number} state.x          signed downrange to the site, m: negative on
 *        the way in, zero on it, positive once an ascent has left it
 * @param {'descent'|'ascent'|'surface'|'entry'|'landed'} state.kind  which leg
 *        is under way — the three lunar ones, and the two at home
 * @param {boolean} [state.aborted] the descent was waved off; draw it in the
 *        failure colour, short of a site it never reached
 * @param {boolean} [state.engine]  the engine is lit
 * @param {number} [state.realT]    real seconds, for flicker and dust only
 */
export function drawSurface(ctx, view, state) {
  const { w, h, colors } = view;
  const stars = view.stars ?? [];
  const cam = surfaceView(w, h);
  const alt = Math.max(0, state.alt);
  const x = state.x;
  const kind = state.kind;
  const earth = state.body === 'earth';
  const engine = state.engine === true;
  const realT = Number(state.realT) || 0;
  const color = state.aborted ? colors.fail : colors.accent;

  // The camera: the vehicle is always at the horizontal centre, and at
  // `anchorY` once it is high enough for the ground to be off the bottom.
  const camAlt = Math.max(alt, cam.liftAlt);
  const altToY = (a) => cam.anchorY - (a - camAlt) / cam.mPerPx;
  const yToAlt = (y) => camAlt - (y - cam.anchorY) * cam.mPerPx;
  const drToX = (dr) => w / 2 + (dr - x) / cam.mPerPx;
  const xToDr = (px) => x + (px - w / 2) * cam.mPerPx;

  const gy = altToY(0);
  // At the planet everything drawn over the world is blended against the sky
  // the way the launch view blends it, which is what stops a black-sky palette
  // being painted onto a blue one.
  const sky = earth ? skyAt(alt) : null;

  drawBackdrop();
  drawTicks();
  if (gy < h) {
    drawGround();
    if (!earth) drawCraters();
    drawSite();
    if (!earth && engine && alt < DUST_ALT) drawDust();
  }
  if (earth) drawCapsule();
  else drawLander();

  /**
   * What is overhead: space at the moon, and at the planet the launch view's
   * own sky, stars and cloud layer (see the header). The clouds go here rather
   * than with the ground because they are above it and the capsule comes down
   * THROUGH them.
   */
  function drawBackdrop() {
    if (!earth) {
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, w, h);
      // No air, so no sky and no fading: the stars are simply there.
      drawStarField(ctx, w, h, stars, { stars: 1 }, 0, 0, colors.fg);
      return;
    }
    paintSky(ctx, w, h, sky);
    drawStarField(
      ctx, w, h, stars, sky,
      (x / cam.mPerPx) * 0.04,
      ((camAlt - cam.liftAlt) / cam.mPerPx) * 0.12,
      colors.fg,
    );
    drawCloudLayer(
      ctx,
      { w, h, mPerPx: cam.mPerPx, drToX, altToY, xToDr, yToAlt },
      sky.day,
    );
  }

  /** The altitude ruler: the launch view's, unlabelled at 1 km, labelled at 5. */
  function drawTicks() {
    const top = yToAlt(0);
    const bottom = Math.max(yToAlt(Math.min(h, gy)), 0);
    ctx.save();
    ctx.strokeStyle = earth ? rgba(lineOver(sky), 1) : colors.muted;
    ctx.lineWidth = 1;
    ctx.globalAlpha = earth ? 0.3 : 0.16;
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
    ctx.globalAlpha = earth ? 0.75 : 0.4;
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
        ctx.fillStyle = earth ? rgba(inkOver(sky), 1) : colors.muted;
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
    const land = earth ? groundOver(sky) : null;
    const g = ctx.createLinearGradient(0, gy, 0, h);
    g.addColorStop(0, land ? rgba(land.fill, 1) : REGOLITH);
    g.addColorStop(1, land ? rgba(land.fill, 1) : REGOLITH_DARK);
    ctx.fillStyle = g;
    ctx.fillRect(0, gy, w, Math.max(h - gy, 0));
    ctx.strokeStyle = land ? rgba(land.line, 1) : REGOLITH_RIM;
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
    ctx.strokeStyle = earth ? rgba(inkOver(sky), 1) : colors.muted;
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

  /**
   * COMING HOME. The capsule, its heat shield, the plasma sheath while it is
   * still a meteor, and the canopy once it is not.
   *
   * Everything here is keyed on the altitude alone — the sheath fades in at the
   * interface and is gone by 25 km, the canopy comes out at CHUTE_ALT and fills
   * over CHUTE_FILL_M — so the sequence is a property of where the capsule is,
   * never of how the flight ends. There is nothing to decide: entry is free
   * (js/core/moon.js), the heat shield was a hardware gate before the burn for
   * home, and a capsule that is drawn here is one that is coming down.
   */
  function drawCapsule() {
    const px = drToX(x);
    const down = kind === 'landed';
    // Lifted by whatever the tilt would otherwise bury (landedLift).
    const py = altToY(alt) - (down ? landedLift() : 0);
    const ink = rgba(inkOver(sky), 1);
    ctx.save();
    ctx.translate(px, py);

    if (!down) {
      drawPlasma();
      drawChute();
    }

    // The body: a blunt cone, flat end down, standing on its shield. Landed,
    // it tips over onto its side the way a capsule on the ground does — about
    // the lifted origin, so the lowest corner of the tilt comes to rest ON the
    // ground rather than under it.
    if (down) ctx.rotate(LANDED_TILT);
    const top = -CAP_H;
    ctx.beginPath();
    ctx.moveTo(-CAP_W / 2, 0);
    ctx.lineTo(CAP_W / 2, 0);
    ctx.lineTo(CAP_W * 0.28, top);
    ctx.lineTo(-CAP_W * 0.28, top);
    ctx.closePath();
    ctx.fillStyle = colors.fg;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.stroke();
    // The shield: the part that does the work, and the only part that is hot.
    ctx.beginPath();
    ctx.moveTo(-CAP_W / 2, 0);
    ctx.quadraticCurveTo(0, SHIELD_BULGE, CAP_W / 2, 0);
    ctx.closePath();
    ctx.fillStyle = down ? ink : '#3b2b26';
    ctx.fill();
    // A stripe, so the sprite reads as the same craft the accent has drawn all
    // flight rather than a white wedge.
    ctx.fillStyle = colors.accent;
    ctx.fillRect(-CAP_W * 0.28, top + 1.5, CAP_W * 0.56, 2);
    ctx.restore();

    if (down) drawSpentCanopy();

    /** The sheath, and the trail of it streaming back downrange. */
    function drawPlasma() {
      const heat = alt >= PLASMA_HOT_M
        ? clamp01((PLASMA_TOP_M - alt) / (PLASMA_TOP_M - PLASMA_HOT_M))
        : clamp01((alt - PLASMA_OUT_M) / (PLASMA_COOL_M - PLASMA_OUT_M));
      if (heat <= 0.02) return;
      // Backwards is -x: the capsule is always flying toward the site.
      const len = 26 + 34 * heat;
      const g = ctx.createLinearGradient(0, 2, -len, -len * 0.18);
      g.addColorStop(0, `rgba(255,246,214,${0.95 * heat})`);
      g.addColorStop(0.35, `rgba(255,150,50,${0.6 * heat})`);
      g.addColorStop(1, 'rgba(255,70,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-CAP_W * 0.6, 3);
      ctx.lineTo(CAP_W * 0.6, 3);
      ctx.lineTo(-len, -len * 0.1);
      ctx.closePath();
      ctx.fill();
      // The bow shock itself, right under the shield.
      ctx.beginPath();
      ctx.ellipse(0, 3, CAP_W * 0.75, 4.5, 0, 0, Math.PI);
      ctx.fillStyle = `rgba(255,236,196,${0.85 * heat})`;
      ctx.fill();
    }

    /** The canopy, filling over the first CHUTE_FILL_M below CHUTE_ALT. */
    function drawChute() {
      if (alt > CHUTE_ALT) return;
      const open = clamp01((CHUTE_ALT - alt) / CHUTE_FILL_M);
      const wide = CHUTE_W * (0.25 + 0.75 * open);
      const high = CHUTE_H * (0.3 + 0.7 * open);
      const topY = -CAP_H - RISER_H * open - high;
      ctx.save();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * CAP_W * 0.3, -CAP_H);
        ctx.lineTo(side * wide * 0.42, topY + high);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(-wide / 2, topY + high);
      ctx.quadraticCurveTo(0, topY - high * 0.8, wide / 2, topY + high);
      ctx.closePath();
      ctx.fillStyle = '#f2f5f8';
      ctx.fill();
      ctx.stroke();
      // Two gores in the accent, so the canopy is this game's canopy.
      ctx.fillStyle = colors.accent;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(-wide * 0.09, topY + high * 0.15, wide * 0.18, high * 0.85);
      ctx.restore();
    }

    /** Down: the canopy collapsed on the ground beside it. */
    function drawSpentCanopy() {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#f2f5f8';
      ctx.beginPath();
      ctx.moveTo(px + 6, gy);
      ctx.quadraticCurveTo(px + 20, gy - 7, px + 34, gy);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }
}
