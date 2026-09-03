// Base vehicle stats before any tree effects are applied. This is the
// vehicle a brand-new save flies: `state.owned` is empty, so
// `buildVehicle(baseVehicle, [])` (no effects) is exactly what the player
// launches on their very first flight.
//
// Sizing target (see ARCHITECTURE.md / task brief): flying straight up, the
// starter should clear the tier 1 floor contract (10 km) with margin —
// roughly 1.3x-1.5x the floor altitude at fuelFraction 1.0, so a loadout of
// fuelFraction 0.8 still clears it — but fall well short of the tier 1 goal
// (100 km), so the tree (js/data/tree.js) has real work to do.
//
// These numbers are sized against the REAL resolver (js/core/resolver.js),
// not the ideal-delta-v shortcut: a straight-up ascent pays gravity losses
// for the whole burn (a lowish-TWR sounding rocket spends ~20-30 s under
// thrust, losing roughly g0 * burnTime of delta-v to gravity alone) plus
// drag, which is far more than the resolver's `LOSS_ALLOWANCE` (15%, a game
// number quoted for the "short by X m/s" readout, not a physical loss
// model — see resolver.js's doc comment on that constant). Sizing content
// from the 15% figure instead of the simulation is exactly the bug this
// file used to have: a nominal ~28 km ideal-dv estimate flew as ~10.4 km in
// the actual sim. So these values are verified with `node tools/balance.mjs`
// (which drives `resolveLaunch` directly, reliability forced to 1 for
// determinism) rather than hand-derived from Tsiolkovsky alone.
//
// Delta-v budget, Tsiolkovsky: dv = isp * g0 * ln(m0 / m1), g0 = 9.80665.
//
//   dry mass   40 kg
//   prop mass  30 kg
//   payload     5 kg
//   isp       200 s
//
//   m0 = dry + prop + payload = 75 kg
//   m1 = dry + payload        = 45 kg
//   dv = 200 * 9.80665 * ln(75/45) = 200 * 9.80665 * 0.5108 ≈ 1001.9 m/s
//
// `node tools/balance.mjs` reports the resolver's actual max altitude for
// this vehicle: ~13 996 m at fuelFraction 1.0 (~1.40x the 10 km floor) and
// ~10 521 m at fuelFraction 0.8 (still clears the floor, ~5% margin) —
// comfortably clear of the floor, nowhere near the 100 km tier goal.
//
// Thrust-to-weight at liftoff (full prop + payload, before any burn):
//
//   weight = m0 * g0 = 75 * 9.80665 ≈ 735.5 N
//   TWR    = 1800 / 735.5 ≈ 2.45
//
// A small sounding-rocket engine: modest chemical isp, TWR comfortably over
// 2 so it clears the pad with room to spare and most of its delta-v isn't
// eaten by gravity losses during the burn (real amateur/university sounding
// rockets sit in roughly this TWR range).
export const baseVehicle = {
  stages: [
    {
      dryMass: 40, // kg, airframe + engine + avionics, empty
      propMass: 30, // kg, propellant loaded
      thrust: 1800, // N, sea-level thrust
      isp: 200, // s, specific impulse
      reliability: 0.85, // 0..1, ignition + burn roll base rate
    },
  ],
  payloadMass: 5, // kg, the contract's payload
  dragArea: 0.03, // m^2, reference cross-section (~0.2 m body diameter)
  dragCoeff: 0.5, // dimensionless, blunt-ish sounding-rocket nose/body
  // Phase 1: 0..N, integer. 0 = no guidance, flies vertical regardless of
  // the loadout's `turn`. The tier 2 guidance branch's first node sets this
  // to 1 via { stat: 'guidance', op: 'set', value: 1 } (js/data/tree.js);
  // buildVehicle (js/core/vehicle.js) must accept unknown top-level numeric
  // stats from baseComponents for that effect to resolve.
  guidance: 0,
  // Phase 2 (ARCHITECTURE.md, "Phase 2 -- tier 3, orbital maneuvering"):
  // five more integer stats, all 0 on the starter, all set/raised by tier 3
  // tree nodes (js/data/tree.js) and read by the resolver's orbital phase
  // (js/core/resolver.js, landing concurrently with this file):
  restarts: 0, // upper-stage relights available
  nav: 0, // 0..3, rendezvous navigation quality
  docking: 0, // 0/1, docking adapter present
  rcs: 0, // 0/1, fine reaction-control thrusters for the final approach
  dockBonus: 0, // added to the docking reliability roll threshold, capped
                // at 0.99 by the resolver (js/data/tree.js's reliability
                // branch: docking rehearsal)
  // Stage abort coverage (js/data/tree.js's reliability branch, tier 2:
  // the abort systems). 0 = a failed stage takes the whole stack with it.
  // N = a failure of any of the bottom N stages, in flight, lets the stack
  // above separate clear and light its own engine (js/core/resolver.js).
  escape: 0,
};
