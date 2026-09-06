// js/core/base.js — equipment, production, storage caps, accrual. Every test
// here is a pure function of a base, a site and a number of milliseconds,
// which is the property the module is written to have.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EQUIPMENT, MAX_LEVEL, POWER_PER_LEVEL, DRAW, RESOURCES,
  EXTRACT_RATE, METALS_RATE, PROCESS_RATE, PROCESS_YIELD, MAX_YIELD,
  FUEL_FRACTION, OXIDIZER_FRACTION, STORE_PER_LEVEL, TANK_SHARE,
  BUILD_FUNDS, BUILD_METALS, METALS_GROWTH,
  newBase, powerBalance, yieldAt, rates, capacity, buildCost, accrue, fillTime,
} from '../js/core/base.js';
import { ELAPSED_CLAMP, HOUR } from '../js/core/clock.js';
import { SITES, siteById } from '../js/data/sites.js';

const reference = siteById('mare-tranquil');   // plentitude 1, quality 1

/** A base with every type at the same level. */
function level(n, store = {}) {
  const b = newBase();
  for (const type of EQUIPMENT) b.equipment[type] = n;
  b.store = { ...b.store, ...store };
  return b;
}

// ---------------------------------------------------------------------------
// Power: the shared cap
// ---------------------------------------------------------------------------

test('one level of power runs exactly one level of everything else', () => {
  // The relationship the whole mechanic hangs off: the four draws sum to one
  // power unit, so a level-1 base is exactly balanced and the first upgrade to
  // anything else browns it out.
  const sum = EQUIPMENT.reduce((t, type) => t + DRAW[type], 0);
  assert.equal(sum, POWER_PER_LEVEL);
  const { supply, draw, ratio } = powerBalance(level(1));
  assert.equal(supply, POWER_PER_LEVEL);
  assert.equal(draw, POWER_PER_LEVEL);
  assert.equal(ratio, 1);
});

test('power itself draws nothing', () => {
  assert.equal(DRAW.power, 0);
});

test('over-drawing throttles everything by the same ratio', () => {
  const b = level(1);
  b.equipment.extractor = 2;                 // +3 draw, no more supply
  const { supply, draw, ratio } = powerBalance(b);
  assert.equal(supply, 10);
  assert.equal(draw, 13);
  assert.ok(Math.abs(ratio - 10 / 13) < 1e-12);
  // ...and the throttle reaches production rather than being cosmetic.
  const r = rates(b, reference);
  assert.ok(Math.abs(r.waterExtracted - 2 * EXTRACT_RATE * (10 / 13)) < 1e-9);
});

test('a base with no power produces nothing', () => {
  const b = level(1);
  b.equipment.power = 0;
  assert.equal(powerBalance(b).ratio, 0);
  const r = rates(b, reference);
  assert.equal(r.waterExtracted, 0);
  assert.equal(r.metals, 0);
  assert.equal(r.fuel, 0);
});

test('an empty base is balanced at zero rather than dividing by zero', () => {
  const { supply, draw, ratio } = powerBalance(newBase());
  assert.equal(supply, 0);
  assert.equal(draw, 0);
  assert.equal(ratio, 0);
});

// ---------------------------------------------------------------------------
// Yield: quality cannot create mass
// ---------------------------------------------------------------------------

test('yieldAt scales with quality and never returns more than the water weighed', () => {
  assert.ok(Math.abs(yieldAt(1) - PROCESS_YIELD) < 1e-12);
  assert.ok(yieldAt(1.25) > yieldAt(1));
  assert.equal(yieldAt(0), 0);
  assert.equal(yieldAt(-1), 0);
  // The cap is the point: the best site in the table must not make propellant
  // out of nothing.
  const bestQuality = Math.max(...SITES.map((s) => s.resources.water.quality));
  assert.ok(yieldAt(bestQuality) < 1, `yield ${yieldAt(bestQuality)} at quality ${bestQuality}`);
  assert.equal(yieldAt(1000), MAX_YIELD);
});

test('the fuel/oxidizer split is stoichiometric and sums to one', () => {
  assert.ok(Math.abs(FUEL_FRACTION + OXIDIZER_FRACTION - 1) < 1e-12);
  // H2 : O2 is about 1 : 7.94 by mass — the oxidizer tank is the big one.
  assert.ok(Math.abs(OXIDIZER_FRACTION / FUEL_FRACTION - 7.94) < 0.05);
});

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

test('rates scale with plentitude, quality and level', () => {
  const rich = siteById('shackleton-rim');
  const base = level(1);
  const here = rates(base, reference);
  const there = rates(base, rich);
  assert.ok(Math.abs(there.waterExtracted / here.waterExtracted
    - rich.resources.water.plentitude) < 1e-9, 'extraction follows water plentitude');
  assert.ok(there.fuel > here.fuel, 'a better quality site makes more propellant');
  assert.ok(there.metals < here.metals, 'and Shackleton is metal-poor');

  const bigger = rates(level(2), reference);
  // Level 2 of everything is still balanced, so the ratio is exactly 2.
  assert.ok(Math.abs(bigger.waterExtracted / here.waterExtracted - 2) < 1e-9);
});

test('the chain is balanced at equal levels: water in equals water processed', () => {
  assert.equal(EXTRACT_RATE, PROCESS_RATE);
  for (const n of [1, 2, 3]) {
    const r = rates(level(n), reference);
    assert.ok(Math.abs(r.water) < 1e-9, `level ${n} should leave no surplus water`);
  }
});

test('a processor that outruns its extractor eats the stockpile, and the rate says so', () => {
  const b = newBase();
  b.equipment = { power: 3, extractor: 1, processor: 2, storage: 1, transport: 0 };
  b.store = { ...b.store, water: 200 };
  const r = rates(b, reference);
  assert.ok(r.water < 0, 'the processor is eating a stockpile, and the rate says so');
  assert.equal(r.waterLimited, false, 'there is water in front of it, so it is not starved');
  assert.equal(r.waterProcessed, r.processorCapacity, 'and it runs flat out on it');
});

// THE CASE THE RATE USED TO GET WRONG. The same base with an EMPTY water tank
// is not eating anything: the extractor hands the processor 40 kg an hour and
// the processor could take 80, so it is idle half of every hour. Quoting the
// capacity said it made twice the fuel it makes.
test('a processor with nothing to eat is starved, not negative', () => {
  const b = newBase();
  b.equipment = { power: 3, extractor: 1, processor: 2, storage: 1, transport: 0 };
  const r = rates(b, reference);
  assert.equal(r.water, 0, 'nothing piles up and nothing is drawn down');
  assert.equal(r.waterLimited, true);
  assert.equal(r.waterProcessed, r.waterExtracted, 'it runs on what comes out of the ground');
  assert.ok(r.waterProcessed < r.processorCapacity, 'and that is less than it could take');
});

// THE QUOTE AND THE ACCRUAL ARE THE SAME ARITHMETIC, which is the property
// that makes a wrong rate impossible rather than merely absent: `rates` quotes
// the hour in front of the base, and `accrue` over exactly one hour must bank
// exactly that.
test('the hourly rate is what accrue does in an hour, at every site', () => {
  for (const site of SITES) {
    for (const n of [1, 3, 5]) {
      const b = level(n);
      const r = rates(b, site);
      const { produced } = accrue(b, site, HOUR);
      for (const res of ['fuel', 'oxidizer', 'metals']) {
        assert.ok(Math.abs(produced[res] - r[res]) < 1e-6,
          `${site.id} level ${n}: ${res} quoted ${r[res]}, accrued ${produced[res]}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('the propellant tanks are sized to the mixture ratio, so they fill together', () => {
  const b = level(1);
  const fuelHours = fillTime(b, reference, 'fuel');
  const oxHours = fillTime(b, reference, 'oxidizer');
  assert.ok(Math.abs(fuelHours - oxHours) < 1e-9,
    `fuel fills in ${fuelHours}h and oxidizer in ${oxHours}h; the tanks are mis-sized`);
});

// STORAGE IS MEANT TO BE THE BINDING CONSTRAINT ON PROPELLANT and the clamp
// the backstop (js/core/clock.js): a tank that takes longer than a day to fill
// never binds, and that much of the storage upgrade sells nothing.
//
// THE OLD FORM OF THIS TEST — every level, every site, inside the clamp — was
// only ever passing because `rates` quoted a processor capacity the ground
// could not feed. With the rate honest it is FALSE, and it is false because it
// was the wrong requirement rather than because the numbers drifted: fill time
// is `storage level / extractor level` times a constant set by the site, so a
// base with storage running level with a starved extractor holds more than a
// day of its own output at EVERY level, and no single STORE_PER_LEVEL can fix
// that without making the good sites fill in five hours. What is true, and is
// what the requirement was reaching for, is the two tests below.
const clampHours = ELAPSED_CLAMP / HOUR;

test('where water is not the constraint, every propellant tank fills inside the clamp', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    for (const site of SITES) {
      if (rates(level(n), site).waterLimited) continue;
      for (const res of ['fuel', 'oxidizer']) {
        const hours = fillTime(level(n), site, res);
        assert.ok(hours < clampHours,
          `${site.id} level ${n}: ${res} takes ${hours.toFixed(1)}h, over the ${clampHours}h clamp`);
      }
    }
  }
});

// AND WHERE IT IS THE CONSTRAINT, THE LADDER STILL STARTS AS A REAL LIMIT.
// A water-poor site fills its tanks more slowly in exact proportion to how
// poor it is — that is what makes it poor — but the first rung of the storage
// ladder must still be a cap the player runs into, or storage is a purchase
// with nothing behind it. Measured with the rest of the base maxed, which is
// the shape the question is asked in: the extractor is what fills the tank.
test('every site supports at least one storage level inside the clamp', () => {
  for (const site of SITES) {
    let highest = 0;
    for (let s = 1; s <= MAX_LEVEL; s += 1) {
      const b = level(MAX_LEVEL);
      b.equipment.storage = s;
      const hours = Math.max(fillTime(b, site, 'fuel'), fillTime(b, site, 'oxidizer'));
      if (hours < clampHours) highest = s;
    }
    assert.ok(highest >= 1,
      `${site.id}: no storage level fills inside the ${clampHours}h clamp`);
  }
});

// Metals are the exception, deliberately and in the other direction: they are
// sized by what they have to buy, so the clamp binds before the cap. The rule
// that replaces "fills inside the clamp" is the one that prevents a soft-lock.
test('the metals stockpile always holds the dearest upgrade at the next level', () => {
  for (let n = 1; n < MAX_LEVEL; n += 1) {
    const cap = capacity(level(n)).metals;
    const dearest = Math.max(...EQUIPMENT.map((t) => buildCost(t, n + 1).metals));
    assert.ok(cap >= dearest,
      `storage ${n} holds ${cap} metals but the dearest level ${n + 1} costs ${dearest}`);
  }
});

test('storage is the cheapest metals upgrade at every level, so the tank can always be grown first', () => {
  for (let n = 2; n <= MAX_LEVEL; n += 1) {
    const costs = EQUIPMENT.map((t) => [t, buildCost(t, n).metals]);
    const cheapest = costs.reduce((a, b) => (a[1] <= b[1] ? a : b));
    assert.equal(cheapest[0], 'storage', `at level ${n} the cheapest upgrade is ${cheapest[0]}`);
  }
});

test('capacity scales with the storage level and is zero without one', () => {
  assert.deepEqual(capacity(newBase()), { water: 0, fuel: 0, oxidizer: 0, metals: 0 });
  const one = capacity(level(1));
  assert.equal(one.water, STORE_PER_LEVEL * TANK_SHARE.water);
  const two = capacity(level(2));
  for (const r of RESOURCES) assert.ok(Math.abs(two[r] - 2 * one[r]) < 1e-9, r);
});

// ---------------------------------------------------------------------------
// Build costs
// ---------------------------------------------------------------------------

test('the first level of anything is funds, every level after it is metals', () => {
  for (const type of EQUIPMENT) {
    assert.deepEqual(buildCost(type, 1), { funds: BUILD_FUNDS[type] });
    assert.deepEqual(buildCost(type, 2), { metals: BUILD_METALS[type] });
    const three = buildCost(type, 3);
    assert.ok(three.metals > BUILD_METALS[type], `${type} level 3 should cost more metals`);
    assert.equal(three.funds, undefined, `${type} level 3 must not cost funds`);
  }
});

test('metals costs grow geometrically and stop at MAX_LEVEL', () => {
  const top = buildCost('power', MAX_LEVEL);
  const below = buildCost('power', MAX_LEVEL - 1);
  assert.ok(Math.abs(top.metals / below.metals - METALS_GROWTH) < 0.02);
  assert.equal(buildCost('power', MAX_LEVEL + 1), null);
  assert.equal(buildCost('power', 0), null);
  assert.equal(buildCost('nonsense', 1), null);
});

test('a site pays for its next equipment level in a bounded number of days', () => {
  // The metals branch has to actually buy something, or it is a resource that
  // only gates. Measured at the middling site, which is where a player who
  // surveys once and lands lands; the poor site is meant to be poor and the
  // rich one is the reward for surveying more.
  const middling = siteById('mare-tranquil');
  const perHour = rates(level(1), middling).metals;
  const cheapest = Math.min(...EQUIPMENT.map((t) => buildCost(t, 2).metals));
  const days = cheapest / perHour / 24;
  assert.ok(days < 2, `the middling site takes ${days.toFixed(1)} days to afford a level 2`);
  // ...and the poorest site is slower but not hopeless.
  const poorest = SITES.reduce((a, b) => (
    a.resources.metals.plentitude <= b.resources.metals.plentitude ? a : b));
  const poorDays = cheapest / rates(level(1), poorest).metals / 24;
  assert.ok(poorDays < 5, `the poorest site takes ${poorDays.toFixed(1)} days`);
});

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

test('accrue banks an hour of production', () => {
  const b = level(1);
  const r = rates(b, reference);
  const { base: next, produced } = accrue(b, reference, HOUR);
  assert.ok(Math.abs(produced.fuel - r.fuel) < 1e-9);
  assert.ok(Math.abs(produced.oxidizer - r.oxidizer) < 1e-9);
  assert.ok(Math.abs(produced.metals - r.metals) < 1e-9);
  assert.ok(Math.abs(next.store.fuel - r.fuel) < 1e-9);
  assert.equal(b.store.fuel, 0, 'the input base is not mutated');
});

test('accrue is linear in elapsed time', () => {
  const one = accrue(level(1), reference, HOUR).produced;
  const three = accrue(level(1), reference, 3 * HOUR).produced;
  for (const r of ['fuel', 'oxidizer', 'metals']) {
    assert.ok(Math.abs(three[r] - 3 * one[r]) < 1e-9, r);
  }
});

test('accrue produces nothing for zero or negative elapsed time', () => {
  for (const ms of [0, -HOUR, NaN]) {
    const { produced } = accrue(level(1), reference, ms);
    for (const r of RESOURCES) assert.equal(produced[r], 0, `${r} at ${ms}`);
  }
});

test('what does not fit was never produced: accrual stops at the cap', () => {
  const b = level(1);
  const caps = capacity(b);
  const { base: next, produced, full } = accrue(b, reference, 10 * ELAPSED_CLAMP);
  for (const r of ['fuel', 'oxidizer', 'metals']) {
    assert.ok(Math.abs(next.store[r] - caps[r]) < 1e-6, `${r} should be exactly full`);
    assert.ok(produced[r] <= caps[r] + 1e-6, `${r} banked more than the tank holds`);
  }
  assert.deepEqual([...full].sort(), ['fuel', 'metals', 'oxidizer']);
});

test('a base with no storage banks nothing, however long it runs', () => {
  const b = level(1);
  b.equipment.storage = 0;
  const { produced } = accrue(b, reference, ELAPSED_CLAMP);
  for (const r of RESOURCES) assert.equal(produced[r], 0, r);
});

test('a full water tank does not stop the processor', () => {
  // Water extracted and immediately consumed never needed a tank to sit in.
  // A base that stopped making propellant because its water tank was full
  // would be punishing the player for a tank they do not need.
  const b = level(1);
  const caps = capacity(b);
  b.store = { ...b.store, water: caps.water };
  const { produced } = accrue(b, reference, HOUR);
  assert.ok(produced.fuel > 0, 'the processor kept running');
});

test('accrue on a site whose water is poor still yields metals', () => {
  const poor = siteById('far-side-flats');
  const { produced } = accrue(level(1), poor, HOUR);
  assert.ok(produced.metals > 0);
  assert.ok(produced.fuel > 0);
  assert.ok(produced.fuel < accrue(level(1), reference, HOUR).produced.fuel);
});

test('accrue with no site is a no-op rather than a crash', () => {
  const { produced, base: next } = accrue(level(1), null, HOUR);
  for (const r of RESOURCES) assert.equal(produced[r], 0, r);
  assert.ok(next.store);
});

test('base.js reads no clock and no rng of its own', () => {
  const src = readFileSync(fileURLToPath(new URL('../js/core/base.js', import.meta.url)), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now|new Date|performance\.now/.test(code));
  assert.ok(!/Math\.random/.test(code));
});
