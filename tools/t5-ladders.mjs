#!/usr/bin/env node
// Tier 5 candidate ladders and schedules, so the numbers in ARCHITECTURE.md's
// "Phase 5 -- tier 5, the neighbours" can be reproduced rather than believed.
//
// WHY THIS EXISTS, AND WHEN IT GOES AWAY. Every number in that section was
// measured before the tier was built, which is the repo's rule (DESIGN.md
// SS14.3: computed, not looked up) -- but the module that will own those
// constants, js/core/system.js, does not exist yet, so there was nowhere for
// the measurement to live. This file is that nowhere: the candidate bodies'
// constants, and the same arithmetic js/core/moon.js does one level up,
// written against js/core/orbit.js's own functions so the two cannot disagree
// about vis-viva or about a Hohmann transfer.
//
// WHEN js/core/system.js LANDS, DELETE THIS. The bodies move into that module,
// the ladder becomes `bodyLadder`, and tools/balance.mjs measures tier 5 the
// way it measures every other tier -- against the real resolver, with a real
// tree behind it. A probe that has been superseded by the thing it was
// probing is a second source of truth, which is the one thing the repo's
// numbers cannot have.
//
// WHAT IT IS NOT. It does not fly anything. There is no vehicle, no tree, no
// resolver and no rng here: it prices the LADDER, which is a property of the
// bodies alone, and it takes the parking orbit as an argument because that is
// the one thing the vehicle decides. The budget those ladders are spent out of
// -- 9 151 m/s of remaining stack at insertion for a tier 4 return -- comes
// from tools/balance.mjs, which does fly things, and is quoted here rather
// than recomputed.
//
// Run: node tools/t5-ladders.mjs

import { elementsFrom, velocityAt, radiusOf, MU } from '../js/core/orbit.js';

const TAU = Math.PI * 2;
const DAY = 86400;

/** The star's standard gravitational parameter, m^3/s^2. Sun-like. */
const MU_STAR = 1.32712e20;
/** The home planet's heliocentric radius, m. Circular, coplanar (see below). */
const A_HOME = 1.496e11;

// THE APPROXIMATIONS, on top of the five js/core/moon.js already lists (they
// all still apply, one level up):
//
//   6. EVERY ORBIT ABOUT THE STAR IS CIRCULAR AND COPLANAR. Real transfer
//      windows move by hundreds of m/s between oppositions because the bodies'
//      orbits are eccentric and inclined; the game has no clock to move them
//      with, so a window here is a fixed geometry rather than a good year and
//      a bad one.
//   7. NO GRAVITY ASSISTS. Same reason the moon is not a second attractor:
//      an assist is a patched conic with a timing constraint, and the game
//      resolves the whole interplanetary leg analytically. It is why the gas
//      giant below is out of reach rather than merely expensive.
//   8. THE CAPTURE IS PRICED AT ONE RADIUS. A low orbit for a planet, the
//      moon's own orbital radius for a moon -- no multi-burn capture, no
//      aerocapture, no apoapsis-raising tricks.

/** Circular speed about the star at radius r, m/s. */
const vStar = (a, r) => Math.sqrt(MU_STAR * (2 / r - 1 / a));
/** Orbital period about the star, s. */
const starPeriod = (a) => TAU * Math.sqrt((a ** 3) / MU_STAR);

/**
 * The burn that turns a bound orbit into a hyperbolic departure, or the
 * reverse. Identical in form to js/core/moon.js's `loi`, which is the point:
 * an escape and a capture are one calculation with the sign of intent.
 */
const hyperBurn = (mu, r, vInf, vHave) => Math.sqrt(vInf * vInf + 2 * (mu / r)) - vHave;

/** Gravity and steering loss on a powered ascent from an airless surface. */
const LANDING_LOSS = 1.15;
/**
 * What a powered descent costs on a body WITH an atmosphere, as a fraction of
 * circular speed. Entry and the aeroshell do the rest -- which is the whole
 * reason the outer planet is landable on this tree and the moon of tier 4 was
 * an 1 879 m/s rung. A quarter is the terminal-descent share of a Mars-class
 * entry, where the atmosphere is thin enough to need a real burn at the end
 * and thick enough that the burn is not the orbit.
 */
const ATMO_DESCENT = 0.25;

const BODIES = [
  // id, label, heliocentric a, mu, radius, low-orbit altitude, atmosphere?
  ['inner', 'inner planet',   1.082e11, 3.2486e14, 6.0518e6, 3e5, true],
  ['outer', 'outer planet',   2.279e11, 4.2828e13, 3.3895e6, 3e5, true],
  ['giant', 'gas giant',      7.785e11, 1.26687e17, 6.9911e7, 6.9911e7, true],
];

// The outer planet's moons: priced THROUGH their planet, capturing at the
// moon's own orbital radius instead of at a low planetary orbit.
const OUTER_MOONS = [
  ['outer/a', 'inner moon', 9.376e6, 7.11e5, 1.11e4],
  ['outer/b', 'outer moon', 2.346e7, 9.8e4, 6.2e3],
];

/**
 * The interplanetary ladder from a given parking orbit, all m/s, plus the
 * schedule's own seconds.
 *
 * @param {number} rp parking periapsis RADIUS about the home planet, m
 * @param {number} ra parking apoapsis RADIUS, m
 */
function ladderFor(body, rp, ra) {
  const [, , aB, muB, rB, parkAlt, atmo] = body;
  const vPark = velocityAt(elementsFrom(rp, ra).a, rp);
  const vHome = Math.sqrt(MU_STAR / A_HOME);

  // The heliocentric Hohmann transfer, and the excess speeds at both ends.
  const aT = (A_HOME + aB) / 2;
  const vInfDepart = Math.abs(vStar(aT, A_HOME) - vHome);
  const vInfArrive = Math.abs(vStar(aT, aB) - Math.sqrt(MU_STAR / aB));

  const tmi = hyperBurn(MU, rp, vInfDepart, vPark);

  const rLow = rB + parkAlt;
  const vCirc = Math.sqrt(muB / rLow);
  const capture = hyperBurn(muB, rLow, vInfArrive, vCirc);

  const descent = vCirc * (atmo ? ATMO_DESCENT : LANDING_LOSS);
  const ascent = vCirc * LANDING_LOSS;

  return {
    tmi, capture, descent, ascent, tri: capture, vInfArrive,
    tof: Math.PI * Math.sqrt((aT ** 3) / MU_STAR),
    ...roundTrip(aB),
  };
}

/**
 * The schedule, from the two orbital periods and the transfer alone.
 *
 * `departPhase` is how far the destination must LEAD the home planet at
 * departure; `stay` is how long the vehicle waits at the far end for the same
 * geometry to come round for the way home. Both are pure Kepler -- this is
 * the number js/core/moon.js could not compute and had to make up
 * (`SURFACE_STAY`, "nothing measures it"), and at another planet it is not a
 * choice at all.
 */
function roundTrip(aB) {
  const pHome = starPeriod(A_HOME);
  const pBody = starPeriod(aB);
  const aT = (A_HOME + aB) / 2;
  const tof = Math.PI * Math.sqrt((aT ** 3) / MU_STAR);
  const wHome = TAU / pHome;
  const wBody = TAU / pBody;
  const departPhase = Math.PI - wBody * tof;   // destination leads home
  const returnPhase = wHome * tof - Math.PI;   // destination leads home, going back
  const dOmega = wBody - wHome;
  let outbound = null;
  for (let k = -40; k <= 40; k += 1) {
    const t = (returnPhase - departPhase + k * TAU) / dOmega;
    if (t >= tof && (outbound === null || t < outbound)) outbound = t;
  }
  return {
    tof,
    departPhase,
    stay: outbound - tof,
    roundTrip: outbound + tof,
    synodic: TAU / Math.abs(dOmega),
  };
}

/** Ladder for a moon of the outer planet: capture at the moon's own radius. */
function moonLadderFor(moon, rp, ra) {
  const outer = BODIES.find((b) => b[0] === 'outer');
  const [, , aB, muB] = outer;
  const base = ladderFor(outer, rp, ra);
  const [, , aM, muM, rM] = moon;
  const vCircAt = Math.sqrt(muB / aM);
  const capture = hyperBurn(muB, aM, base.vInfArrive, vCircAt);
  const touchdown = Math.sqrt(muM / rM) * LANDING_LOSS;
  return { ...base, capture, tri: capture, descent: touchdown, ascent: touchdown };
}

const profiles = {
  flyby: ['tmi'],
  orbit: ['tmi', 'capture'],
  land: ['tmi', 'capture', 'descent'],
  return: ['tmi', 'capture', 'descent', 'ascent', 'tri'],
};
const sum = (l, steps) => steps.reduce((t, s) => t + l[s], 0);
const m = (x) => String(Math.round(x)).padStart(8);
const d = (x) => (x / DAY).toFixed(1).padStart(9);

// The parking orbits worth pricing against: the one a tier 4 `return` actually
// flies (tools/balance.mjs, widest notch), and the eccentric one an
// ORBIT_MIN_ALT cutoff can leave, which is where the Oberth discount shows up.
const PARKINGS = [
  ['85 x 194 km  (a tier 4 return, flown)', 85000, 194000],
  ['80 x 4 381 km (eccentric cutoff)', 80000, 4381000],
];

console.log(`home: heliocentric v ${Math.round(Math.sqrt(MU_STAR / A_HOME))} m/s, `
  + `year ${(starPeriod(A_HOME) / DAY).toFixed(1)} d\n`);

for (const [label, pAlt, aAlt] of PARKINGS) {
  const rp = radiusOf(pAlt);
  const ra = radiusOf(aAlt);
  console.log(`=== Parking orbit: ${label} ===`);
  console.log('  body                    tmi capture descent  ascent |   flyby   orbit    land  return');
  const rows = [
    ...BODIES.map((b) => [b[1], ladderFor(b, rp, ra)]),
    ...OUTER_MOONS.map((mn) => [`outer's ${mn[1]}`, moonLadderFor(mn, rp, ra)]),
  ];
  for (const [name, l] of rows) {
    console.log(`  ${name.padEnd(19)}${m(l.tmi)}${m(l.capture)}${m(l.descent)}${m(l.ascent)} |`
      + `${m(sum(l, profiles.flyby))}${m(sum(l, profiles.orbit))}`
      + `${m(sum(l, profiles.land))}${m(sum(l, profiles.return))}`);
  }
  console.log();
}

console.log('=== Schedules (independent of the parking orbit) ===');
console.log('  body                      tof      stay     round   synodic   depart phase');
for (const b of BODIES) {
  const t = roundTrip(b[2]);
  console.log(`  ${b[1].padEnd(19)}${d(t.tof)}${d(t.stay)}${d(t.roundTrip)}${d(t.synodic)}`
    + `   ${(t.departPhase * 180 / Math.PI).toFixed(1).padStart(7)} deg`
    + `   (${(t.roundTrip / starPeriod(A_HOME)).toFixed(2)} home years)`);
}

// THE WINDOW CANNOT BE BOUGHT. A faster transfer arrives sooner but leaves
// from very nearly the same place, so delta-v is not an answer to a phase
// error -- which is why ARCHITECTURE.md prices the window in DAYS OF WAITING
// rather than in m/s the way tier 3's phasing burn is priced.
console.log('\n=== Buying a window: fast transfers to the outer planet ===');
{
  const aB = BODIES.find((b) => b[0] === 'outer')[2];
  const aT = (A_HOME + aB) / 2;
  const wBody = TAU / starPeriod(aB);
  const hoh = { tof: starPeriod(aT) / 2, v: vStar(aT, A_HOME), nu: Math.PI };
  const phi0 = hoh.nu - wBody * hoh.tof;
  console.log(`  Hohmann: ${(hoh.tof / DAY).toFixed(1)} d, depart phase `
    + `${(phi0 * 180 / Math.PI).toFixed(1)} deg`);
  for (const f of [1.05, 1.2, 1.5]) {
    const a = aT * f;
    const e = 1 - A_HOME / a;                     // periapsis at A_HOME
    const cosNu = ((a * (1 - e * e)) / aB - 1) / e;
    if (cosNu < -1 || cosNu > 1) continue;
    const nu = Math.acos(cosNu);
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const tof = (E - e * Math.sin(E)) * Math.sqrt((a ** 3) / MU_STAR);
    const phi = nu - wBody * tof;
    const dPhi = ((phi - phi0) * 180) / Math.PI;
    console.log(`  a/aT ${f.toFixed(2)}: ${(tof / DAY).toFixed(0)} d, `
      + `+${Math.round(vStar(a, A_HOME) - hoh.v)} m/s at departure, `
      + `depart phase moves ${dPhi.toFixed(1)} deg`);
  }
}
