// New game state, derived vehicle, tier progress. Pure. See
// ARCHITECTURE.md for the full state/save schema (version 2, phase 1).
import { collectEffects } from './tree.js';

// newGame(seed) -> State
// Starting funds are 0: launching is free in phase 0 (the floor contract
// is what pays), and 0 is "enough for nothing" per the task brief, so the
// very first purchase has to come from a launch.
//
// `version` here is the schema a fresh game is BORN at, and must track
// save.js's SCHEMA_VERSION (2, phase 1) — hardcoded rather than imported to
// avoid a state.js -> save.js dependency this module didn't have before
// (the same "duplicated literal" tradeoff phase 0 already made: save.js's
// own SCHEMA_VERSION constant is the second copy).
//
// `best` is per-tier and per-metric (ARCHITECTURE.md, "state.js, save.js —
// tier progression, schema v2"): `maxAltitude` is kept for tier 1 and old
// saves, `maxDownrange`/`bestPeriapsis` are tier 2's, and `wins` records
// which tier win screens have already been shown (`{ [tier]: true }`) —
// see advanceTier below for where a tier's win gets recorded.
export function newGame(seed) {
  return {
    version: 2,
    seed,
    draws: 0,
    funds: 0,
    reputation: 0,
    resources: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
    owned: [],
    tier: 1,
    launches: { 1: 0 },
    best: { maxAltitude: 0, maxDownrange: 0, bestPeriapsis: null, wins: {} },
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

// Take the max of `current` and `incoming`, but only when `incoming` is
// actually a finite number — an outcome from an older resolver (or a
// hand-written test fixture) may simply not carry a phase 1 field
// (`maxDownrange`, `periapsis`), and an absent field must leave the
// running best untouched rather than being coerced into 0/NaN and
// clobbering it. `current === null` (bestPeriapsis's "never attempted"
// starting value) is treated as "no floor yet", not as 0.
function maxOrKeep(current, incoming) {
  if (typeof incoming !== 'number' || !Number.isFinite(incoming)) return current;
  if (current === null || current === undefined) return incoming;
  return Math.max(current, incoming);
}

// recordLaunch(state, mission, outcome, draws = 0) -> new state
// Increments launches[state.tier]; updates best.maxAltitude (always) and
// best.maxDownrange / best.bestPeriapsis (only when the outcome actually
// carries `maxDownrange` / `periapsis` — see maxOrKeep above, phase 1
// outcome fields may be absent on an older/fabricated outcome); appends to
// history (capped at 20 most recent, now also carrying `periapsis` and
// `downrange`); and advances `draws` by the rng draws the launch consumed
// (if the caller tracked and passed them — resolveLaunch's rng draws its
// own count, so this is opt-in).
export function recordLaunch(state, mission, outcome, draws = 0) {
  const tier = state.tier;
  const launches = {
    ...state.launches,
    [tier]: (state.launches[tier] ?? 0) + 1,
  };
  const best = {
    ...state.best,
    maxAltitude: Math.max(state.best.maxAltitude ?? 0, outcome.maxAltitude ?? 0),
    maxDownrange: maxOrKeep(state.best.maxDownrange ?? 0, outcome.maxDownrange),
    bestPeriapsis: maxOrKeep(state.best.bestPeriapsis ?? null, outcome.periapsis),
  };
  const entry = {
    tier,
    missionId: mission.id,
    success: outcome.success,
    maxAltitude: outcome.maxAltitude,
    periapsis: outcome.periapsis ?? null,
    downrange: outcome.maxDownrange ?? null,
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

// advanceTier(state) -> new state
// tier + 1, launches[newTier] reset to 0, contracts cleared (a new tier's
// offer pool differs — screens.js regenerates it). Also marks the tier just
// left as won in best.wins, so a win screen the player has already seen
// (per-tier) is not shown again on a reload — this is the write side of the
// `best.wins` read documented on newGame above, and of the `winShown`
// single-tier version save.js's migrations[1] promotes from.
export function advanceTier(state) {
  const tier = state.tier + 1;
  return {
    ...state,
    tier,
    launches: { ...state.launches, [tier]: 0 },
    contracts: [],
    best: {
      ...state.best,
      wins: { ...(state.best.wins ?? {}), [state.tier]: true },
    },
  };
}

// tierGoalMet(state, missions) -> boolean
// Checks state.best against tierGoals[state.tier]. Accepts either the
// tierGoals map itself, or an object carrying it as `.tierGoals` (e.g. the
// whole js/data/missions.js module namespace) — ARCHITECTURE.md names the
// second parameter `missions` without pinning down which shape the caller
// passes, so both are supported.
//
// The requirement shape decides which `best` metric it's checked against
// (ARCHITECTURE.md: "tier 1 on maxAltitude and tier 2 on bestPeriapsis"):
// an `altitude` requirement reads best.maxAltitude, an `orbit.periapsis`
// requirement reads best.bestPeriapsis, and a `downrange` requirement (not
// used by any tierGoal yet, but part of the same three-shape mission
// requirement union — see js/data/missions.js) reads best.maxDownrange.
export function tierGoalMet(state, missions) {
  const goals = missions.tierGoals ?? missions;
  const goal = goals[state.tier];
  if (!goal) return false;
  const req = goal.requirement;
  if (req.altitude !== undefined) {
    return (state.best.maxAltitude ?? 0) >= req.altitude;
  }
  if (req.orbit !== undefined) {
    const bestPeriapsis = state.best.bestPeriapsis;
    return bestPeriapsis !== null && bestPeriapsis !== undefined && bestPeriapsis >= req.orbit.periapsis;
  }
  if (req.downrange !== undefined) {
    return (state.best.maxDownrange ?? 0) >= req.downrange;
  }
  return false;
}
