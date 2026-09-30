import { saveState, loadState } from './state.js';

/**
 * Trade loop — NOT IMPLEMENTED.
 *
 * Deliberately left as a stub. Repeated buy/sell round trips against a pool
 * you seeded yourself is wash trading regardless of how the report is
 * labeled, and it is not authored here.
 */
export async function runTrades(ctx) {
  throw new Error('runTrades not implemented — see comment in src/loop.js');
}

export async function resumeTrades(ctx) {
  const state = await loadState(ctx.statePath);
  if (!state) throw new Error(`no run state at ${ctx.statePath}`);
  if (state.tradeIndex >= ctx.settings.tradeCount) return state;
  return runTrades({ ...ctx, state });
}
