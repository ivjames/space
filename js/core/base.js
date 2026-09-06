// Surface bases: equipment, production rates, storage caps, and accrual over
// elapsed time. Pure — no DOM, no `Date.now`, no `Math.random`. See
// ARCHITECTURE.md, "Phase 3b — the economy, whole".
//
// This module is to the economy what js/core/orbit.js is to the flight model:
// the place the numbers are derived, so the UI that draws a base and the tick
// that runs it cannot disagree about what it produces.
//
// IT DOES NOT KNOW WHAT TIME IT IS. `accrue` takes a duration in milliseconds
// and nothing else; where that duration came from, and the 24-hour clamp on
// it, are js/core/clock.js's. Keeping the two apart is what makes every
// production test a pure function of a base, a site and a number.
//
// WHERE A RESOURCE IS, IS THE WHOLE POINT (DESIGN.md §8: "Product has to move
// from base to depot"). So there are two stores and they are not the same:
//
//   base.store         what is AT the base, capped by its storage equipment.
//                      Production fills this. Metals are spent from it,
//                      on-site, and never leave.
//   state.resources    the player's LEDGER — what has been hauled off the
//                      surface and can be spent on the tree. Only a haul
//                      (or, in phase 4, an automatic one) moves anything from
//                      the first into the second.
//
// A single global pool would make transport pointless, and transport is the
// mechanic DESIGN.md §8 spends a section on. So the split is deliberate, and
// it is what makes a resource-gated tree node mean "you have landed, built,
// produced AND hauled" rather than "you have landed".

import { hoursIn } from './clock.js';

/**
 * The five equipment types, in the order DESIGN.md §8 draws the chain:
 *
 *   power -> extractor (water, metals) -> processor (water -> fuel + oxidizer)
 *                                      -> storage -> transport
 *
 * The order is the UI's row order and the order `powerBalance` sums draw in,
 * so a base tab and a rate table read the same way down the page.
 */
export const EQUIPMENT = ['power', 'extractor', 'processor', 'storage', 'transport'];

/** Highest level any equipment type can reach. */
export const MAX_LEVEL = 5;

/**
 * Power supplied per level of `power`, in power units.
 *
 * The unit is arbitrary and deliberately so — it exists to be compared against
 * `DRAW`, and nothing else in the game reads it. What makes it meaningful is
 * the relationship below: one level of power runs exactly one level of
 * everything else.
 */
export const POWER_PER_LEVEL = 10;

/**
 * Power drawn per level, by type.
 *
 * These four sum to exactly POWER_PER_LEVEL, and that is the design rather
 * than a coincidence: a base with every type at level 1 draws exactly what one
 * power unit supplies, so the FIRST upgrade the player makes to anything else
 * browns the base out and the shared cap DESIGN.md §8 describes announces
 * itself immediately, legibly, and without a tutorial. Every level after that
 * is the same arithmetic.
 *
 * `power` itself draws nothing: a reactor that ran on its own output would be
 * either free energy or a fixed point, and neither is a mechanic.
 */
export const DRAW = { power: 0, extractor: 3, processor: 4, storage: 1, transport: 2 };

/** Water extracted per hour, per extractor level, at plentitude 1. kg. */
export const EXTRACT_RATE = 40;
/** Metals extracted per hour, per extractor level, at plentitude 1. kg. */
export const METALS_RATE = 18;
/** Water CONSUMED per hour, per processor level, at power. kg. */
export const PROCESS_RATE = 40;

// PROCESS_RATE EQUALS EXTRACT_RATE ON PURPOSE. It makes the chain balanced at
// equal levels: a level-n extractor feeds a level-n processor exactly, so
// water sits at zero and everything that comes out of the ground becomes
// propellant. A player who raises one without the other sees the consequence
// immediately — surplus water piling up against its cap, or a processor idle —
// and that is a legible mistake rather than a hidden inefficiency.

/**
 * Mass of propellant recovered per unit of water, at quality 1.
 *
 * NOT 1. Quality is a multiplier around 1 (js/data/sites.js) and the best site
 * in the table has 1.25, so a reference yield of 1 would let a good site
 * create mass out of nothing. 0.7 is the reference recovery — the rest is lost
 * to the process — and `yieldAt` caps the product below 1 however good the
 * site, because the one thing electrolysis cannot do is return more propellant
 * than the water weighed.
 */
export const PROCESS_YIELD = 0.7;
/** Ceiling on the recovered fraction, however good the site. */
export const MAX_YIELD = 0.95;

// The split between fuel and oxidizer is STOICHIOMETRY, not a game number:
// water is H2O, electrolysis gives H2 and O2, and the masses decide the rest.
// Standard atomic masses; the ratio works out at about 1 : 7.94 by mass, which
// is why an oxidizer tank is the big one on every real hydrolox vehicle.
const M_H2 = 2.016;
const M_O2 = 31.998;
const M_H2O = M_H2 + M_O2 / 2;
/** Fraction of recovered propellant mass that is fuel (H2). */
export const FUEL_FRACTION = M_H2 / M_H2O;
/** Fraction that is oxidizer (O2). */
export const OXIDIZER_FRACTION = 1 - FUEL_FRACTION;

/**
 * Storage per storage level, kg, as the WATER tank's size. Every other tank is
 * this scaled by its share below.
 */
export const STORE_PER_LEVEL = 360;

/**
 * Tank sizes, as a share of STORE_PER_LEVEL.
 *
 * THE PROPELLANT TANKS ARE SIZED TO THE MIXTURE RATIO, which is what a real
 * vehicle does and what makes the caps behave: fuel is produced at
 * FUEL_FRACTION of the propellant rate and stored at FUEL_FRACTION of the
 * tank, so the two tanks fill in exactly the same time. A shared cap across
 * all four resources would have the oxidizer tank full and the fuel tank at
 * an eighth for the whole game, and the storage upgrade would be selling the
 * player eight times more oxidizer capacity than they can use.
 *
 * METALS ARE SIZED BY WHAT THEY HAVE TO BUY, NOT BY WHEN THEY FILL, and this
 * is the one place the two tank rules differ. Every level above the first is
 * priced in metals (BUILD_METALS), so a metals stockpile that could not hold
 * the dearest upgrade at the next level would make that upgrade unreachable —
 * a soft-lock, which DESIGN.md §7 forbids outright, and one the player could
 * not see coming because the number they are saving toward is on a different
 * screen from the tank that cannot hold it. So the share is set to clear
 * BUILD_METALS at every level (test/base.test.js walks all five), and the
 * consequence is accepted: a metals stockpile takes more than one session to
 * fill, so for metals the ELAPSED_CLAMP binds before the cap does.
 *
 * That inversion is right rather than merely tolerable. Metals are the
 * "come back tomorrow" resource — the one the player saves up to spend — and a
 * metals cap that filled overnight would cap the growth of the base rather
 * than its offline accrual. Propellant is the opposite: it is produced to be
 * hauled, so its tanks are sized to fill inside the clamp and the storage
 * upgrade is what buys a longer night away. And 2.5 is not a strange number
 * physically: metals are stockpiled in a yard, not held in a cryogenic
 * pressure vessel, so a metals "tank" being the big one on the pad is what
 * a real base would look like.
 *
 * THE TWO NUMBERS ARE SIZED AGAINST EACH OTHER AND AGAINST THE CLAMP, and
 * `tools/balance.mjs` reports the margin rather than only a pass: at
 * STORE_PER_LEVEL 400 the slowest propellant tank (far-side-flats) filled in
 * 23.8 hours against a 24-hour clamp, which passed and would have
 * stopped passing on any change to a rate, a site or the clamp. 360 puts it
 * at 21.4 hours, and the metals share moves with it so the stockpile still
 * clears the dearest next-level cost.
 */
export const TANK_SHARE = {
  water: 1,
  fuel: FUEL_FRACTION,
  oxidizer: OXIDIZER_FRACTION,
  metals: 2.8,
};

/** The four resources a base can hold, in ledger order. */
export const RESOURCES = ['water', 'fuel', 'oxidizer', 'metals'];

/**
 * Funds price of the FIRST level of each type — the one that is launched.
 *
 * Tier-4-era prices: the tree's tier 4 nodes run 80 000 to 240 000, and a
 * piece of base equipment is a payload rather than a vehicle, so these sit
 * under that band. Transport is the dearest because it is a vehicle.
 */
export const BUILD_FUNDS = {
  power: 60000, extractor: 80000, processor: 120000, storage: 50000, transport: 140000,
};

/**
 * Metals price of the SECOND level of each type, and the base of the geometric
 * run above it.
 *
 * EVERY LEVEL AFTER THE FIRST IS PAID IN METALS, ON SITE. That is the payoff
 * DESIGN.md §8 promises the metals branch — "metals spent on-site build the
 * next piece of equipment without launching it" — and it is the reason metals
 * are extracted but never processed and never hauled. A base that is producing
 * metals is a base that is growing itself.
 */
export const BUILD_METALS = {
  power: 400, extractor: 600, processor: 900, storage: 350, transport: 900,
};
/** How much dearer each level is than the one below it. */
export const METALS_GROWTH = 1.6;

// STORAGE IS THE CHEAPEST METALS UPGRADE AT EVERY LEVEL, and that is what
// makes the ladder unlockable rather than merely affordable: the tank can
// always be grown before the thing that needs a bigger tank. Without it a
// player could reach a level whose cost exceeded their stockpile with no way
// to raise the stockpile, which is the soft-lock TANK_SHARE.metals is sized
// against, arrived at from the other direction. test/base.test.js pins it.

const lvl = (base, type) => Math.max(0, Math.floor(base?.equipment?.[type] ?? 0));

/** An empty base: nothing built, nothing stored. */
export function newBase() {
  return {
    equipment: { power: 0, extractor: 0, processor: 0, storage: 0, transport: 0 },
    store: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
  };
}

/**
 * Power supply, draw, and the throttle everything runs at.
 *
 * A SINGLE THROTTLE, NOT A PRIORITY ORDER. When draw exceeds supply everything
 * runs at `supply / draw` rather than the extractor running full and the
 * processor going without. A priority order is a rule the player has to be
 * taught and then remember; a throttle is one they can read off two numbers on
 * the screen, and it degrades smoothly instead of falling off a cliff at the
 * moment one more level is bought.
 *
 * A base with no power at all has ratio 0 and produces nothing, which is the
 * true statement rather than a special case.
 *
 * @returns {{ supply: number, draw: number, ratio: number }} ratio in [0, 1]
 */
export function powerBalance(base) {
  const supply = lvl(base, 'power') * POWER_PER_LEVEL;
  let draw = 0;
  for (const type of EQUIPMENT) draw += lvl(base, type) * DRAW[type];
  if (draw <= 0) return { supply, draw: 0, ratio: supply > 0 ? 1 : 0 };
  return { supply, draw, ratio: Math.min(1, supply / draw) };
}

/**
 * The recovered propellant fraction at a site's water quality.
 *
 * `quality * PROCESS_YIELD`, capped at MAX_YIELD — see PROCESS_YIELD for why
 * the cap is not optional.
 */
export function yieldAt(quality) {
  const q = Number.isFinite(quality) && quality > 0 ? quality : 0;
  return Math.min(MAX_YIELD, q * PROCESS_YIELD);
}

/**
 * Production rates, per hour, at full power.
 *
 * Everything a base tab needs to show what it is doing, and everything
 * `accrue` needs to do it. Quoted PER HOUR because that is the number a player
 * can reason about — "this fills overnight" — even though the accrual itself
 * is continuous.
 *
 * `water` is the NET rate: extracted less what the processor consumes. It goes
 * negative on a base whose processor outruns its extractor, which is a real
 * state (the processor is eating a stockpile) and is shown as such rather than
 * clamped away.
 *
 * @param {object} base
 * @param {object} site from js/data/sites.js
 * @returns {{ water, metals, fuel, oxidizer, waterExtracted, waterProcessed }}
 */
export function rates(base, site) {
  const { ratio } = powerBalance(base);
  const wp = site?.resources?.water?.plentitude ?? 0;
  const wq = site?.resources?.water?.quality ?? 0;
  const mp = site?.resources?.metals?.plentitude ?? 0;

  const waterExtracted = lvl(base, 'extractor') * EXTRACT_RATE * wp * ratio;
  const metals = lvl(base, 'extractor') * METALS_RATE * mp * ratio;
  const waterProcessed = lvl(base, 'processor') * PROCESS_RATE * ratio;
  const product = waterProcessed * yieldAt(wq);

  return {
    waterExtracted,
    waterProcessed,
    water: waterExtracted - waterProcessed,
    metals,
    fuel: product * FUEL_FRACTION,
    oxidizer: product * OXIDIZER_FRACTION,
  };
}

/**
 * Per-resource storage cap, kg.
 *
 * Storage is the offline limit (DESIGN.md §3) as well as the tank: `accrue`
 * fills toward these and stops, so a base whose tanks are full produced
 * nothing while the player was away. That is what a full tank means, and it is
 * why the cap is both the limit and the natural upgrade.
 */
export function capacity(base) {
  const size = lvl(base, 'storage') * STORE_PER_LEVEL;
  const caps = {};
  for (const r of RESOURCES) caps[r] = size * TANK_SHARE[r];
  return caps;
}

/**
 * Cost of raising `type` from `level - 1` to `level`.
 *
 * Level 1 is funds — the first of anything is a payload, launched. Every level
 * after it is metals, spent on site (DESIGN.md §8). Above MAX_LEVEL there is
 * no cost because there is nothing to buy: the caller checks `level <=
 * MAX_LEVEL` and this returns null so a bad call cannot silently look free.
 *
 * @returns {{ funds: number } | { metals: number } | null}
 */
export function buildCost(type, level) {
  if (!EQUIPMENT.includes(type)) return null;
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) return null;
  if (level === 1) return { funds: BUILD_FUNDS[type] };
  return { metals: Math.round(BUILD_METALS[type] * METALS_GROWTH ** (level - 2)) };
}

/**
 * Run a base for `elapsed` milliseconds.
 *
 * The order matters and is the chain's own: extract, then process what is
 * available (this hour's extraction plus whatever was already in the water
 * tank), then bank the products against their caps.
 *
 * WHAT DOES NOT FIT WAS NEVER PRODUCED. A tank that fills mid-interval stops
 * accepting; the surplus is not queued, not banked elsewhere, and not reported
 * as a loss. That is what a full tank means, and it is the mechanism behind
 * DESIGN.md §3's "offline accrual is capped by storage capacity".
 *
 * @param {object} base
 * @param {object} site
 * @param {number} elapsed ms (already clamped by js/core/clock.js)
 * @returns {{ base: object, produced: object, full: string[] }}
 *   the new base, what was actually banked per resource, and which tanks
 *   ended the interval full (which is what the storage-full notification and
 *   the base tab both read).
 */
export function accrue(base, site, elapsed) {
  const hours = hoursIn(elapsed);
  const store = { ...newBase().store, ...(base?.store ?? {}) };
  const caps = capacity(base);
  const produced = { water: 0, fuel: 0, oxidizer: 0, metals: 0 };

  if (hours <= 0 || !site) {
    return { base: { ...base, store }, produced, full: fullTanks(store, caps) };
  }

  const r = rates(base, site);

  // Water first: what came out of the ground this interval joins what was
  // already in the tank, and the processor eats from the total. It is capped
  // only at the END, after processing, because water that is extracted and
  // immediately consumed never needed a tank to sit in — a base with a full
  // water tank and a running processor is still making propellant.
  const extracted = r.waterExtracted * hours;
  const available = store.water + extracted;
  const processed = Math.min(r.waterProcessed * hours, available);
  const product = processed * yieldAt(site.resources?.water?.quality ?? 0);

  const next = { ...store };
  const bank = (key, amount) => {
    if (!(amount > 0)) return;
    const room = Math.max(0, caps[key] - next[key]);
    const taken = Math.min(amount, room);
    next[key] += taken;
    produced[key] += taken;
  };

  // The water left over after processing is what the tank has to hold.
  const leftover = available - processed;
  const waterRoom = Math.max(0, caps.water);
  next.water = Math.min(leftover, waterRoom);
  produced.water = next.water - store.water;

  bank('fuel', product * FUEL_FRACTION);
  bank('oxidizer', product * OXIDIZER_FRACTION);
  bank('metals', r.metals * hours);

  return { base: { ...base, store: next }, produced, full: fullTanks(next, caps) };
}

/** Which tanks are at (or within a gram of) their cap. */
function fullTanks(store, caps) {
  return RESOURCES.filter((res) => caps[res] > 0 && store[res] >= caps[res] - 1e-6);
}

/**
 * Hours to fill a tank from empty at the current rates — what the base tab
 * quotes, and what the propellant-tank half of the storage rule is checked
 * against (see TANK_SHARE: the propellant tanks fill inside clock.js's clamp,
 * the metals stockpile deliberately does not).
 *
 * Infinity for a resource that is not being produced, which is the honest
 * answer and reads correctly as "never" rather than as a very large number.
 */
export function fillTime(base, site, resource) {
  const caps = capacity(base);
  const r = rates(base, site);
  const rate = resource === 'water' ? r.water : r[resource];
  if (!(rate > 0) || !(caps[resource] > 0)) return Infinity;
  return caps[resource] / rate;
}
