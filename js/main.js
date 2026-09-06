// Boot: load the save (or start a new game) -> build state -> mount the UI.
//
// This module is the only place in the codebase allowed to be
// non-deterministic: the seed comes from crypto.getRandomValues here, and
// from nowhere else. Everything downstream is a pure function of
// { seed, draws } plus the player's choices (ARCHITECTURE.md §Constraints).

import { makeStorage } from './core/save.js';
import { newGame, deriveVehicle } from './core/state.js';
import { tick } from './core/clock.js';
import { accrue } from './core/base.js';
import { autoHaul } from './core/haul.js';
import { siteById } from './data/sites.js';
import { loadTree } from './core/tree.js';
import { generateContracts, boardStale } from './core/contracts.js';
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

/**
 * Fill state.contracts if it is empty or stale (js/core/contracts.js,
 * boardStale), advancing the saved draw count. The board is normally only
 * redrawn after a launch, so a save made before a gate was added (or
 * tightened) would otherwise keep showing a contract that cannot be flown
 * until the player burns a launch on it. screens.js applies the same test
 * every time the contracts screen is shown, which is what catches a
 * purchase made on the tree tab.
 */
function ensureContracts(s) {
  if (!boardStale(s, missions)) return s;
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

/**
 * Run the production clock forward to now, once, and report what accrued.
 *
 * THIS IS THE ONLY PLACE IN THE GAME THAT READS A CLOCK, and it is here for
 * the same reason the seed is: this module is the one allowed to be
 * non-deterministic. js/core/clock.js is named for the clock and deliberately
 * never reads one — `now` goes in as an argument, so every accrual test is a
 * pure function of two integers.
 *
 * The order matters. `tick` stamps `lastTick` whether or not anything accrued,
 * so a fresh or migrated save (`lastTick: null`) starts its clock here and is
 * paid nothing; every tick after it pays the elapsed time, clamped to a day.
 * Then each base runs for that long against its own site, and — once the
 * routing node is owned (phase 4) — the base-to-depot route runs itself over
 * the same interval, out of the same tanks, at the same ratio a manual run
 * pays. Automation buys away the launch, never the physics.
 *
 * @returns {{ elapsed, produced, full, hauled }} the summary the base tab
 *   shows as "while you were away"
 */
async function runClock(s, now, vehicle) {
  const { state: stamped, elapsed } = tick(s, now);
  const produced = { water: 0, fuel: 0, oxidizer: 0, metals: 0 };
  const full = new Set();
  let hauled = 0;
  if (elapsed <= 0) return { state: stamped, summary: { elapsed, produced, full: [], hauled } };

  const bases = { ...(stamped.bases ?? {}) };
  let objects = stamped.objects ?? [];
  let resources = { ...stamped.resources };
  const depot = objects.find((o) => o.kind === 'depot' && o.store) ?? null;

  for (const [siteId, base] of Object.entries(bases)) {
    const site = siteById(siteId);
    if (!site) continue;
    const run = accrue(base, site, elapsed);
    bases[siteId] = run.base;
    for (const [res, amount] of Object.entries(run.produced)) produced[res] += amount;
    for (const res of run.full) full.add(res);

    if ((vehicle?.autoHaul ?? 0) >= 1 && depot) {
      const move = autoHaul(vehicle, bases[siteId], elapsed, depot.id);
      if (move) {
        const store = { ...bases[siteId].store };
        for (const [res, amount] of Object.entries(move.drawn)) {
          store[res] = Math.max(0, (store[res] ?? 0) - amount);
        }
        bases[siteId] = { ...bases[siteId], store };
        for (const [res, amount] of Object.entries(move.delivered)) {
          resources[res] = (resources[res] ?? 0) + amount;
        }
        objects = objects.map((o) => (o.id === depot.id && o.store
          ? {
            ...o,
            store: {
              ...o.store,
              fuel: (o.store.fuel ?? 0) + move.delivered.fuel,
              oxidizer: (o.store.oxidizer ?? 0) + move.delivered.oxidizer,
            },
          }
          : o));
        hauled += move.cargo;
        // A route that is running itself is not a route whose tanks are
        // stuck full, which is exactly what the player bought.
        for (const res of ['fuel', 'oxidizer']) full.delete(res);
      }
    }
  }

  return {
    state: {
      ...stamped, bases, objects, resources,
    },
    summary: { elapsed, produced, full: [...full], hauled },
  };
}

/**
 * "Storage full" (DESIGN.md §8). Fires while a route is manual and stops once
 * it is automated, which is what the player is buying — so it is not called at
 * all when `autoHaul` is owned, and `runClock` above clears the propellant
 * tanks from `full` in that case for the same reason.
 *
 * Best effort and silent when refused: the Notifications API needs a
 * permission this game never interrupts anyone to ask for. The base tab is
 * where it is offered, and a player who says no simply gets the on-screen
 * warning instead.
 */
function notifyStorageFull(full) {
  if (full.length === 0) return;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // eslint-disable-next-line no-new
    new Notification('Storage full', {
      body: `${full.join(', ')} at capacity — production has stopped until it is hauled.`,
      tag: 'space.storage-full',
    });
  } catch (err) {
    console.warn('could not post a notification:', err);
  }
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

  // The clock runs once at boot, after the UI exists so the result can be
  // shown, and again whenever the page comes back to the foreground — which
  // is the case that matters on a phone, where "closing the game" is
  // switching away from it and the app is never reloaded.
  const advanceClock = async () => {
    const vehicle = await deriveVehicle(state, tree, baseVehicle);
    const { state: next, summary } = await runClock(state, Date.now(), vehicle);
    update(next);
    screens.reportAccrual(summary);
    if (!((vehicle?.autoHaul ?? 0) >= 1)) notifyStorageFull(summary.full);
    if (screens.view.name === 'base') screens.render();
  };
  advanceClock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') advanceClock();
  });

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
    cheat: ({ funds = 0, reputation = 0 } = {}) => { update(credit(state, { funds, reputation })); },
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
