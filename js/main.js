// Boot: load the save (or start a new game) -> build state -> mount the UI.
//
// This module is the only place in the codebase allowed to be
// non-deterministic: the seed comes from crypto.getRandomValues here, and
// from nowhere else. Everything downstream is a pure function of
// { seed, draws } plus the player's choices (ARCHITECTURE.md §Constraints).

import { makeStorage } from './core/save.js';
import { newGame } from './core/state.js';
import { loadTree } from './core/tree.js';
import { generateContracts } from './core/contracts.js';
import { credit } from './core/economy.js';
import { makeRng } from './core/rng.js';
import { nodes } from './data/tree.js';
import { missions, tierGoals } from './data/missions.js';
import { baseVehicle } from './data/components.js';
import { mountHud } from './ui/hud.js';
import { mountScreens } from './ui/screens.js';

const hudEl = document.getElementById('hud');
const screenEl = document.getElementById('screen');
const actionsEl = document.getElementById('actions');

/** A random uint32 for a new game's seed. */
function freshSeed() {
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] >>> 0;
  } catch {
    // No crypto (very old browser, exotic embedding): any uint32 will do —
    // the seed only has to differ between games, not be unguessable.
    return (Date.now() ^ (performance.now() * 1000)) >>> 0;
  }
}

/** In-memory stand-in for localStorage: private mode, or a blocked origin. */
function memoryBackend() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// Safari in private mode throws on localStorage *access*, not just on write,
// so even reaching for the object is wrapped.
function makeSafeStorage() {
  try {
    const probe = '__space.probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return { storage: makeStorage(window.localStorage), persistent: true };
  } catch (err) {
    console.warn('localStorage unavailable; progress will not persist:', err);
    return { storage: makeStorage(memoryBackend()), persistent: false };
  }
}

const { storage, persistent } = makeSafeStorage();

let state = null;
let renderHud = null;
let screens = null;

function save() {
  try {
    storage.save(state);
  } catch (err) {
    // A full quota must not take the game down mid-flight.
    console.warn('could not save:', err);
  }
}

/** Commit a new state: save it, then repaint the HUD and the current screen. */
function update(next) {
  state = typeof next === 'function' ? next(state) : next;
  save();
  if (renderHud) renderHud(state);
  if (screens) screens.render();
}

/** Fill state.contracts if it is empty, advancing the saved draw count. */
function ensureContracts(s) {
  if (Array.isArray(s.contracts) && s.contracts.length > 0) return s;
  const rng = makeRng(s.seed, s.draws);
  const before = rng.draws;
  const contracts = generateContracts(s, missions, rng);
  return { ...s, contracts, draws: s.draws + (rng.draws - before) };
}

/**
 * A save that will not load is reported, never silently replaced
 * (js/core/save.js throws a descriptive Error, DESIGN §save). The player is
 * told what happened and gets the one button that can fix it.
 */
function showCorruptNotice(err) {
  hudEl.innerHTML = '';
  actionsEl.innerHTML = '';
  screenEl.innerHTML = `
    <div class="screen" data-screen="notice">
      <div class="pad">
        <h1 class="title">Save not loaded</h1>
        <p class="hint notice-msg"></p>
        <p class="hint">Your progress could not be read. Starting a new game
          replaces it; nothing else here can recover it.</p>
        <button class="btn-primary" data-action="new-game">START NEW GAME</button>
      </div>
    </div>`;
  screenEl.querySelector('.notice-msg').textContent = String(err?.message ?? err);
  screenEl.querySelector('[data-action="new-game"]').addEventListener('click', () => {
    try {
      storage.clear();
    } catch (clearErr) {
      console.warn('could not clear the save:', clearErr);
    }
    boot(newGame(freshSeed()));
  });
}

function boot(initial) {
  state = ensureContracts(initial);

  const tree = loadTree(nodes);

  hudEl.innerHTML = '';
  screenEl.innerHTML = '';
  actionsEl.innerHTML = '';

  renderHud = mountHud(hudEl);
  screens = mountScreens({
    screenEl,
    actionsEl,
    getState: () => state,
    update,
    tree,
    missions,
    tierGoals,
    components: baseVehicle,
  });

  renderHud(state);
  save();

  // Tests only (ARCHITECTURE.md §UI hooks). `state` is a getter because every
  // core call returns a NEW state object — a snapshot handed out once would
  // go stale on the first launch.
  window.__space = {
    get state() { return state; },
    tree,
    missions,
    tierGoals,
    persistent,
    // The screen flow itself, so a test can read the current view (its name,
    // the loadout it holds, the last outcome). Tests only; no UI reads this.
    screens,
    // Tests only: credit funds so a smoke test can buy without grinding.
    cheat: ({ funds = 0 } = {}) => { update(credit(state, { funds })); },
  };
}

let loaded = null;
let unreadable = false;
try {
  loaded = storage.load();
} catch (err) {
  unreadable = true;
  console.warn('save could not be loaded:', err);
  showCorruptNotice(err);
}

if (!unreadable) boot(loaded ?? newGame(freshSeed()));
