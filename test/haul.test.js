// js/core/haul.js — the cargo run from a surface base to an orbital depot,
// and the rocket equation that decides whether it is worth flying.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HAUL_PER_LEVEL, DRY_FRACTION, HAUL_RELIABILITY, HAUL_RELIABILITY_MAX,
  haulEconomics, maxCargo, resolveHaul,
} from '../js/core/haul.js';
import { ascentFromSurface, lunarLadder, LLO_ALT } from '../js/core/moon.js';
import { FUEL_FRACTION, OXIDIZER_FRACTION, newBase } from '../js/core/base.js';
import { radiusOf } from '../js/core/orbit.js';
import { makeRng } from '../js/core/rng.js';
import { newGame, recordLaunch } from '../js/core/state.js';
import { missions } from '../js/data/missions.js';
import { nodes } from '../js/data/tree.js';

const DEPOT = { id: 'depot-1', name: 'Lunar depot', store: { fuel: 0, oxidizer: 0 } };
/** An rng that always succeeds / always fails, so the roll is not the subject. */
const ALWAYS = { next: () => 0 };
const NEVER = { next: () => 0.999999 };

/** A base with a full-enough store to fly. */
function stockedBase(transport = 1, fuel = 400, oxidizer = 3200) {
  const b = newBase();
  b.equipment = {
    power: 2, extractor: 1, processor: 1, storage: 3, transport,
  };
  b.store = { water: 0, fuel, oxidizer, metals: 0 };
  return b;
}

// ---------------------------------------------------------------------------
// The rung, and the equation over it
// ---------------------------------------------------------------------------

test('the haul climbs moon.js\'s own ascent rung, not a copy of it', () => {
  const { dv } = haulEconomics(450, 1000);
  assert.equal(dv, ascentFromSurface());
  // ...and the ladder agrees, which is the point of the shared function: the
  // lander that came back up and the tanker pay the same.
  const ladder = lunarLadder(radiusOf(80000), radiusOf(200000));
  assert.ok(Math.abs(ladder.ascent - dv) < 1e-9);
});

test('the delivered-per-burned ratio is the table ARCHITECTURE.md quotes', () => {
  const at = (isp) => haulEconomics(isp, 4000).ratio;
  assert.ok(Math.abs(at(280) - 0.89) < 0.01, `isp 280 -> ${at(280)}`);
  assert.ok(Math.abs(at(320) - 1.06) < 0.01, `isp 320 -> ${at(320)}`);
  assert.ok(Math.abs(at(360) - 1.24) < 0.01, `isp 360 -> ${at(360)}`);
  assert.ok(Math.abs(at(450) - 1.64) < 0.01, `isp 450 -> ${at(450)}`);
});

test('the ratio does not depend on how big the load is', () => {
  // Both dry mass and propellant scale with cargo, so a bigger tanker is not a
  // better one — only a better engine is. That is what makes the tree node the
  // decision and the transport level a capacity.
  const small = haulEconomics(450, 500).ratio;
  const big = haulEconomics(450, 40000).ratio;
  assert.ok(Math.abs(small - big) < 1e-9);
});

test('haulEconomics is zero rather than NaN without an engine or a load', () => {
  for (const [isp, cargo] of [[0, 1000], [450, 0], [-1, -1]]) {
    const e = haulEconomics(isp, cargo);
    assert.equal(e.burned, 0);
    assert.equal(e.cargo, 0);
  }
});

// ---------------------------------------------------------------------------
// What the tanks can actually pay for
// ---------------------------------------------------------------------------

test('maxCargo is limited by the tanks, and cargo plus propellant fits in them', () => {
  const store = { fuel: 400, oxidizer: 3200 };
  const cargo = maxCargo(450, store, 1);
  const { burned } = haulEconomics(450, cargo);
  const drawnFuel = (cargo + burned) * FUEL_FRACTION;
  const drawnOx = (cargo + burned) * OXIDIZER_FRACTION;
  assert.ok(drawnFuel <= store.fuel + 1e-6, `drew ${drawnFuel} fuel from ${store.fuel}`);
  assert.ok(drawnOx <= store.oxidizer + 1e-6, `drew ${drawnOx} oxidizer from ${store.oxidizer}`);
  // One of the two tanks is emptied exactly — the binding one.
  assert.ok(Math.abs(drawnFuel - store.fuel) < 1e-6 || Math.abs(drawnOx - store.oxidizer) < 1e-6);
});

test('maxCargo is limited by the transport level once the tanks are deep enough', () => {
  const deep = { fuel: 1e9, oxidizer: 1e9 };
  assert.equal(maxCargo(450, deep, 1), HAUL_PER_LEVEL);
  assert.equal(maxCargo(450, deep, 3), 3 * HAUL_PER_LEVEL);
});

test('a better engine sends a bigger load from the same tanks', () => {
  const store = { fuel: 400, oxidizer: 3200 };
  assert.ok(maxCargo(450, store, 9) > maxCargo(320, store, 9));
});

test('maxCargo is zero without an engine, a level, or anything in the tanks', () => {
  assert.equal(maxCargo(0, { fuel: 1e6, oxidizer: 1e6 }, 1), 0);
  assert.equal(maxCargo(450, { fuel: 1e6, oxidizer: 1e6 }, 0), 0);
  assert.equal(maxCargo(450, { fuel: 0, oxidizer: 0 }, 1), 0);
  // A tank pair with hydrogen and no oxygen cannot fly: the mixture binds.
  assert.equal(maxCargo(450, { fuel: 1e6, oxidizer: 0 }, 1), 0);
});

// ---------------------------------------------------------------------------
// The flight
// ---------------------------------------------------------------------------

test('a stocked base with a tanker delivers, and says what it delivered', () => {
  const out = resolveHaul({ haulIsp: 450 }, stockedBase(), DEPOT, ALWAYS);
  assert.equal(out.success, true);
  assert.ok(out.haul.cargo > 1000);
  assert.ok(out.haul.burned > 0);
  assert.ok(out.haul.cargo > out.haul.burned, 'the run must pay');
  assert.match(out.readout, /Delivered .* to Lunar depot/);
  // What was delivered is split at the mixture ratio it was made in.
  assert.ok(Math.abs(out.haul.delivered.fuel / out.haul.cargo - FUEL_FRACTION) < 1e-9);
  assert.ok(Math.abs(out.haul.delivered.oxidizer / out.haul.cargo - OXIDIZER_FRACTION) < 1e-9);
});

test('a lost tanker still costs the base the whole load', () => {
  const out = resolveHaul({ haulIsp: 450 }, stockedBase(), DEPOT, NEVER);
  assert.equal(out.success, false);
  assert.equal(out.haul.cargo, 0);
  assert.equal(out.haul.delivered, null);
  assert.ok(out.haul.drawn.fuel > 0, 'the tanker lit and left with it');
  assert.match(out.readout, /Tanker lost/);
});

test('the reliability bonus raises the roll but never past the ceiling', () => {
  // A roll just under the bonused threshold succeeds only with the bonus.
  const roll = (v) => ({ next: () => v });
  const justOver = roll(HAUL_RELIABILITY + 0.01);
  assert.equal(resolveHaul({ haulIsp: 450 }, stockedBase(), DEPOT, justOver).success, false);
  assert.equal(
    resolveHaul({ haulIsp: 450, haulBonus: 0.05 }, stockedBase(), DEPOT, justOver).success, true,
  );
  const aboveCeiling = roll(HAUL_RELIABILITY_MAX + 0.001);
  assert.equal(
    resolveHaul({ haulIsp: 450, haulBonus: 1 }, stockedBase(), DEPOT, aboveCeiling).success, false,
    'no amount of tree spending makes a haul certain',
  );
});

test('no tanker, no transport equipment, and empty tanks each say which', () => {
  const noEngine = resolveHaul({}, stockedBase(), DEPOT, ALWAYS);
  assert.equal(noEngine.success, false);
  assert.match(noEngine.readout, /No tanker/);
  assert.equal(noEngine.haul.drawn, null, 'nothing moved, so nothing is debited');

  const noKit = resolveHaul({ haulIsp: 450 }, stockedBase(0), DEPOT, ALWAYS);
  assert.match(noKit.readout, /No transport equipment/);

  const empty = resolveHaul({ haulIsp: 450 }, stockedBase(1, 10, 80), DEPOT, ALWAYS);
  assert.equal(empty.success, false);
  assert.match(empty.readout, /Not enough propellant/);
  assert.equal(empty.haul.drawn, null, 'a run too small to fly costs nothing');
});

// ---------------------------------------------------------------------------
// What recordLaunch does with it — the three sides of the trade
// ---------------------------------------------------------------------------

const haulMission = missions.find((m) => m.id === 'haul-mare-tranquil');

function stateWithBase() {
  const s = newGame(1);
  return {
    ...s,
    tier: 4,
    bases: { 'mare-tranquil': stockedBase() },
    objects: [{
      id: 'depot-1', kind: 'depot', name: 'Lunar depot', body: 'moon',
      periapsis: LLO_ALT, apoapsis: LLO_ALT, phase: 0, dockedTo: null,
      store: { fuel: 0, oxidizer: 0 },
    }],
  };
}

test('a successful haul debits the base, credits the ledger and fills the depot', () => {
  const state = stateWithBase();
  const outcome = resolveHaul({ haulIsp: 450 }, state.bases['mare-tranquil'], DEPOT, ALWAYS);
  const next = recordLaunch(state, haulMission, outcome);

  const before = state.bases['mare-tranquil'].store;
  const after = next.bases['mare-tranquil'].store;
  assert.ok(Math.abs((before.fuel - after.fuel) - outcome.haul.drawn.fuel) < 1e-6);
  assert.ok(Math.abs(next.resources.fuel - outcome.haul.delivered.fuel) < 1e-6);
  assert.ok(Math.abs(next.objects[0].store.oxidizer - outcome.haul.delivered.oxidizer) < 1e-6);
  // The base always loses more than the ledger gains: the difference is what
  // the tanker burned climbing.
  const lost = (before.fuel - after.fuel) + (before.oxidizer - after.oxidizer);
  const gained = next.resources.fuel + next.resources.oxidizer;
  assert.ok(lost > gained, 'propellant is spent getting propellant up');
});

test('a lost tanker debits the base and credits nothing', () => {
  const state = stateWithBase();
  const outcome = resolveHaul({ haulIsp: 450 }, state.bases['mare-tranquil'], DEPOT, NEVER);
  const next = recordLaunch(state, haulMission, outcome);
  assert.ok(next.bases['mare-tranquil'].store.oxidizer < state.bases['mare-tranquil'].store.oxidizer);
  assert.equal(next.resources.fuel, 0);
  assert.equal(next.objects[0].store.fuel, 0);
});

test('a haul counts toward the launch score', () => {
  // DESIGN.md §8: hauls count, which is what makes auto-transport a score
  // improvement rather than only a convenience.
  const state = stateWithBase();
  const outcome = resolveHaul({ haulIsp: 450 }, state.bases['mare-tranquil'], DEPOT, ALWAYS);
  const next = recordLaunch(state, haulMission, outcome);
  assert.equal(next.launches[4], 1);
  assert.equal(next.history.at(-1).hauled, 'depot-1');
});

test('a base store can never be driven negative', () => {
  const state = stateWithBase();
  const outcome = {
    success: true,
    readout: 'x',
    haul: {
      cargo: 1, burned: 1, to: 'depot-1',
      delivered: { fuel: 1, oxidizer: 1 },
      drawn: { fuel: 1e9, oxidizer: 1e9 },
    },
  };
  const next = recordLaunch(state, haulMission, outcome);
  assert.equal(next.bases['mare-tranquil'].store.fuel, 0);
  assert.equal(next.bases['mare-tranquil'].store.oxidizer, 0);
});

// ---------------------------------------------------------------------------
// The tree's one number
// ---------------------------------------------------------------------------

test('every tanker the tree can sell delivers more than it burns', () => {
  // DESIGN.md §8: "hauling pays from the first trip". It is a constraint on
  // this node's isp, not a balance knob -- a hypergolic tanker would lose the
  // player propellant on every run with nothing on screen saying so.
  const tankers = nodes.flatMap((n) => n.effects
    .filter((e) => e.stat === 'haulIsp')
    .map((e) => [n.id, e.value]));
  assert.ok(tankers.length > 0, 'the tree sells no tanker at all');
  for (const [id, isp] of tankers) {
    const ratio = haulEconomics(isp, 4000).ratio;
    assert.ok(ratio > 1.2, `${id} sells an isp ${isp} tanker: ratio ${ratio.toFixed(2)}`);
  }
});
