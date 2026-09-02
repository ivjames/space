// Tech tree UI: one section per branch, one full-width row per node.
// Never a pan/zoom graph (DESIGN.md §10, §15).
//
// Rows carry the stable hooks the smoke test uses:
//   .row[data-node="<id>"] with class owned | buyable | locked
// Tapping a buyable row buys it and re-renders; the caller's state update
// refreshes the HUD.

import { branches, canBuy, buy } from '../core/tree.js';

const STAT_LABELS = {
  thrust: 'thrust',
  isp: 'isp',
  reliability: 'reliability',
  propMass: 'propellant',
  dryMass: 'dry mass',
  payloadMass: 'payload',
  dragArea: 'drag area',
  dragCoeff: 'drag',
};

const MASS_STATS = new Set(['propMass', 'dryMass', 'payloadMass']);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 'stages.0.thrust' -> 'thrust'; 'stages.1.reliability' -> 'S2 reliability'. */
function statLabel(path) {
  const parts = String(path).split('.');
  if (parts[0] === 'stages') {
    const idx = Number(parts[1]);
    const key = parts[2];
    const label = STAT_LABELS[key] ?? key;
    return Number.isFinite(idx) && idx > 0 ? `S${idx + 1} ${label}` : label;
  }
  const key = parts[parts.length - 1];
  return STAT_LABELS[key] ?? key;
}

function signed(n, unit = '') {
  const sign = n < 0 ? '−' : '+';
  const mag = Math.abs(n);
  const shown = Number.isInteger(mag) ? String(mag) : String(Math.round(mag * 10) / 10);
  return `${sign}${shown}${unit}`;
}

/**
 * One effect as a compact phrase: "thrust +20%", "propellant +15 kg",
 * "reliability ×1.08", "+1 stage".
 * @param {object} effect
 * @returns {string}
 */
export function effectSummary(effect) {
  if (!effect || typeof effect !== 'object') return '';
  if (effect.addStage) return '+1 stage';
  const label = statLabel(effect.stat);
  const key = String(effect.stat).split('.').pop();
  if (effect.op === 'mul') {
    // Reliability reads better as a multiplier than as a percentage of a
    // probability ("reliability +8%" invites "8% of what?").
    if (key === 'reliability') {
      return `${label} ×${Math.round(effect.value * 1000) / 1000}`;
    }
    return `${label} ${signed(Math.round((effect.value - 1) * 1000) / 10, '%')}`;
  }
  if (effect.op === 'add') {
    return `${label} ${signed(effect.value, MASS_STATS.has(key) ? ' kg' : '')}`;
  }
  return `${label} = ${effect.value}`;
}

/** The whole effects array as one line. */
export function effectsSummary(effects = []) {
  return effects.map(effectSummary).filter(Boolean).join(', ');
}

function costText(cost = {}) {
  const parts = [];
  if (cost.funds) parts.push(`${cost.funds}`);
  for (const [key, amount] of Object.entries(cost.resources ?? {})) {
    parts.push(`${amount} ${key}`);
  }
  return parts.join(' + ') || 'free';
}

function nodeState(tree, state, node) {
  if (state.owned.includes(node.id)) return 'owned';
  if (canBuy(tree, state, node.id)) return 'buyable';
  return 'locked';
}

function lockReason(tree, state, node) {
  const missing = (node.requires ?? []).filter((r) => !state.owned.includes(r));
  if (missing.length > 0) {
    const names = missing.map((id) => tree.byId.get(id)?.name ?? id);
    return `needs ${names.join(', ')}`;
  }
  return 'not enough funds';
}

/**
 * Mount the shop into `el`.
 *
 * @param {HTMLElement} el
 * @param {object} ctx
 * @param {object} ctx.tree            loadTree() result
 * @param {() => object} ctx.getState
 * @param {(next: object) => void} ctx.update  commits a new state
 * @returns {() => void} render
 */
export function mountShop(el, ctx) {
  const { tree, getState, update } = ctx;

  function render() {
    const state = getState();
    const html = branches(tree).map((branch) => {
      const owned = branch.nodes.filter((n) => state.owned.includes(n.id)).length;
      const rows = branch.nodes.map((node) => {
        const cls = nodeState(tree, state, node);
        // The lock reason lives in the main column, not the side one: it is a
        // sentence, and a sentence in a right-aligned side column squeezes the
        // node's own name down to one character per line on a 360px screen.
        const reason = cls === 'locked'
          ? `<div class="hint row-reason">${escapeHtml(lockReason(tree, state, node))}</div>`
          : '';
        return `
          <li class="row node ${cls}" data-node="${escapeHtml(node.id)}" role="button" tabindex="0">
            <div class="row-main">
              <div class="row-title">${escapeHtml(node.name)}</div>
              <div class="hint row-desc">${escapeHtml(node.desc ?? '')}</div>
              <div class="hint row-effects">${escapeHtml(effectsSummary(node.effects))}</div>
              ${reason}
            </div>
            <div class="row-side">
              <div class="cost">${escapeHtml(cls === 'owned' ? '✓' : costText(node.cost))}</div>
              <div class="hint row-note">${escapeHtml(cls === 'owned' ? 'owned' : cls === 'locked' ? 'locked' : 'buy')}</div>
            </div>
          </li>`;
      }).join('');
      return `
        <section class="branch">
          <h2 class="branch-head">
            <span>${escapeHtml(branch.name)}</span>
            <span class="hint">${owned}/${branch.nodes.length}</span>
          </h2>
          <ul class="list">${rows}</ul>
        </section>`;
    }).join('');

    el.innerHTML = html;
  }

  function onActivate(ev) {
    const row = ev.target.closest?.('[data-node]');
    if (!row || !el.contains(row)) return;
    const id = row.getAttribute('data-node');
    const state = getState();
    if (!canBuy(tree, state, id)) {
      row.classList.add('shake');
      setTimeout(() => row.classList.remove('shake'), 300);
      return;
    }
    update(buy(tree, state, id));
    render();
  }

  el.addEventListener('click', onActivate);
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onActivate(ev);
    }
  });

  render();
  return render;
}
