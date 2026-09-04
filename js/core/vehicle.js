// Vehicle stat model and delta-v. Pure: no DOM, no globals, no randomness.
//
// A vehicle is a stat block derived from the tech tree, never assembled by
// the player (ARCHITECTURE.md §js/core/vehicle.js):
//
//   Stage   { dryMass, propMass, thrust, isp, reliability }  kg, kg, N, s, 0..1
//   Vehicle { stages: Stage[], payloadMass, dragArea, dragCoeff }
//
// stages[0] is the bottom stage — the one that lifts off — and each stage
// carries every stage above it plus the payload.

/** Standard gravity, m/s^2. The Isp -> exhaust-velocity constant. */
export const G0 = 9.80665;

/**
 * Structural deep copy of plain objects, arrays and primitives.
 * Deliberately hand-rolled rather than structuredClone: keeps this module
 * dependent on nothing but the language, which is the point of js/core.
 */
function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
    return out;
  }
  return value;
}

/**
 * Resolve a dotted stat path to its container and key, e.g.
 * 'stages.0.thrust' -> { container: vehicle.stages[0], key: 'thrust' }.
 * Throws on anything that does not name an existing numeric field.
 */
function resolveStatPath(vehicle, path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`buildVehicle: effect has an invalid stat path: ${JSON.stringify(path)}`);
  }
  const parts = path.split('.');
  let container = vehicle;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = container?.[key];
    if (next === undefined || next === null || typeof next !== 'object') {
      throw new Error(`buildVehicle: unknown stat path '${path}' (failed at '${key}')`);
    }
    container = next;
  }
  const key = parts[parts.length - 1];
  if (typeof container?.[key] !== 'number') {
    throw new Error(`buildVehicle: unknown stat path '${path}' (no number at '${key}')`);
  }
  return { container, key };
}

/**
 * The fields the Vehicle shape names itself. Everything else that is a
 * top-level number on the base components is copied through as an extra stat
 * (see buildVehicle). The CAPABILITY_STATS below are deliberately NOT in this
 * set: they are seeded with a default of 0 and then overwritten by the base's
 * own value when the base supplies one.
 */
const NAMED_VEHICLE_FIELDS = new Set(['stages', 'payloadMass', 'dragArea', 'dragCoeff']);

/**
 * Capability stats every vehicle carries, defaulting to 0.
 *
 * They are seeded here rather than left to the base components because the TREE
 * is what turns them on, with `{ stat: 'restarts', op: 'set', value: 1 }` — and
 * an effect can only target a stat that already exists (an unknown path throws,
 * which is what catches typos). Seeding them means such a node works against
 * any base, a hand-written fixture needs no boilerplate, and the resolver can
 * read `vehicle.nav` without a guard.
 *
 *   guidance   0/1   can steer at all (phase 1: the gravity turn)
 *   restarts   int   upper-stage relights available for the orbital phase
 *   nav        0..3  rendezvous navigation quality
 *   docking    0/1   docking adapter
 *   rcs        0/1   fine approach thrusters
 *   dockBonus  0..1  added to the docking roll's threshold
 *   escape     int   stage abort coverage: how many interstages, counted
 *                    from the bottom, let the stack above separate from a
 *                    stage that fails under it and fly on (resolver.js)
 *   lander     0/1   a lander: without one the lunar sequence cannot descend
 *   shield     0/1   a heat shield: without one it cannot come home
 *   landerBonus 0..1 added to the landing roll's threshold
 *
 * The last three are phase 3's, and are the same kind of thing the phase 2 ones
 * are: a structure node sets `lander` and `shield`, a reliability node adds
 * `landerBonus`, and js/core/resolver.js reads all three off the vehicle with no
 * guard. Seeding them here is what lets those nodes exist at all — an effect can
 * only target a stat that already exists.
 *
 * Anything else a base declares as a top-level number still comes through as an
 * extra stat, so adding a further stat stays a data change (phase 1's contract).
 */
const CAPABILITY_STATS = [
  'guidance', 'restarts', 'nav', 'docking', 'rcs', 'dockBonus', 'escape',
  'lander', 'shield', 'landerBonus',
];

const REQUIRED_STAGE_FIELDS = ['dryMass', 'propMass', 'thrust', 'isp', 'reliability'];

function normalizeStage(stage, where) {
  if (!stage || typeof stage !== 'object') {
    throw new Error(`buildVehicle: ${where} is not a stage object`);
  }
  const out = {};
  for (const field of REQUIRED_STAGE_FIELDS) {
    const v = stage[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`buildVehicle: ${where} is missing a numeric '${field}'`);
    }
    out[field] = v;
  }
  return out;
}

/**
 * Build a Vehicle from base components plus the tree's effects.
 *
 * The base is deep-copied first, so neither `baseComponents` nor any effect
 * object is mutated and two builds from the same base never share structure.
 * Effects are applied in the order given — order matters for mul/add mixes,
 * and `addStage` effects must therefore come before any effect targeting the
 * stage they add.
 *
 * Effect shapes:
 *   { stat: 'stages.0.thrust', op: 'add' | 'mul' | 'set', value: number }
 *   { stat: 'payloadMass',     op: 'set', value: number }
 *   { stat: 'guidance',        op: 'set', value: 1 }   // see EXTRA STATS below
 *   { addStage: { dryMass, propMass, thrust, isp, reliability } }
 *
 * EXTRA STATS (phase 1). Beyond the four fields the Vehicle shape names, any
 * further TOP-LEVEL numeric field on `baseComponents` is carried through onto
 * the built vehicle, and `set` / `add` / `mul` effects can target it by name.
 * That is what makes `vehicle.guidance` (ARCHITECTURE.md, phase 1) a pure data
 * change: `js/data/components.js` adds `guidance: 0` to the starter and a tree
 * node sets it to 1, with no edit here. Non-numeric extras are ignored — a
 * vehicle is a stat block, and only numbers are stats.
 *
 * The CAPABILITY_STATS (`guidance`, phase 2's `restarts`, `nav`, `docking`,
 * `rcs`, `dockBonus`, and `escape`, and phase 3's `lander`, `shield` and
 * `landerBonus`) are always present and default to 0, so the resolver can
 * read them on a hand-written phase 0 fixture without a guard, and a tree node
 * can `set` or `add` one on a base that never declared it.
 *
 * @param {object} baseComponents a Vehicle-shaped object (js/data/components.js)
 * @param {Array<object>} [effects=[]]
 * @returns {object} Vehicle
 */
export function buildVehicle(baseComponents, effects = []) {
  if (!baseComponents || typeof baseComponents !== 'object') {
    throw new Error('buildVehicle: baseComponents must be a Vehicle-shaped object');
  }
  const base = deepCopy(baseComponents);
  const vehicle = {
    stages: (base.stages ?? []).map((s, i) => normalizeStage(s, `stages.${i}`)),
    payloadMass: base.payloadMass ?? 0,
    dragArea: base.dragArea ?? 0,
    dragCoeff: base.dragCoeff ?? 0,
  };
  for (const stat of CAPABILITY_STATS) vehicle[stat] = 0;
  for (const key of Object.keys(base)) {
    if (NAMED_VEHICLE_FIELDS.has(key)) continue;
    const value = base[key];
    if (typeof value === 'number' && Number.isFinite(value)) vehicle[key] = value;
  }

  const list = effects ?? [];
  if (!Array.isArray(list)) throw new Error('buildVehicle: effects must be an array');

  for (let i = 0; i < list.length; i += 1) {
    const effect = list[i];
    if (!effect || typeof effect !== 'object') {
      throw new Error(`buildVehicle: effect ${i} is not an object`);
    }

    if (effect.addStage !== undefined) {
      vehicle.stages.push(normalizeStage(effect.addStage, `effect ${i} addStage`));
      continue;
    }

    const { stat, op, value } = effect;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`buildVehicle: effect ${i} ('${stat}') has a non-numeric value`);
    }
    const { container, key } = resolveStatPath(vehicle, stat);
    switch (op) {
      case 'add': container[key] += value; break;
      case 'mul': container[key] *= value; break;
      case 'set': container[key] = value; break;
      default:
        throw new Error(`buildVehicle: effect ${i} ('${stat}') has unknown op '${op}'`);
    }
  }

  return vehicle;
}

/**
 * Mass sitting on top of stage `i`: every stage above it, plus the payload.
 *
 * `fuelFraction` scales the propellant of the stages above, because a loadout
 * fuel fraction is a decision about how much propellant the whole vehicle is
 * loaded with — the upper stages fly with the same fraction, so stage i has
 * to lift only that much of their propellant. (ARCHITECTURE.md writes this
 * helper as `stackMassAbove(vehicle, i)`; the third parameter is optional and
 * defaults to a fully fuelled stack, so that signature still holds.)
 *
 * @param {object} vehicle
 * @param {number} i stage index, 0 = bottom
 * @param {number} [fuelFraction=1]
 * @returns {number} kg
 */
export function stackMassAbove(vehicle, i, fuelFraction = 1) {
  let mass = vehicle.payloadMass ?? 0;
  for (let j = i + 1; j < vehicle.stages.length; j += 1) {
    const stage = vehicle.stages[j];
    mass += stage.dryMass + stage.propMass * fuelFraction;
  }
  return mass;
}

/**
 * Ideal delta-v of stage `i` — Tsiolkovsky, with the stage carrying every
 * stage above it plus the payload:
 *
 *   dv = isp * g0 * ln(m0 / mf)
 *   m0 = above + dryMass_i + propMass_i * fuelFraction
 *   mf = above + dryMass_i
 *
 * @param {object} vehicle
 * @param {number} i stage index, 0 = bottom
 * @param {number} [fuelFraction=1] 0..1, scales usable propellant
 * @returns {number} m/s
 */
export function stageDeltaV(vehicle, i, fuelFraction = 1) {
  const stage = vehicle.stages?.[i];
  if (!stage) throw new Error(`stageDeltaV: no stage ${i}`);
  const above = stackMassAbove(vehicle, i, fuelFraction);
  const mf = above + stage.dryMass;
  const m0 = mf + stage.propMass * fuelFraction;
  if (mf <= 0 || m0 <= mf) return 0;
  return stage.isp * G0 * Math.log(m0 / mf);
}

/**
 * Sum of every stage's ideal delta-v.
 *
 * @param {object} vehicle
 * @param {number} [fuelFraction=1]
 * @returns {number} m/s
 */
export function totalDeltaV(vehicle, fuelFraction = 1) {
  let total = 0;
  for (let i = 0; i < (vehicle.stages?.length ?? 0); i += 1) {
    total += stageDeltaV(vehicle, i, fuelFraction);
  }
  return total;
}
