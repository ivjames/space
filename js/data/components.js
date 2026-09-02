// Base vehicle stats before any tree effects are applied. This is the
// vehicle a brand-new save flies: `state.owned` is empty, so
// `buildVehicle(baseVehicle, [])` (no effects) is exactly what the player
// launches on their very first flight.
//
// Sizing target (set by the implementer, see ARCHITECTURE.md / task brief):
// flying straight up, the starter should clear the tier 1 floor contract
// (20 km) comfortably but fall well short of the tier 1 goal (100 km), so
// the tree (js/data/tree.js) has real work to do.
//
// Delta-v budget, Tsiolkovsky: dv = isp * g0 * ln(m0 / m1), g0 = 9.80665.
//
//   dry mass   40 kg
//   prop mass  30 kg
//   payload     5 kg
//   isp       170 s
//
//   m0 = dry + prop + payload = 75 kg
//   m1 = dry + payload        = 45 kg
//   dv = 170 * 9.80665 * ln(75/45) = 170 * 9.80665 * 0.5108 ≈ 851.6 m/s
//
// Altitude reached flying straight up (ideal, then derated for the fixed
// gravity/drag loss allowance the resolver documents, ~15%):
//
//   effective dv  ≈ 851.6 / 1.15 ≈ 740.5 m/s
//   altitude      = effective_dv^2 / (2 * 9.80665) ≈ 27 950 m  (~28 km)
//
// That lands in the 20-30 km target band: clears the 20 km floor contract
// with margin, nowhere near the 100 km tier goal (which needs ~1600 m/s,
// see js/data/tree.js for the same arithmetic against the full tree).
//
// Thrust-to-weight at liftoff (full prop + payload, before any burn):
//
//   weight = m0 * g0 = 75 * 9.80665 ≈ 735.5 N
//   TWR    = 1500 / 735.5 ≈ 2.04
//
// A small sounding-rocket engine: modest chemical isp, TWR a bit over 2 so
// it clears the pad with room to spare (real amateur/university sounding
// rockets sit in roughly this range).
export const baseVehicle = {
  stages: [
    {
      dryMass: 40, // kg, airframe + engine + avionics, empty
      propMass: 30, // kg, propellant loaded
      thrust: 1500, // N, sea-level thrust
      isp: 170, // s, specific impulse
      reliability: 0.85, // 0..1, ignition + burn roll base rate
    },
  ],
  payloadMass: 5, // kg, the contract's payload
  dragArea: 0.03, // m^2, reference cross-section (~0.2 m body diameter)
  dragCoeff: 0.5, // dimensionless, blunt-ish sounding-rocket nose/body
};
