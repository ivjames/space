#!/usr/bin/env node
// Balance audit for the tier 1 content (js/data/*). Runs the REAL resolver —
// never the ideal delta-v shortcut — so what it reports is what a player
// actually experiences flying straight up through real gravity and drag
// losses. See ARCHITECTURE.md (vehicle/resolver/tree/missions) and
// DESIGN.md §6/§7.
//
// Usage: node tools/balance.mjs
//
// Reports:
//   - the starter's max altitude (fuelFraction 1.0 and 0.8)
//   - every mission's cheapest prereq-valid reaching set + cost
//   - the tier goal's cheapest reaching set + cost
//   - the full tree's max altitude
//   - the minimum liftoff TWR over every prereq-valid owned set
//   - a greedy player's launch count to the tier goal
//
// Determinism: reliability is forced to 1 on a deep copy of the vehicle
// before every resolve. The resolver has no reliability-override option, and
// nothing here depends on the rng beyond that (a reliability-1 vehicle flies
// bit-identically under any seed — see resolver.js's docs on the mid-burn
// roll), so a fixed seed is used throughout for repeatability.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = (p) => path.join(here, '..', 'js', 'core', p);
const data = (p) => path.join(here, '..', 'js', 'data', p);

const { resolveLaunch } = await import(core('resolver.js'));
const { buildVehicle } = await import(core('vehicle.js'));
const { makeRng } = await import(core('rng.js'));
const { loadTree, collectEffects, canBuy, buy } = await import(core('tree.js'));
const { baseVehicle } = await import(data('components.js'));
const { nodes } = await import(data('tree.js'));
const { missions, tierGoals } = await import(data('missions.js'));

const G0 = 9.80665;
const SEED = 1;
// Larger than any altitude this tree can reach, so the resolver always flies
// the whole trajectory instead of stopping early at a "goal" altitude — we
// want maxAltitude, not success/failure against some requirement.
const NO_CEILING_MISSION = { requirement: { altitude: 1e9 } };

function forceReliability(vehicle) {
  const copy = JSON.parse(JSON.stringify(vehicle));
  for (const stage of copy.stages) stage.reliability = 1;
  return copy;
}

function maxAltitudeOf(vehicle, fuelFraction = 1) {
  const rng = makeRng(SEED);
  const outcome = resolveLaunch(
    forceReliability(vehicle),
    NO_CEILING_MISSION,
    { fuelFraction },
    rng,
    {},
  );
  return outcome.maxAltitude;
}

function liftoffTWR(vehicle, fuelFraction = 1) {
  const totalMass = vehicle.stages.reduce(
    (m, s) => m + s.dryMass + s.propMass * fuelFraction,
    vehicle.payloadMass,
  );
  const liftoffThrust = vehicle.stages[0]?.thrust ?? 0;
  return liftoffThrust / (totalMass * G0);
}

function fundsCost(node) {
  return node.cost?.funds ?? 0;
}

// ---- Enumerate every prereq-valid owned set (2^N over the tree) -----------

const tree = loadTree(nodes);
const ids = nodes.map((n) => n.id);
if (ids.length > 20) {
  throw new Error(`balance.mjs: brute force assumes a small tree, got ${ids.length} nodes`);
}

const validSets = [];
for (let mask = 0; mask < 1 << ids.length; mask += 1) {
  const owned = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (mask & (1 << i)) owned.push(ids[i]);
  }
  const ownedSet = new Set(owned);
  let valid = true;
  for (const id of owned) {
    const reqs = tree.byId.get(id).requires ?? [];
    if (!reqs.every((r) => ownedSet.has(r))) {
      valid = false;
      break;
    }
  }
  if (!valid) continue;

  const state = { owned, funds: 0, resources: {} };
  const effects = collectEffects(tree, state);
  const vehicle = buildVehicle(baseVehicle, effects);
  const altitude = maxAltitudeOf(vehicle, 1);
  const twr = liftoffTWR(vehicle, 1);
  const cost = owned.reduce((sum, id) => sum + fundsCost(tree.byId.get(id)), 0);
  validSets.push({ owned, altitude, twr, cost });
}

function cheapestReaching(requiredAltitude) {
  let best = null;
  for (const set of validSets) {
    if (set.altitude < requiredAltitude) continue;
    if (!best || set.cost < best.cost) best = set;
  }
  return best;
}

// ---- Greedy player simulation ----------------------------------------------
//
// Each launch: fly the highest-payout mission the current vehicle (at
// fuelFraction 1.0, reliability forced to 1 for determinism, matching the
// rest of this script) can reach; if none of the non-floor missions are
// reachable yet, fly the floor contract (always affordable, always offered,
// per DESIGN.md §7). Bank the payout, then greedily buy the cheapest
// afford­able node that increases max altitude, repeating until no such node
// is affordable, then launch again. Stops when max altitude clears the tier
// goal. Reputation gating (minReputation) is not modeled — this is a
// best-case "always qualifies" player, so the reported count is a lower
// bound on launches, which is the right side to be conservative about here.
function greedyLaunchesToGoal() {
  const goalAltitude = tierGoals[1].requirement.altitude;
  const floorMission = missions.find((m) => m.floor);
  let state = { owned: [], funds: 0, resources: {} };
  let launches = 0;
  const MAX_LAUNCHES = 500;

  const altitudeOf = (s) => {
    const vehicle = buildVehicle(baseVehicle, collectEffects(tree, s));
    return maxAltitudeOf(vehicle, 1);
  };

  let altitude = altitudeOf(state);
  while (altitude < goalAltitude) {
    if (launches >= MAX_LAUNCHES) {
      throw new Error(`greedy simulation did not reach the tier goal within ${MAX_LAUNCHES} launches`);
    }
    let best = floorMission;
    for (const m of missions) {
      if (m.requirement.altitude <= altitude && m.payout > best.payout) best = m;
    }
    state = { ...state, funds: state.funds + best.payout };
    launches += 1;

    // Spend down on the cheapest altitude-increasing node, repeatedly, until
    // nothing affordable helps anymore.
    for (;;) {
      let pick = null;
      for (const node of tree.nodes) {
        if (!canBuy(tree, state, node.id)) continue;
        const candidateState = { ...state, owned: [...state.owned, node.id] };
        const candidateAltitude = altitudeOf(candidateState);
        if (candidateAltitude > altitude + 1e-6) {
          if (!pick || fundsCost(node) < fundsCost(pick)) pick = node;
        }
      }
      if (!pick) break;
      state = buy(tree, state, pick.id);
      altitude = altitudeOf(state);
    }
  }
  return launches;
}

// ---- Report -----------------------------------------------------------------

console.log('=== Starter vehicle ===');
const starterVehicle = buildVehicle(baseVehicle, []);
const starterAlt1 = maxAltitudeOf(starterVehicle, 1);
const starterAlt08 = maxAltitudeOf(starterVehicle, 0.8);
console.log(`  max altitude @ fuelFraction 1.0: ${starterAlt1.toFixed(0)} m`);
console.log(`  max altitude @ fuelFraction 0.8: ${starterAlt08.toFixed(0)} m`);
console.log(`  liftoff TWR: ${liftoffTWR(starterVehicle, 1).toFixed(2)}`);

console.log('\n=== Full tree (all nodes owned) ===');
const fullState = { owned: ids, funds: 0, resources: {} };
const fullVehicle = buildVehicle(baseVehicle, collectEffects(tree, fullState));
const fullAlt = maxAltitudeOf(fullVehicle, 1);
const fullCost = ids.reduce((s, id) => s + fundsCost(tree.byId.get(id)), 0);
console.log(`  max altitude @ fuelFraction 1.0: ${fullAlt.toFixed(0)} m`);
console.log(`  total cost: ${fullCost} funds`);

console.log('\n=== Minimum liftoff TWR over every prereq-valid owned set ===');
let minTwr = Infinity;
let minTwrOwned = [];
for (const set of validSets) {
  if (set.twr < minTwr) {
    minTwr = set.twr;
    minTwrOwned = set.owned;
  }
}
console.log(`  min TWR: ${minTwr.toFixed(3)} (owned=[${minTwrOwned.join(',') || '(none)'}])`);
console.log(`  ${validSets.length} prereq-valid sets checked out of ${1 << ids.length} masks`);

console.log('\n=== Missions: cheapest prereq-valid reaching set ===');
for (const m of missions) {
  const best = cheapestReaching(m.requirement.altitude);
  const label = m.floor ? ' (floor)' : '';
  if (!best) {
    console.log(`  ${m.id}${label}: UNREACHABLE at ${m.requirement.altitude} m`);
    continue;
  }
  console.log(
    `  ${m.id}${label}: ${m.requirement.altitude} m -> ${best.cost} funds, ` +
    `${best.owned.length} node(s) [${best.owned.join(', ') || '(none)'}], reaches ${best.altitude.toFixed(0)} m`,
  );
}

console.log('\n=== Tier 1 goal: cheapest prereq-valid reaching set ===');
const goalAltitude = tierGoals[1].requirement.altitude;
const goalBest = cheapestReaching(goalAltitude);
if (!goalBest) {
  console.log(`  UNREACHABLE at ${goalAltitude} m`);
} else {
  console.log(
    `  ${goalAltitude} m -> ${goalBest.cost} funds (${((goalBest.cost / fullCost) * 100).toFixed(0)}% of full tree cost), ` +
    `${goalBest.owned.length} node(s) [${goalBest.owned.join(', ')}]`,
  );
}

console.log('\n=== Greedy player simulation ===');
const launches = greedyLaunchesToGoal();
console.log(`  launches to reach the tier 1 goal (${goalAltitude} m): ${launches}`);
