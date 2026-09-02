// New game state, derived vehicle, tier progress. Pure. See
// ARCHITECTURE.md for the full state/save schema (version 3, phase 2).
import { collectEffects } from './tree.js';

import { phaseFor } from './orbit.js';

// newGame(seed) -> State
// Starting funds are 0: launching is free in phase 0 (the floor contract
// is what pays), and 0 is "enough for nothing" per the task brief, so the
// very first purchase has to come from a launch.
//
// `version` here is the schema a fresh game is BORN at, and must track
// save.js's SCHEMA_VERSION (3, phase 2) — hardcoded rather than imported to
// avoid a state.js -> save.js dependency this module didn't have before
// (the same "duplicated literal" tradeoff phase 0 already made: save.js's
// own SCHEMA_VERSION constant is the second copy).
//
// `best` is per-tier and per-metric (ARCHITECTURE.md, "state.js, save.js —
// tier progression, schema v2" and "...schema v3"): `maxAltitude` is kept
// for tier 1 and old saves, `maxDownrange`/`bestPeriapsis` are tier 2's,
// `bestClosestApproach`/`docked` are tier 3's (phase 2), and `wins` records
// which tier win screens have already been shown (`{ [tier]: true }`) —
// see advanceTier below for where a tier's win gets recorded.
//
// `objects` is new in phase 2 (ARCHITECTURE.md, "Persistent objects in
// orbit"): everything the player has ever launched and left in orbit (a
// station core, a docked module, a satellite), independent of `tier` —
// they persist across a tier advance, which is why advanceTier below does
// not touch this field.
export function newGame(seed) {
  return {
    version: 3,
    seed,
    draws: 0,
    funds: 0,
    reputation: 0,
    resources: { water: 0, fuel: 0, oxidizer: 0, metals: 0 },
    owned: [],
    tier: 1,
    launches: { 1: 0 },
    best: {
      maxAltitude: 0,
      maxDownrange: 0,
      bestPeriapsis: null,
      bestClosestApproach: null,
      docked: false,
      wins: {},
    },
    contracts: [],
    history: [],
    objects: [],
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

// Mirror of maxOrKeep, but for a metric where SMALLER is better
// (closestApproach: how close the vehicle got to its target, metres —
// phase 2's outcome field). Same "absent/non-finite incoming leaves the
// running best untouched" and "null means never attempted, not 0" rules.
function minOrKeep(current, incoming) {
  if (typeof incoming !== 'number' || !Number.isFinite(incoming)) return current;
  if (current === null || current === undefined) return incoming;
  return Math.min(current, incoming);
}

// findTarget(state, kind) -> object | null
// The newest undocked object of the given kind (ARCHITECTURE.md,
// "Persistent objects in orbit"): the resolver's opts.target for a
// rendezvous/dock mission, and generateContracts' `requiresObject`/`unique`
// gates (js/core/contracts.js) both read this shape. "Newest" is array
// order — addObject/recordLaunch always append, never reorder or remove,
// so the LAST matching entry is the most recently launched one. "Undocked"
// excludes anything with `dockedTo` set (a docked module is no longer a
// separate rendezvous target; the core it's docked to still is, since the
// core's own `dockedTo` stays null forever — nothing docks it to a third
// thing).
export function findTarget(state, kind) {
  const objects = state.objects ?? [];
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (obj.kind === kind && obj.dockedTo == null) return obj;
  }
  return null;
}

// addObject(state, obj) -> new state
// Appends obj to state.objects. Does not assign an id/phase/etc itself —
// recordLaunch (below) is the one real caller and builds the full object
// (id from nextObjectId, phase from phaseFor) before calling this; exposed
// separately per ARCHITECTURE.md's exported-function list, for tests and
// any future direct caller (e.g. a debug/cheat path).
export function addObject(state, obj) {
  return { ...state, objects: [...(state.objects ?? []), obj] };
}

// dockObject(state, id, toId) -> new state
// Sets the `dockedTo` of the object with the given id. Not used by
// recordLaunch's own dock-mission handling below (a dock mission's
// deployed module is created ALREADY docked — ARCHITECTURE.md: "for a dock
// success, adding the module already docked... and marking nothing else"
// — so there is no separately-existing object to retroactively dock).
// Exposed for tests and any future mission shape that docks an
// already-existing object rather than a newly deployed one.
export function dockObject(state, id, toId) {
  return {
    ...state,
    objects: (state.objects ?? []).map((obj) => (obj.id === id ? { ...obj, dockedTo: toId } : obj)),
  };
}

// nextObjectId(objects, kind) -> 'kind-N', N = 1 + however many objects of
// that kind already exist (docked or not — docking never removes an
// object from state.objects, so counting only undocked ones would risk a
// collision the moment something of that kind ever gets docked).
function nextObjectId(objects, kind) {
  const count = objects.filter((obj) => obj.kind === kind).length;
  return `${kind}-${count + 1}`;
}

// The orbit a newly deployed object is recorded at: phase 2's `insertion`
// field when the resolver provides it (ARCHITECTURE.md: "orbit from
// outcome.insertion or outcome.periapsis/apoapsis"), else the phase 1
// bare `periapsis`/`apoapsis` fields — so a deploy still records a sane
// orbit against a resolver that hasn't landed phase 2's `insertion` field
// yet (the concurrent-edit case this whole file is written to tolerate).
function objectOrbitFrom(outcome) {
  if (outcome.insertion) {
    return { periapsis: outcome.insertion.periapsis, apoapsis: outcome.insertion.apoapsis };
  }
  return { periapsis: outcome.periapsis ?? null, apoapsis: outcome.apoapsis ?? null };
}

// recordLaunch(state, mission, outcome, draws = 0) -> new state
// Increments launches[state.tier]; updates best.maxAltitude (always),
// best.maxDownrange / best.bestPeriapsis (only when the outcome actually
// carries `maxDownrange` / `periapsis` — see maxOrKeep above, phase 1
// outcome fields may be absent on an older/fabricated outcome), and (phase
// 2) best.bestClosestApproach / best.docked from `outcome.closestApproach`
// / `outcome.docked`; appends to history (capped at 20 most recent, now
// also carrying `closestApproach` and `docked`); applies `mission.deploys`
// on a successful outcome (ARCHITECTURE.md, "Persistent objects in orbit":
// a new object, id `<kind>-<n>`, orbit from objectOrbitFrom above, phase
// from phaseFor(id) — see the module-load guard at the top of this file —
// and, when the outcome is a dock success, `dockedTo` set to the docked
// target's id straight away rather than via a separate dockObject call);
// and advances `draws` by the rng draws the launch consumed (if the caller
// tracked and passed them — resolveLaunch's rng draws its own count, so
// this is opt-in).
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
    bestClosestApproach: minOrKeep(state.best.bestClosestApproach ?? null, outcome.closestApproach),
    docked: (state.best.docked ?? false) || outcome.docked === true,
  };
  const entry = {
    tier,
    missionId: mission.id,
    success: outcome.success,
    maxAltitude: outcome.maxAltitude,
    periapsis: outcome.periapsis ?? null,
    downrange: outcome.maxDownrange ?? null,
    closestApproach: outcome.closestApproach ?? null,
    docked: outcome.docked ?? false,
    readout: outcome.readout,
  };
  const history = [...state.history, entry].slice(-20);

  let objects = state.objects ?? [];
  if (outcome.success && mission.deploys) {
    const { kind, name } = mission.deploys;
    const id = nextObjectId(objects, kind);
    const { periapsis, apoapsis } = objectOrbitFrom(outcome);
    // A dock mission's outcome carries the docked-to target's id in
    // orbital.target.id (ARCHITECTURE.md's Outcome shape); every other
    // deploying mission (satellite, core) never sets outcome.docked, so
    // dockedTo stays null — a freshly deployed core/satellite is not
    // docked to anything.
    const dockedTo = outcome.docked ? (outcome.orbital?.target?.id ?? null) : null;
    objects = [
      ...objects,
      {
        id,
        kind,
        name,
        periapsis,
        apoapsis,
        phase: phaseFor(id),
        dockedTo,
        launchedAt: { tier, launch: launches[tier] },
      },
    ];
  }

  return {
    ...state,
    launches,
    best,
    history,
    objects,
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
// The requirement shape decides which `best` metric (or, for `dock`,
// `state.objects`) it's checked against (ARCHITECTURE.md: "tier 1 on
// maxAltitude and tier 2 on bestPeriapsis"; phase 2: "tierGoalMet handles
// { dock } (any object with dockedTo set) and { rendezvous }
// (bestClosestApproach <= within)"): an `altitude` requirement reads
// best.maxAltitude, an `orbit.periapsis` requirement reads
// best.bestPeriapsis, a `downrange` requirement (not used by any tierGoal
// yet, but part of the same requirement union — see js/data/missions.js)
// reads best.maxDownrange, a `rendezvous.within` requirement reads
// best.bestClosestApproach, and a `dock` requirement scans state.objects
// directly rather than best.docked (a boolean can't say WHICH object got
// docked, but the objects array can, so that's the source of truth here —
// best.docked stays a cheap "has this ever happened" flag for the UI/HUD).
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
  if (req.rendezvous !== undefined) {
    const best = state.best.bestClosestApproach;
    return best !== null && best !== undefined && best <= req.rendezvous.within;
  }
  if (req.dock !== undefined) {
    return (state.objects ?? []).some((obj) => obj.dockedTo != null);
  }
  return false;
}
