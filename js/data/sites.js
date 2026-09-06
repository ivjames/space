// The candidate landing sites, and the two hidden numbers per resource per
// site (DESIGN.md §8). Data only — no logic, no rng, no state. See
// ARCHITECTURE.md, "Phase 3b — the economy, whole".
//
// WHAT IS TRUE, AND WHAT THE PLAYER KNOWS, ARE DIFFERENT THINGS AND LIVE IN
// DIFFERENT PLACES. This file is what is TRUE: a site's plentitude and quality
// are fixed properties of the ground, written down here, identical in every
// save. What the player KNOWS is `state.sites[id].surveyed`, a boolean, and it
// is the only part that is persisted.
//
// The alternative — rolling a site's numbers at survey time from the game's
// rng — was rejected for two reasons. A survey is meant to REVEAL information
// the world already has, and a number that comes into existence at the moment
// you look at it is not information, it is a slot machine with a delta-v cost.
// And it would make the save the source of truth for the world rather than for
// the player's knowledge of it, so a lost save would lose the map as well as
// the progress.
//
// PLENTITUDE AND QUALITY ARE NOT THE SAME NUMBER AND DO NOT DO THE SAME JOB
// (DESIGN.md §8, and js/core/base.js is where they bite):
//
//   plentitude   scales EXTRACTION — how much comes out of the ground per
//                hour, at a given extractor level.
//   quality      scales PROCESSING — how much fuel and oxidizer a unit of
//                water becomes, at a given processor level.
//
// So a site can be worth landing on for its water and worth nothing for its
// propellant, or the other way round, and the two numbers cannot be collapsed
// into one "richness" without throwing the decision away. Both are
// multipliers around 1: 1.0 is the reference site the rates in base.js are
// quoted against, so a rate table and a site table can be read together.
//
// METALS HAVE A PLENTITUDE AND NO QUALITY, and the asymmetry is the point:
// nothing processes metals. They come out of the ground and are spent on the
// ground, building the next piece of equipment without launching it, which is
// the payoff DESIGN.md §8 promises the metals branch. A `quality` on metals
// would be a number with nothing to multiply.

/**
 * The sites, in the order the base tab lists them.
 *
 * FOUR, AND THEY DIFFER ENOUGH TO BE A DECISION. A survey that always came
 * back with good news would be a cutscene with a delta-v cost, so the set is
 * built to span the interesting cases rather than to be uniformly attractive:
 *
 *   - one rich in water and poor in metals (propellant now, no growth),
 *   - its mirror (growth now, propellant later),
 *   - one middling in both, which is the safe answer and the one a player who
 *     does not want to think can take,
 *   - one poor in both, which exists so that a survey can come back with bad
 *     news and so the decision has a wrong answer.
 *
 * The last one is not a trap: it is surveyable for the same cost as the
 * others, and finding out is what the survey is for. A player who lands there
 * anyway has made a mistake the game told them about.
 */
export const SITES = [
  {
    id: 'mare-tranquil',
    body: 'moon',
    name: 'Mare Tranquillitatis',
    // The middling site, and deliberately the first one listed: it is the
    // reference every other site's numbers read against, and it is where a
    // player who surveys once and lands immediately ends up. Nothing about it
    // is a mistake.
    resources: {
      water: { plentitude: 1.0, quality: 1.0 },
      metals: { plentitude: 1.0 },
    },
  },
  {
    id: 'shackleton-rim',
    body: 'moon',
    name: 'Shackleton Rim',
    // Water-rich and metal-poor: a permanently shadowed polar crater is where
    // lunar water actually is, and it is bare rock rather than mare basalt.
    // The propellant site, and the one that makes hauling pay soonest.
    resources: {
      water: { plentitude: 1.7, quality: 1.25 },
      metals: { plentitude: 0.5 },
    },
  },
  {
    id: 'aristarchus',
    body: 'moon',
    name: 'Aristarchus Plateau',
    // The mirror: metal-rich, water-poor. Slower to propellant, faster to the
    // equipment levels that make everything else cheaper, because metals are
    // what the second level of every type is priced in.
    resources: {
      water: { plentitude: 0.55, quality: 0.85 },
      metals: { plentitude: 1.8 },
    },
  },
  {
    id: 'far-side-flats',
    body: 'moon',
    name: 'Far Side Flats',
    // The bad site. Poor in both, and its water is poor QUALITY as well as
    // scarce — the two numbers pulling the same way is what makes it clearly
    // bad rather than a trade-off, which is what a survey needs to be able to
    // tell you. Nothing else in the table is dominated like this.
    resources: {
      water: { plentitude: 0.4, quality: 0.6 },
      metals: { plentitude: 0.45 },
    },
  },
];

/** Site by id, or null. */
export function siteById(id) {
  return SITES.find((s) => s.id === id) ?? null;
}

/** The sites on a body, in table order. */
export function sitesOn(body) {
  return SITES.filter((s) => s.body === body);
}
