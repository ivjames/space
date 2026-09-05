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
//     the ticker prints it on. A `flyby` makes no burn at the moon at all, so
//     its arrival is an event and nothing else: the `flyby` event is the
//     closest approach, and it is the last thing on a flyby's timeline.
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
// hyperbola to trace.
//
// THE CLOSE-UP. The three steps AT the moon have no planet-centred orbit worth
// drawing, and the resolver hands them `elements: null` for exactly that
// reason. Drawing them ON the moon marker — a ring around it for lunar orbit,
// a dot on its limb for a landing — is what the cislunar frame did, and at
// this fit the marker is ten pixels of floored dust speck: the whole of a
// capture, a descent, a landing, a stay, an ascent and a departure happened
// inside a circle the width of the word MOON beside it. The mission is the
// part that cannot be seen.
//
// So when the vehicle arrives the CAMERA GOES IN. It is one frame still — the
// same two bodies, the same clock, the same events — with a centre and a fit
// that move: from the planet at the origin fitted to A_MOON, to the moon
// itself fitted to the drawn lunar orbit, about 150x closer. The scale eases
// geometrically and the pan is tied to it (the moon holds roughly still on
// screen while the picture opens around it, then centres), because panning
// linearly against a geometric zoom throws the moon off the canvas halfway
// through and brings it back.
//
// In the close-up the moon is drawn at TRUE SIZE and the 100 km orbit is
// stretched by LUNAR_ALT_EXAGGERATION — precisely the trade the planet-centred
// frame makes, one body over, and the corner note swaps from "bodies not to
// scale" to "lunar altitude x6" to say so. The vehicle is on that ring, moving
// at the period the ladder is priced against; the powered descent flies it
// down over DESCENT_TIME, braking, so its downrange rate falls away as its
// altitude does and it arrives with both at zero; the ascent is the same in
// reverse over ASCENT_TIME. Each leaves the same fading trail behind it that
// the transfer does, in the moon's frame rather than the planet's.
//
// None of that is new information. Every position in the close-up is derived
// from a burn that has already happened, the constants in js/core/moon.js and
// the playback clock: where the vehicle is put on the ring is the direction of
// home at the capture, and how far round it has gone since is the clock. The
// ONE thing worth naming is that the descent's LENGTH is known when it starts
// (it is a constant) while its OUTCOME is not: the landing event and the
// landing-failure event both arrive at the far end of it, which is what makes
// a descent something to watch rather than something to have watched.
//
// The two pictures do not cross-fade into each other, they hand over: below
// FRAME_CUTOFF of either, that one is not drawn. The planet-centred furniture
// at the close-up's scale is a set of paths tens of thousands of pixels wide,
// and there is nothing to be gained by stroking them at alpha 0.01.
//
// THE SHOT ON THE GROUND. The close-up is a picture of an orbit, and it stops
// being a picture of a landing in the last few kilometres of one: at a fit set
// by the drawn lunar orbit the moon is ninety pixels of radius, so the final
// kilometre is two of them and the lander is a marker touching a limb. The
// player watched the rocket leave the planet from a hundred metres away
// (js/ui/ascent.js: VIEW_SPAN_M, a fixed fifteen kilometres per canvas height);
// the moon is where the tier ends, and it deserves the same seat. So below
// SURFACE_ALT the view CUTS to js/ui/surface.js — the surface shot — which
// draws the touchdown and, a day later, the liftoff that starts the trip home,
// side-on, on the launch view's own ruler: the same metres per pixel, the same
// km ticks, the same ground marks. Sharing those constants is what makes "the
// same scale" a fact rather than a claim.
//
// It is a CUT and not a camera move, and that is the difference between it and
// the close-up above. The camera could travel from the planet to the moon
// because the two pictures share an origin, an orientation and a projection and
// differ only by 150x of scale. The surface shot shares none of them: its up is
// the local vertical at the landing site, its ground is flat, its altitudes are
// honest where the close-up's are stretched x6, and it is another 180x in.
// Easing between two pictures with nothing in common is a smear, so the view
// does what a broadcast does when the tracking camera has nothing left to show
// — it cuts to the one on the ground, dipped through black over SHOT_CUT_S.
// Which picture is live is `shotFade`, and what asks for the cut is the
// altitude the vehicle is drawn at right now: a position already on the screen,
// which is the same licence the three lunar rates take. A fourth rate goes with
// it (SHOT_RATE), because 240x plays the last eight kilometres in a fifth of a
// second.
//
// AND THE WAY HOME. A `return` profile's timeline used to end at the burn for
// home, so the map — which plays the timeline and stops at its last event —
// stopped with the vehicle at the moon on the one flight whose whole point is
// coming back from it. The resolver now carries the leg it always priced: the
// top of the atmosphere, one transfer of flight later, and the ground
// ENTRY_TIME after that (js/core/moon.js). So the coast home is FLOWN, in the
// cislunar frame the transfer out was flown in — the same fading arc, the same
// radius-scaled rate, and the closing range in the corner pointed the other
// way ("TO EARTH") — and then the ENTRY is the surface shot again, at the
// planet.
//
// That second shot opens at the interface rather than at SURFACE_ALT, because
// an entry has no orbital half to hand over from: there is no picture of it
// that is an orbit, and the whole hundred and twenty kilometres of it is
// weather. `entryAt` is the only opinion anything has about its shape, exactly
// as `poweredAt` is for the descent, and the sky it falls through is the launch
// view's own (js/ui/surface.js).
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
import {
  A_MOON, ASCENT_TIME, DESCENT_TIME, ENTRY_ALT, ENTRY_TIME, LLO_ALT, LLO_PERIOD,
  R_MOON, lunarLadder, lunarSchedule,
} from '../core/moon.js';
import { SURFACE_ALT, drawSurface } from './surface.js';
// The chrome is drawn over whatever the shot is drawn over, and at the planet
// that is a sky: these are the same blends js/ui/ascent.js reads its own labels
// against, so a clock over a daylight sky is legible for the same reason the
// launch view's is (see drawChrome).
import { accentOver, inkOver, parseHex, rgba, skyAt } from './ascent.js';

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
 * Rates at the moon, simulated seconds per real second, once the camera has
 * gone in (see THE CLOSE-UP in the header). Three of them, because the lunar
 * leg has three speeds and no single one of them reads:
 *
 *   LUNAR_RATE       coasting in low lunar orbit. A two-hour revolution plays
 *                    in about nine seconds, which makes the quarter of one the
 *                    schedule waits before descending a little over two — long
 *                    enough for the camera to finish arriving in it, which is
 *                    what sets the number.
 *   LUNAR_BURN_RATE  the powered descent and the powered ascent — the two legs
 *                    that are a trip rather than an instant, and the only ones
 *                    worth watching closely. A twelve-minute descent takes
 *                    three seconds of it.
 *   SURFACE_RATE     the stay, which is a day of doing nothing (there is no
 *                    surface activity in phase 3) and is over in two seconds.
 *
 * Each is keyed on what the vehicle is DOING, which is something a burn or an
 * event has already said — the same licence rateNow's radius scaling takes, and
 * the same shape as js/ui/ascent.js's burn and coast rates. They are quoted
 * absolutely and applied as a fraction of the playback rate, so a test that
 * overrides `speed` still scales all four together.
 */
export const LUNAR_RATE = 800;
export const LUNAR_BURN_RATE = 240;
export const SURFACE_RATE = 43200;

/**
 * Simulated seconds per real second inside the SURFACE SHOT — the fourth rate,
 * and the slowest of them, for the same reason the other three exist: what the
 * vehicle is doing has changed, and the number that read the last leg does not
 * read this one. `LUNAR_BURN_RATE` plays the whole descent in three seconds,
 * which is right while a hundred kilometres of it is on screen at once and
 * wrong for the last eight, where the picture is a kilometre and a half of
 * canvas: at 240x the lander crosses it in a fifth of a second. At this value
 * the last 8 km of a descent take about seven seconds and the first 8 km of the
 * ascent home about four, which is a landing and a liftoff rather than two
 * cuts. Keyed on the drawn altitude, which is an observable — the same licence
 * `rateNow`'s radius scaling takes, and it says nothing about how the flight
 * ends. The stay keeps SURFACE_RATE: a day at 30x is nine hours of watching.
 */
export const SHOT_RATE = 30;

/**
 * Simulated seconds per real second down the first hundred kilometres of the
 * flight home, before the surface shot's own scale means anything. The same
 * argument LUNAR_BURN_RATE makes at the moon: 120 km at 30x is a minute of
 * watching a capsule fall through an empty sky, and the part worth watching is
 * the part with a ground in it, which SHOT_RATE plays.
 */
export const ENTRY_RATE = 240;

/**
 * THE ENTRY, drawn. The resolver prices the way home as one burn and says how
 * long the fall at the far end of it takes (js/core/moon.js, ENTRY_TIME);
 * these three numbers are the only opinion anything has about the SHAPE of
 * that fall, and this is where they live for the same reason `poweredAt`'s
 * are here — this is the only place that draws it.
 *
 *   ENTRY_ALT    the interface, and where the shot opens — js/core/moon.js's,
 *                not one of this module's own, because it is the periapsis the
 *                leg home is aimed at and timed to (RETURN_TOF): the coast
 *                ends at the altitude the fall starts from, on the same frame.
 *   ENTRY_RANGE  how far downrange the fall covers. Chosen so that the shot
 *                OPENS at the speed a lunar return actually arrives at — the
 *                cubic below leaves 3 x RANGE / TIME at the interface, and at
 *                these values that is 11 km/s.
 *   ENTRY_FALL   the altitude's exponent. With the cubic downrange it puts the
 *                interface crossing at about two degrees below the horizon,
 *                which is the corridor a return from the moon has to fly, and
 *                it brings both rates to zero at the ground rather than
 *                arriving with either still on.
 */
const ENTRY_RANGE = 2.2e6;
const ENTRY_FALL = 1.9;

/**
 * How much lunar altitude is stretched in the close-up, relative to the moon's
 * own radius. Exactly the reason ALT_EXAGGERATION exists, one body over: the
 * orbit the ladder is priced against sits 100 km above a 1 737 km moon, which
 * is 6% and draws as a line on the limb. At x6 it is a ring a third of a radius
 * clear of the surface, which is a picture of an orbit.
 */
export const LUNAR_ALT_EXAGGERATION = 6;

/** Room left around the drawn lunar orbit in the close-up. */
const LUNAR_FIT_SLACK = 1.18;

/**
 * How far down an aborted descent is drawn, as a fraction of the descent it
 * was making.
 *
 * An abort is not a touchdown — `landed` is false, the contract does not pay,
 * and the readout says the flight ended on the way down — so the one thing the
 * close-up must not do is draw the vehicle sitting on the surface in red. That
 * is exactly what freezing it where the abort is ANNOUNCED would do: the roll
 * is about the touchdown itself ("3.2 m/s lateral drift"), so the resolver
 * announces it at the far end of the descent, which is ground level. A few
 * hundred metres short of it is a wave-off, which is what the word means.
 */
const ABORT_U = 0.94;

/**
 * Drawn distance from the moon's CENTRE for something at true distance `r`
 * from it: the moon keeps its size, the altitude above it is stretched. The
 * exact counterpart of `drawRadius` at the planet, and the reason the close-up
 * has a note in the corner.
 */
const drawLunar = (r) => R_MOON + (r - R_MOON) * LUNAR_ALT_EXAGGERATION;

/** Time constant of the camera move, real seconds. */
const ZOOM_TAU = 0.42;

/**
 * How long the last frame is held when the flight ends at the moon, real
 * seconds. Every lunar profile ends on a picture that is still moving — a
 * landing's last event is the touchdown, an orbit's is a revolution, a
 * return's is the burn that starts the camera pulling back — so without this
 * the view cuts to the result screen mid-move. It is real time with the
 * simulation stopped, so it shows nothing that had not already happened.
 */
const LUNAR_HOLD_S = 1.6;

/**
 * How long the cut to and from the surface shot takes, real seconds.
 *
 * It is a CUT, dipped through black, and not the camera move the close-up is.
 * The camera could move from the planet to the moon because both pictures share
 * an origin and an orientation and are 150x apart; the surface shot shares
 * neither — its up is the local vertical at the landing site, its ground is
 * flat, and nothing in it is exaggerated — and it is another 180x in. Easing
 * between two pictures with nothing in common is a smear, so the view does what
 * a broadcast does when the tracking camera has nothing left to show: it cuts
 * to the one on the ground. Fast enough that the dip costs about ten simulated
 * seconds, slow enough to read as a cut rather than a glitch.
 */
const SHOT_CUT_S = 0.36;

/**
 * Below this much of either picture, that picture is not drawn at all. It is a
 * cutoff rather than a fade to nothing because the two pictures are 150x apart
 * in scale: the planet-centred furniture at the close-up's scale is a set of
 * paths tens of thousands of pixels across, and drawing them at alpha 0.01
 * costs the same as drawing them at 1.
 */
const FRAME_CUTOFF = 0.02;

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
/**
 * How long the picture stays wide after arriving at the moon, real seconds,
 * before the camera starts moving (see THE CLOSE-UP in the header). One burn
 * flash, which is why it is that constant rather than a number of its own: the
 * capture is an event in the cislunar picture and reads as one there — a ring
 * expanding beside a moon at the end of a five-day arc — and a camera that
 * starts moving on the same frame throws that away. The same dwell runs before
 * the camera pulls back out after the burn for home.
 */
export const LUNAR_DWELL_S = FLASH_S;
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
  let half = 1;
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
  // The beat held at the end of a flight that finished at the moon (finish()).
  let holding = false;
  let holdLeft = 0;

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
  // A flyby has rounded the moon: the `flyby` event, which is the arrival a
  // profile that makes no burn there has instead of a capture.
  let flewBy = false;
  // The flown arc's two ends, in SIM time. It starts at the burn that put the
  // vehicle on the conic it is drawn on — t0 for the parking orbit the ascent
  // left it in — and runs to now, except while the vehicle is at the moon,
  // where there is no planet-centred motion left to trace and the arc holds at
  // the instant it arrived.
  let trailFrom = t0;
  let trailTo = null;

  // THE CLOSE-UP (see the header). `zoom` is how far the camera has moved from
  // the planet-centred picture to the moon-centred one, 0..1; it eases toward
  // whichever of the two the vehicle's CURRENT state asks for, and never
  // before `dwellUntil`, which is the beat the arrival and the departure are
  // each given at the wide scale first. Real seconds throughout: the camera is
  // the one thing here that is not on the simulation's clock.
  let zoom = 0;
  let dwellUntil = 0;
  /** The lunar orbit the ladder is priced against, and its rate of turn. */
  const rLLO = R_MOON + LLO_ALT;
  const lunarOmega = TWO_PI / LLO_PERIOD;
  /** Half-width the close-up fits to: the drawn orbit, plus room to label it. */
  const lunarFit = drawLunar(rLLO) * LUNAR_FIT_SLACK;
  // Where on that orbit the vehicle is, in the moon's frame. `lunarRef` is the
  // point a coast is measured from (set by the capture, and again when an
  // ascent finishes); `powered` is a descent or an ascent under way, which is
  // the only time the vehicle is not on the ring. Both are set by burns that
  // have happened.
  let lunarRef = null;              // { t, theta }
  let powered = null;               // { t, theta, span, kind }
  let touchdownTheta = 0;
  // THE SURFACE SHOT (js/ui/surface.js). How far the cut to it has gone, 0..1,
  // in real seconds like `zoom`: below a half the frame is the orbital picture,
  // above it the one on the ground, and the dip through black is widest at the
  // half. Nothing about it reads the outcome — it is asked for by the altitude
  // the vehicle is CURRENTLY drawn at, which is a position already on screen.
  let shotFade = 0;
  // THE FLIGHT HOME. `entering` is set by the entry event — the top of the
  // atmosphere, one transfer after the burn for home — and is what the shot on
  // the ground is drawn from once the vehicle is back at the planet; `home` is
  // the recovery event at the far end of it. Both are events that have already
  // been read out in the ticker, like everything else here.
  let entering = null;              // { t }
  let home = false;

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
    half = Math.max(1, Math.min(w, h) / 2 - FIT_MARGIN_PX);
    if (changed || stars.length === 0) stars = makeStars(STAR_COUNT, w, h);
  }

  /**
   * Point the camera, which is what `pxPerM` and the planet's screen position
   * are between them: `cx, cy` is where the world origin lands, so a `zoom` of
   * 0 puts it in the middle of the canvas and every frame draws exactly what it
   * drew before this existed.
   *
   * The scale eases GEOMETRICALLY across the 150x between the two pictures — a
   * linear one spends nine tenths of the move already at the moon — and the pan
   * is derived from the scale rather than from `zoom` directly, so that the
   * moon holds roughly still on screen while the picture opens around it. Pan
   * linearly against a geometric zoom and the moon leaves the canvas at the
   * halfway point and comes back.
   */
  function applyCamera() {
    let camX = 0;
    let camY = 0;
    let camFit = fit;
    if (cislunar && moon && zoom > 0) {
      camFit = fit * ((lunarFit / fit) ** zoom);
      const pan = (fit - camFit) / (fit - lunarFit);
      const mp = stateAt(moon, simT);
      camX = mp.x * pan;
      camY = mp.y * pan;
    }
    pxPerM = half / camFit;
    cx = w / 2 - camX * pxPerM;
    cy = h / 2 + camY * pxPerM;
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
  function drawPlanet(alpha = 1) {
    // MIN_BODY_PX is a no-op in the stretched frame and the whole of the
    // planet in the cislunar one, where its true size is two pixels.
    const rp = Math.max(R * pxPerM, MIN_BODY_PX);
    ctx.save();
    ctx.globalAlpha = alpha;
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

    ctx.globalAlpha = 0.35 * alpha;
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
  function drawTrail(orbit, fromT, toT, stroke, fade = 1) {
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
      ctx.globalAlpha = (TRAIL_MIN_ALPHA + (TRAIL_MAX_ALPHA - TRAIL_MIN_ALPHA) * u) * fade;
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
  function drawChrome(toMoon = null, altitude = null, toEarth = null) {
    // Over a daylight sky the night palette's greys and its cyan wash out to
    // nothing, so on the way home the chrome blends against the sky exactly as
    // the launch view's own labels do. Everywhere else — space, the moon, the
    // dip through black at the top of an entry — the blend is a no-op, because
    // the sky it blends against is night.
    const overSky = entering && shotShown() && Number.isFinite(altitude)
      ? skyAt(Math.max(0, altitude))
      : null;
    const muted = overSky ? rgba(inkOver(overSky), 1) : colors.muted;
    const accent = overSky
      ? rgba(accentOver(overSky, parseHex(colors.accent, [0, 212, 255])), 1)
      : colors.accent;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = muted;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText(formatClock(simT - t0), 6, 6);
    ctx.fillStyle = accent;
    ctx.font = 'bold 10px "Courier New", monospace';
    // Which phase of the flight this is. The entry is the one part of a lunar
    // mission that is not cislunar at all — it is eight kilometres over the
    // launch site under a canopy — and saying otherwise there is the sort of
    // label a player reads twice.
    ctx.fillText(
      entering ? 'ENTRY PHASE' : cislunar ? 'CISLUNAR PHASE' : 'ORBITAL PHASE',
      6, 20,
    );

    if (Number.isFinite(toMoon)) {
      ctx.fillStyle = muted;
      ctx.font = '10px "Courier New", monospace';
      ctx.fillText(`TO MOON ${formatFarRange(toMoon)}`, 6, 34);
    } else if (Number.isFinite(toEarth)) {
      // The same measurement pointed the other way, on the way home. It is the
      // vehicle's own altitude above the planet — a number off the picture,
      // like the range to the moon is — and it is the one line that says the
      // flight is closing rather than merely coasting.
      ctx.fillStyle = muted;
      ctx.font = '10px "Courier New", monospace';
      ctx.fillText(`TO EARTH ${formatFarRange(toEarth)}`, 6, 34);
    } else if (Number.isFinite(altitude)) {
      // The same measurement one body over, and quoted in the near-field
      // format rather than the cislunar one: a descent finishes in metres.
      ctx.fillStyle = muted;
      ctx.font = '10px "Courier New", monospace';
      ctx.fillText(`ALTITUDE ${formatRange(Math.max(0, altitude))}`, 6, 34);
    }

    ctx.fillStyle = muted;
    ctx.font = '9px "Courier New", monospace';
    ctx.textBaseline = 'bottom';
    // Exactly one of the two is a lie in any of the three pictures, and this
    // says which: the stretched frame's altitudes, the cislunar frame's
    // bodies, and — the close-up being the cislunar frame's trade made over
    // again about the moon — the close-up's altitudes.
    // The shot on the ground is the one picture in the game where neither of
    // the two is a lie: the moon is not drawn as a body at all, nothing is
    // stretched, and a pixel is the same number of metres it was on the way up
    // off the planet. So the slot says which scale that is instead.
    const note = cislunar
      ? (shotShown() ? 'launch scale'
        : zoom > 0.5 ? `lunar altitude ×${LUNAR_ALT_EXAGGERATION}` : 'bodies not to scale')
      : `altitude ×${ALT_EXAGGERATION}`;
    ctx.fillText(note, 6, h - 6);

    // The word in the corner is only ever something that has already been read
    // out in the ticker.
    const word = cislunar
      ? (failed ? 'BURN FAILED'
        : landingAborted ? 'LANDING ABORTED'
          : home ? 'RECOVERED'
            : entering ? 'ENTRY'
              : returning ? 'RETURNING'
                : atMoon === 'surface' ? 'LANDED'
                  : atMoon === 'descent' ? 'DESCENT'
                    : atMoon === 'ascent' ? 'ASCENT'
                      : flewBy ? 'FLYBY' : null)
      : (docked ? 'DOCKED' : dockFailed ? 'DOCKING ABORTED' : failed ? 'BURN FAILED' : null);
    if (word) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 11px "Courier New", monospace';
      const good = cislunar
        ? word !== 'BURN FAILED' && word !== 'LANDING ABORTED'
        : word === 'DOCKED';
      ctx.fillStyle = good ? accent : colors.fail;
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
   * A point on a powered leg, as a fraction `u` of the way through it, in the
   * moon's frame.
   *
   * Altitude goes as (1-u)^2 coming down and u^2 going up, so the vehicle
   * reaches the surface with its rate of descent already at zero and leaves it
   * with its rate of climb building from zero — a soft landing and a liftoff,
   * rather than two collisions. The angle swept goes with the integral of the
   * same factor, which is a descent that brakes as it falls and an ascent that
   * accelerates as it climbs. A descent covers about 18 degrees of moon doing
   * it; Apollo's covered 490 km of a 10 900 km circumference, which is 16.
   *
   * Nothing here is resolved anywhere else: the resolver prices the leg as one
   * impulsive burn and says how long it takes (js/core/moon.js), and this is
   * the only place that has an opinion about the shape of it, because this is
   * the only place that draws it.
   */
  function poweredAt(leg, u) {
    const c = Math.min(1, Math.max(0, u));
    const down = leg.kind === 'descent';
    const h = down ? (1 - c) * (1 - c) : c * c;
    const swept = down ? c - (c * c) / 2 : (c * c) / 2;
    return {
      r: R_MOON + (rLLO - R_MOON) * h,
      theta: leg.theta + lunarOmega * leg.span * swept,
    };
  }

  /**
   * Where the capsule is `u` of the way through the fall home, in the same two
   * numbers the surface shot takes everywhere else: the altitude above the
   * ground, and the signed downrange to the point it is coming down at, which
   * is negative all the way in and zero on arrival.
   *
   * Altitude goes as (1-u)^ENTRY_FALL and the distance still to run as (1-u)^3,
   * so the capsule crosses the interface shallow and fast — eleven kilometres a
   * second, two degrees below the horizon — loses almost all of the downrange
   * in the first minute of atmosphere, and comes down the last few kilometres
   * nearly vertically with both rates falling to nothing at the ground. It is
   * the descent's own trick (poweredAt) with the exponents that make an entry
   * rather than a landing: there, the two shapes match and the path is a
   * straight line; here the horizontal dies faster than the vertical, which is
   * what a parachute looks like at the end of a re-entry.
   */
  function entryAt(u) {
    const c = Math.min(1, Math.max(0, u));
    const left = 1 - c;
    return {
      alt: ENTRY_ALT * (left ** ENTRY_FALL),
      x: -ENTRY_RANGE * (left ** 3),
    };
  }

  /**
   * Where the vehicle is in the MOON's frame at time `t`: its true distance
   * from the moon's centre, and its angle round it. Three states, each of them
   * entered by a burn or an event that has already happened — coasting the
   * orbit the capture put it in, under power on a descent or an ascent, or
   * sitting where the touchdown left it. Nothing rotates the moon, so the last
   * of those does not move.
   */
  function lunarPoint(t) {
    if (atMoon === 'surface') return { r: R_MOON, theta: touchdownTheta };
    if (powered) {
      const u = (t - powered.t) / powered.span;
      return poweredAt(powered, landingAborted ? Math.min(u, ABORT_U) : u);
    }
    const ref = lunarRef ?? { t, theta: 0 };
    return { r: rLLO, theta: ref.theta + lunarOmega * (t - ref.t) };
  }

  /**
   * A point in the moon's frame as a planet-centred one, so that the frame's
   * own `screenOf` draws it and the close-up needs no second projection.
   *
   * The moon's position is passed IN rather than sampled per point, because a
   * path in the moon's frame is a path in the moon's frame: sampling the
   * moon's own orbital motion along a twelve-minute descent would smear it
   * across the thousand kilometres the moon travels while it happens.
   */
  function toWorld(p, mp) {
    const rd = drawLunar(p.r);
    return { x: mp.x + Math.cos(p.theta) * rd, y: mp.y + Math.sin(p.theta) * rd, r: 0 };
  }

  /** Which way home is, in the moon's frame: where a capture arrives. */
  function homeTheta(t) {
    const mp = stateAt(moon, t);
    return Math.atan2(-mp.y, -mp.x);
  }

  /** Screen heading in the close-up, exactly as `headingAt` is for an orbit. */
  function lunarHeading(t, mp) {
    const dt = LLO_PERIOD / 512;
    const a = screenOf(toWorld(lunarPoint(t - dt), mp));
    const b = screenOf(toWorld(lunarPoint(t), mp));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (!dx && !dy) return 0;
    return Math.atan2(dy, dx);
  }

  /**
   * The path flown since the current powered leg lit, fading out behind — the
   * transfer's trail, in the moon's frame and over a quarter of an hour rather
   * than five days. It survives the touchdown that ends it, so the descent is
   * still drawn while the vehicle sits at the bottom of it, and it stops where
   * an abort stopped the vehicle.
   */
  function drawLunarTrail(toT, mp, stroke, fade) {
    if (!powered) return;
    const flown = (toT - powered.t) / powered.span;
    const uEnd = Math.min(landingAborted ? ABORT_U : 1, flown);
    if (!(uEnd > 0)) return;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    let prev = screenOf(toWorld(poweredAt(powered, 0), mp));
    for (let i = 1; i <= TRAIL_STEPS; i += 1) {
      const u = i / TRAIL_STEPS;
      const pt = screenOf(toWorld(poweredAt(powered, uEnd * u), mp));
      ctx.globalAlpha = (TRAIL_MIN_ALPHA + (TRAIL_MAX_ALPHA - TRAIL_MIN_ALPHA) * u) * fade;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      prev = pt;
    }
    ctx.restore();
  }

  /**
   * A circle drawn around something already on screen, at a radius in pixels:
   * the ring that stands for lunar orbit while the picture is still wide, and
   * the lunar orbit itself once the camera has gone in.
   */
  function drawRing(pt, r, color, alpha, dash) {
    if (!(r > 0) || !(alpha > 0)) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The cislunar frame, at whichever of its two scales the camera is between
   * (see THE CLOSE-UP in the header): the two bodies and the transfer between
   * them, or the moon, the orbit round it and the ground under that.
   *
   * The moon is drawn from the first frame; everything about the vehicle comes
   * from a burn or an event that has already happened.
   */
  function frameCislunar() {
    const mp = stateAt(moon, simT);
    const mpt = screenOf(mp);
    // Planet-centred on a conic of its own, or somewhere in the moon's frame
    // once a capture has put it there.
    const here = atMoon ? lunarPoint(simT) : null;
    const vp = here ? toWorld(here, mp) : stateAt(vehicle, simT);
    const vpt = screenOf(vp);

    const track = failed ? colors.fail : colors.accent;
    // How much of each of the two pictures is on screen. NOT `zoom` and
    // `1 - zoom`: the camera crosses 150x of scale, so by a third of the way in
    // the planet-centred furniture is already a set of arcs thousands of pixels
    // wide with no shape left to read, and the lunar orbit on the way out is a
    // ring the size of a marker. Each picture is faded over the half of the
    // move that it means anything in, and both are cut below FRAME_CUTOFF.
    const wide = Math.max(0, 1 - zoom * 2.4);
    const near = Math.max(0, (zoom - 0.45) / 0.55);

    drawSpace();
    if (wide > FRAME_CUTOFF) {
      drawPlanet(wide);
      drawOrbit(moon, colors.muted, [4, 4], 0.5 * wide);
      // Where it is going, and then — over the top of it — how much of that it
      // has actually flown. Two curves rather than one: see the header.
      drawOrbit(vehicle, track, [3, 5], PROJECTION_ALPHA * wide);
      drawTrail(vehicle, trailFrom, trailTo ?? simT, track, wide);
    }
    const rm = drawMoon(mpt);
    // Which side of the moon to put the vehicle on: the one facing home, which
    // is the only direction this frame has an opinion about. Its label goes a
    // line ABOVE the moon's rather than beside it — at the wide scale the two
    // markers are a few pixels apart, and no horizontal rule keeps two labels
    // off each other once the moon is near an edge and both flip the same way.
    const moonSide = cx - mpt.x > 0 ? -1 : 1;
    drawLabel(mpt, colors.muted, 'MOON', rm + 7, moonSide);

    if (atMoon) {
      const color = failed || landingAborted ? colors.fail : colors.accent;
      // The orbit it was captured into, at whichever scale can show it: a ring
      // just clear of a ten-pixel marker while the picture is wide, and the
      // orbit itself — true moon, stretched altitude — once the camera is in.
      if (wide > FRAME_CUTOFF && atMoon !== 'surface') {
        drawRing(mpt, rm + 5, color, 0.9 * wide, []);
      }
      if (near > FRAME_CUTOFF) {
        drawRing(mpt, drawLunar(rLLO) * pxPerM, colors.muted, 0.45 * near, [4, 4]);
        drawLunarTrail(simT, mp, color, near);
      }
      // A craft under way, a dot once it is down. The label is the moon's own
      // rule in reverse, for the same reason: at the wide scale the two are
      // the same few pixels.
      if (atMoon === 'surface') drawMarker(vpt, color, null, true);
      else drawCraft(vpt, lunarHeading(simT, mp), color, null);
      // In the close-up the vehicle is its own marker, a moon's radius clear of
      // the moon's label, so its own goes beside it. While the picture is wide
      // the two are the same few pixels and nothing horizontal separates them,
      // so it goes a line above the moon instead.
      if (near > 0.5) drawLabel(vpt, color, 'VEHICLE', 11, -moonSide);
      else drawLabel({ x: mpt.x, y: mpt.y - rm - 11 }, color, 'VEHICLE', rm + 7, moonSide);
      drawFlashes(vpt);
    } else {
      // A flyby's closest approach puts the craft ON the moon marker — the
      // transfer's apoapsis is where the moon is, which is what makes it a
      // flyby — so once the two are within a marker of each other the craft's
      // label goes a line above, exactly as the captured vehicle's does, and
      // the two stop printing over one another. Measured off the two screen
      // positions, like everything else in this frame, not off the outcome.
      const crowded = Math.hypot(vpt.x - mpt.x, vpt.y - mpt.y) < rm + CRAFT_LEN;
      drawCraft(vpt, headingAt(vehicle, simT), track, crowded ? null : 'VEHICLE');
      if (crowded) {
        drawLabel({ x: mpt.x, y: mpt.y - rm - 11 }, track, 'VEHICLE', rm + 7, moonSide);
      }
      drawFlashes(vpt);
    }

    // How far there is still to go, measured off the two positions on screen
    // exactly as the tier 3 frame's separation line is. It is the one number
    // that says "approaching" rather than "en route", and it says nothing
    // about whether the vehicle gets there. At the moon it gives way to the
    // altitude, which is the same measurement one body over and is what the
    // descent is: a hundred kilometres counted down to nothing.
    veil();
    drawChrome(
      here || returning ? null : Math.hypot(mp.x - vp.x, mp.y - vp.y),
      here ? here.r - R_MOON : null,
      here || !returning ? null : Math.max(0, Math.hypot(vp.x, vp.y) - R),
    );
  }

  /**
   * Is the vehicle low enough for the shot on the ground (js/ui/surface.js)?
   *
   * The altitude it is drawn at right now, and which leg it is on — both of
   * them things a burn or an event has already said, exactly as the three lunar
   * rates are. A coast in lunar orbit is a hundred kilometres up and is the
   * close-up's picture; a descent below SURFACE_ALT, the stay, and the first
   * kilometres of the ascent home are the surface's.
   */
  function nearSurface() {
    if (!cislunar) return false;
    // Home: the shot owns the frame from the interface down, because the whole
    // of an entry is inside the atmosphere and none of it is an orbit.
    if (entering) return true;
    if (!atMoon) return false;
    if (atMoon === 'surface') return true;
    if (!powered) return false;
    return lunarPoint(simT).r - R_MOON <= SURFACE_ALT;
  }

  /** Which of the two pictures owns this frame. */
  const shotShown = () => shotFade >= 0.5;

  /**
   * What the surface shot is drawn from, measured off the same lunar state the
   * close-up plots: the altitude above the surface, and the signed downrange to
   * the SITE — the point the descent under way is aimed at, which is the far end
   * of the leg that has already lit, or the point the ascent lifted from.
   *
   * The site is not the outcome. Where a descent is aimed is fixed by the burn
   * that started it and DESCENT_TIME, both in the past; whether the vehicle
   * arrives there is the landing event's to say, and an abort is drawn stopped
   * short of it (ABORT_U), which is the one thing the close-up was too far out
   * to show.
   */
  function surfaceState() {
    if (entering) {
      const p = entryAt((simT - entering.t) / ENTRY_TIME);
      return {
        body: 'earth',
        alt: p.alt,
        x: p.x,
        kind: home ? 'landed' : 'entry',
        realT,
      };
    }
    const p = lunarPoint(simT);
    const site = atMoon === 'surface' || !powered
      ? touchdownTheta
      : powered.kind === 'descent' ? poweredAt(powered, 1).theta : powered.theta;
    const kind = atMoon === 'surface' || !powered ? 'surface' : powered.kind;
    return {
      body: 'moon',
      alt: p.r - R_MOON,
      x: R_MOON * (p.theta - site),
      kind,
      aborted: landingAborted,
      engine: kind !== 'surface',
      realT,
    };
  }

  /** The dip through black the cut is made across (SHOT_CUT_S). */
  function veil() {
    const a = 1 - Math.abs(2 * shotFade - 1);
    if (a <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /**
   * The shot on the ground: the same starfield the frame above it has, the
   * surface view (js/ui/surface.js) at the launch scale, and the same chrome —
   * the clock and the altitude never blink, whichever camera is live.
   */
  function frameSurface() {
    const state = surfaceState();
    drawSurface(ctx, { w, h, colors, stars }, state);
    veil();
    drawChrome(null, state.alt);
  }

  function frame() {
    resize();
    applyCamera();
    if (!cislunar) {
      frameOrbital();
      return;
    }
    if (shotShown()) frameSurface();
    else frameCislunar();
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
      powered = null;
      lunarRef = null;
      returning = true;
      trailFrom = burn.t;
      trailTo = null;
      // The departure gets the same beat at the wide scale that the arrival
      // got, and for the same reason: the burn is the event, and the camera
      // pulling out over the top of it is not.
      dwellUntil = realT + LUNAR_DWELL_S;
      return;
    }
    // The capture puts it in lunar orbit, on the side of the moon it arrived
    // from, which is the side facing home.
    if (burn.kind === 'loi') {
      atMoon = 'orbit';
      lunarRef = { t: burn.t, theta: homeTheta(burn.t) };
      powered = null;
      dwellUntil = realT + LUNAR_DWELL_S;
      // Arrived: the trail stops where the capture happened rather than
      // carrying on round the transfer the vehicle is no longer flying.
      if (trailTo === null) trailTo = burn.t;
      return;
    }
    // The two legs with a length. Whether the descent between them ended on
    // the surface is the landing event's to say, not the burn's — the burn can
    // succeed and the touchdown still fail, and DESCENT_TIME separates them.
    if (burn.kind === 'descent') {
      powered = { t: burn.t, theta: lunarPoint(burn.t).theta, span: DESCENT_TIME, kind: 'descent' };
      atMoon = 'descent';
      return;
    }
    if (burn.kind === 'ascent') {
      powered = { t: burn.t, theta: touchdownTheta, span: ASCENT_TIME, kind: 'ascent' };
      atMoon = 'ascent';
    }
  }

  /**
   * The one lunar transition no burn and no event announces: the far end of an
   * ascent, which is the vehicle back in the orbit it left. It is derived from
   * the burn that started it and a constant, exactly as the descent's far end
   * is, so it is not a look-ahead — it is the same arithmetic one frame later.
   */
  function settle(t) {
    if (powered && powered.kind === 'ascent' && t >= powered.t + powered.span) {
      lunarRef = { t: powered.t + powered.span, theta: poweredAt(powered, 1).theta };
      powered = null;
      atMoon = 'orbit';
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
      // reaches the surface on the frame the ticker says it did, which is the
      // far end of the descent it has spent the last DESCENT_TIME flying.
      else if (ev.kind === 'landing') {
        touchdownTheta = lunarPoint(ev.t).theta;
        atMoon = 'surface';
      } else if (ev.kind === 'landing-failure') {
        // Waved off: the descent holds just short of the ground rather than
        // finishing on a surface the vehicle never reached (ABORT_U).
        landingAborted = true;
      }
      // Home. The interface is the frame the shot on the ground takes over on
      // (nearSurface), and the recovery is the far end of the fall it has spent
      // ENTRY_TIME flying — the same shape as the descent and its touchdown,
      // one body over.
      else if (ev.kind === 'entry') {
        entering = { t: ev.t };
      } else if (ev.kind === 'recovery') {
        home = true;
      }
      // The pass. Nothing about the drawn orbit changes — the vehicle is still
      // coasting the transfer it departed on, which is the whole point of a
      // free return — so this only says the corner word out loud.
      else if (ev.kind === 'flyby') flewBy = true;
      try {
        onEvent(ev);
      } catch (err) {
        // A broken ticker must not stop the playback.
        console.error('map onEvent threw:', err);
      }
    }
  }

  function finish() {
    if (handle.done || holding) return;
    simT = finalT;
    flushTo(finalT);
    settle(finalT);
    // A flight that ends at the moon ends on a picture that is still moving:
    // a landing's last event is the touchdown, an orbit's is a revolution, and
    // a return's is the burn that starts the camera pulling back out. Hold the
    // last frame for a beat rather than cutting to the result screen mid-move.
    // Real time with the simulation stopped, so nothing that had not already
    // happened is shown — and a tap skips it like everything else.
    if (!skipped && cislunar && (atMoon || entering || zoom > FRAME_CUTOFF)) {
      holding = true;
      holdLeft = LUNAR_HOLD_S;
      dwellUntil = 0;
      frame();
      raf = requestAnimationFrame(tick);
      return;
    }
    complete();
  }

  /** The end of playback proper: draw the last frame, let go, hand back. */
  function complete() {
    if (handle.done) return;
    holding = false;
    handle.done = true;
    // A skip has no time to move the camera in, so it arrives where it would
    // have arrived.
    if (skipped && cislunar) {
      zoom = atMoon ? 1 : 0;
      shotFade = nearSurface() ? 1 : 0;
    }
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
    // At the moon the radius that scales the cislunar rate stops meaning
    // anything — everything happens within a thousandth of it — so the three
    // things the vehicle can be doing there set the rate instead. Each is
    // something a burn or an event has already said (see LUNAR_RATE).
    // Coming home: fast down the empty part, the shot's own rate once there is
    // a ground in the picture. Keyed on the altitude it is drawn at, like
    // everything else here.
    if (entering) {
      const { alt } = entryAt((simT - entering.t) / ENTRY_TIME);
      return rate * ((alt > SURFACE_ALT ? ENTRY_RATE : SHOT_RATE) / CISLUNAR_RATE);
    }
    if (atMoon) {
      const powering = atMoon === 'descent' || atMoon === 'ascent';
      const near = atMoon === 'surface' ? SURFACE_RATE
        : powering ? (nearSurface() ? SHOT_RATE : LUNAR_BURN_RATE)
          : LUNAR_RATE;
      return rate * (near / CISLUNAR_RATE);
    }
    const { r } = stateAt(vehicle, simT);
    return rate * Math.min(1, Math.max(CISLUNAR_MIN_FRAC, r / A_MOON));
  }

  /**
   * Move the camera toward whichever picture the vehicle's CURRENT state asks
   * for, once whatever dwell it was given has run out. Real time, an
   * exponential ease, and a snap at the end so that `zoom` reaches its target
   * exactly rather than approaching it for the rest of the flight.
   */
  function easeCamera(dt) {
    if (!cislunar || realT < dwellUntil) return;
    const target = atMoon ? 1 : 0;
    if (zoom === target) return;
    zoom += (target - zoom) * (1 - Math.exp(-dt / ZOOM_TAU));
    if (Math.abs(target - zoom) < 0.002) zoom = target;
  }

  /**
   * Run the cut to or from the shot on the ground. Linear rather than the
   * camera's exponential ease: a cut has a length, and half of it is the frame
   * the pictures change on (SHOT_CUT_S).
   */
  function easeShot(dt) {
    if (!cislunar) return;
    const target = nearSurface() ? 1 : 0;
    if (shotFade === target) return;
    const step = dt / SHOT_CUT_S;
    shotFade = target > shotFade
      ? Math.min(target, shotFade + step)
      : Math.max(target, shotFade - step);
  }

  function tick(now) {
    if (stopped) return;
    if (!lastNow) lastNow = now;
    const dt = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    realT += dt;
    // The hold at the end: real time runs, the simulation does not.
    if (holding) {
      holdLeft -= dt;
      easeCamera(dt);
      easeShot(dt);
      frame();
      if (holdLeft <= 0) complete();
      else raf = requestAnimationFrame(tick);
      return;
    }
    // A RATE IS ONLY VALID UP TO THE NEXT THING THAT CHANGES IT, so a frame
    // never carries the clock past a burn or an event. The stay on the surface
    // runs at SURFACE_RATE — a day in two seconds — and one frame of that is
    // 4 320 simulated seconds, which is ten times the whole climb back to
    // orbit: unclamped, the frame that ends the stay steps over the ascent
    // burn, over ASCENT_TIME and out the far side, and the flight goes from
    // sitting on the moon to being in orbit round it between two frames with
    // nothing drawn in between. Clamping drops the remainder of that frame,
    // which costs at most one frame at the new rate, and it lands every burn
    // flash on its own instant rather than up to a frame late.
    const bound = Math.min(
      burnsApplied < burns.length ? burns[burnsApplied].t : Infinity,
      emitted < events.length ? events[emitted].t : Infinity,
    );
    const step = dt * rateNow();
    // Everything at or before `simT` has been flushed, so `bound` is always
    // ahead of it; the guard is there so that a degenerate timeline stalls
    // nothing — a clamp to a boundary behind the clock would never advance.
    simT = bound > simT ? Math.min(simT + step, bound) : simT + step;
    easeCamera(dt);
    easeShot(dt);
    if (simT >= finalT) {
      finish();
      return;
    }
    flushTo(simT);
    settle(simT);
    frame();
    raf = requestAnimationFrame(tick);
  }

  function skip() {
    if (stopped || handle.done) return;
    cancelAnimationFrame(raf);
    skipped = true;
    if (holding) complete();
    else finish();
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
