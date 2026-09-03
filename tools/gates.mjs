#!/usr/bin/env node
// Hardware gates, derived from the real resolver rather than guessed.
//
// RULE (ARCHITECTURE.md, "js/core/contracts.js"): an altitude, downrange or
// orbit mission's `requiresNode` is the GENERATOR SET of the cheapest
// prereq-valid node set that reaches its requirement -- the set's nodes
// minus those already implied by another member's prerequisite chain, so a
// locked contract reports each missing purchase once. The board therefore
// offers a rung exactly when the player has bought the documented ladder
// path to it (js/data/tree.js's LADDER notes), never a rung the vehicle
// cannot fly along that path.
//
// This file computes that. For every prereq-valid set of TRAJECTORY-
// AFFECTING nodes (a node whose effects touch anything but reliability,
// guidanceReliability, restarts, nav, docking, rcs or dockBonus -- those
// never move the vehicle), it flies the derived vehicle at full fuel with
// reliability forced to 1 across the turn range and records the best
// altitude (vertical), downrange and periapsis it reaches. From that table
// it reports, per mission:
//
//   gate        the rule's answer, what js/data/missions.js carries
//   supersets   prereq-valid sets that satisfy the gate
//   failing     supersets that still fall short -- a node that makes the
//               vehicle worse for the shape (the stage 2 high-flow injector
//               on an orbit contract, the top-stage reserve tank before the
//               lighter fairing). Data cannot express "not this node", so
//               these are documented at the mission and pinned by test.
//   hidden      reaching sets the gate does not admit: a different path to
//               the same capability. The ladder tab still names the
//               missing purchase, so the player is pointed at the path.
//   necessary   nodes no reaching set is without, for the report only
//
// test/data.test.js imports deriveGates and asserts every mission's
// requiresNode is exactly its gate, and that every failing set carries a
// node the mission's note names as harmful.
//
//   node tools/gates.mjs            full report
//   node tools/gates.mjs --steps 11 coarser turn sweep (faster, for a look)

import { pathToFileURL } from 'node:url';
import { makeRng } from '../js/core/rng.js';
import { nodes } from '../js/data/tree.js';
import { missions } from '../js/data/missions.js';
import { loadTree, collectEffects } from '../js/core/tree.js';
import { buildVehicle } from '../js/core/vehicle.js';
import { resolveLaunch } from '../js/core/resolver.js';
import { baseVehicle } from '../js/data/components.js';

export const MAX_TIER = 3;
const INERT = /reliability|restarts|^nav$|^docking$|^rcs$|^dockBonus$/;

const tree = loadTree(nodes);
const byId = new Map(nodes.map((n) => [n.id, n]));

function trajectoryNode(n) {
  return (n.effects ?? []).some((e) => e.addStage !== undefined || !INERT.test(e.stat ?? ''));
}
export const trajectoryNodes = nodes.filter((n) => (n.tier ?? 1) <= MAX_TIER && trajectoryNode(n)).map((n) => n.id);
export const inertNodes = nodes.filter((n) => (n.tier ?? 1) <= MAX_TIER && !trajectoryNode(n)).map((n) => n.id);

// An inert prerequisite changes nothing in flight, so it is treated as owned
// for free -- but ITS prerequisites still have to hold (prop-13 needs
// prop-10, which needs prop-9: no third stage, no reserve tank on it).
export function satisfied(id, owned) {
  if (owned.includes(id)) return true;
  if (!inertNodes.includes(id)) return false;
  return (byId.get(id).requires ?? []).every((r) => satisfied(r, owned));
}
function valid(owned) {
  return owned.every((id) => (byId.get(id).requires ?? []).every((r) => satisfied(r, owned)));
}

function force(v) {
  return { ...v, guidanceReliability: 1, stages: v.stages.map((s) => ({ ...s, reliability: 1 })) };
}

const ORBIT_PROBE = { id: 'probe', profile: 'orbit', requirement: { orbit: { periapsis: 1 } } };
const ALT_PROBE = { id: 'probe', profile: 'sounding', requirement: { altitude: 1 } };

export function metricsOf(owned, steps) {
  const v = force(buildVehicle(baseVehicle, collectEffects(tree, { owned })));
  const vert = resolveLaunch(v, ALT_PROBE, { fuelFraction: 1, turn: 0, vertical: true }, makeRng(1), {});
  let downrange = 0;
  let periapsis = -Infinity;
  if (owned.includes('guide-1')) {
    for (let i = 0; i < steps; i += 1) {
      const o = resolveLaunch(v, ORBIT_PROBE, { fuelFraction: 1, turn: i / (steps - 1) }, makeRng(1), {});
      downrange = Math.max(downrange, o.maxDownrange ?? 0);
      periapsis = Math.max(periapsis, o.periapsis ?? -Infinity);
    }
  }
  return { altitude: vert.maxAltitude ?? 0, downrange, periapsis };
}

export function meets(m, req) {
  if (req.altitude !== undefined) return m.altitude >= req.altitude;
  if (req.downrange !== undefined) return m.downrange >= req.downrange;
  if (req.orbit !== undefined) return m.periapsis >= req.orbit.periapsis;
  return null;
}

export function closure(ids) {
  const seen = new Set();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of byId.get(id).requires ?? []) stack.push(r);
  }
  return seen;
}

// Nodes of `set` not implied by another member's prerequisite chain.
export function generators(set) {
  return set.filter((id) => !set.some((other) => other !== id && closure([other]).has(id)));
}

/** Every prereq-valid set of trajectory nodes, with its metrics and cost. */
export function buildTable(steps = 21) {
  const sets = [];
  (function grow(idx, owned) {
    if (idx === trajectoryNodes.length) {
      if (valid(owned)) sets.push(owned);
      return;
    }
    grow(idx + 1, owned);
    grow(idx + 1, [...owned, trajectoryNodes[idx]]);
  })(0, []);
  return sets.map((owned) => ({
    owned,
    m: metricsOf(owned, steps),
    cost: owned.reduce((s, id) => s + (byId.get(id).cost.funds ?? 0), 0),
  }));
}

/**
 * The rule applied to one mission against a table: null for a rendezvous /
 * dock mission (the orbital sequence's own checks gate those), otherwise
 * { gate, cheapest, supersets, failing, hidden, necessary, reaching }.
 */
export function deriveGate(mission, table) {
  const req = mission.requirement;
  if (meets(table[0].m, req) === null) return null;
  const tierSets = table.filter((row) => row.owned.every((id) => (byId.get(id).tier ?? 1) <= (mission.tier ?? 1)));
  const reaching = tierSets.filter((row) => meets(row.m, req));
  if (reaching.length === 0) return { gate: null, reaching, tierSets };
  const cheapest = [...reaching].sort((a, b) => a.cost - b.cost)[0];
  const gate = generators(cheapest.owned);
  const gateClosure = closure(gate);
  const supersets = tierSets.filter((row) => [...gateClosure].every((id) => satisfied(id, row.owned)));
  const failing = supersets.filter((row) => !meets(row.m, req));
  const hidden = reaching.filter((row) => !supersets.includes(row));
  const necessary = trajectoryNodes.filter((id) => reaching.every((row) => row.owned.includes(id)));
  return { gate, gateClosure, cheapest, supersets, failing, hidden, necessary, reaching, tierSets };
}

export function deriveGates(steps = 21) {
  const table = buildTable(steps);
  return { table, gates: new Map(missions.map((m) => [m.id, deriveGate(m, table)])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const STEPS = Number(process.argv[process.argv.indexOf('--steps') + 1]) || 21;
  console.log(`trajectory nodes (${trajectoryNodes.length}): ${trajectoryNodes.join(', ')}`);
  console.log(`inert nodes (${inertNodes.length}): ${inertNodes.join(', ')}`);
  const t0 = Date.now();
  const { table, gates } = deriveGates(STEPS);
  console.log(`${table.length} prereq-valid sets probed at ${STEPS} turn steps in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  for (const mission of missions) {
    const g = gates.get(mission.id);
    if (g === null) continue;
    console.log(`== ${mission.id} (tier ${mission.tier ?? 1}) ${JSON.stringify(mission.requirement)}${mission.floor ? ' [floor]' : ''}`);
    if (!g.gate) {
      console.log('   UNREACHABLE by any set up to its tier\n');
      continue;
    }
    console.log(`   reaching sets: ${g.reaching.length} of ${g.tierSets.length}; necessary [${g.necessary.join(', ')}]`);
    console.log(`   cheapest reaching set: ${g.cheapest.cost} funds [${g.cheapest.owned.join(', ')}]`);
    console.log(`   gate: [${g.gate.join(', ')}] -> ${g.supersets.length} supersets, ${g.failing.length} fall short, ${g.hidden.length} reaching sets hidden`);
    for (const row of g.failing) {
      console.log(`      falls short with [${row.owned.filter((id) => !g.gateClosure.has(id)).join(', ')}] added -> periapsis ${Math.round(row.m.periapsis)}, downrange ${Math.round(row.m.downrange)}, altitude ${Math.round(row.m.altitude)}`);
    }
    for (const row of g.hidden.slice(0, 3)) {
      console.log(`      hidden: [${row.owned.filter((id) => !g.gateClosure.has(id)).join(', ')}] reaches without the gate (${row.cost} funds)`);
    }
    const existing = mission.requiresNode === undefined ? [] : [].concat(mission.requiresNode);
    const same = existing.length === g.gate.length && g.gate.every((id) => existing.includes(id));
    console.log(`   current requiresNode: [${existing.join(', ')}] ${same ? 'OK' : '<-- DIFFERS'}\n`);
  }
}
