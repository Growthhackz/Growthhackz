import { ledger } from '../db/repositories.js';
import { fromMicros, toMicros } from '../lib/money.js';
import { nowIso, type ServiceContext } from './context.js';

export async function getBalanceSummary(ctx: ServiceContext) {
  const provider = await ctx.provider.getBalance();
  const totals = ledger.totals(ctx.db);
  const lowBalance = provider.balanceMicros < toMicros(ctx.config.LOW_BALANCE_ALERT_USD);
  if (lowBalance) {
    ctx.log.warn({ balanceUsd: fromMicros(provider.balanceMicros) }, 'provider balance is low');
  }
  return {
    provider: ctx.provider.name,
    balanceUsd: fromMicros(provider.balanceMicros),
    currency: provider.currency,
    lowBalance,
    lowBalanceThresholdUsd: ctx.config.LOW_BALANCE_ALERT_USD,
    ledger: {
      fundedUsd: fromMicros(totals.fundedMicros),
      spentUsd: fromMicros(totals.spentMicros),
    },
  };
}

/** Record a manual top-up of the provider account, for bookkeeping. */
export function recordFunding(ctx: ServiceContext, amountUsd: number, note?: string): void {
  ledger.add(ctx.db, {
    kind: 'funding',
    amount_micros: toMicros(amountUsd),
    order_id: null,
    campaign_id: null,
    note: note ?? null,
    created_at: nowIso(ctx),
  });
}
