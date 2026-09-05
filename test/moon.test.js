import test from 'node:test';
import assert from 'node:assert/strict';

import {
  R_MOON,
  MU_MOON,
  A_MOON,
  LLO_ALT,
  LANDING_LOSS,
  ASCENT_TIME,
  DESCENT_TIME,
  LLO_PERIOD,
  LUNAR_STEPS,
  SURFACE_STAY,
  lunarLadder,
  lunarSchedule,
  ENTRY_TIME,
} from '../js/core/moon.js';
import {
  MU,
  R,
  radiusOf,
  elementsFrom,
  velocityAt,
  hohmann,
  positionAt,
} from '../js/core/orbit.js';

/** The parking orbit the whole tier departs from, as a radius. */
const park = (alt) => radiusOf(alt);
/** Circular speed in low lunar orbit — the number three rungs are built on. */
const vCircLunar = Math.sqrt(MU_MOON / (R_MOON + LLO_ALT));

// ---------------------------------------------------------------------------
// The constants. They are the only inputs the ladder has, so a typo in one of
// them is a typo in every rung — these check them against the bodies they are
// meant to describe rather than against themselves.
// ---------------------------------------------------------------------------

test('the lunar constants describe a moon, not a second planet', () => {
  // Radius and mu: a body about a quarter the planet's radius with about an
  // eightieth of its mass, which is what makes lunar orbit cheap and the
  // landing affordable.
  assert.ok(Math.abs(R_MOON - 1.737e6) < 5e3, `R_MOON drifted: ${R_MOON}`);
  assert.ok(Math.abs(MU_MOON - 4.903e12) < 5e9, `MU_MOON drifted: ${MU_MOON}`);
  assert.ok(R_MOON / R > 0.24 && R_MOON / R < 0.30, `radius ratio ${R_MOON / R}`);
  assert.ok(MU_MOON / MU > 0.011 && MU_MOON / MU < 0.013, `mass ratio ${MU_MOON / MU}`);

  // Surface gravity ~1.62 m/s^2, one sixth of the planet's: the number every
  // schoolchild knows, and the one the landing rungs are really about.
  const gMoon = MU_MOON / (R_MOON * R_MOON);
  assert.ok(Math.abs(gMoon - 1.62) < 0.02, `lunar surface gravity ${gMoon}`);

  // The orbit is 60 planetary radii out, which is why the map needs a second
  // frame (ARCHITECTURE.md, phase 3): no altitude exaggeration survives it.
  assert.ok(A_MOON / R > 55 && A_MOON / R < 65, `A_MOON is ${A_MOON / R} planet radii`);

  // A sidereal month falls out of A_MOON and the PLANET's mu: 27.3 days. It is
  // never used, but it is the strongest single check that the two bodies are
  // in one universe with one set of units.
  const month = 2 * Math.PI * Math.sqrt((A_MOON ** 3) / MU) / 86400;
  assert.ok(Math.abs(month - 27.3) < 0.3, `sidereal month ${month} days`);
});

test('LLO_ALT and LLO_PERIOD describe the orbit the ladder is priced from', () => {
  assert.equal(LLO_ALT, 100000);
  // Circular speed there is ~1.63 km/s — the textbook LLO figure, and the base
  // of the descent, ascent and capture rungs.
  assert.ok(Math.abs(vCircLunar - 1633) < 15, `LLO circular speed ${vCircLunar}`);
  // Kepler's third law about the MOON: about two hours.
  const expected = 2 * Math.PI * Math.sqrt(((R_MOON + LLO_ALT) ** 3) / MU_MOON);
  assert.ok(Math.abs(LLO_PERIOD - expected) < 1e-9);
  assert.ok(LLO_PERIOD > 6900 && LLO_PERIOD < 7200, `LLO period ${LLO_PERIOD}s`);
});

test('LUNAR_STEPS is the flight order, and nothing is missing from it', () => {
  assert.deepEqual(LUNAR_STEPS, ['tli', 'loi', 'descent', 'ascent', 'tei']);
  // Every step names a rung of the ladder, and every rung is a step: the two
  // are indexed against each other by the resolver, so a name that appears in
  // one and not the other is a silent 0 m/s burn.
  const ladder = lunarLadder(park(180000), park(180000));
  for (const step of LUNAR_STEPS) {
    assert.equal(typeof ladder[step], 'number', `${step} is not a rung`);
    assert.ok(ladder[step] > 0, `${step} is free, which cannot be right`);
  }
  assert.deepEqual(
    Object.keys(ladder).filter((k) => k !== 'tof').sort(),
    [...LUNAR_STEPS].sort(),
  );
});

// ---------------------------------------------------------------------------
// The ladder, rung by rung. Each test asserts the closed-form identity the
// module header claims — so a rung cannot quietly stop being computed from the
// constants — and then a textbook number, so an identity that is internally
// consistent and physically wrong still fails.
// ---------------------------------------------------------------------------

test('tli is the Hohmann departure to lunar distance, ~3.1 km/s from a low orbit', () => {
  for (const alt of [160000, 180000, 200000, 400000]) {
    const r = park(alt);
    const { tli } = lunarLadder(r, r);
    // From a CIRCULAR parking orbit the burn at periapsis is exactly the
    // Hohmann first leg: the identity ARCHITECTURE.md quotes the rung as.
    assert.ok(Math.abs(tli - hohmann(r, A_MOON).dv1) < 1e-9, `${alt}: ${tli}`);
  }
  // The textbook figure: Apollo's TLI from a 185 km parking orbit was ~3.15
  // km/s, and the ideal Hohmann one is a little under that.
  const { tli } = lunarLadder(park(200000), park(200000));
  assert.ok(tli > 3000 && tli < 3250, `TLI from 200 km: ${tli}`);

  // Higher parking orbit, cheaper departure — half the trip is already paid
  // for. The whole reason a lunar mission parks in the LOWEST orbit it can is
  // that the ascent to a higher one costs more than this saves.
  const low = lunarLadder(park(160000), park(160000)).tli;
  const high = lunarLadder(park(400000), park(400000)).tli;
  assert.ok(high < low, `${high} should be under ${low}`);
  assert.ok(low - high < 100, 'and only a little cheaper');
});

test('tli is charged at the parking orbit periapsis, so an ellipse is cheaper', () => {
  // An eccentric parking orbit is already moving fast at periapsis, so the
  // departure burn there is smaller — the Oberth effect, and the one place the
  // ladder cares about the SHAPE of the orbit the ascent achieved rather than
  // just its size.
  const circular = lunarLadder(park(180000), park(180000)).tli;
  const eccentric = lunarLadder(park(180000), park(2000000)).tli;
  assert.ok(eccentric < circular, `${eccentric} should be under ${circular}`);
  assert.ok(circular - eccentric > 300, 'and by a lot: this is a real decision');

  // The identity, spelled out: the transfer's speed at periapsis less the
  // parking orbit's own speed there.
  const rp = park(180000);
  const ra = park(2000000);
  const expected = velocityAt(elementsFrom(rp, A_MOON).a, rp)
    - velocityAt(elementsFrom(rp, ra).a, rp);
  assert.ok(Math.abs(eccentric - expected) < 1e-9);

  // The apsides may be given in either order, as elementsFrom's are.
  assert.deepEqual(lunarLadder(ra, rp), lunarLadder(rp, ra));
});

test('loi captures a hyperbolic arrival into low lunar orbit, ~0.8 km/s', () => {
  const r = park(180000);
  const { loi } = lunarLadder(r, r);

  // The identity: arrival excess speed against the moon, then vis-viva on the
  // hyperbola that excess implies, less the circular speed it is pulled onto.
  const transfer = elementsFrom(r, A_MOON);
  const vInf = Math.abs(velocityAt(transfer.a, A_MOON) - velocityAt(A_MOON, A_MOON));
  const expected = Math.sqrt(vInf * vInf + 2 * (MU_MOON / (R_MOON + LLO_ALT))) - vCircLunar;
  assert.ok(Math.abs(loi - expected) < 1e-9, `${loi} vs ${expected}`);

  // The textbook figure: Apollo's LOI was ~0.9 km/s, and a coplanar Hohmann
  // arrival is at the cheap end of that band.
  assert.ok(loi > 800 && loi < 900, `LOI: ${loi}`);
  // The arrival excess itself is ~0.8 km/s, which is the number the patched
  // conic this model does not do would have handed the lunar leg.
  assert.ok(vInf > 700 && vInf < 950, `v-infinity: ${vInf}`);
});

test('descent and ascent are the circular speed times the loss factor, ~1.9 km/s', () => {
  const r = park(180000);
  const { descent, ascent } = lunarLadder(r, r);
  assert.ok(Math.abs(descent - vCircLunar * LANDING_LOSS) < 1e-9);
  // No atmosphere, so landing and launching are the same problem backwards.
  assert.equal(ascent, descent);
  assert.ok(descent > 1800 && descent < 1950, `descent: ${descent}`);
  // The loss factor is the whole difference from the ideal, and it is a
  // markup, never a discount.
  assert.ok(LANDING_LOSS > 1 && LANDING_LOSS < 1.3);
  assert.ok(descent > vCircLunar);
});

test('tei equals loi, and neither depends on the parking orbit much', () => {
  for (const alt of [160000, 200000, 400000]) {
    const r = park(alt);
    const { loi, tei } = lunarLadder(r, r);
    // Symmetry: the return leg is the arrival run backwards, and entry at the
    // planet is free — the atmosphere does the braking.
    assert.equal(tei, loi);
  }
  // A higher departure orbit arrives a shade slower, so the capture is a shade
  // cheaper; the effect is tiny next to the TLI it costs.
  const lowLoi = lunarLadder(park(160000), park(160000)).loi;
  const highLoi = lunarLadder(park(400000), park(400000)).loi;
  assert.ok(highLoi <= lowLoi && lowLoi - highLoi < 10, `${lowLoi} vs ${highLoi}`);
});

test('tof is the transfer half-period: about five days', () => {
  const r = park(180000);
  const { tof } = lunarLadder(r, r);
  assert.ok(Math.abs(tof - hohmann(r, A_MOON).tof) < 1e-9);
  const days = tof / 86400;
  assert.ok(days > 4.5 && days < 5.5, `time of flight ${days} days`);
});

// ---------------------------------------------------------------------------
// The ladder as a whole: the budget the tier is balanced against, and the
// guards a caller can rely on.
// ---------------------------------------------------------------------------

test('the full return profile costs about 8.5 km/s past insertion', () => {
  const r = park(180000);
  const l = lunarLadder(r, r);
  const total = LUNAR_STEPS.reduce((sum, step) => sum + l[step], 0);
  // ARCHITECTURE.md phase 3: "tier 4 needs 8 km/s past insertion, which no
  // single stage carries". This is that number, and it is why dvAvailable had
  // to become the remaining stack.
  assert.ok(total > 8000 && total < 9000, `return profile: ${total} m/s`);

  // The profiles are strictly nested, so each rung of the mission ladder costs
  // strictly more than the one below it.
  const flyby = l.tli;
  const orbit = flyby + l.loi;
  const land = orbit + l.descent;
  const ret = land + l.ascent + l.tei;
  assert.ok(flyby < orbit && orbit < land && land < ret);
  assert.equal(ret, total);
});

test('a degenerate parking orbit gives zeros, not NaN', () => {
  for (const bad of [[0, 0], [-1, 100], [park(180000), Infinity], [NaN, NaN]]) {
    const l = lunarLadder(bad[0], bad[1]);
    for (const key of Object.keys(l)) {
      assert.equal(l[key], 0, `${key} on ${bad}`);
    }
  }
});

test('every rung is finite and positive for every orbit a launch can reach', () => {
  for (let alt = 80000; alt <= 2000000; alt += 40000) {
    const l = lunarLadder(park(alt), park(alt));
    for (const key of Object.keys(l)) {
      assert.ok(Number.isFinite(l[key]) && l[key] > 0, `${key} at ${alt}m: ${l[key]}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The schedule. It exists so the resolver and the map cannot disagree about
// WHEN each step happens — and, since the ladder prices the departure at the
// parking orbit's periapsis, about WHERE the vehicle is when it departs. The
// two used to disagree: the burn was scheduled half an orbit after insertion,
// which is the far side of the orbit, and priced at periapsis, which is the
// near one. These pin the two together.
// ---------------------------------------------------------------------------

test('the schedule departs at the next periapsis, which is where TLI is priced', () => {
  // A genuinely eccentric parking orbit — 80 x 4 381 km, the shape a lunar
  // ascent actually cuts off in — so the departure point is a decision worth
  // hundreds of m/s rather than a rounding error.
  const rp = park(80000);
  const ra = park(4381000);
  const { a, e, period } = elementsFrom(rp, ra);
  assert.ok(e > 0.2, `this test needs an eccentric orbit, got e ${e}`);
  const ladder = lunarLadder(rp, ra);

  for (const phase of [0, 0.05, 0.25, 0.4999, 0.5, 0.75, 0.999]) {
    const { tli } = lunarSchedule(1000, period, ladder, phase);
    const coast = tli - 1000;
    // A coast, never an instantaneous burn, and never more than one orbit.
    assert.ok(coast > 0 && coast <= period + 1e-9, `phase ${phase}: coast ${coast}s`);
    assert.ok(Math.abs(coast - (1 - phase) * period) < 1e-9, `phase ${phase}`);

    // The guard that matters: wherever it inserted, it burns at PERIAPSIS.
    const at = positionAt(rp, ra, 0, phase, coast);
    assert.ok(Math.abs(at.r - rp) < 1e-3, `phase ${phase}: burns at r ${at.r}, periapsis is ${rp}`);

    // And therefore the burn it makes is the burn it was charged for. Departing
    // half an orbit later, at apoapsis, would cost ~983 m/s more than the
    // ladder quotes — which is exactly what the old schedule did.
    const costThere = Math.abs(velocityAt(elementsFrom(at.r, A_MOON).a, at.r)
      - velocityAt(a, at.r));
    assert.ok(Math.abs(costThere - ladder.tli) < 1e-9, `phase ${phase}: ${costThere} vs ${ladder.tli}`);
  }

  const atApoapsis = Math.abs(velocityAt(elementsFrom(ra, A_MOON).a, ra) - velocityAt(a, ra));
  assert.ok(atApoapsis - ladder.tli > 900, `the far side costs ${atApoapsis - ladder.tli} m/s more`);
});

test('a phase of 0 waits a whole orbit rather than burning at insertion', () => {
  // Already at periapsis is the one case where "the next periapsis" could mean
  // "now". It does not: a burn at the instant of insertion is not a coast, and
  // the map would have nothing to draw between the two.
  const r = park(180000);
  const { period } = elementsFrom(r, r);
  const ladder = lunarLadder(r, r);
  assert.equal(lunarSchedule(0, period, ladder, 0).tli, period);
  // A phase outside 0..1 wraps, and rubbish is treated as periapsis rather
  // than turning the whole timeline into NaN.
  assert.equal(lunarSchedule(0, period, ladder, 2).tli, period);
  assert.equal(lunarSchedule(0, period, ladder, -0.25).tli, 0.25 * period);
  for (const bad of [NaN, Infinity, undefined, null, 'soon']) {
    assert.equal(lunarSchedule(0, period, ladder, bad).tli, period, `phase ${bad}`);
  }
  // Omitting it entirely is the same as periapsis: every caller that does not
  // know where it is gets the full coast.
  assert.equal(lunarSchedule(0, period, ladder).tli, period);
});

test('the rest of the schedule hangs off the transfer and the lunar orbit', () => {
  const rp = park(80000);
  const ra = park(4381000);
  const { period } = elementsFrom(rp, ra);
  const ladder = lunarLadder(rp, ra);
  const s = lunarSchedule(500, period, ladder, 0.3);

  // Capture one time of flight after departure; the descent burn a quarter of
  // a lunar orbit after arriving; the touchdown a powered descent after that;
  // the ascent a surface stay later; the burn home a quarter orbit after the
  // ascent has finished putting the vehicle back in orbit.
  assert.ok(Math.abs(s.loi - (s.tli + ladder.tof)) < 1e-9);
  assert.ok(Math.abs(s.descent - (s.loi + LLO_PERIOD / 4)) < 1e-9);
  assert.ok(Math.abs((s.touchdown - s.descent) - DESCENT_TIME) < 1e-6);
  // The stay is measured from the TOUCHDOWN, not from the burn that starts the
  // descent: the vehicle is not on the surface until it is on the surface.
  assert.ok(Math.abs((s.ascent - s.touchdown) - SURFACE_STAY) < 1e-6);
  assert.ok(Math.abs((s.orbited - s.ascent) - ASCENT_TIME) < 1e-6);
  assert.ok(Math.abs(s.tei - (s.orbited + LLO_PERIOD / 4)) < 1e-9);
  // Strictly ordered, which is what lets the resolver walk it as flight order.
  const times = LUNAR_STEPS.map((step) => s[step]);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] > times[i - 1], LUNAR_STEPS[i]);
  // And the way home, which is the way out flown backwards: the same time of
  // flight to the top of the atmosphere, then the fall to the ground. Neither
  // is a burn — entry is free — but a schedule that stopped at `tei` stopped
  // 380 000 km from home on the one profile that is about coming home.
  assert.ok(Math.abs(s.entry - (s.tei + ladder.tof)) < 1e-9);
  assert.ok(Math.abs((s.home - s.entry) - ENTRY_TIME) < 1e-6);
  // Days, not minutes: the transfer dominates everything else on it, and there
  // are two of them.
  assert.ok((s.tei - 500) / 86400 > 6, 'the burn for home is most of a week in');
  assert.ok((s.home - 500) / 86400 > 10, 'and the whole flight is a week and a half');
});
