import test from 'node:test';
import assert from 'node:assert/strict';

import {
  R_MOON,
  MU_MOON,
  A_MOON,
  LLO_ALT,
  LANDING_LOSS,
  LLO_PERIOD,
  LUNAR_STEPS,
  lunarLadder,
} from '../js/core/moon.js';
import {
  MU,
  R,
  radiusOf,
  elementsFrom,
  velocityAt,
  hohmann,
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
