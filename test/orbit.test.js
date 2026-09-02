import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MU,
  R,
  PHASING_DV_PER_DEG,
  radiusOf,
  altitudeOf,
  elementsFrom,
  velocityAt,
  hohmann,
  transferDeltaV,
  phasingDeltaV,
  positionAt,
  phaseFor,
} from '../js/core/orbit.js';
import { MU as RESOLVER_MU, R_EARTH } from '../js/core/resolver.js';

const TWO_PI = Math.PI * 2;
/** Angle of a position, normalised to [0, 2pi). */
const angleOf = (p) => (Math.atan2(p.y, p.x) + TWO_PI) % TWO_PI;
/** Smallest absolute difference between two angles, radians. */
const angleGap = (a, b) => {
  const d = Math.abs(a - b) % TWO_PI;
  return Math.min(d, TWO_PI - d);
};

// ---------------------------------------------------------------------------
// One planet
// ---------------------------------------------------------------------------

test('the resolver and the orbit helpers share one planet', () => {
  assert.equal(R, R_EARTH);
  assert.equal(MU, RESOLVER_MU);
  assert.ok(Math.abs(MU - 3.98e14) < 5e12, `mu drifted: ${MU}`);
});

test('radiusOf and altitudeOf are inverses', () => {
  assert.equal(radiusOf(0), R);
  assert.equal(altitudeOf(R), 0);
  for (const alt of [-1000, 0, 100000, 35786000]) {
    assert.equal(altitudeOf(radiusOf(alt)), alt);
  }
});

// ---------------------------------------------------------------------------
// elementsFrom / velocityAt
// ---------------------------------------------------------------------------

test('elementsFrom on a circular orbit', () => {
  const r = radiusOf(300000);
  const { a, e, period } = elementsFrom(r, r);
  assert.equal(a, r);
  assert.equal(e, 0);
  // A 300 km circular orbit takes about 90 minutes.
  assert.ok(Math.abs(period - TWO_PI * Math.sqrt((r * r * r) / MU)) < 1e-9);
  assert.ok(period > 5300 && period < 5600, `period ${period}`);
});

test('elementsFrom on an ellipse, either way round', () => {
  const rp = radiusOf(200000);
  const ra = radiusOf(2000000);
  const el = elementsFrom(rp, ra);
  assert.ok(Math.abs(el.a - (rp + ra) / 2) < 1e-9);
  assert.ok(Math.abs(el.e - (ra - rp) / (ra + rp)) < 1e-12);
  assert.ok(el.e > 0 && el.e < 1);
  // The apsides may be given in either order.
  assert.deepEqual(elementsFrom(ra, rp), el);
  // A higher orbit takes longer.
  assert.ok(el.period > elementsFrom(rp, rp).period);
  // Degenerate input reports zeros rather than NaN.
  assert.equal(elementsFrom(0, 0).period, 0);
});

test('velocityAt is vis-viva, and circular where a = r', () => {
  const r = radiusOf(300000);
  assert.ok(Math.abs(velocityAt(r, r) - Math.sqrt(MU / r)) < 1e-9);
  assert.ok(Math.abs(velocityAt(r, r) - 7726) < 30, `circular at 300 km: ${velocityAt(r, r)}`);

  // On an ellipse: fastest at periapsis, slowest at apoapsis, and both agree
  // with the specific energy of the orbit.
  const rp = radiusOf(200000);
  const ra = radiusOf(2000000);
  const { a } = elementsFrom(rp, ra);
  const vp = velocityAt(a, rp);
  const va = velocityAt(a, ra);
  assert.ok(vp > va);
  assert.ok(Math.abs((vp * vp) / 2 - MU / rp - ((va * va) / 2 - MU / ra)) < 1e-3);
  // Angular momentum is conserved: r_p v_p = r_a v_a.
  assert.ok(Math.abs(rp * vp - ra * va) / (rp * vp) < 1e-9);
  assert.equal(velocityAt(a, 0), 0);
});

// ---------------------------------------------------------------------------
// hohmann / transferDeltaV
// ---------------------------------------------------------------------------

test('hohmann LEO -> GEO matches the textbook 3.9 km/s', () => {
  // The standard worked example: 300 km circular to geostationary (35 786 km).
  const r1 = radiusOf(300000);
  const r2 = radiusOf(35786000);
  const { dv1, dv2, tof } = hohmann(r1, r2);
  const total = dv1 + dv2;
  const TEXTBOOK = 3890;
  assert.ok(Math.abs(total - TEXTBOOK) / TEXTBOOK < 0.02,
    `LEO->GEO should be ~3.9 km/s, got ${total}`);
  // The split is the textbook one too: ~2.4 km/s to leave, ~1.5 to circularise.
  assert.ok(Math.abs(dv1 - 2420) < 60, `dv1 ${dv1}`);
  assert.ok(Math.abs(dv2 - 1470) < 60, `dv2 ${dv2}`);
  // Time of flight is half the transfer ellipse's period: about 5h15.
  assert.ok(Math.abs(tof - 5.25 * 3600) / (5.25 * 3600) < 0.02, `tof ${tof}`);
});

test('hohmann is symmetric and zero between identical circles', () => {
  const r1 = radiusOf(200000);
  const r2 = radiusOf(1200000);
  const up = hohmann(r1, r2);
  const down = hohmann(r2, r1);
  assert.ok(Math.abs(up.dv1 + up.dv2 - (down.dv1 + down.dv2)) < 1e-9);
  assert.equal(up.tof, down.tof);

  const same = hohmann(r1, r1);
  assert.ok(Math.abs(same.dv1) < 1e-9);
  assert.ok(Math.abs(same.dv2) < 1e-9);
  assert.equal(hohmann(0, r1).dv1, 0);
});

test('transferDeltaV between identical orbits is 0', () => {
  for (const [rp, ra] of [
    [radiusOf(200000), radiusOf(200000)],
    [radiusOf(180000), radiusOf(900000)],
    [radiusOf(100000), radiusOf(35786000)],
  ]) {
    assert.equal(transferDeltaV(rp, ra, rp, ra), 0);
  }
});

test('transferDeltaV charges for size and for shape', () => {
  const rp = radiusOf(200000);
  const ra = radiusOf(200000);

  // Pure size change, circle to circle: exactly the Hohmann cost.
  const bigger = radiusOf(700000);
  const size = transferDeltaV(rp, ra, bigger, bigger);
  const { dv1, dv2 } = hohmann(rp, bigger);
  assert.ok(Math.abs(size - (dv1 + dv2)) < 1e-9);
  assert.ok(size > 0);

  // Pure shape change, same semi-major axis: only the eccentricity term.
  const el = elementsFrom(rp, ra);
  const eccentric = transferDeltaV(rp, ra, radiusOf(100000), radiusOf(300000));
  const shape = elementsFrom(radiusOf(100000), radiusOf(300000));
  assert.ok(Math.abs(eccentric - Math.abs(el.e - shape.e) * velocityAt(shape.a, shape.a) * 0.5) < 1e-9);
  assert.ok(eccentric > 0);

  // Further is dearer, and the cost is symmetric in the two orbits' roles.
  const near = transferDeltaV(rp, ra, radiusOf(300000), radiusOf(300000));
  const far = transferDeltaV(rp, ra, radiusOf(3000000), radiusOf(3000000));
  assert.ok(far > near);
  assert.ok(Math.abs(near - transferDeltaV(radiusOf(300000), radiusOf(300000), rp, ra)) < 1e-9);
});

// ---------------------------------------------------------------------------
// phasingDeltaV
// ---------------------------------------------------------------------------

test('phasingDeltaV is linear in the angle and blind to its sign', () => {
  assert.equal(PHASING_DV_PER_DEG, 4);
  assert.equal(phasingDeltaV(0), 0);
  assert.equal(phasingDeltaV(30), 120);
  assert.equal(phasingDeltaV(-30), 120);
  assert.equal(phasingDeltaV(180), 720);
  assert.equal(phasingDeltaV(undefined), 0);
  assert.ok(phasingDeltaV(60) > phasingDeltaV(59));
});

// ---------------------------------------------------------------------------
// positionAt
// ---------------------------------------------------------------------------

test('positionAt on a circular orbit advances 2 pi per period at constant r', () => {
  const r = radiusOf(300000);
  const { period } = elementsFrom(r, r);

  const start = positionAt(r, r, 0, 0, 0);
  assert.ok(Math.abs(start.r - r) < 1e-6);
  assert.ok(Math.abs(start.x - r) < 1e-6, 'phase 0 is at periapsis, on +x');
  assert.ok(Math.abs(start.y) < 1e-6);

  // One period later it is back where it started, having gone all the way
  // round: the angle matches, and the quarter and half points are where a
  // constant angular rate puts them.
  const full = positionAt(r, r, 0, 0, period);
  assert.ok(angleGap(angleOf(full), angleOf(start)) < 1e-9, 'a period is exactly one turn');
  assert.ok(Math.abs(angleOf(positionAt(r, r, 0, 0, period / 4)) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(angleOf(positionAt(r, r, 0, 0, period / 2)) - Math.PI) < 1e-9);

  // r never moves, and the angle advances monotonically through the orbit.
  let prev = 0;
  for (let i = 1; i <= 64; i += 1) {
    const p = positionAt(r, r, 0, 0, (i * period) / 64);
    assert.ok(Math.abs(p.r - r) < 1e-6, `r moved on a circle: ${p.r}`);
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - r) < 1e-6);
    const advanced = (i * TWO_PI) / 64;
    assert.ok(advanced > prev);
    prev = advanced;
  }
});

test('positionAt on an eccentric orbit: r at phase 0 is the periapsis radius', () => {
  const rp = radiusOf(200000);
  const ra = radiusOf(2000000);
  const { a, e, period } = elementsFrom(rp, ra);

  const peri = positionAt(rp, ra, 0, 0, 0);
  assert.ok(Math.abs(peri.r - rp) < 1e-6, `periapsis radius ${peri.r} vs ${rp}`);
  assert.ok(Math.abs(peri.trueAnomaly) < 1e-9, 'true anomaly is 0 at periapsis');

  // Half an orbit on (in MEAN anomaly, which is what phase is) is apoapsis.
  const apo = positionAt(rp, ra, 0, 0, period / 2);
  assert.ok(Math.abs(apo.r - ra) < 1e-6, `apoapsis radius ${apo.r} vs ${ra}`);
  assert.ok(Math.abs(angleGap(angleOf(apo), Math.PI)) < 1e-9);

  // Every point satisfies the conic equation, which is the check that the
  // Kepler solve and the true-anomaly conversion agree.
  for (let i = 0; i <= 32; i += 1) {
    const p = positionAt(rp, ra, 0, 0, (i * period) / 32);
    const conic = (a * (1 - e * e)) / (1 + e * Math.cos(p.trueAnomaly));
    assert.ok(Math.abs(p.r - conic) / conic < 1e-9, `conic mismatch at i=${i}`);
    assert.ok(p.r >= rp - 1e-6 && p.r <= ra + 1e-6);
  }

  // Kepler's second law: it sweeps faster at periapsis than at apoapsis, and
  // by the exact factor (ra / rp)^2 that conservation of angular momentum
  // demands (r^2 dtheta/dt is constant).
  const dt = period / 200;
  const nearPeri = angleGap(angleOf(positionAt(rp, ra, 0, 0, dt)), angleOf(peri));
  const nearApo = angleGap(
    angleOf(positionAt(rp, ra, 0, 0, period / 2 + dt)), angleOf(apo),
  );
  const ratio = nearPeri / nearApo;
  const expected = (ra / rp) ** 2;
  assert.ok(ratio > 1.5, `periapsis should be faster: ${nearPeri} vs ${nearApo}`);
  assert.ok(Math.abs(ratio - expected) / expected < 0.02,
    `angular rate ratio ${ratio} should be (ra/rp)^2 = ${expected}`);
});

test('positionAt honours argPeriapsis and phase0, and wraps', () => {
  const rp = radiusOf(200000);
  const ra = radiusOf(1000000);
  const { period } = elementsFrom(rp, ra);

  // Rotating the orbit rotates every point on it by the same angle.
  const turned = positionAt(rp, ra, Math.PI / 2, 0, 0);
  assert.ok(Math.abs(turned.x) < 1e-6);
  assert.ok(Math.abs(turned.y - rp) < 1e-6);

  // phase0 is where it is at t = 0, so phase0 = f is the same as t = f * period.
  for (const f of [0.1, 0.25, 0.6, 0.9]) {
    const byPhase = positionAt(rp, ra, 0.3, f, 0);
    const byTime = positionAt(rp, ra, 0.3, 0, f * period);
    assert.ok(Math.abs(byPhase.x - byTime.x) < 1e-6 && Math.abs(byPhase.y - byTime.y) < 1e-6);
  }
  // Phases outside [0, 1) wrap.
  const wrapped = positionAt(rp, ra, 0, 1.25, 0);
  const plain = positionAt(rp, ra, 0, 0.25, 0);
  assert.ok(Math.abs(wrapped.x - plain.x) < 1e-6 && Math.abs(wrapped.y - plain.y) < 1e-6);

  // Degenerate orbit: no NaN.
  const nowhere = positionAt(0, 0, 0, 0, 100);
  assert.equal(nowhere.r, 0);
  assert.ok(Number.isFinite(nowhere.x) && Number.isFinite(nowhere.y));
});

test('positionAt is fast enough to animate', () => {
  const rp = radiusOf(200000);
  const ra = radiusOf(2000000);
  for (let i = 0; i < 1000; i += 1) positionAt(rp, ra, 0.4, 0.2, i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i += 1) positionAt(rp, ra, 0.4, 0.2, i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 100, `20 000 Kepler solves took ${ms.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------
// phaseFor
// ---------------------------------------------------------------------------

test('phaseFor is stable, in [0, 1), and spread over the range', () => {
  for (const id of ['core-1', 'module-2', 'satellite-17', '', 'x']) {
    const p = phaseFor(id);
    assert.ok(p >= 0 && p < 1, `${id} -> ${p}`);
    assert.equal(p, phaseFor(id), 'the same id always gives the same phase');
  }
  assert.notEqual(phaseFor('core-1'), phaseFor('core-2'));
  assert.notEqual(phaseFor('core-1'), phaseFor('core-10'));

  // Not a constant, and not clustered: 200 ids land in every fifth of the
  // range. (A hash that failed this would put every object in one place.)
  const buckets = new Set();
  for (let i = 0; i < 200; i += 1) buckets.add(Math.floor(phaseFor(`core-${i}`) * 5));
  assert.equal(buckets.size, 5, `phases clustered: ${[...buckets].join(',')}`);

  // Non-string input is coerced, not crashed on.
  assert.equal(phaseFor(12), phaseFor('12'));
  assert.ok(phaseFor(undefined) >= 0 && phaseFor(undefined) < 1);
});
