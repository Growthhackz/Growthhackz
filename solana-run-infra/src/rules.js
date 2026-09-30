import { randomUUID } from 'node:crypto';

// Interval rules fire on a schedule rather than a price move, so they carry a
// floor: a buy rule and a sell rule both firing every minute would just be the
// round-trip volume loop again. Price rules have no floor.
export const MIN_INTERVAL_MINUTES = 15;

const BUY_AMOUNT_TYPES = ['sol', 'pctSol'];
const SELL_AMOUNT_TYPES = ['token', 'pctToken'];

const isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function validateTrade({ side, amountType, amount }) {
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell');
  const types = side === 'buy' ? BUY_AMOUNT_TYPES : SELL_AMOUNT_TYPES;
  if (!types.includes(amountType)) {
    throw new Error(`${side} amountType must be one of ${types.join(', ')}`);
  }
  if (!isPosNum(amount)) throw new Error('amount must be a positive number');
  if (amountType.startsWith('pct') && amount > 100) throw new Error('percent must be ≤ 100');
  return { side, amountType, amount };
}

function validateTrigger(t) {
  if (!t || typeof t !== 'object') throw new Error('trigger required');
  if (t.type === 'priceAbove' || t.type === 'priceBelow') {
    if (!isPosNum(t.price)) throw new Error('trigger price must be a positive number (SOL per token)');
    return { type: t.type, price: t.price };
  }
  if (t.type === 'interval') {
    if (!isPosNum(t.minutes) || t.minutes < MIN_INTERVAL_MINUTES) {
      throw new Error(`interval must be at least ${MIN_INTERVAL_MINUTES} minutes`);
    }
    return { type: 'interval', minutes: t.minutes };
  }
  throw new Error('trigger type must be priceAbove, priceBelow or interval');
}

// Normalizes user input into a stored rule. Runtime fields (runs, lastRunAt,
// armed) are carried over from `prev` when a rule is edited in place.
export function normalizeRule(input, prev) {
  const trade = validateTrade(input);
  const trigger = validateTrigger(input.trigger);
  const maxRuns = input.maxRuns == null || input.maxRuns === ''
    ? null
    : Number(input.maxRuns);
  if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
    throw new Error('maxRuns must be a positive integer or empty');
  }
  const note = typeof input.note === 'string' ? input.note.slice(0, 80) : '';
  return {
    id: prev?.id ?? randomUUID(),
    enabled: input.enabled !== false,
    ...trade,
    trigger,
    repeat: Boolean(input.repeat),
    maxRuns,
    note,
    runs: prev?.runs ?? 0,
    lastRunAt: prev?.lastRunAt ?? null,
    armed: prev?.armed ?? true
  };
}

export function normalizeRules(list, prevRules = []) {
  if (!Array.isArray(list)) throw new Error('rules must be an array');
  if (list.length > 50) throw new Error('at most 50 rules per wallet');
  const byId = new Map(prevRules.map((r) => [r.id, r]));
  return list.map((r, i) => {
    try { return normalizeRule(r, byId.get(r.id)); }
    catch (e) { throw new Error(`rule ${i + 1}: ${e.message}`); }
  });
}

// Decides whether a rule fires now. Returns the rule's next runtime state and
// whether to trade. Price rules fire when the price crosses the level; with
// `repeat` they re-arm once the price moves back across it.
export function evaluateRule(rule, { price, now }) {
  if (!rule.enabled) return { fire: false, next: rule };
  if (rule.maxRuns !== null && rule.runs >= rule.maxRuns) {
    return { fire: false, next: { ...rule, enabled: false } };
  }

  const t = rule.trigger;
  if (t.type === 'interval') {
    const due = rule.lastRunAt == null || now - rule.lastRunAt >= t.minutes * 60_000;
    return { fire: due, next: rule };
  }

  if (price == null) return { fire: false, next: rule };
  const hit = t.type === 'priceAbove' ? price >= t.price : price <= t.price;
  if (!hit) return { fire: false, next: rule.armed ? rule : { ...rule, armed: true } };
  if (!rule.armed) return { fire: false, next: rule };
  return { fire: true, next: { ...rule, armed: false } };
}

// State after a rule's trade finished (successfully or not).
export function afterRun(rule, { now, ok }) {
  const runs = ok ? rule.runs + 1 : rule.runs;
  const oneShotPrice = rule.trigger.type !== 'interval' && !rule.repeat;
  const exhausted = rule.maxRuns !== null && runs >= rule.maxRuns;
  return {
    ...rule,
    runs,
    lastRunAt: now,
    enabled: rule.enabled && !(ok && (oneShotPrice || exhausted))
  };
}
