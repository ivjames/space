# space — design document

A launch-and-upgrade space program game for mobile. Launch autonomous rockets,
earn funds, buy your way up a tech tree, reach further out. Six tiers from
sub-orbit to the asteroids. No piloting, no vehicle assembly, no ads, no
microtransactions.

Status: pre-build. This document records the decisions made so far, the
reasoning behind each, and what is still open. Numbers in this document are
placeholders unless marked otherwise. Everything is tunable until playtesting
says it isn't.

---

## 1. Decisions

Locked, in the order they were made. Each one constrains the rest.

| # | Decision | Reason |
|---|----------|--------|
| 1 | Both a PWA and Capacitor store builds, from one codebase | Reach both without two games |
| 2 | Fictional setting | Avoids accuracy debates and lets the tree branch freely |
| 3 | Not a KSP clone: no vehicle assembly, no flight control | Different genre entirely, see §2 |
| 4 | Rockets are autonomous, no piloting | The launch is a result, not an input |
| 5 | Tech is gated on funds, not on research timers | Abilities unlock the moment the player can pay |
| 6 | Genre reference is Hedgehog Launch 2 without the piloting | Launch, earn, buy, launch |
| 7 | Six tiers: sub-orbit, orbit, orbital maneuvering, moon, planets and their moons, asteroids | Long arc, each tier introduces a new capability |
| 8 | Landing produces resources | Gives the late tree something funds can't buy |
| 9 | The clock comes back, for base production only | Resources accrue over wall-clock time |
| 10 | Stations and equipment for resource collection | Surface bases produce, orbital depots hold |
| 11 | Resources: fuel, oxidizer, metals, water, with plentitude and quality per site | Water is raw, fuel/oxidizer are products, metals are separate |
| 12 | Free on the stores, no ads, no microtransactions | See §12 |
| 13 | Manual transport hauls until auto-transport is purchased in the tree | Standard idle shape: collect by hand, then buy the automation |
| 14 | Build each upgrade path incrementally, unless logic says otherwise | See §14 |

## 2. What this game is and is not

**Is:** the launch-and-upgrade genre (Hedgehog Launch, Learn to Fly, Burrito
Bison). One run earns money, money buys upgrades, upgrades make the next run go
further, a goal with a run counter is the score. That genre already solves
pacing: the launch is the session unit, the goal ends the tier, the run count
gives replay value.

**Is not:** Kerbal Space Program. KSP is a physics sandbox where you assemble
vehicles from parts and fly them. As long as the player never assembles a
vehicle and never flies one, this is structurally a different game. Rockets are
stat blocks, missions resolve against those stats.

**What removing piloting costs.** In the reference games, mid-flight input is
what makes two runs with the same upgrades differ. Without it, a run is a
deterministic function of the shop and the launch becomes a cutscene. This
design replaces piloting with pre-launch decisions and reliability rolls
(§5).

## 3. Core loop

```
choose mission  ->  choose loadout  ->  launch (autonomous)  ->  outcome
      ^                                                            |
      |                                                            v
   buy tech  <---------------------  funds, reputation, resources
```

- **Launch** is instant from the player's point of view: a short animated
  sequence resolving to an outcome. Nothing waits on a timer.
- **Funds** come from contracts: a customer pays for a payload delivered to a
  destination with a profile. Payloads require capabilities, capabilities come
  from the tree.
- **Buy tech** is instant and funds-gated. There are no research timers.
- **Score** is the launch count per tier: fewer launches to reach the tier
  goal is better.

### What's on the clock and what isn't

| System | Clock? | Why |
|--------|--------|-----|
| Research / tech purchase | No | Decision 5 |
| Launches | No | A launch resolves now |
| Base production | Yes | Decision 9. Stations produce per hour of wall-clock time, capped by storage |
| Transport hauls | No | A haul is a launch |

Offline accrual is capped by storage capacity, which makes storage both the
offline limit and a natural upgrade. Elapsed time is clamped per app open
(placeholder: 24h). Clock manipulation is the player's own problem; we do not
fight it.

## 4. The unifying number: delta-v

Hedgehog Launch has altitude. This game has delta-v.

- Every destination and profile has a delta-v requirement.
- Every vehicle configuration has a delta-v capacity.
- Every failed run reads as "short by X m/s" (or as a component failure, §5).
- Propellant produced and stored off-Earth reduces the requirement for what
  lies beyond it (§8).

One axis makes six tiers feel like one system instead of six minigames. The
fictional setting means we set the numbers; the tree's numbers and the tier
order must agree (§6, ordering note).

## 5. Variance: what replaces piloting

Two sources, both pre-launch. A third is available but weak.

1. **Loadout choices.** Fuel mass vs payload mass, staging, launch window.
   The player makes the call, the rocket executes it. Loadout is the main
   skill expression in the game: a player who understands the delta-v
   budget does better than one who doesn't.
2. **Reliability rolls.** Each component has a reliability stat. Failures
   happen visibly at a stage of the flight ("second stage cut out at T+142s").
   Reliability improves with tech and with flight count on that component.
3. **Environmental variance** (weather, solar event). Cheap, but pure
   randomness feels unfair if the player had no lever against it. Use
   sparingly, and only where a tech node gives a lever (weather forecasting,
   radiation hardening).

**Readable failure is the point.** The flight animation must show why the run
ended where it did, and the readout must point at a specific tree branch:
"short by 400 m/s" points at engines or staging, "stage 2 ignition failure"
points at reliability. That link is the reason the tree exists.

## 6. Tiers

Tiers are **milestones in one continuous game**, not prestige resets. Each has
a goal, a win screen, and a launch count as score. A carryover reset
(new-game-plus) is reserved for after the asteroids tier.

| Tier | Goal (placeholder) | What it introduces | Failure reads as |
|------|--------------------|--------------------|------------------|
| 1. Sub-orbit | Reach 100 km | Thrust, altitude. Pure launch game. | "reached 62 km" |
| 2. Orbit | Complete one orbit | Velocity, not altitude. "More thrust" stops working; the player must buy something different. | "short by X m/s" |
| 3. Orbital maneuvering | Rendezvous and dock two launches | Restartable engines, delta-v budget, rendezvous, docking. A capability tier, no destination of its own. Unlocks everything after it. | "closest approach 14 km" |
| 4. Moon | Land and return | Mission profiles (flyby, orbit, land, return) with escalating payouts. First resources (§8). | "short by X m/s for return" |
| 5. Planets and their moons | Land on a body in another system | Transfer windows, mission duration, many bodies. Depth comes from profiles per body, not body count. | "missed window", "short by X" |
| 6. Asteroids | Establish a mining station | Precision navigation, low-gravity ops. The economy shifts from contracts to resources. | "capture failed" |

**Ordering note.** In real delta-v terms, near-Earth asteroids are cheaper to
reach than Mars, so asteroids before planets is the physically natural order.
Asteroids last is a narrative choice, not an error, and it is allowed because
the setting is fictional. The tree's delta-v numbers must be written to
agree with the order above.

**Tier 3 needs a goal of its own.** It has no destination, so its win
condition is an assembly or refueling task. Without one it is a set of
prerequisites with no payoff.

**Two views.** Tiers 1 and 2 want a side-view ascent. Tiers 3 onward want a
map view with orbit lines. Once every launch reliably reaches orbit, the
ascent stops being informative and should be compressed or skipped.

## 7. Economy

Three currencies. Each exists because the others can't do its job.

| Currency | Earned by | Spent on | Why it exists |
|----------|-----------|----------|---------------|
| Funds | Contracts (mission payouts) | Tech, vehicles, equipment | The primary gate |
| Reputation | Successful missions; lost on failure | Scales contract payouts; some contracts require a minimum | Gives failure a cost beyond the vehicle; a second axis for the tree |
| Resources | Bases (§8) | Late-tree nodes, on-site construction, refueling | What funds can't buy |

**Bankruptcy cannot happen.** A baseline vehicle is always affordable, or a
minimum contract always pays. A soft-lock is worse than a lose screen, and
the base game has no lose (§11).

**Risk and lose conditions are tuned together.** If a failure can end the
game, players stop taking high-payout missions and the risk system goes
unused. If failure only costs a run, they gamble freely.

## 8. Resources, bases, stations

### Resources

| Resource | Role | Source |
|----------|------|--------|
| Water | Raw | Extracted at a site |
| Fuel | Product | Processed from water |
| Oxidizer | Product | Processed from water |
| Metals | Raw, spent on-site | Extracted at a site; builds equipment without launching it |

Two hidden numbers per resource per site:

- **Plentitude** sets the extraction rate.
- **Quality** sets the processing yield.

Both are revealed by a **survey**, an orbital mission profile. This gives the
orbit and maneuvering tiers a purpose after they are won and makes site
selection the pre-landing decision.

### What resources do that funds don't

1. **Gate the late tree.** From tier 4 on, some nodes cost a resource that no
   contract pays out. Only landings unlock them. This keeps the tree from
   being a shop once income outgrows prices.
2. **Change the delta-v math.** Propellant at a depot lets a vehicle refuel
   there, so destinations beyond it get cheaper. Landing becomes a strategic
   investment, and it is the mechanic that makes tiers 5 and 6 reachable
   without absurd vehicles.

A resource that just sells for funds is funds with a detour. We do not do that.

### Equipment

Five types with levels. Not a catalog.

```
power  ->  extractor (water, metals)  ->  processor (water -> fuel + oxidizer)
                                          ->  storage  ->  transport
```

| Equipment | Does | Bottleneck it creates |
|-----------|------|-----------------------|
| Power | Runs everything | Shared cap across the base |
| Extractor | Water and metals at plentitude × level | Input rate |
| Processor | Water into fuel + oxidizer at quality × level | Conversion rate |
| Storage | Holds product; caps offline accrual | The offline limit |
| Transport | Moves product to a depot (§ below) | Delivery |

Metals spent on-site build the next piece of equipment without launching
it. That is the payoff for the metals branch.

### Stations

| Kind | Where | Does |
|------|-------|------|
| Surface base | On a landed body | Produces, on the clock |
| Orbital depot | In orbit around a body | Holds propellant for refueling passing vehicles |

Product has to move from base to depot.

### Transport: manual, then auto

- **Manual haul** is a launch profile (cargo run: base to depot, or depot to
  vehicle). It uses the same launch flow as a mission, so nothing new is
  built, and it can fail like any launch. Hauls **count toward the launch
  score**, so buying auto-transport also improves the score.
- **Hauling pays from the first trip.** The tanker's own propellant cost sits
  well under what it delivers, or the player loses value each trip without
  knowing it.
- **Auto-transport is in reach.** Priced so a player with one base and a
  handful of hauls can afford it. If it sits far up the tree, the manual
  phase is a chore every player endures identically.
- **Tiered automation.** Auto per route or per body first, then rate and
  capacity upgrades. Three or four small purchases that each remove a
  specific chore, and the manual phase returns briefly each time a new body
  is opened.
- **Notifications.** "Storage full" fires while a route is manual and stops
  once it is automated. That is what the player is buying.

## 9. Missions and contracts

A contract is: destination + profile + payload class + payout + reputation
requirement.

Profiles, in rough tier order: sounding, orbit, survey, rendezvous, dock,
flyby, land, return, cargo (haul), station build, mining.

Contract generation is procedural from the player's unlocked capabilities,
with a guaranteed floor contract always available (§7, bankruptcy).

## 10. Tech tree

- **Funds-gated**, instant purchase, prerequisites as a DAG.
- **Branches trade off**, or the tree is a list with lines. The three axes
  are reliability, capacity, cost. A node that is strictly better than its
  sibling should not exist.
- **Late nodes are resource-gated** (§8).
- **Data-driven**: the tree is JSON. Nodes carry cost, prerequisites, and
  effects. Effects are stat deltas on vehicle components, unlocked profiles,
  unlocked equipment, or automation flags.

### Tree UI on a phone

A pan/zoom DAG of 100+ nodes is unusable on a six-inch screen. Use tiered
lists (one column per branch, rows per level) or a radial layout. Prototype
the navigation before writing the content.

## 11. Win and lose

- **Win:** each tier is a milestone with a win screen. Finishing tier 6 is
  the game's end and unlocks new-game-plus.
- **Score:** launch count per tier.
- **Lose, base game:** none. Failures cost a launch, never the game.
  Bankruptcy is prevented (§7).
- **Lose, hard mode:** a launch cap per tier. Miss it and the program is cut.
  The same number is both score and constraint. Reputation zero as an
  additional shutdown condition is an option for hard mode.

Because runs are deterministic without piloting, a win is guaranteed given
enough launches. The cap is the only lose that is meaningful in this model.

## 12. Business model

Free on the stores. No ads. No microtransactions. No backend, no accounts, no
server-side save validation. Cheating is the player's own problem.

There is no cost to cover except developer accounts and time, so free with no
revenue is a complete answer. If some revenue is wanted later, the acceptable
shapes are:

- **A tip.** One non-consumable in-app purchase that unlocks nothing, or a
  cosmetic. Confirm current store policy on tipping before relying on it.
- **External donation link.** Fine on the PWA. Store rules on linking out to
  payment vary by platform and region; do not assume it is allowed.

**Whatever is picked, it never reaches game state.** With the clock back,
"pay to skip the timer" is the obvious temptation and is exactly the
mechanic this design excludes. A clock tuned for fun and a clock tuned to
sell skips are different clocks. This is the first one.

## 13. Platform and stack

- **One codebase.** Vanilla JS, HTML5 canvas, single-page. No framework, no
  bundler for the web build. Matches the shape of the other lab980 canvas
  games (sparkle, sheep, slime).
- **PWA:** static files, service worker for offline, `localStorage` (or
  IndexedDB if the save outgrows it) for state. Deployable as a static
  vhost on the lab980 droplet.
- **Capacitor:** wraps the same web directory. Adds `android/` and `ios/`
  and a build step, so this repo will not be a single `index.html`. The web
  app stays buildless; Capacitor points at its directory.
- **Native plugins needed:** Local Notifications (storage full). Nothing
  else identified yet.
- **Store accounts** are required for the Capacitor builds regardless of
  price. Apple's is an annual fee and Google's is one-time as far as known;
  confirm current figures before budgeting.
- **Portrait, one thumb.** Short runs. Two render modes (§6, two views).

## 14. Build order

Decision 14: build each upgrade path as we go, unless logic dictates that
more has to be built at once. Here is where logic dictates.

### Must exist before any tier is playable (the foundation)

These are not upgrade paths; they are the substrate every path runs on.
Building tier 1 without them means rebuilding tier 1 later.

1. **Save/load** with a versioned schema and migrations. Every later phase
   changes the save shape; a migration path from day one is cheaper than a
   reset.
2. **Tree data model and loader.** JSON nodes with cost, prerequisites,
   effects. The tier 1 tree is tiny, but the loader and the effect system
   must be general.
3. **Vehicle stat model and delta-v calculation.** Components with mass,
   thrust, Isp, reliability; a vehicle is a stack of components; delta-v is
   computed, not looked up. Tier 1 uses altitude as its readout, but the
   same calculation must be producing it, or tier 2 is a rewrite.
4. **Launch resolver.** Takes vehicle + mission + loadout, produces an
   outcome and a timeline of events (stage burns, failures). The animation
   plays the timeline; the readout summarizes it. Separating resolver from
   renderer is what lets the two views (§6) share one simulation.
5. **Contract generator** with the floor contract.
6. **Currency and purchase flow.** Funds now; reputation and resources as
   fields in the schema even if nothing earns them yet.

### Then, per tier, in order

Each tier adds its tree branch, its profiles, its readouts, and its win
screen. Content for a tier is written when that tier is built, not before.

| Phase | Delivers | Playable? |
|-------|----------|-----------|
| 0 | Foundation above, tier 1 tree, side-view ascent, sub-orbit goal | Yes: the Hedgehog Launch layer |
| 1 | Tier 2: velocity model, orbit goal, reputation earning | Yes |
| 2 | Tier 3: map view, rendezvous/docking resolver, assembly goal | Yes |
| 3 | Tier 4: profiles, survey, first resources, base equipment, **the clock**, manual haul, storage notification | Yes |
| 4 | Auto-transport tiers, resource-gated nodes, refueling delta-v | Yes |
| 5 | Tier 5: transfer windows, multiple bodies, duration | Yes |
| 6 | Tier 6: asteroids, mining station, economy shift | Yes |
| 7 | Hard mode cap, new-game-plus | Yes |
| — | Capacitor wrap and store builds | Can start any time after phase 0 |

### Things that must be built together within a phase

- **Phase 2 and the map view.** Rendezvous cannot be shown in the side view.
  The map renderer and the docking resolver ship together.
- **Phase 3 is the largest.** The clock, base production, equipment, storage
  caps, offline accrual, notifications, the haul profile, and the survey
  profile all depend on each other. Splitting it leaves half of a system
  visible with nothing to do. Order inside the phase: survey → land →
  equipment and production → storage and offline accrual → haul → notification.
- **Reputation** can be introduced in phase 1 as a stat that only rises, and
  gain its cost (loss on failure, contract minimums) in phase 3 when there
  is enough contract variety for minimums to mean something.

## 15. Not doing

- Piloting or any in-flight input.
- Vehicle assembly from parts.
- Research timers.
- Ads, microtransactions, energy meters, monetized time gates.
- A backend, accounts, or server-side saves.
- Prestige resets per tier.
- A pan/zoom DAG for the tree on mobile.
- A resource that just converts to funds.
- A large equipment catalog.

## 16. Open questions

Not decided. Each changes something concrete.

1. **Setting names.** The fictional system, the bodies, the agency. Needed
   before tier 4 content; not before.
2. **Elapsed-time clamp** for offline accrual. Placeholder 24h.
3. **Hauls in the score.** Decided yes above; revisit if it makes the manual
   phase feel punitive in playtesting.
4. **Environmental variance:** include at all, and if so which tech nodes
   give a lever against it.
5. **Tier 3 goal:** assembly (dock two launches) vs refuel (tanker to a
   depot). Assembly is proposed above.
6. **Tree layout:** tiered lists vs radial. Prototype both in phase 0 with
   fake data.
7. **Revenue:** none, tip IAP, or donation link. Does not affect the build
   until the store submission.
8. **Save store:** `localStorage` until the save exceeds what it handles
   comfortably; IndexedDB after. Decide when the phase 3 schema is known.
