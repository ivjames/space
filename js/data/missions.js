// Tier 1 mission templates and tier goals. Profiles are all 'sounding'
// (DESIGN.md §9 lists 'sounding' first, tier order); tier 2 introduces
// 'orbit' and its own velocity-shaped requirement.
//
// Payouts scale with altitude requirement; repGain/repLoss scale gently
// with risk (a harder mission costs more reputation on a miss and pays
// more reputation on a hit). `sound-1` is the floor contract: it's always
// offered and always affordable to attempt (DESIGN.md §7), so it has no
// `minReputation` gate and the lowest requirement in the tier — the
// starter vehicle clears it with margin (see components.js).
//
// `minReputation` gates the harder, better-paying contracts so early
// reputation losses have a real consequence (a mission drops out of the
// pool) without being able to lock the player out of the floor contract,
// which never checks reputation.
//
// ALTITUDE LADDER. Sized against the real resolver (`node tools/balance.mjs`
// drives resolveLaunch directly, reliability forced to 1), not the ideal
// delta-v shortcut — see js/data/components.js and js/data/tree.js for why
// that distinction is the whole point. Each threshold lines up with the
// cheapest prereq-valid tree.js node set that reaches it, so the ladder
// tracks real purchases rather than an arbitrary altitude curve:
//
//   sound-1 (floor)   10 km ->       0 funds, 0 nodes  (the starter alone)
//   sound-2           25 km ->   2 600 funds, 2 nodes  (struct-1, struct-2)
//   sound-3           35 km ->   3 100 funds, 3 nodes  (+ prop-1)
//   sound-4           60 km ->  11 100 funds, 6 nodes  (+ prop-2, prop-3, struct-3)
//   sound-5          100 km ->  16 100 funds, 7 nodes  (+ prop-4)
//
// Node-count deltas between consecutive rungs are 2, 1, 3, 1 — each step
// needs one to three more purchases than the last, never a jump the player
// can't see coming. `sound-5`'s cheapest set (16 100 funds, 7 of 12 nodes,
// 53% of the full tree's cost) leaves struct-4 (the second stage) and the
// whole reliability branch as deliberate headroom past the goal, not a
// requirement to reach it.
export const missions = [
  {
    id: 'sound-1',
    tier: 1,
    name: 'Sounding test',
    profile: 'sounding',
    requirement: { altitude: 10000 },
    payout: 400,
    repGain: 1,
    repLoss: 0,
    floor: true,
  },
  {
    id: 'sound-2',
    tier: 1,
    name: 'Upper-atmosphere sample',
    profile: 'sounding',
    requirement: { altitude: 25000 },
    payout: 700,
    repGain: 1,
    repLoss: 1,
  },
  {
    id: 'sound-3',
    tier: 1,
    name: 'Mesosphere probe',
    profile: 'sounding',
    requirement: { altitude: 35000 },
    payout: 1100,
    repGain: 2,
    repLoss: 1,
    minReputation: 10,
  },
  {
    id: 'sound-4',
    tier: 1,
    name: 'Thermosphere survey',
    profile: 'sounding',
    requirement: { altitude: 60000 },
    payout: 1600,
    repGain: 2,
    repLoss: 2,
    minReputation: 20,
  },
  {
    id: 'sound-5',
    tier: 1,
    name: 'Karman line delivery',
    profile: 'sounding',
    requirement: { altitude: 100000 },
    payout: 2200,
    repGain: 3,
    repLoss: 2,
    minReputation: 30,
  },

  // -----------------------------------------------------------------------
  // TIER 2 — orbit. PROVISIONAL, same caveat as js/data/tree.js: sized to a
  // plausible ladder shape, not against the real resolver (still being
  // rewritten alongside this file — see ARCHITECTURE.md's "Phase 1 — tier
  // 2, orbit"). Re-tune thresholds against `node tools/balance.mjs` once it
  // lands, the same way the tier 1 altitude ladder above was.
  //
  // Five rungs, each a different requirement shape (ARCHITECTURE.md: a
  // mission has exactly one of `{ altitude }`, `{ downrange }`,
  // `{ orbit: { periapsis } }`):
  //
  //   orbit-down-1   downrange 150 km   the turn matters before orbit does:
  //                                     a lazy or absent turn still impacts
  //                                     well short of this
  //   orbit-down-2   downrange 400 km   a better turn, or partial guidance
  //   orbit-apogee   altitude 300 km    high-apogee rung: a strong vertical
  //                                     (or shallow-turn) flight, no orbit
  //                                     quality required
  //   orbit-low      periapsis 90 km    low-orbit rung: above
  //                                     ORBIT_MIN_ALT (80 km, resolver.js)
  //                                     but short of the tier goal
  //   orbit-goal     periapsis 100 km   the tier goal itself, offered as a
  //                                     contract too (matches tierGoals[2])
  //
  // Payouts are well above tier 1's (max 2 200): 3 000-14 000. repGain/
  // repLoss scale up to match (tier 1 tops out at 3/2). minReputation gates
  // climb through the range reputation can actually reach by tier 2 (tier 1
  // gates top out at 30) so reputation keeps mattering into the new tier,
  // per DESIGN.md.
  {
    id: 'orbit-down-1',
    tier: 2,
    name: 'Downrange telemetry hop',
    profile: 'orbit',
    requirement: { downrange: 150000 },
    payout: 3000,
    repGain: 3,
    repLoss: 2,
    minReputation: 20,
  },
  {
    id: 'orbit-down-2',
    tier: 2,
    name: 'Extended downrange hop',
    profile: 'orbit',
    requirement: { downrange: 400000 },
    payout: 4500,
    repGain: 3,
    repLoss: 3,
    minReputation: 35,
  },
  {
    id: 'orbit-apogee',
    tier: 2,
    name: 'High-apogee survey',
    profile: 'orbit',
    requirement: { altitude: 300000 },
    payout: 5500,
    repGain: 4,
    repLoss: 3,
    minReputation: 45,
  },
  {
    id: 'orbit-low',
    tier: 2,
    name: 'Low-orbit insertion',
    profile: 'orbit',
    requirement: { orbit: { periapsis: 90000 } },
    payout: 8000,
    repGain: 5,
    repLoss: 4,
    minReputation: 60,
  },
  {
    id: 'orbit-goal',
    tier: 2,
    name: 'Reach orbit',
    profile: 'orbit',
    requirement: { orbit: { periapsis: 100000 } },
    payout: 12000,
    repGain: 6,
    repLoss: 4,
    minReputation: 75,
  },
];

export const tierGoals = {
  1: { requirement: { altitude: 100000 }, name: 'Reach 100 km' },
  2: { requirement: { orbit: { periapsis: 100000 } }, name: 'Reach orbit' },
};
