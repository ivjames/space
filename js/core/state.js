// New game state, derived vehicle, tier progress. Pure. See
// ARCHITECTURE.md for the full state/save schema (version 1).
import { collectEffects } from './tree.js';

// newGame(seed) -> State
// Starting funds are 0: launching is free in phase 0 (the floor contract
// is what pays), and 0 is "enough for nothing" per the task brief, so the
// very first purchase has to come from a launch.
export function newGame(seed) {
  return {
    version: 1,
    seed,
    draws: 0,
    funds: 0,
    reputation: 0,
    resources: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
    owned: [],
    tier: 1,
    launches: { 1: 0 },
    best: { maxAltitude: 0 },
    contracts: [],
    history: [],
  };
}

// deriveVehicle(state, tree, components) -> Vehicle
// buildVehicle(components, collectEffects(tree, state))
//
// `buildVehicle` lives in js/core/vehicle.js, owned by another module in
// this build (concurrently authored, per the task brief). It's imported
// dynamically, at call time rather than at module load, specifically so
// this module (and every *other* export in it) loads and tests cleanly
// even on a checkout where vehicle.js doesn't exist yet or is mid-edit.
// See test/state.test.js for how the deriveVehicle test itself is guarded.
export async function deriveVehicle(state, tree, components) {
  const { buildVehicle } = await import('../core/vehicle.js');
  return buildVehicle(components, collectEffects(tree, state));
}

// recordLaunch(state, mission, outcome, draws = 0) -> new state
// Increments launches[state.tier], updates best.maxAltitude, appends to
// history (capped at 20 most recent), and advances `draws` by the rng
// draws the launch consumed (if the caller tracked and passed them —
// resolveLaunch's rng draws its own count, so this is opt-in).
export function recordLaunch(state, mission, outcome, draws = 0) {
  const tier = state.tier;
  const launches = {
    ...state.launches,
    [tier]: (state.launches[tier] ?? 0) + 1,
  };
  const best = {
    ...state.best,
    maxAltitude: Math.max(state.best.maxAltitude, outcome.maxAltitude),
  };
  const entry = {
    tier,
    missionId: mission.id,
    success: outcome.success,
    maxAltitude: outcome.maxAltitude,
    readout: outcome.readout,
  };
  const history = [...state.history, entry].slice(-20);

  return {
    ...state,
    launches,
    best,
    history,
    draws: state.draws + draws,
  };
}

// tierGoalMet(state, missions) -> boolean
// Checks state.best against tierGoals[state.tier]. Accepts either the
// tierGoals map itself, or an object carrying it as `.tierGoals` (e.g. the
// whole js/data/missions.js module namespace) — ARCHITECTURE.md names the
// second parameter `missions` without pinning down which shape the caller
// passes, so both are supported.
export function tierGoalMet(state, missions) {
  const goals = missions.tierGoals ?? missions;
  const goal = goals[state.tier];
  if (!goal) return false;
  return state.best.maxAltitude >= goal.requirement.altitude;
}
