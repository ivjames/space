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
  // TIER 2 — orbit. Balanced against the REAL phase 1 resolver via
  // `node tools/balance.mjs` (its GOAL 2/3 reports), the same way the tier
  // 1 altitude ladder above was against phase 0's — not a plausible-looking
  // shape picked ahead of the resolver landing.
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
  // The CUMULATIVE cheapest-reaching-set chain across these five rungs
  // (js/data/tree.js's own LADDER note has the node-by-node story) steps
  // 1, 2, 2, 2, 1 new nodes per rung — every step in ARCHITECTURE.md's
  // "one to three more purchases than the previous" range, in the sensible
  // order the requirement shapes themselves suggest (downrange needs only
  // guidance; apogee needs raw thrust with no turn quality; low orbit and
  // the goal need the third stage, in that order since the tier goal's
  // higher periapsis is what needs prop-9's extra margin on top of
  // orbit-low's prop-8). This is hand-verified against `node
  // tools/balance.mjs`'s GOAL 2 report, not just the independent
  // per-mission heuristic also printed there (which restarts from empty
  // for every mission and can report a smaller set for a later, harder
  // rung — see that report's own NOTE for why the cumulative chain is the
  // one that matters here).
  //
  // Payouts are well above tier 1's (max 2 200): 3 000-14 000. repGain/
  // repLoss scale up to match (tier 1 tops out at 3/2). minReputation gates
  // climb through the range reputation can actually reach by tier 2 (tier 1
  // gates top out at 30) so reputation keeps mattering into the new tier,
  // per DESIGN.md. `node tools/balance.mjs`'s GOAL 3 greedy simulation
  // confirms these gates are reachable in practice, not just numerically:
  // reputation crosses every rung's minReputation several launches before
  // that rung's vehicle becomes affordable, so the gate is never what a
  // greedy player is actually waiting on. The same simulation reaches the
  // tier goal in 36 tier 2 launches — inside the 30-60 target (raising
  // tier 2 NODE COSTS, not payouts, is what moved this up from an earlier
  // pass's 20; see js/data/tree.js's COSTS note).
  //
  // HARDWARE GATE, `requiresNode: 'guide-1'`. Every rung whose requirement
  // the resolver cannot meet without a turn carries it: `pitchProgram`
  // (js/core/resolver.js) returns the identically-vertical program unless
  // `vehicle.guidance >= 1`, and guide-1 (js/data/tree.js) is the only
  // tier 2 node that sets `guidance` at all. A downrange requirement needs
  // the vehicle to go sideways; a periapsis requirement needs a sideways
  // velocity. Before this gate the random draw could put orbit-down-1 on a
  // fresh tier 2 board, where a player with no guidance owned could accept
  // it, fly straight up, and lose reputation on a contract that was never
  // completable -- the rule (js/core/contracts.js, lockReasons) is that
  // hardware a mission cannot be flown without is a gate on the draw, not
  // a surprise after the launch.
  //
  // The gate is about what is IMPOSSIBLE, not what is hard, so the two
  // altitude-shaped tier 2 templates do not carry it. `orbit-entry` is a
  // `sounding` profile (see FILLER, next). `orbit-apogee` is a `profile:
  // 'orbit'` contract, but its 300 km is an altitude shape and, probed
  // against the real resolver, a vehicle with prop-5/6 and struct-4/5 and
  // NO guidance tops out around 620 km straight up -- a player who bought
  // thrust before the flight computer can fly it vertical and win it. Its
  // balanced cheapest set happens to include guide-1 (tree.js's LADDER
  // note walks the cumulative chain), but that is a cost story, the same
  // way sound-5 sits on a tier 1 board before its tree is affordable; it
  // is not a lock.
  //
  // FILLER, `orbit-entry`. A tier 2 player's very first launches have
  // nothing to buy: `guide-1` (11 000) is what the CHEAPEST tier 2 rung
  // needs, and every other tier 2 requirement shape needs guidance too
  // (a `downrange`/`orbit` flight is vertical, and goes nowhere, without
  // it) -- so a player arriving in tier 2 on tier 1's own payouts (2 200
  // at best) faced long runs of identical, ungoverned floor-contract
  // launches with no ladder rung crossed in between -- both right at tier 2
  // entry and again mid-ladder while saving for a pricier node (a 5-launch
  // dry streak measured before this contract existed, saving from
  // `orbit-down-1`'s own set toward the second node it needs). That is a
  // dry streak, not a decision. `orbit-entry` is an `altitude` requirement
  // -- the one shape guidance does not gate -- sized to what the
  // MINIMAL tier 1 goal-reaching set already flies, not the full tier 1
  // tree: `node tools/balance.mjs`'s own tier 1 cheapest-goal-set report
  // gives 117 344 m for that set, and a greedy player owns exactly that
  // set (never the full tree) on arrival in tier 2, so pricing this against
  // the full tree's ~189 800 m would make it unreachable for exactly the
  // player who needs it. 110 000 m sits safely under that with margin, and
  // is still a genuine step up over sound-5's own 100 000 m ceiling.
  // `minReputation: 0` (not undefined, so it still carries a gate the
  // "every tier 2 mission has a minReputation gate" test can read) keeps
  // it offerable immediately, the same "no gate at all in practice" role
  // sound-1 and satellite play entering their own tiers. `filler: true` is
  // a marker only -- it opts the mission OUT of the cumulative ladder
  // tests below (there is no node to buy on top of the previous rung for
  // it to reach; it is not a rung in that sense) without touching any
  // other assertion (payout, requirement shape, minReputation type all
  // still hold).
  {
    id: 'orbit-entry',
    tier: 2,
    name: 'High-altitude survey',
    profile: 'sounding',
    requirement: { altitude: 110000 },
    payout: 5000,
    repGain: 2,
    repLoss: 1,
    minReputation: 0,
    filler: true,
  },
  {
    id: 'orbit-down-1',
    tier: 2,
    name: 'Downrange telemetry hop',
    profile: 'orbit',
    requirement: { downrange: 150000 },
    requiresNode: 'guide-1',
    payout: 6500,
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
    requiresNode: 'guide-1',
    payout: 8500,
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
    payout: 10500,
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
    requiresNode: 'guide-1',
    payout: 13000,
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
    requiresNode: 'guide-1',
    payout: 16000,
    repGain: 6,
    repLoss: 4,
    minReputation: 75,
  },

  // -----------------------------------------------------------------------
  // TIER 3 — orbital maneuvering. ARCHITECTURE.md, "js/data/missions.js —
  // tier 3 ladder": this five-mission set, in this order, balanced against
  // the REAL phase 2 resolver (`node tools/balance.mjs`'s TIER 3 section)
  // the same way tier 1 and tier 2 are balanced against their own resolver
  // phases — not a plausible-looking continuation of tier 2's numbers.
  //
  //   satellite   orbit >= 100 km, deploys a satellite, REPEATABLE — the
  //               tier's income filler (tier 2 had none; tier 3 needs one
  //               because every other rung below gates on an object or a
  //               node that isn't there on day one of the tier). No
  //               minReputation: immediately offerable at tier 3, the same
  //               role sound-1/orbit-down-1 played entering their tiers.
  //               Its periapsis is tierGoals[2]'s own 100 km, DELIBERATELY
  //               not a step above it. On arrival the tier 3 pool holds
  //               exactly two eligible templates (this one and core; the
  //               rest gate on a core in orbit), the board draws two, and
  //               js/core/contracts.js fills from the current tier first,
  //               so every tier 3 board until a core flies is the floor +
  //               satellite + core with no draw to reroll. (core's gate is
  //               40 rep; below it the second slot falls back to a tier 2
  //               or tier 1 template instead, which is more income, not
  //               less -- a player who won tier 2 on orbit-goal's 75 gate
  //               is well past it.) This rung is therefore the ONLY
  //               income on that board, and it has to be flyable by
  //               whatever vehicle just won tier 2. Sized
  //               against the real resolver, not the ideal: over every
  //               prereq-valid tier 2 node set that reaches the tier 2
  //               goal at all, the weakest tops out at 125 978 m periapsis
  //               (best turn, reliability forced to 1), and at 110 km the
  //               turn band is ONE 0.05 notch of the loadout slider for
  //               that set (two for the ladder's own goal set) -- a knife
  //               edge, with the result screen pointing at hardware. At
  //               100 km the weakest set clears it on two consecutive
  //               notches (0.50 and 0.55) and the ladder set on three, and
  //               the turn that won tier 2 wins this by definition.
  //               It sat at 150 km before this: unreachable without the
  //               struct-7/8/10 chain (52 000 funds on top of the ladder's
  //               goal set; the full tier 1 + 2 tree tops out at 145 684
  //               m, so a tier 3 node was needed), which is the SAME chain
  //               core needs -- so it was core's rung with a lower payout,
  //               and the board's only income was the 400-fund floor for
  //               on the order of a hundred launches (130 from the ladder
  //               set with nothing banked; 94 from the greedy simulation's
  //               own arrival state, which already owns struct-7). The
  //               greedy tier 3 simulation in test/data.test.js could not
  //               see any of this: it picks from every mission of tier <=
  //               3 rather than from a drawn board, so it flew tier 2's
  //               orbit-goal for income the real board never offers at
  //               tier 3. test/data.test.js pins the "never above
  //               tierGoals[2]" rule instead.
  //   core        orbit >= 160 km, deploys the (unique) station core —
  //               the prerequisite EVERY other tier 3 rung below needs, via
  //               requiresObject: 'core'. DEVIATES from ARCHITECTURE.md's
  //               200 km: js/data/tree.js's own top-of-tier-3 comment
  //               ("THE ECCENTRICITY TRAP") has the numbers — past roughly
  //               180 km the tree's real capability only clears the
  //               periapsis by flying deep into a near-vertical, wildly
  //               eccentric trajectory (apoapsis in the millions of
  //               metres), which no reserve tank this tree could carry can
  //               ever match back down to a target orbit. 160 km sits in
  //               the band the real resolver clears without that blowout —
  //               confirmed against resolveLaunch, not assumed.
  //   rdv-1       rendezvous within 5 km of the core — the first
  //               navigation rung, needs nav >= 1 (guide-3, radar), the
  //               thrusters (prop-12) that give the radar's approach its
  //               margin, and enough restarts for the match burn (prop-11)
  //               to be affordable at all.
  //   rdv-2       rendezvous within 500 m — an order of magnitude tighter,
  //               needs the star tracker (guide-4) or better, again with
  //               thrusters.
  //   dock        the tier goal: dock to the core, deploying (and docking)
  //               the lab module. Gated on BOTH requiresObject: 'core' (a
  //               target to dock to) and requiresNode including
  //               'struct-module' (the module hardware itself) — the
  //               two-gate shape ARCHITECTURE.md calls out by name for
  //               this exact rung.
  //
  // HARDWARE GATES (`requiresNode`, string or array — js/core/contracts.js,
  // lockReasons). Same rule as tier 2's: a node the resolver makes a
  // mission unflyable without is a gate on the random draw, so the board
  // never offers a contract the player cannot complete. Each gate below is
  // read off js/core/resolver.js's actual checks, not the node blurbs:
  //
  //   guide-1     satellite, core, and (via the guidance chain) everything
  //               else: an orbit requirement needs a turn, and pitchProgram
  //               flies straight up unless `guidance >= 1`.
  //   prop-11     rdv-1, rdv-2, dock. resolveOrbitalSequence's match step
  //               stops for want of restarts when `restarts < 2`, before
  //               spending any delta-v at all; prop-10 alone sets restarts
  //               to 1, and prop-11 (+2, on top of prop-10) is the only
  //               node that raises it past that. rcs (prop-12) does NOT
  //               change this: it only waives the approach step's restart
  //               (`!rcs && restartsLeft < 1`), never the match step's two,
  //               so prop-10 + prop-12 still stops at the first burn.
  //               prop-11's three restarts cover match (2) + approach (1)
  //               exactly; the phasing pair costs a third restart only when
  //               |phase error| > PHASE_TOLERANCE_DEG, which is a window-
  //               slider matter, not a hardware one.
  //   guide-3     rdv-1. closestApproach = NAV_APPROACH[nav] * (1 +
  //               |err|/30) / (rcs ? 2 : 1), and success is
  //               `closestApproach <= within`. NAV_APPROACH = [50000, 5000,
  //               500, 50], so nav 0 can never close to 5 km (25 km even
  //               with rcs) and nav 1 (guide-3) is the first level that
  //               can. guide-3 requires guide-1, so the turn gate is
  //               carried by the chain rather than listed twice.
  //   guide-4     rdv-2: within 500 m needs nav 2; nav 1 with rcs is
  //               2500 m, still five times too wide.
  //   prop-12     rdv-1, rdv-2. THE MARGIN. nav 1 reaches exactly 5000 m
  //               and nav 2 exactly 500 m only at ZERO phase error, and
  //               zero is not a value the player can set: the launch
  //               window slider (js/ui/screens.js) steps by 0.01 of an
  //               orbit, 3.6 degrees, while a target's phase (phaseFor,
  //               js/core/orbit.js) is a hash of its id -- the first core
  //               sits at 0.778, so the nearest notch is 0.588 degrees off
  //               and the radar closes to 5 098 m, never 5 000. Halving
  //               the approach with rcs turns both rungs from a knife edge
  //               into a band: at the slider's worst half-notch error of
  //               1.8 degrees, nav 1 + rcs is 2 650 m and nav 2 + rcs is
  //               265 m, both inside their rung with room for a sloppier
  //               window (up to 30 degrees for rdv-1 and 30 for rdv-2).
  //               test/data.test.js pins this against the resolver's own
  //               constants at that worst-case error.
  //   guide-5     dock: the dock step requires `closestApproach <=
  //               DOCK_RANGE` (100 m). nav 2 + rcs is 250 m, so the star
  //               tracker does not suffice even with thrusters; nav 3's
  //               50 m does, with or without rcs (53 m at the slider's
  //               worst half-notch, under 100 m up to a 30 degree phase
  //               error). rcs is therefore a docking RELIABILITY buy
  //               (DOCK_RELIABILITY_RCS) on this rung, not a gate.
  //   struct-module   dock: the module itself, carried up and left docked.
  //               It requires struct-9 (the docking adapter, which sets
  //               `docking` -- the dock step's `hasDockingAdapter` check),
  //               so the adapter is carried by the chain too.
  //
  // Nodes implied by a listed node's prerequisite chain (guide-1 under
  // guide-3/4/5, prop-10 under prop-11, struct-9 under struct-module) are
  // not repeated, so a locked contract reports each missing purchase once.
  //
  // Payouts continue above tier 2's ceiling (12 000); repGain/repLoss and
  // minReputation climb through the range reputation can actually reach by
  // tier 3 (tier 2 gates top out at 75), same "keeps mattering into the new
  // tier" reasoning as tier 2's own note.
  {
    id: 'satellite',
    tier: 3,
    name: 'Comsat deployment',
    profile: 'orbit',
    requirement: { orbit: { periapsis: 100000 } },
    deploys: { kind: 'satellite', name: 'Comsat' },
    requiresNode: 'guide-1',
    payout: 20000,
    repGain: 5,
    repLoss: 3,
  },
  {
    id: 'core',
    tier: 3,
    name: 'Station core delivery',
    profile: 'orbit',
    requirement: { orbit: { periapsis: 160000 } },
    deploys: { kind: 'core', name: 'Station core' },
    unique: true,
    requiresNode: 'guide-1',
    payout: 30000,
    repGain: 7,
    repLoss: 4,
    minReputation: 40,
  },
  {
    id: 'rdv-1',
    tier: 3,
    name: 'Rendezvous with the station core',
    profile: 'orbit',
    requirement: { rendezvous: { target: 'core', within: 5000 } },
    requiresObject: 'core',
    requiresNode: ['prop-11', 'guide-3', 'prop-12'],
    payout: 26000,
    repGain: 6,
    repLoss: 4,
    minReputation: 55,
  },
  {
    id: 'rdv-2',
    tier: 3,
    name: 'Close approach to the station core',
    profile: 'orbit',
    requirement: { rendezvous: { target: 'core', within: 500 } },
    requiresObject: 'core',
    requiresNode: ['prop-11', 'guide-4', 'prop-12'],
    payout: 36000,
    repGain: 7,
    repLoss: 5,
    minReputation: 70,
  },
  {
    id: 'dock',
    tier: 3,
    name: 'Dock the lab module',
    profile: 'orbit',
    requirement: { dock: { target: 'core' } },
    deploys: { kind: 'module', name: 'Lab module' },
    requiresObject: 'core',
    requiresNode: ['struct-module', 'prop-11', 'guide-5'],
    payout: 55000,
    repGain: 10,
    repLoss: 6,
    minReputation: 85,
  },
];

export const tierGoals = {
  1: { requirement: { altitude: 100000 }, name: 'Reach 100 km' },
  2: { requirement: { orbit: { periapsis: 100000 } }, name: 'Reach orbit' },
  3: { requirement: { dock: { target: 'core' } }, name: 'Assemble a station' },
};
