import { events, orders, refills, type RefillRow } from '../db/repositories.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { ProviderRejectedError } from '../providers/types.js';
import { nowIso, type ServiceContext } from './context.js';

/** Ask the provider to top an order back up (for drops) while its refill guarantee is open. */
export async function requestRefill(ctx: ServiceContext, orderId: string, reason: 'manual' | 'auto'): Promise<RefillRow> {
  const order = orders.get(ctx.db, orderId);
  if (!order) throw new NotFoundError('Order');
  if (!order.provider_order_id || !['completed', 'partial'].includes(order.status)) {
    throw new ConflictError(`Order is ${order.status}; refills are only possible after delivery`);
  }
  if (!order.refill_days) throw new ConflictError('This service has no refill guarantee');
  if (order.refill_until && order.refill_until < nowIso(ctx)) {
    throw new ConflictError(`Refill window closed on ${order.refill_until}`);
  }

  const now = nowIso(ctx);
  const row: RefillRow = {
    id: newId('rfl'),
    order_id: orderId,
    provider_refill_id: null,
    status: 'requested',
    error: null,
    requested_at: now,
    updated_at: now,
  };
  try {
    const { providerRefillId } = await ctx.provider.refill(order.provider_order_id);
    row.provider_refill_id = providerRefillId;
    row.status = 'pending';
  } catch (err) {
    row.status = err instanceof ProviderRejectedError ? 'rejected' : 'error';
    row.error = err instanceof Error ? err.message : String(err);
  }
  refills.insert(ctx.db, row);
  // Record the attempt either way so auto-refill doesn't hammer a rejecting order.
  orders.update(ctx.db, orderId, { last_refill_at: now }, now);
  events.add(ctx.db, orderId, 'refill_requested', row.error ?? `Provider refill ${row.provider_refill_id}`, { reason, status: row.status }, now);
  return row;
}

export async function runAutoRefills(ctx: ServiceContext): Promise<number> {
  const now = ctx.clock.now();
  const lastBefore = new Date(now.getTime() - ctx.config.AUTO_REFILL_EVERY_DAYS * 86_400_000).toISOString();
  const due = orders.dueForAutoRefill(ctx.db, now.toISOString(), lastBefore);
  for (const o of due) {
    try {
      await requestRefill(ctx, o.id, 'auto');
    } catch (err) {
      ctx.log.warn({ orderId: o.id, err: String(err) }, 'auto refill failed');
    }
  }
  return due.length;
}

export async function pollOpenRefills(ctx: ServiceContext): Promise<number> {
  const open = refills.open(ctx.db);
  for (const r of open) {
    try {
      const state = await ctx.provider.getRefillStatus(r.provider_refill_id!);
      if (state.status !== r.status) {
        const now = nowIso(ctx);
        refills.updateStatus(ctx.db, r.id, state.status, state.error ?? null, now);
        events.add(ctx.db, r.order_id, 'refill_status', `Refill ${r.provider_refill_id}: ${state.status}`, undefined, now);
      }
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        refills.updateStatus(ctx.db, r.id, 'error', err.message, nowIso(ctx));
      } else {
        ctx.log.warn({ refillId: r.id, err: String(err) }, 'refill status check failed');
      }
    }
  }
  return open.length;
}
