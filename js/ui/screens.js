// Screen flow: contracts -> loadout -> launch -> result ->
//   (tree | contracts | win -> tier -> contracts).
//
// One screen is in #screen at a time, carrying data-screen; the primary
// action lives in #actions carrying data-action (ARCHITECTURE.md §UI hooks).
// Everything here is presentation and sequencing — every state transition is
// a js/core call whose new state is handed back to main.js through update().

import { makeRng } from '../core/rng.js';
import {
  resolveLaunch,
  TURN_START_LAZY,
  TURN_START_HARD,
  TURN_END_LAZY,
  TURN_END_HARD,
} from '../core/resolver.js';
import { totalDeltaV, G0 } from '../core/vehicle.js';
import {
  recordLaunch, tierGoalMet, deriveVehicle, advanceTier, findTarget,
} from '../core/state.js';
import { applyOutcome } from '../core/economy.js';
import { generateContracts } from '../core/contracts.js';
import { playOutcome } from './ascent.js';
import { playOrbital } from './map.js';
import { mountShop } from './shop.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function km(m) {
  if (m >= 1000) return `${Math.round(m / 1000)} km`;
  return `${Math.round(m)} m`;
}

function ms(v) {
  return `${Math.round(v)} m/s`;
}

/**
 * A ticker timestamp. Ascent events land in the first few hundred seconds and
 * keep the padded "T+142s" they have always had; the orbital phase runs for
 * hours, where five digits of seconds stop being readable.
 */
function tickTime(t) {
  const sec = Math.max(0, Math.round(t));
  if (sec < 3600) return `T+${String(sec).padStart(3, ' ')}s`;
  const h = Math.floor(sec / 3600);
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  return `T+${h}:${m}h`;
}

/**
 * An orbit element (periapsis/apoapsis) as text. Unlike km() this has to cope
 * with a NEGATIVE altitude — a periapsis under the surface is how the resolver
 * says "this comes back down" — and with +Infinity, which is an escape
 * trajectory, and with null, which is "the flight never left the pad".
 */
function elementText(v) {
  if (v === null || v === undefined) return '—';
  if (!Number.isFinite(v)) return 'escape';
  if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)} km`;
  return `${Math.round(v)} m`;
}

/**
 * A separation between two spacecraft: "500 m" / "3.2 km" / "14 km". Same
 * shape as the resolver's own readouts, so the result screen's row and the
 * sentence above it agree.
 */
function range(m) {
  if (typeof m !== 'number' || !Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** An object's orbit as the contracts board quotes it: "200 × 214 km". */
function orbitText(periapsis, apoapsis) {
  if (typeof periapsis === 'number' && Number.isFinite(periapsis)
      && typeof apoapsis === 'number' && Number.isFinite(apoapsis)) {
    return `${Math.round(periapsis / 1000)} × ${Math.round(apoapsis / 1000)} km`;
  }
  return `${elementText(periapsis)} × ${elementText(apoapsis)}`;
}

/**
 * Which requirement shape a mission asks for. A mission has exactly one:
 * { altitude } | { downrange } | { orbit: { periapsis } } (phases 0-1), and
 * { rendezvous: { target, within } } | { dock: { target } } (phase 2).
 */
function reqKind(requirement) {
  if (requirement) {
    if (typeof requirement.altitude === 'number') return 'altitude';
    if (typeof requirement.downrange === 'number') return 'downrange';
    if (requirement.orbit && typeof requirement.orbit.periapsis === 'number') return 'orbit';
    if (requirement.rendezvous && typeof requirement.rendezvous.within === 'number') return 'rendezvous';
    if (requirement.dock) return 'dock';
  }
  return 'altitude';
}

/** The requirement in its own unit: "25 km", "orbit ≥ 100 km", "rendezvous within 5 km". */
function requirementText(requirement) {
  switch (reqKind(requirement)) {
    case 'downrange': return `${km(requirement.downrange)} downrange`;
    case 'orbit': return `orbit ≥ ${km(requirement.orbit.periapsis)}`;
    case 'rendezvous': return `rendezvous within ${km(requirement.rendezvous.within)}`;
    case 'dock': return 'dock';
    default: return km(requirement?.altitude ?? 0);
  }
}

/** The two shapes that fly to something already in orbit (phase 2). */
function needsTarget(mission) {
  const kind = reqKind(mission?.requirement);
  return kind === 'rendezvous' || kind === 'dock';
}

/** Which kind of object a target mission flies to ('core'). */
function targetKind(mission) {
  const req = mission?.requirement;
  return req?.rendezvous?.target ?? req?.dock?.target ?? null;
}

/**
 * The phase error as a sentence, with the SIGN CONVENTION the resolver
 * documents (js/core/resolver.js, wrapDeg): `phaseErrorDeg` is the vehicle's
 * own phase MINUS the target's, so a POSITIVE value means the vehicle is
 * inserted ahead of the target — and therefore that the target is that far
 * BEHIND. A negative value is the target ahead, which is the case the
 * resolver's own doc comment pins ("window 0.9 against a target at phase 0.1
 * ... reads 'Target was 72 deg ahead'").
 */
function phaseErrorText(deg) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return '—';
  const mag = Math.round(Math.abs(deg));
  if (mag === 0) return 'Target was alongside';
  return `Target was ${mag}° ${deg < 0 ? 'ahead' : 'behind'}`;
}

/**
 * The tier's own progress metric against its goal, as { label, text }.
 *
 * A tier is judged on the metric its goal is shaped from (state.js's
 * tierGoalMet: an altitude goal reads best.maxAltitude, an orbit goal reads
 * best.bestPeriapsis), so the hint under a tier 2 board must not keep quoting
 * an altitude the tier no longer cares about. "none yet" rather than "0 km"
 * when nothing has been achieved: a 0 km periapsis is a real, very different
 * claim from never having had one.
 */
function tierBest(state, g) {
  switch (reqKind(g?.requirement)) {
    case 'orbit': {
      // recordLaunch takes the max periapsis of every flight, and a flight
      // that comes straight back down has a periapsis far BELOW the surface
      // (the resolver's way of saying "this trajectory hits the ground").
      // Quoting "best periapsis -2 598 km" as progress towards orbit is
      // noise, so anything at or below the surface reads as "none yet" — the
      // player has not had a periapsis worth the name.
      const p = state.best?.bestPeriapsis;
      return {
        label: 'best periapsis',
        text: typeof p === 'number' && p > 0 ? elementText(p) : 'none yet',
      };
    }
    case 'downrange': {
      const d = state.best?.maxDownrange ?? 0;
      return { label: 'best downrange', text: d > 0 ? km(d) : 'none yet' };
    }
    case 'dock':
    case 'rendezvous': {
      // Tier 3 is judged on how close the player has ever got, and — for the
      // dock goal — on whether anything is actually joined up there, which is
      // what state.objects (not a metric) records.
      if (reqKind(g?.requirement) === 'dock'
          && (state.objects ?? []).some((obj) => obj.dockedTo != null)) {
        return { label: 'station', text: 'assembled' };
      }
      const c = state.best?.bestClosestApproach;
      return {
        label: 'best approach',
        text: typeof c === 'number' && Number.isFinite(c) ? range(c) : 'none yet',
      };
    }
    default:
      return { label: 'best altitude', text: km(state.best?.maxAltitude ?? 0) };
  }
}

/** What the tier is about, for the interstitial and the win screen. */
const TIER_NAMES = { 1: 'Altitude', 2: 'Orbit', 3: 'Orbital maneuvering' };

/**
 * The one thing that changed, said once, on the interstitial that opens a
 * tier. Each entry is a short list of paragraphs; the screen prints them in
 * order under the goal.
 */
const TIER_BLURB = {
  2: [
    'Altitude is no longer the answer. Turn, and gain speed.',
    `Guidance is a new branch in the tree. Without it the rocket flies
      straight up whatever the loadout asks for; with it, the loadout gains a turn.`,
  ],
  3: [
    `Orbit is no longer the end of the flight. Reach it, then fly to something
      already up there: match its orbit, close the angle, approach, dock.`,
    `Nothing is piloted. After insertion the flight is a sequence of burns the
      upper stage can or cannot make, so restarts, navigation and a docking
      adapter are what the tier is really buying — and the launch window is a
      new loadout choice, because a rocket inserted level with its target
      pays nothing for phasing.`,
  ],
};

/** The teaser on a win screen, for the tier the player is about to open. */
const TIER_TEASER = {
  2: 'velocity, not altitude',
  3: 'a second launch, to something the first one left in orbit',
};

/** Navigation quality, by `vehicle.nav` (resolver.js's NAV_APPROACH ladder). */
const NAV_NAMES = ['none', 'radar', 'star tracker', 'docking sensors'];

const lerp = (a, b, u) => a + (b - a) * u;

/** 0 -> "late, lazy turn", 1 -> "early, hard turn". */
function turnDescriptor(turn) {
  if (turn <= 0.1) return 'late, lazy turn';
  if (turn < 0.35) return 'late turn';
  if (turn < 0.65) return 'mid turn';
  if (turn < 0.9) return 'early turn';
  return 'early, hard turn';
}

/**
 * The live readout under the turn slider. It describes the PROGRAM the
 * loadout selects — where it leaves vertical and where it reaches horizontal,
 * straight off the pitch-program constants the resolver exports — and never
 * what the flight will do with it. (Predicting the flight is the thing this
 * screen is not allowed to do.)
 */
function turnProgramText(turn) {
  const start = lerp(TURN_START_LAZY, TURN_START_HARD, turn);
  const end = lerp(TURN_END_LAZY, TURN_END_HARD, turn);
  return `${turnDescriptor(turn)} — vertical to ${km(start)}, horizontal by ${km(end)}`;
}

/**
 * Mount the screen flow.
 *
 * @param {object} ctx
 * @param {HTMLElement} ctx.screenEl
 * @param {HTMLElement} ctx.actionsEl
 * @param {() => object} ctx.getState
 * @param {(next: object) => void} ctx.update  commits a new state (and saves)
 * @param {object} ctx.tree
 * @param {Array}  ctx.missions
 * @param {object} ctx.tierGoals
 * @param {object} ctx.components base vehicle
 * @returns {{ render(): void, show(name: string): Promise<void>, view: object }}
 */
export function mountScreens(ctx) {
  const { screenEl, actionsEl, getState, update, tree, missions, tierGoals, components } = ctx;

  const view = {
    name: 'contracts',
    contractId: null,
    // Loadout values live here, not in the DOM, so they persist between
    // launches (ARCHITECTURE.md, phase 1: "Loadout values persist in `view`
    // between launches") — the screen is rebuilt from scratch every time.
    fuelFraction: 1,
    turn: 0.5,
    // The launch window, 0..1 of the way round the orbit (phase 2). It is
    // compared against the target's own phase, so it only means anything on a
    // rendezvous/dock mission — but it persists like the others.
    window: 0.5,
    outcome: null,
    error: null,    // a launch that could not be attempted, shown on loadout
    mission: null,
    ticker: [],
    playing: false,
    handle: null,
    pending: null,   // { next, delta } committed when playback ends
    delta: null,     // { funds, reputation } shown on the result screen
  };

  // The derived vehicle is a pure function of the owned nodes, and deriving
  // it is async (state.js dynamic-imports vehicle.js), so it is cached and
  // refreshed whenever `owned` changes rather than awaited inside render().
  let vehicle = null;
  let vehicleKey = null;

  async function ensureVehicle() {
    const state = getState();
    const key = state.owned.join('|');
    if (vehicle && key === vehicleKey) return vehicle;
    vehicle = await deriveVehicle(state, tree, components);
    vehicleKey = key;
    return vehicle;
  }

  function missionById(id) {
    return missions.find((m) => m.id === id) ?? null;
  }

  function offeredMissions() {
    const state = getState();
    return (state.contracts ?? []).map(missionById).filter(Boolean);
  }

  function selectedMission() {
    return missionById(view.contractId) ?? offeredMissions()[0] ?? null;
  }

  function goal() {
    return tierGoals[getState().tier] ?? null;
  }

  // ---- screens -----------------------------------------------------------

  function tabsHtml(active) {
    return `
      <nav class="tabs">
        <div class="tab ${active === 'contracts' ? 'active' : ''}" data-tab="contracts" role="button" tabindex="0">CONTRACTS</div>
        <div class="tab ${active === 'tree' ? 'active' : ''}" data-tab="tree" role="button" tabindex="0">TECH TREE</div>
      </nav>`;
  }

  /**
   * "In orbit": everything the player has left up there (ARCHITECTURE.md,
   * phase 2). It is the board's memory — a rendezvous contract is only
   * offered because one of these exists, and the tier 3 goal is a statement
   * about this list. The element is always present so a test can select it;
   * it is hidden while there is nothing to say and no tier that cares.
   */
  function objectsHtml() {
    const state = getState();
    const objects = state.objects ?? [];
    const nameOf = (id) => objects.find((o) => o.id === id)?.name ?? id;
    if (objects.length === 0 && (state.tier ?? 1) < 3) {
      return '<section class="objects" data-objects hidden></section>';
    }
    const rows = objects.map((obj) => `
        <li class="row object" data-object="${escapeHtml(obj.id)}">
          <div class="row-main">
            <div class="row-title">${escapeHtml(obj.name ?? obj.id)}</div>
            <div class="hint">${escapeHtml(orbitText(obj.periapsis, obj.apoapsis))}${
              obj.dockedTo ? ` · docked to ${escapeHtml(nameOf(obj.dockedTo))}` : ''
            }</div>
          </div>
          <div class="row-side">
            <div class="hint row-note">${escapeHtml(obj.kind ?? '')}</div>
          </div>
        </li>`).join('');
    return `
      <section class="objects" data-objects>
        <h2 class="branch-head">
          <span>IN ORBIT</span>
          <span class="hint">${objects.length}</span>
        </h2>
        ${objects.length
          ? `<ul class="list">${rows}</ul>`
          : '<p class="hint objects-empty">Nothing up there yet. A deployment contract leaves something behind.</p>'}
      </section>`;
  }

  function contractsHtml() {
    const state = getState();
    const g = goal();
    const best = tierBest(state, g);
    const rows = offeredMissions().map((m) => {
      const selected = m.id === view.contractId;
      const rep = [
        m.repGain ? `+${m.repGain} rep` : null,
        m.repLoss ? `−${m.repLoss} rep on failure` : 'no rep risk',
      ].filter(Boolean).join(' · ');
      return `
        <li class="row contract ${selected ? 'selected' : ''}" data-contract="${escapeHtml(m.id)}" role="button" tabindex="0">
          <div class="row-main">
            <div class="row-title">${escapeHtml(m.name)}${m.floor ? ' <span class="tag">floor</span>' : ''}</div>
            <div class="hint">${escapeHtml(requirementText(m.requirement))} · ${escapeHtml(rep)}</div>
          </div>
          <div class="row-side">
            <div class="cost">${m.payout}</div>
            <div class="hint">payout</div>
          </div>
        </li>`;
    }).join('');

    return `
      <div class="screen" data-screen="contracts">
        ${tabsHtml('contracts')}
        <div class="pad">
          <p class="hint goal-line">
            Tier ${state.tier} goal: ${escapeHtml(g?.name ?? '—')} ·
            ${escapeHtml(best.label)} ${escapeHtml(best.text)}
          </p>
          <ul class="list">${rows}</ul>
          <p class="hint foot">Tap a contract, then Select.</p>
          ${objectsHtml()}
        </div>
      </div>`;
  }

  /**
   * The line under the launch window slider. Like the turn hint it describes
   * the CHOICE and nothing else: where on the orbit this window inserts the
   * vehicle, and how that sits against the target's own phase — which is
   * state (js/core/state.js's `objects`, drawn on the map from its first
   * frame), not a prediction of the flight. What it costs, whether the
   * vehicle can pay it, and how close it ends up are all the flight's to say.
   */
  function windowHintText(value, target) {
    const deg = Math.round(value * 360);
    if (!target) return `Inserts ${deg}° round the orbit.`;
    // The target's position is world state (the map draws it from frame
    // one). The error between it and this window is NOT shown: that is the
    // flight's to report, afterwards, and working it out is the decision.
    const at = Math.round((target.phase ?? 0) * 360);
    return `${target.name ?? target.id} is at ${at}°. Inserts ${deg}° round the orbit.`;
  }

  function loadoutHtml() {
    const mission = selectedMission();
    const ff = view.fuelFraction;
    const dv = vehicle ? totalDeltaV(vehicle, ff) : 0;
    const stages = vehicle?.stages?.length ?? 0;
    const guidance = vehicle?.guidance ?? 0;
    const wet = vehicle
      ? vehicle.stages.reduce((m, s) => m + s.dryMass + s.propMass * ff, vehicle.payloadMass)
      : 0;
    const twr = vehicle && wet > 0 ? (vehicle.stages[0]?.thrust ?? 0) / (wet * G0) : 0;

    // The turn slider exists only when the vehicle can actually steer: with
    // guidance 0 the resolver treats `turn` as 0 whatever the loadout says
    // (resolver.js, pitchProgram), so offering the control would be a lie.
    // Nothing here predicts the flight — no required delta-v, no verdict —
    // only what the pitch program itself is.
    // A sounding contract is a vertical flight by definition: the turn slider
    // is not offered for an altitude requirement and the flight goes straight
    // up, whatever guidance the vehicle carries.
    const missionTurns = !!(mission?.requirement && mission.requirement.altitude === undefined);
    const turnField = !missionTurns
      ? `
          <div class="field">
            <label class="field-label">
              <span>Turn</span>
              <span class="field-value">—</span>
            </label>
            <p class="hint">Sounding flight: straight up.</p>
          </div>`
      : guidance >= 1
      ? `
          <div class="field">
            <label class="field-label" for="turn">
              <span>Turn</span>
              <span class="field-value" data-turn-readout>${view.turn.toFixed(2)}</span>
            </label>
            <input id="turn" type="range" data-loadout="turn"
                   min="0" max="1" step="0.05" value="${view.turn}">
            <p class="hint" data-turn-hint>${escapeHtml(turnProgramText(view.turn))}</p>
            <p class="hint">Which one this vehicle wants is the decision.</p>
          </div>`
      : `
          <div class="field">
            <label class="field-label">
              <span>Turn</span>
              <span class="field-value">—</span>
            </label>
            <p class="hint">No guidance: flies vertical.</p>
          </div>`;

    // What the vehicle can do once it is in orbit (phase 2). Listed only when
    // it can do it at all: a zero here is not a stat, it is the absence of one.
    const restarts = Math.max(0, Math.floor(vehicle?.restarts ?? 0));
    const nav = Math.max(0, Math.floor(vehicle?.nav ?? 0));
    const docking = (vehicle?.docking ?? 0) >= 1;
    const rcs = (vehicle?.rcs ?? 0) >= 1;
    const orbitalStats = [
      restarts > 0 ? `<div><dt>Restarts</dt><dd>${restarts}</dd></div>` : '',
      nav > 0 ? `<div><dt>Navigation</dt><dd>${escapeHtml(NAV_NAMES[nav] ?? String(nav))}</dd></div>` : '',
      docking ? '<div><dt>Docking</dt><dd>adapter</dd></div>' : '',
      rcs ? '<div><dt>RCS</dt><dd>fine control</dd></div>' : '',
    ].join('');

    // The launch window only means something against something already in
    // orbit, so the slider appears exactly on the missions that fly to one.
    const target = needsTarget(mission) ? findTarget(getState(), targetKind(mission)) : null;

    // "Target dock" is not a sentence. A mission that flies to an object says
    // what it is flying to, by name.
    const kind = reqKind(mission?.requirement);
    const targetName = target?.name ?? target?.id ?? 'the target';
    const objective = kind === 'dock'
      ? `Dock with ${targetName}`
      : kind === 'rendezvous'
        ? `Within ${km(mission.requirement.rendezvous.within)} of ${targetName}`
        : `Target ${requirementText(mission?.requirement)}`;
    const windowField = needsTarget(mission)
      ? `
          <div class="field">
            <label class="field-label" for="win">
              <span>Launch window</span>
              <span class="field-value" data-window-readout>${Math.round(view.window * 360)}°</span>
            </label>
            <input id="win" type="range" data-loadout="window"
                   min="0" max="1" step="0.01" value="${view.window}">
            <p class="hint" data-window-hint>${escapeHtml(windowHintText(view.window, target))}</p>
            <p class="hint">Inserting level with the target costs nothing; an angle is paid off in phasing burns.</p>
          </div>`
      : '';

    const error = view.error
      ? `<p class="readout failure" data-error>${escapeHtml(view.error)}</p>`
      : '';

    return `
      <div class="screen" data-screen="loadout">
        <div class="pad">
          <h1 class="title">${escapeHtml(mission?.name ?? 'Loadout')}</h1>
          ${error}
          <p class="hint">${escapeHtml(objective)} · payout ${mission?.payout ?? 0}</p>

          <dl class="stats">
            <div><dt>Stages</dt><dd>${stages}</dd></div>
            <div><dt>Delta-v</dt><dd>${ms(dv)}</dd></div>
            <div><dt>Liftoff mass</dt><dd>${Math.round(wet)} kg</dd></div>
            <div><dt>Liftoff TWR</dt><dd class="${twr < 1 ? 'bad' : ''}">${twr.toFixed(2)}</dd></div>
            ${orbitalStats}
          </dl>

          ${windowField}

          <div class="field">
            <label class="field-label" for="ff">
              <span>Fuel load</span>
              <span class="field-value" data-loadout-readout>${Math.round(ff * 100)}%</span>
            </label>
            <input id="ff" type="range" data-loadout="fuelFraction"
                   min="0.5" max="1" step="0.05" value="${ff}">
            <p class="hint">Less fuel is lighter and burns shorter; more fuel is more delta-v but a heavier, slower climb.</p>
          </div>

          ${turnField}
        </div>
      </div>`;
  }

  function launchHtml() {
    return `
      <div class="screen" data-screen="launch">
        <div class="ascent-wrap"><canvas id="ascent"></canvas></div>
        <div class="pad">
          <ul class="ticker" data-ticker></ul>
          <p class="hint">Tap the flight to skip ahead.</p>
        </div>
      </div>`;
  }

  function resultHtml() {
    const o = view.outcome;
    const delta = view.delta ?? { funds: 0, reputation: 0 };
    const mission = view.mission;
    const state = getState();
    const kind = reqKind(mission?.requirement);
    const guidance = vehicle?.guidance ?? 0;

    // What the result points the player at. A failure is always reliability's
    // problem; a shortfall is propulsion/structure — except that a tier 2
    // mission asking for orbit or downrange cannot be flown AT ALL by a
    // vehicle that only knows how to go straight up, and saying "buy more
    // thrust" there would send the player the wrong way (DESIGN.md §6: the
    // player must buy something DIFFERENT).
    const points = [];
    const orb = o?.orbital ?? null;
    if (o?.failure) {
      points.push(`<p class="hint points" data-points-at="reliability">Reliability upgrades reduce this.</p>`);
    } else if (o && !o.success && orb) {
      // A tier 3 miss is usually not a delta-v shortfall: the sequence names
      // the step it could not perform, and that step names a branch.
      if (orb.stoppedAt === 'restarts') {
        points.push(`<p class="hint points" data-points-at="propulsion">The upper stage ran out of relights. Propulsion buys restartable engines and more of them.</p>`);
      } else if (orb.stoppedAt === 'dock-failure') {
        points.push(`<p class="hint points" data-points-at="reliability">The approach was close enough; the latch was not. Reliability rehearses docking.</p>`);
      } else if (orb.stoppedAt === 'deltaV') {
        points.push(`<p class="hint points" data-points-at="propulsion">The orbital phase ran dry: propulsion adds isp and a propellant reserve…</p>`);
        points.push(`<p class="hint points" data-points-at="structure">…or structure lightens what the top stage has to carry.</p>`);
      } else if (kind === 'dock' && (vehicle?.docking ?? 0) === 0) {
        points.push(`<p class="hint points" data-points-at="structure">No docking adapter: nothing on this vehicle can latch. Structure carries it.</p>`);
      } else {
        points.push(`<p class="hint points" data-points-at="guidance">The approach was too wide. Navigation is what narrows it — and a smaller launch-window error widens nothing.</p>`);
      }
    } else if (o && !o.success) {
      if (guidance === 0 && kind === 'orbit') {
        points.push(`<p class="hint points" data-points-at="guidance">No guidance: a vertical flight cannot orbit. Guidance is what turns the rocket over.</p>`);
      } else if (guidance === 0 && kind === 'downrange') {
        points.push(`<p class="hint points" data-points-at="guidance">No guidance: a vertical flight cannot fly downrange. Guidance is what turns the rocket over.</p>`);
      }
      points.push(`<p class="hint points" data-points-at="propulsion">More delta-v: propulsion raises thrust and isp…</p>`);
      points.push(`<p class="hint points" data-points-at="structure">…or structure adds propellant and, later, another stage.</p>`);
    }

    // Detail rows follow the requirement: an orbit mission is judged on the
    // ellipse it ended in, a downrange mission on how far it got.
    const rows = [`<div><dt>Apogee</dt><dd>${km(o?.maxAltitude ?? 0)}</dd></div>`];
    if (kind === 'rendezvous' || kind === 'dock') {
      rows.push(`<div><dt>Orbit</dt><dd>${escapeHtml(orbitText(o?.periapsis, o?.apoapsis))}</dd></div>`);
      rows.push(`<div><dt>Closest approach</dt><dd data-result="closest-approach">${escapeHtml(range(o?.closestApproach))}</dd></div>`);
      rows.push(`<div><dt>Launch window</dt><dd>${escapeHtml(phaseErrorText(orb?.phaseErrorDeg))}</dd></div>`);
      rows.push(`<div><dt>Orbital delta-v</dt><dd>${ms(orb?.dvUsed ?? 0)} of ${ms(orb?.dvAvailable ?? 0)}</dd></div>`);
      if (kind === 'dock') {
        rows.push(`<div><dt>Docked</dt><dd data-result="docked" class="${o?.docked ? 'good' : ''}">${o?.docked ? 'yes' : 'no'}</dd></div>`);
      }
    } else if (kind === 'orbit') {
      rows.push(`<div><dt>Apoapsis</dt><dd>${elementText(o?.apoapsis)}</dd></div>`);
      rows.push(`<div><dt>Periapsis</dt><dd>${elementText(o?.periapsis)}</dd></div>`);
    } else if (kind === 'downrange') {
      rows.push(`<div><dt>Downrange</dt><dd>${km(o?.maxDownrange ?? 0)}</dd></div>`);
    }
    rows.push(`<div><dt>Max speed</dt><dd>${ms(o?.maxSpeed ?? 0)}</dd></div>`);
    rows.push(`<div><dt>Delta-v used</dt><dd>${ms(o?.deltaVAchieved ?? 0)}</dd></div>`);
    if (o && !o.success) rows.push(`<div><dt>Short by</dt><dd>${ms(o.shortBy)}</dd></div>`);

    const g = goal();
    const best = tierBest(state, g);
    const readoutKind = o?.success ? 'success' : o?.failure ? 'failure' : 'short';
    return `
      <div class="screen" data-screen="result">
        <div class="pad">
          <p class="hint">${escapeHtml(mission?.name ?? '')} · launch ${state.launches[state.tier]}</p>
          <p class="readout ${readoutKind}" data-readout="${readoutKind}">${escapeHtml(o?.readout ?? '')}</p>
          ${points.join('')}
          <dl class="stats">${rows.join('')}</dl>
          <p class="ledger">
            <span class="${delta.funds > 0 ? 'good' : 'muted'}">${delta.funds > 0 ? `+${delta.funds}` : '+0'} funds</span>
            <span class="${delta.reputation > 0 ? 'good' : delta.reputation < 0 ? 'bad' : 'muted'}">${delta.reputation > 0 ? '+' : ''}${delta.reputation} rep</span>
          </p>
          <p class="hint">Tier ${state.tier} goal: ${escapeHtml(g?.name ?? '—')} · ${escapeHtml(best.label)} ${escapeHtml(best.text)}.</p>
        </div>
      </div>`;
  }

  function treeHtml() {
    return `
      <div class="screen" data-screen="tree">
        ${tabsHtml('tree')}
        <div class="pad">
          <p class="hint">Every node is instant and funds-gated. Siblings trade off.</p>
          <div data-shop></div>
        </div>
      </div>`;
  }

  function winHtml() {
    const state = getState();
    const g = goal();
    const best = tierBest(state, g);
    const kind = reqKind(g?.requirement);
    const launches = state.launches[state.tier];
    // Each tier's win is stated in the terms that tier was played in — tier 3
    // did not "reach" anything, it built something (ARCHITECTURE.md, phase 2:
    // "Assembled a station in N launches").
    const won = kind === 'dock'
      ? `Assembled a station in ${launches} launches`
      : kind === 'rendezvous'
        ? `Rendezvoused in ${launches} launches`
        : kind === 'orbit'
          ? `Reached orbit in ${launches} launches`
          : kind === 'downrange'
            ? `Reached ${km(g.requirement.downrange)} downrange in ${launches} launches`
            : `Reached ${km(g?.requirement.altitude ?? 100000)} in ${launches} launches`;
    const nextGoal = tierGoals[state.tier + 1] ?? null;
    return `
      <div class="screen" data-screen="win">
        <div class="pad win-pad">
          <p class="hint">TIER ${state.tier} COMPLETE</p>
          <p class="readout success">${escapeHtml(won)}</p>
          <p class="hint">${escapeHtml(best.label[0].toUpperCase() + best.label.slice(1))} ${escapeHtml(best.text)}. Fewer launches is the better score.</p>
          ${nextGoal
            ? `<p class="hint">Tier ${state.tier + 1} asks for ${escapeHtml(requirementText(nextGoal.requirement))}${
                TIER_TEASER[state.tier + 1] ? ` — ${escapeHtml(TIER_TEASER[state.tier + 1])}` : ''
              }. Continue to open it.</p>`
            : `<p class="hint">The game stops here for now. Continue returns to contracts and the tier stays at ${state.tier}.</p>`}
        </div>
      </div>`;
  }

  /**
   * The interstitial between one tier and the next. It runs once, straight
   * after advanceTier, and its whole job is to say that the rules changed
   * before the player meets a board full of contracts they cannot read.
   */
  function tierHtml() {
    const state = getState();
    const g = goal();
    return `
      <div class="screen" data-screen="tier">
        <div class="pad win-pad">
          <p class="hint">NEW TIER</p>
          <p class="readout success">Tier ${state.tier}: ${escapeHtml(TIER_NAMES[state.tier] ?? '')}</p>
          <p class="hint tier-goal">Goal: ${escapeHtml(g?.name ?? '—')} · ${escapeHtml(requirementText(g?.requirement))}</p>
          ${(TIER_BLURB[state.tier] ?? []).map((line) => `<p class="hint">${escapeHtml(line.replace(/\s+/g, ' ').trim())}</p>`).join('')}
        </div>
      </div>`;
  }

  // ---- actions bar -------------------------------------------------------

  function actionsHtml() {
    switch (view.name) {
      case 'contracts':
        return `<button class="btn-primary" data-action="select" ${selectedMission() ? '' : 'disabled'}>SELECT</button>`;
      case 'loadout':
        return `<div class="actions-row">
            <button class="btn-secondary" data-action="back">Back</button>
            <button class="btn-primary" data-action="launch">LAUNCH</button>
          </div>`;
      case 'launch':
        return `<button class="btn-primary" data-action="continue" ${view.playing ? 'disabled' : ''}>CONTINUE</button>`;
      case 'result':
        return `<button class="btn-primary" data-action="continue">CONTINUE</button>`;
      case 'tree':
        return `<button class="btn-primary" data-action="back">BACK</button>`;
      case 'win':
      case 'tier':
        return `<button class="btn-primary" data-action="continue">CONTINUE</button>`;
      default:
        return '';
    }
  }

  // ---- rendering ---------------------------------------------------------

  let lastRendered = null;

  function renderScreen() {
    // Repainting the same screen (a purchase, a selection) should not throw
    // the player back to the top of a scrolled list.
    const keepScroll = lastRendered === view.name ? screenEl.scrollTop : 0;
    switch (view.name) {
      case 'contracts': screenEl.innerHTML = contractsHtml(); break;
      case 'loadout': screenEl.innerHTML = loadoutHtml(); break;
      case 'launch': screenEl.innerHTML = launchHtml(); break;
      case 'result': screenEl.innerHTML = resultHtml(); break;
      case 'win': screenEl.innerHTML = winHtml(); break;
      case 'tier': screenEl.innerHTML = tierHtml(); break;
      case 'tree':
        screenEl.innerHTML = treeHtml();
        mountShop(screenEl.querySelector('[data-shop]'), { tree, getState, update });
        break;
      default: screenEl.innerHTML = '';
    }
    lastRendered = view.name;
    screenEl.scrollTop = keepScroll;
  }

  /**
   * Repaint. The launch screen is the one exception to a full rebuild: it
   * owns a canvas mid-animation, so a state commit there refreshes only the
   * actions bar rather than throwing the flight away.
   */
  function render() {
    if (view.name === 'launch' && screenEl.querySelector('#ascent')) {
      actionsEl.innerHTML = actionsHtml();
      return;
    }
    renderScreen();
    actionsEl.innerHTML = actionsHtml();
  }

  async function show(name) {
    // Whatever could not be launched last time is not this screen's problem.
    if (name !== 'loadout') view.error = null;
    if (view.handle && name !== 'launch') {
      view.handle.stop();
      view.handle = null;
      view.playing = false;
    }
    view.name = name;
    if (name === 'contracts') {
      // A save can carry a won tier whose win screen was already acknowledged
      // before the next tier existed (a phase 0 save that reached 100 km:
      // save.js migrates its winShown into wins[1] with tier still 1). Such a
      // player would otherwise never see the tier above. Advance them now,
      // through the same path Continue-from-win takes.
      const s0 = getState();
      if ((s0.best?.wins ?? {})[s0.tier] && tierGoals[s0.tier + 1] && tierGoalMet(s0, tierGoals)) {
        continueFromWin();
        // update() repaints only once mountScreens has returned; at boot it
        // has not, so paint the interstitial here.
        render();
        return;
      }
      // Offers are regenerated after every launch, so a stale selection has
      // to fall back to something that is actually on the board.
      const offered = getState().contracts ?? [];
      if (!offered.includes(view.contractId)) view.contractId = offered[0] ?? null;
    }
    if (name === 'loadout' || name === 'launch') await ensureVehicle();
    render();
  }

  // ---- the launch itself -------------------------------------------------

  /**
   * Draw a fresh board of offers for `s`, folding the draws they consume back
   * into the save so a reload replays identically. This is the ONE place
   * contracts are regenerated after the first boot — after every launch, and
   * again after advanceTier clears them — and it resumes the same rng stream
   * main.js's own ensureContracts() does, from `s.draws`.
   */
  function withFreshContracts(s) {
    const rng = makeRng(s.seed, s.draws);
    const before = rng.draws;
    const contracts = generateContracts(s, missions, rng);
    return { ...s, contracts, draws: s.draws + (rng.draws - before) };
  }

  async function doLaunch() {
    const state = getState();
    const mission = selectedMission();
    if (!mission) return;
    await ensureVehicle();

    // A rendezvous or dock contract is only ever offered while its target is
    // in orbit (js/core/contracts.js's `requiresObject` gate), so this is a
    // bug, not a game state — but the resolver THROWS without a target, and a
    // thrown exception mid-launch would leave the player on a dead screen
    // with nothing said. Say it instead.
    let target = null;
    if (needsTarget(mission)) {
      target = findTarget(state, targetKind(mission));
      if (!target) {
        view.error = `No ${targetKind(mission) ?? 'target'} in orbit to fly to.`
          + ' This contract should not have been offered — pick another.';
        render();
        return;
      }
    }
    view.error = null;

    // One rng for the whole turn, resumed from the save's draw count so a
    // reload replays identically (ARCHITECTURE.md §rng).
    const rng = makeRng(state.seed, state.draws);
    const before = rng.draws;
    // `turn` is ignored by the resolver unless vehicle.guidance >= 1, which
    // is exactly why the loadout screen hides the slider in that case.
    const outcome = resolveLaunch(
      vehicle,
      mission,
      // Altitude contracts fly vertical whatever the slider says (the loadout
      // does not offer it for them).
      { fuelFraction: view.fuelFraction, turn: view.turn, window: view.window, vertical: mission.requirement.altitude !== undefined },
      rng,
      target ? { target } : {},
    );

    let next = recordLaunch(state, mission, outcome, rng.draws - before);
    const afterOutcome = applyOutcome(next, mission, outcome);
    const delta = {
      funds: afterOutcome.funds - next.funds,
      reputation: afterOutcome.reputation - next.reputation,
    };
    next = afterOutcome;

    // New offers for the next round.
    next = withFreshContracts(next);

    view.outcome = outcome;
    view.mission = mission;
    view.delta = delta;
    view.ticker = [];
    view.pending = next;
    view.playing = true;
    view.name = 'launch';
    renderScreen();
    actionsEl.innerHTML = actionsHtml();

    const canvas = screenEl.querySelector('#ascent');
    const tickerEl = screenEl.querySelector('[data-ticker]');

    const appendTicker = (ev) => {
      const li = document.createElement('li');
      li.className = `tick ${ev.kind}`;
      li.textContent = `${tickTime(ev.t)}  ${ev.text}`;
      tickerEl.appendChild(li);
      tickerEl.scrollTop = tickerEl.scrollHeight;
    };

    /** Playback is over — on whichever view was last holding the canvas. */
    const flightDone = () => {
      view.playing = false;
      view.handle = null;
      // The outcome is committed when the flight finishes, not when it is
      // resolved: the HUD would otherwise announce the payout before the
      // player has watched the rocket earn it.
      if (view.pending) {
        const committed = view.pending;
        view.pending = null;
        update(committed);
      }
      actionsEl.innerHTML = actionsHtml();
    };

    /**
     * The handoff (ARCHITECTURE.md, phase 2). On a target mission the ascent
     * view stops at the `insertion` event and the SAME canvas is handed to the
     * map view, which plays the orbital phase from there. A flight that never
     * inserted has no such event: the ascent plays to its end as it always
     * did, and this never runs.
     */
    const toMapView = () => {
      view.handle = playOrbital(canvas, outcome, {
        target,
        onEvent: appendTicker,
        onDone: flightDone,
      });
    };

    view.handle = playOutcome(canvas, outcome, {
      // The whole requirement, not just an altitude: phase 1 missions ask for
      // downrange or an orbit, and the marker has to say which. A target
      // mission is flown to the TARGET's periapsis (which is what the
      // resolver cuts the ascent off at), and that orbit is state — known
      // before the flight, so marking it leaks nothing.
      requirement: target
        ? { orbit: { periapsis: target.periapsis } }
        : mission.requirement,
      // The sprite needs to know it is a stack before the first separation;
      // that comes from the vehicle, never from the outcome (js/ui/ascent.js).
      stages: vehicle?.stages?.length ?? 1,
      stopAtKind: target ? 'insertion' : undefined,
      onEvent: appendTicker,
      onDone: () => {
        // Read AFTER the ascent has played: by now the insertion either
        // happened on screen or the flight ended without one.
        if (target && outcome.insertion && outcome.orbital) toMapView();
        else flightDone();
      },
    });
  }

  function afterResult() {
    const state = getState();
    const met = tierGoalMet(state, tierGoals);
    // `best.wins` is per-tier (state.js; save.js's migrations[1] promotes the
    // old single `winShown` boolean into wins[1]), and it is written when the
    // player acknowledges the win, not when it is displayed — see
    // continueFromWin, where advanceTier does the writing.
    if (met && !(state.best.wins ?? {})[state.tier]) {
      show('win');
      return;
    }
    show('contracts');
  }

  /**
   * Continue from a tier win. If there is a tier above this one, advanceTier
   * takes it (which also records the win in best.wins), its cleared board is
   * refilled from the new tier's pool, and the interstitial explains what
   * changed. If there is not — tier 2 is where phase 1 stops — the win is
   * recorded, the tier stays put, and the player goes back to the board.
   */
  function continueFromWin() {
    const state = getState();
    const tier = state.tier;
    if (tierGoals[tier + 1]) {
      // The screen is switched BEFORE the commit so update()'s repaint draws
      // the interstitial, not one frame of a win screen for a tier the player
      // has already left.
      view.name = 'tier';
      update(withFreshContracts(advanceTier(state)));
      return;
    }
    update({
      ...state,
      best: { ...state.best, wins: { ...(state.best.wins ?? {}), [tier]: true } },
    });
    show('contracts');
  }

  // ---- input -------------------------------------------------------------

  function onScreenActivate(ev) {
    const tab = ev.target.closest?.('[data-tab]');
    if (tab) {
      show(tab.getAttribute('data-tab'));
      return;
    }
    const contract = ev.target.closest?.('[data-contract]');
    if (contract) {
      view.contractId = contract.getAttribute('data-contract');
      render();
    }
  }

  screenEl.addEventListener('click', onScreenActivate);
  screenEl.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.closest?.('[data-tab],[data-contract]')) {
      ev.preventDefault();
      onScreenActivate(ev);
    }
  });

  screenEl.addEventListener('input', (ev) => {
    const slider = ev.target.closest?.('[data-loadout]');
    if (!slider) return;
    // Repaint the numbers without rebuilding the input (which would drop the
    // thumb mid-drag).
    const which = slider.getAttribute('data-loadout');
    if (which === 'fuelFraction') {
      view.fuelFraction = Number(slider.value);
      const readout = screenEl.querySelector('[data-loadout-readout]');
      if (readout) readout.textContent = `${Math.round(view.fuelFraction * 100)}%`;
      updateLoadoutNumbers();
    } else if (which === 'turn') {
      view.turn = Number(slider.value);
      const readout = screenEl.querySelector('[data-turn-readout]');
      if (readout) readout.textContent = view.turn.toFixed(2);
      const hint = screenEl.querySelector('[data-turn-hint]');
      if (hint) hint.textContent = turnProgramText(view.turn);
    } else if (which === 'window') {
      view.window = Number(slider.value);
      const readout = screenEl.querySelector('[data-window-readout]');
      if (readout) readout.textContent = `${Math.round(view.window * 360)}°`;
      const hint = screenEl.querySelector('[data-window-hint]');
      if (hint) {
        const mission = selectedMission();
        const target = needsTarget(mission) ? findTarget(getState(), targetKind(mission)) : null;
        hint.textContent = windowHintText(view.window, target);
      }
    }
  });

  function updateLoadoutNumbers() {
    if (view.name !== 'loadout' || !vehicle) return;
    const ff = view.fuelFraction;
    const dv = totalDeltaV(vehicle, ff);
    const wet = vehicle.stages.reduce((m, s) => m + s.dryMass + s.propMass * ff, vehicle.payloadMass);
    const twr = wet > 0 ? (vehicle.stages[0]?.thrust ?? 0) / (wet * G0) : 0;
    const dds = screenEl.querySelectorAll('.stats dd');
    if (dds.length >= 4) {
      dds[1].textContent = ms(dv);
      dds[2].textContent = `${Math.round(wet)} kg`;
      dds[3].textContent = twr.toFixed(2);
      dds[3].className = twr < 1 ? 'bad' : '';
    }
  }

  actionsEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute('data-action');
    if (action === 'select') show('loadout');
    else if (action === 'launch') doLaunch();
    else if (action === 'back') show('contracts');
    else if (action === 'continue') {
      if (view.name === 'launch') show('result');
      else if (view.name === 'result') afterResult();
      else if (view.name === 'win') continueFromWin();
      else show('contracts');
    }
  });

  // ---- first paint -------------------------------------------------------
  view.contractId = getState().contracts?.[0] ?? null;
  // Through show(), not render(): show('contracts') is where a save that
  // already won its tier gets moved up, and a boot is the first place that
  // matters.
  show(view.name);

  return { render, show, view };
}
