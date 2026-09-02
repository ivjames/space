// Ledger: funds, reputation, resources. Pure — every function returns a
// new state, never mutates its input. See ARCHITECTURE.md.

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// credit(state, { funds, reputation, resources }) -> new state
// Adds funds and resources, adds (or subtracts, if negative) reputation,
// clamped to [0, 100].
export function credit(state, { funds = 0, reputation = 0, resources = {} } = {}) {
  const newResources = { ...state.resources };
  for (const [key, amount] of Object.entries(resources)) {
    newResources[key] = (newResources[key] ?? 0) + amount;
  }
  return {
    ...state,
    funds: state.funds + funds,
    reputation: clamp(state.reputation + reputation, 0, 100),
    resources: newResources,
  };
}

// canAfford(state, cost) -> boolean
// cost: { funds?: number, resources?: { [key]: number } }
export function canAfford(state, cost = {}) {
  const funds = cost.funds ?? 0;
  if (state.funds < funds) return false;
  const resources = cost.resources ?? {};
  for (const [key, amount] of Object.entries(resources)) {
    if ((state.resources[key] ?? 0) < amount) return false;
  }
  return true;
}

// debit(state, cost) -> new state; throws if unaffordable.
export function debit(state, cost = {}) {
  if (!canAfford(state, cost)) {
    throw new Error(`cannot debit: unaffordable cost ${JSON.stringify(cost)}`);
  }
  const funds = cost.funds ?? 0;
  const resources = cost.resources ?? {};
  const newResources = { ...state.resources };
  for (const [key, amount] of Object.entries(resources)) {
    newResources[key] = (newResources[key] ?? 0) - amount;
  }
  return {
    ...state,
    funds: state.funds - funds,
    resources: newResources,
  };
}

// applyOutcome(state, mission, outcome) -> new state
// Success: credit the payout and the reputation gain.
// Failure: no payout, apply the reputation loss.
export function applyOutcome(state, mission, outcome) {
  if (outcome.success) {
    return credit(state, { funds: mission.payout, reputation: mission.repGain });
  }
  return credit(state, { reputation: -mission.repLoss });
}
