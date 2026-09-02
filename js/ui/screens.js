// Screen flow: contracts -> loadout -> launch -> result -> (tree | contracts | win).
//
// One screen is in #screen at a time, carrying data-screen; the primary
// action lives in #actions carrying data-action (ARCHITECTURE.md §UI hooks).
// Everything here is presentation and sequencing — every state transition is
// a js/core call whose new state is handed back to main.js through update().

import { makeRng } from '../core/rng.js';
import { resolveLaunch } from '../core/resolver.js';
import { totalDeltaV, G0 } from '../core/vehicle.js';
import { recordLaunch, tierGoalMet, deriveVehicle } from '../core/state.js';
import { applyOutcome } from '../core/economy.js';
import { generateContracts } from '../core/contracts.js';
import { playOutcome } from './ascent.js';
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
    fuelFraction: 1,
    outcome: null,
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

  function contractsHtml() {
    const state = getState();
    const g = goal();
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
            <div class="hint">${km(m.requirement.altitude)} · ${escapeHtml(rep)}</div>
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
            best so far ${km(state.best.maxAltitude)}
          </p>
          <ul class="list">${rows}</ul>
          <p class="hint foot">Tap a contract, then Select.</p>
        </div>
      </div>`;
  }

  function loadoutHtml() {
    const mission = selectedMission();
    const ff = view.fuelFraction;
    const dv = vehicle ? totalDeltaV(vehicle, ff) : 0;
    const stages = vehicle?.stages?.length ?? 0;
    const wet = vehicle
      ? vehicle.stages.reduce((m, s) => m + s.dryMass + s.propMass * ff, vehicle.payloadMass)
      : 0;
    const twr = vehicle && wet > 0 ? (vehicle.stages[0]?.thrust ?? 0) / (wet * G0) : 0;

    return `
      <div class="screen" data-screen="loadout">
        <div class="pad">
          <h1 class="title">${escapeHtml(mission?.name ?? 'Loadout')}</h1>
          <p class="hint">Target ${mission ? km(mission.requirement.altitude) : '—'} · payout ${mission?.payout ?? 0}</p>

          <dl class="stats">
            <div><dt>Stages</dt><dd>${stages}</dd></div>
            <div><dt>Delta-v</dt><dd>${ms(dv)}</dd></div>
            <div><dt>Liftoff mass</dt><dd>${Math.round(wet)} kg</dd></div>
            <div><dt>Liftoff TWR</dt><dd class="${twr < 1 ? 'bad' : ''}">${twr.toFixed(2)}</dd></div>
          </dl>

          <div class="field">
            <label class="field-label" for="ff">
              <span>Fuel load</span>
              <span class="field-value" data-loadout-readout>${Math.round(ff * 100)}%</span>
            </label>
            <input id="ff" type="range" data-loadout="fuelFraction"
                   min="0.5" max="1" step="0.05" value="${ff}">
            <p class="hint">Less fuel is lighter and burns shorter; more fuel is more delta-v but a heavier, slower climb.</p>
          </div>
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
    const points = [];
    if (o?.failure) {
      points.push(`<p class="hint points" data-points-at="reliability">Reliability upgrades reduce this.</p>`);
    } else if (o && !o.success) {
      points.push(`<p class="hint points" data-points-at="propulsion">More delta-v: propulsion raises thrust and isp…</p>`);
      points.push(`<p class="hint points" data-points-at="structure">…or structure adds propellant and, later, a second stage.</p>`);
    }

    const kind = o?.success ? 'success' : o?.failure ? 'failure' : 'short';
    return `
      <div class="screen" data-screen="result">
        <div class="pad">
          <p class="hint">${escapeHtml(mission?.name ?? '')} · launch ${state.launches[state.tier]}</p>
          <p class="readout ${kind}" data-readout="${kind}">${escapeHtml(o?.readout ?? '')}</p>
          ${points.join('')}
          <dl class="stats">
            <div><dt>Apogee</dt><dd>${km(o?.maxAltitude ?? 0)}</dd></div>
            <div><dt>Max speed</dt><dd>${ms(o?.maxSpeed ?? 0)}</dd></div>
            <div><dt>Delta-v used</dt><dd>${ms(o?.deltaVAchieved ?? 0)}</dd></div>
            ${o && !o.success ? `<div><dt>Short by</dt><dd>${ms(o.shortBy)}</dd></div>` : ''}
          </dl>
          <p class="ledger">
            <span class="${delta.funds > 0 ? 'good' : 'muted'}">${delta.funds > 0 ? `+${delta.funds}` : '+0'} funds</span>
            <span class="${delta.reputation > 0 ? 'good' : delta.reputation < 0 ? 'bad' : 'muted'}">${delta.reputation > 0 ? '+' : ''}${delta.reputation} rep</span>
          </p>
          <p class="hint">Best altitude ${km(state.best.maxAltitude)} of ${km(goal()?.requirement.altitude ?? 0)}.</p>
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
    return `
      <div class="screen" data-screen="win">
        <div class="pad win-pad">
          <p class="hint">TIER ${state.tier} COMPLETE</p>
          <p class="readout success">Reached ${km(g?.requirement.altitude ?? 100000)} in ${state.launches[state.tier]} launches</p>
          <p class="hint">Best altitude ${km(state.best.maxAltitude)}. Fewer launches is the better score.</p>
          <p class="hint">Tier 2 asks for orbital velocity rather than altitude. Phase 0 stops here.</p>
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
    if (view.handle && name !== 'launch') {
      view.handle.stop();
      view.handle = null;
      view.playing = false;
    }
    view.name = name;
    if (name === 'contracts') {
      // Offers are regenerated after every launch, so a stale selection has
      // to fall back to something that is actually on the board.
      const offered = getState().contracts ?? [];
      if (!offered.includes(view.contractId)) view.contractId = offered[0] ?? null;
    }
    if (name === 'loadout' || name === 'launch') await ensureVehicle();
    render();
  }

  // ---- the launch itself -------------------------------------------------

  async function doLaunch() {
    const state = getState();
    const mission = selectedMission();
    if (!mission) return;
    await ensureVehicle();

    // One rng for the whole turn, resumed from the save's draw count so a
    // reload replays identically (ARCHITECTURE.md §rng).
    const rng = makeRng(state.seed, state.draws);
    const before = rng.draws;
    const outcome = resolveLaunch(vehicle, mission, { fuelFraction: view.fuelFraction }, rng);

    let next = recordLaunch(state, mission, outcome, rng.draws - before);
    const afterOutcome = applyOutcome(next, mission, outcome);
    const delta = {
      funds: afterOutcome.funds - next.funds,
      reputation: afterOutcome.reputation - next.reputation,
    };
    next = afterOutcome;

    // New offers for the next round, drawn from the same rng, with the draws
    // they consume folded back into the save.
    const drawsBefore = rng.draws;
    const contracts = generateContracts(next, missions, rng);
    next = { ...next, contracts, draws: next.draws + (rng.draws - drawsBefore) };

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
      li.textContent = `T+${String(Math.round(ev.t)).padStart(3, ' ')}s  ${ev.text}`;
      tickerEl.appendChild(li);
      tickerEl.scrollTop = tickerEl.scrollHeight;
    };

    view.handle = playOutcome(canvas, outcome, {
      requirement: mission.requirement?.altitude ?? 0,
      // The sprite needs to know it is a stack before the first separation;
      // that comes from the vehicle, never from the outcome (js/ui/ascent.js).
      stages: vehicle?.stages?.length ?? 1,
      onEvent: appendTicker,
      onDone: () => {
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
      },
    });
  }

  function afterResult() {
    const state = getState();
    const met = tierGoalMet(state, tierGoals);
    if (met && !state.best.winShown) {
      // `best` is spread through by recordLaunch and round-trips through the
      // save untouched, so the "already celebrated" flag lives there rather
      // than in a second storage key.
      update({ ...state, best: { ...state.best, winShown: true } });
      show('win');
      return;
    }
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
    const slider = ev.target.closest?.('[data-loadout="fuelFraction"]');
    if (!slider) return;
    view.fuelFraction = Number(slider.value);
    // Repaint the numbers without rebuilding the input (which would drop the
    // thumb mid-drag).
    const readout = screenEl.querySelector('[data-loadout-readout]');
    if (readout) readout.textContent = `${Math.round(view.fuelFraction * 100)}%`;
    updateLoadoutNumbers();
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
      else show('contracts');
    }
  });

  // ---- first paint -------------------------------------------------------
  view.contractId = getState().contracts?.[0] ?? null;
  render();

  return { render, show, view };
}
