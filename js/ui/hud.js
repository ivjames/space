// Persistent HUD strip: funds, reputation, launches this tier.
//
// Browser-only (js/ui), imports nothing from js/core — it is handed a state
// object and only reads it. The stable selectors the smoke test uses
// (ARCHITECTURE.md §UI hooks) are [data-hud="funds"|"reputation"|"launches"].

/**
 * Mount the HUD into `el` and return a render function.
 *
 * @param {HTMLElement} el
 * @returns {(state: object) => void} render
 */
export function mountHud(el) {
  el.innerHTML = `
    <div class="hud-item">
      <span class="hud-label">FUNDS</span>
      <span class="hud-value" data-hud="funds">0</span>
    </div>
    <div class="hud-item">
      <span class="hud-label">REP</span>
      <span class="hud-value" data-hud="reputation">0</span>
    </div>
    <div class="hud-item">
      <span class="hud-label">LAUNCHES</span>
      <span class="hud-value" data-hud="launches">0</span>
    </div>
  `;

  const fundsEl = el.querySelector('[data-hud="funds"]');
  const repEl = el.querySelector('[data-hud="reputation"]');
  const launchEl = el.querySelector('[data-hud="launches"]');

  return function render(state) {
    if (!state) return;
    fundsEl.textContent = String(Math.round(state.funds ?? 0));
    repEl.textContent = String(Math.round(state.reputation ?? 0));
    // "launches this tier" — the per-tier counter is also the tier's score
    // (DESIGN.md §11), so the HUD shows the current tier's count, not a total.
    launchEl.textContent = String(state.launches?.[state.tier] ?? 0);
  };
}
