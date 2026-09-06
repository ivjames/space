// The cargo haul: a tanker climbing off a surface base to an orbital depot.
// Pure — no DOM, no `Date.now`, no `Math.random` (the rng is passed in, as
// everywhere else). See ARCHITECTURE.md, "Phase 3b — the economy, whole".
//
// WHY THIS IS NOT A CASE OF resolveLaunch. Every mission in the game so far
// leaves the pad, and `resolveLaunch` integrates that: one central gravity
// term, one atmosphere, one planet-centred frame. A haul starts on the lunar
// surface, which that integrator cannot express — the same constraint that
// kept the moon from being a second attractor in phase 3. So a haul is
// resolved the way the lunar sequence is: analytically, as a burn the vehicle
// can or cannot afford, plus a roll.
//
// DESIGN.md §8 says a haul "uses the same launch flow as a mission, so nothing
// new is built, and it can fail like any launch". That is about the FLOW —
// pick it off the board, watch it, read the outcome, count it in the score —
// and that flow is unchanged. What is new is only the resolution, and it is
// forty lines because a haul is one burn.
//
// THE ONE RUNG IS THE LUNAR ASCENT, and it is `moon.js`'s own
// (`ascentFromSurface`, 1 879 m/s), not a copy of it. The mission that landed
// the base paid exactly this to come back up; a tanker leaving the same
// surface for the same orbit pays the same, and sharing the function is what
// stops the lander and the tanker from disagreeing about the moon.

import { G0 } from './vehicle.js';
import { ascentFromSurface } from './moon.js';
import { FUEL_FRACTION, OXIDIZER_FRACTION } from './base.js';

/**
 * Cargo a tanker carries, kg per level of `transport` equipment.
 *
 * The capacity upgrade is the transport level, so this is what one level of it
 * is worth, and it is sized against the base that fills it: a level-1 base on
 * the reference site makes about 28 kg of propellant an hour, so 4 t is
 * roughly six days of production — which is far too long, and is exactly why
 * the storage cap (js/core/base.js, ~45 kg of propellant per storage level)
 * binds long before the tanker is full. A haul carries what the tanks hold,
 * not what the tanker could hold, and that is the pressure the storage upgrade
 * is under.
 */
export const HAUL_PER_LEVEL = 4000;

/**
 * Tanker dry mass as a fraction of its cargo.
 *
 * A GAME NUMBER, and the one the whole economy turns on: it and the isp decide
 * whether a haul delivers more than it burns (see `haulEconomics`). 15% is a
 * reasonable propellant-tanker structure fraction and is the figure
 * ARCHITECTURE.md's table is computed at.
 */
export const DRY_FRACTION = 0.15;

/** Probability a haul arrives, with a bare tanker and no reliability bought. */
export const HAUL_RELIABILITY = 0.92;
/** Ceiling on the haul roll, however much `haulBonus` the tree buys. */
export const HAUL_RELIABILITY_MAX = 0.99;

/**
 * What one haul costs and delivers, from the tanker's engine alone.
 *
 * THE ROCKET EQUATION, AND IT IS THE DESIGN. A one-way tanker climbing the
 * ascent rung has mass ratio R = exp(dv / (isp g0)); it lifts its dry mass and
 * its cargo, so the propellant it burns is (dry + cargo) * (R - 1). The number
 * that matters is `ratio` — cargo delivered per unit of propellant burned —
 * because both sides come out of the same base tanks:
 *
 *   isp 280 -> 0.89     a hypergolic tanker LOSES propellant every trip
 *   isp 320 -> 1.06     a storable one breaks even inside the noise
 *   isp 450 -> 1.64     a cryogenic one pays
 *
 * So DESIGN.md §8's "hauling pays from the first trip" is not a balance knob,
 * it is a constraint on the ONE NUMBER the tree sells: the tanker's engine.
 * `js/data/tree.js`'s `struct-16` sets `haulIsp` to 450 — a hydrolox upper
 * stage, which is exactly what the base's processor makes out of the site's
 * water — so the tanker burns the thing it is there to carry and the chain
 * closes. A cheaper hypergolic tanker would have been a node that loses the
 * player propellant every time they used it, with nothing on screen saying so.
 * test/data.test.js asserts the ratio for every tanker the tree can sell,
 * rather than trusting this comment.
 *
 * @param {number} isp tanker engine specific impulse, s
 * @param {number} cargo kg to deliver
 * @returns {{ dv, ratio, burned, cargo, dry }} `burned` and `cargo` in kg
 */
export function haulEconomics(isp, cargo) {
  const dv = ascentFromSurface();
  if (!(isp > 0) || !(cargo > 0)) return { dv, ratio: 0, burned: 0, cargo: 0, dry: 0 };
  const massRatio = Math.exp(dv / (isp * G0));
  const dry = DRY_FRACTION * cargo;
  const burned = (dry + cargo) * (massRatio - 1);
  return { dv, ratio: burned > 0 ? cargo / burned : Infinity, burned, cargo, dry };
}

/**
 * The largest haul a base's tanks can actually pay for, kg of cargo.
 *
 * A haul draws cargo AND propellant out of the same store, so what limits it
 * is `cargo + burned` against what is in the tanks, not `cargo` alone. Solving
 * that for cargo is where the tanker's efficiency shows up in the fiction the
 * player sees: a better engine does not only waste less, it lets a given tank
 * farm send a bigger load.
 *
 * The store is drawn at the mixture ratio — a tanker cannot burn hydrogen it
 * has no oxygen for — so the binding tank is whichever of the two runs out
 * first, which on a base running its own processor is neither, since they are
 * produced and stored in exactly that ratio (js/core/base.js).
 */
export function maxCargo(isp, store, capacityLevel) {
  const ceiling = Math.max(0, capacityLevel) * HAUL_PER_LEVEL;
  if (!(ceiling > 0) || !(isp > 0)) return 0;
  const massRatio = Math.exp(ascentFromSurface() / (isp * G0));
  // cargo + (1 + DRY_FRACTION) * cargo * (R - 1) <= available
  const perCargo = 1 + (1 + DRY_FRACTION) * (massRatio - 1);
  const fuel = Math.max(0, store?.fuel ?? 0);
  const ox = Math.max(0, store?.oxidizer ?? 0);
  // Whichever tank runs out first, expressed as total propellant mass.
  const available = Math.min(fuel / FUEL_FRACTION, ox / OXIDIZER_FRACTION);
  return Math.min(ceiling, available / perCargo);
}

/**
 * Automatic hauling, run as part of a production tick (phase 4).
 *
 * WHAT AUTOMATION BUYS IS THE LAUNCH, NOT THE PHYSICS. The propellant an
 * automatic run burns is charged at exactly the ratio a manual one pays —
 * `haulEconomics` is the same function — so buying `autoHaul` removes the
 * chore DESIGN.md §8 says it removes and nothing else. A cheaper automatic
 * haul would make the manual phase strictly worse than waiting, which is the
 * opposite of what a tiered automation ladder is for.
 *
 * IT DOES NOT ROLL. `resolveHaul` risks the load on a reliability roll because
 * the player chose to fly it and watches it happen; an automatic run happens
 * while nobody is looking, and a dice throw the player cannot see, cannot
 * influence and is not told about is not variance, it is an unexplained
 * shortfall. So the automated route is safe and slower — `rate` is what the
 * tree sells — and the reliability node keeps its job on the manual runs that
 * open every new body.
 *
 * @param {object} vehicle needs `haulIsp`, `haulRate` (runs per day) and
 *   optionally `haulCapacity` (a multiplier on the load)
 * @param {object} base
 * @param {number} elapsed ms (already clamped by js/core/clock.js)
 * @returns {object|null} the same `haul` block `resolveHaul` produces, so
 *   js/core/state.js applies it by exactly the same path — or null when
 *   nothing moved, which is the common case on a short tick.
 */
export function autoHaul(vehicle, base, elapsed, depotId = null) {
  const isp = Number(vehicle?.haulIsp) || 0;
  const rate = Number(vehicle?.haulRate) || 0;
  const capacityMul = Number(vehicle?.haulCapacity) || 1;
  const level = Math.max(0, Math.floor(base?.equipment?.transport ?? 0));
  const days = (Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0) / 86400000;
  if (isp <= 0 || rate <= 0 || level <= 0 || days <= 0) return null;

  // What the route could move in this much time, and what the tanks can pay
  // for. The second is nearly always the binding one, which is the intended
  // shape: automation removes the launch, storage still sets the pace.
  const byRate = rate * days * level * HAUL_PER_LEVEL * capacityMul;
  const byTanks = maxCargo(isp, base?.store ?? {}, level * capacityMul);
  const cargo = Math.min(byRate, byTanks);
  if (!(cargo > 0)) return null;

  const { burned } = haulEconomics(isp, cargo);
  return {
    cargo,
    burned,
    delivered: { fuel: cargo * FUEL_FRACTION, oxidizer: cargo * OXIDIZER_FRACTION },
    drawn: {
      fuel: (cargo + burned) * FUEL_FRACTION,
      oxidizer: (cargo + burned) * OXIDIZER_FRACTION,
    },
    to: depotId,
    stoppedAt: null,
    automatic: true,
  };
}

/**
 * Fly one haul.
 *
 * @param {object} vehicle  needs `haulIsp` (the tanker engine) and
 *   `haulBonus` (reliability bought from the tree); both default to 0, so a
 *   vehicle with no tanker cannot haul at all — the same shape `lander` and
 *   `shield` use in the lunar sequence.
 * @param {object} base     the surface base, with its `store` and `equipment`
 * @param {object} depot    the object being hauled to (for the readout)
 * @param {object} rng      from makeRng
 * @returns {object} outcome — `success`, `readout`, `events`, and a `haul`
 *   block carrying what moved, so `recordLaunch` can debit the base and credit
 *   the ledger without re-deriving any of it.
 */
export function resolveHaul(vehicle, base, depot, rng) {
  const isp = Number(vehicle?.haulIsp) || 0;
  const bonus = Number(vehicle?.haulBonus) || 0;
  const level = Math.max(0, Math.floor(base?.equipment?.transport ?? 0));
  const store = base?.store ?? {};
  const events = [];

  const fail = (readout) => ({
    success: false,
    readout,
    events,
    haul: {
      cargo: 0, burned: 0, delivered: null, drawn: null, to: depot?.id ?? null, stoppedAt: readout,
    },
  });

  if (isp <= 0) return fail('No tanker: the transport equipment has nothing to fly.');
  if (level <= 0) return fail('No transport equipment at the base.');

  const cargo = maxCargo(isp, store, level);
  // A haul that would move less than a tonne is not a launch, it is a gesture:
  // the player is told to let the tanks fill rather than being allowed to
  // spend a launch on 40 kg. This is a floor on the ACTION, not a failure, so
  // it reads as advice.
  if (cargo < 1000) {
    return fail('Not enough propellant at the base to fill a tanker.');
  }

  const { burned, dv } = haulEconomics(isp, cargo);
  events.push({
    t: 0,
    kind: 'burn',
    text: `Ascent burn: ${Math.round(dv)} m/s, ${Math.round(burned)} kg of propellant.`,
  });

  const threshold = Math.min(HAUL_RELIABILITY_MAX, HAUL_RELIABILITY + bonus);
  if (!(rng.next() < threshold)) {
    // The propellant is spent either way — the tanker lit and left — so a
    // failed haul costs the base its load. That is what makes the reliability
    // node worth buying, and it is the same shape as a failed docking: the
    // launch is gone, the vehicle is gone, the program continues.
    events.push({ t: 1, kind: 'haul-failure', text: 'The tanker was lost on the climb.' });
    return {
      success: false,
      readout: `Tanker lost: ${Math.round(cargo)} kg did not arrive.`,
      events,
      haul: {
        cargo: 0,
        burned: cargo + burned,
        delivered: null,
        // DRAWN IS WHAT LEAVES THE TANKS, and it is the full load on a failed
        // haul: the tanker lit, left, and took the cargo with it. The base
        // pays the same either way, which is what makes the reliability node
        // worth buying and what keeps a failed haul a real cost rather than a
        // re-roll.
        drawn: {
          fuel: (cargo + burned) * FUEL_FRACTION,
          oxidizer: (cargo + burned) * OXIDIZER_FRACTION,
        },
        to: depot?.id ?? null,
        stoppedAt: 'lost',
      },
    };
  }

  events.push({ t: 1, kind: 'haul', text: `Docked at ${depot?.name ?? 'the depot'}.` });
  return {
    success: true,
    readout: `Delivered ${Math.round(cargo)} kg to ${depot?.name ?? 'the depot'}.`,
    events,
    haul: {
      cargo,
      burned,
      // What actually moves, split at the mixture ratio it was made in.
      delivered: { fuel: cargo * FUEL_FRACTION, oxidizer: cargo * OXIDIZER_FRACTION },
      drawn: {
        fuel: (cargo + burned) * FUEL_FRACTION,
        oxidizer: (cargo + burned) * OXIDIZER_FRACTION,
      },
      to: depot?.id ?? null,
      stoppedAt: null,
    },
  };
}
