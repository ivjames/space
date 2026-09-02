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
export const missions = [
  {
    id: 'sound-1',
    tier: 1,
    name: 'Sounding test',
    profile: 'sounding',
    requirement: { altitude: 20000 },
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
    requirement: { altitude: 40000 },
    payout: 700,
    repGain: 1,
    repLoss: 1,
  },
  {
    id: 'sound-3',
    tier: 1,
    name: 'Mesosphere probe',
    profile: 'sounding',
    requirement: { altitude: 60000 },
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
    requirement: { altitude: 80000 },
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
];

export const tierGoals = {
  1: { requirement: { altitude: 100000 }, name: 'Reach 100 km' },
};
