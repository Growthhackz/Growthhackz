import { transaction } from '../db/database.js';
import { events, ledger, orders, type OrderRow } from '../db/repositories.js';
import { ACTIVE_STATUSES, type OrderStatus } from '../domain/products.js';
import { NotFoundError } from '../lib/errors.js';
import type { ProviderOrderState, ProviderOrderStatus } from '../providers/types.js';
import { isoPlus, nowIso, type ServiceContext } from './context.js';

const TERMINAL_PROVIDER: readonly ProviderOrderStatus[] = ['completed', 'partial', 'canceled'];
const POLL_BATCH = 500;

/** Apply a provider status snapshot to our order row. Returns true if anything meaningful changed. */
export function applyProviderState(ctx: ServiceContext, order: OrderRow, state: ProviderOrderState): boolean {
  const now = nowIso(ctx);
  const nowMs = ctx.clock.now().getTime();
  const { POLL_MIN_BACKOFF_MS: minBackoff, POLL_MAX_BACKOFF_MS: maxBackoff } = ctx.config;
  const backoff = Math.min(maxBackoff, Math.max(minBackoff, (order.poll_backoff_ms ?? minBackoff) * 2));

  if (state.error || state.status === 'unknown') {
    const message = state.error ?? `Unrecognized provider status "${state.rawStatus}"`;
    transaction(ctx.db, () => {
      orders.update(ctx.db, order.id, { last_error: message, next_poll_at: isoPlus(ctx, backoff), poll_backoff_ms: backoff }, now);
      if (order.last_error !== message) events.add(ctx.db, order.id, 'poll_error', message, state, now);
    });
    return false;
  }

  const newStatus: OrderStatus = state.status;
  const statusChanged = newStatus !== order.status;
  const progressChanged = state.remains !== order.remains || state.startCount !== order.start_count;
  const terminal = TERMINAL_PROVIDER.includes(state.status);

  transaction(ctx.db, () => {
    const patch: Partial<OrderRow> = {
      status: newStatus,
      provider_status_raw: state.rawStatus,
      start_count: state.startCount,
      remains: state.remains,
      charge_micros: state.chargeMicros ?? order.charge_micros,
      currency: state.currency ?? order.currency,
      last_error: null,
    };
    if (terminal) {
      patch.next_poll_at = null;
      patch.poll_backoff_ms = null;
      patch.completed_at = order.completed_at ?? now;
      if (state.status !== 'canceled' && order.refill_days && !order.refill_until) {
        patch.refill_until = new Date(nowMs + order.refill_days * 86_400_000).toISOString();
      }
    } else {
      const next = statusChanged || progressChanged ? minBackoff : backoff;
      patch.next_poll_at = isoPlus(ctx, next);
      patch.poll_backoff_ms = next;
    }
    orders.update(ctx.db, order.id, patch, now);

    // Keep the ledger's recorded spend for this order equal to the provider's latest charge.
    if (state.chargeMicros !== null) {
      const recorded = ledger.orderSpend(ctx.db, order.id);
      const delta = state.chargeMicros - recorded;
      if (delta !== 0) {
        ledger.add(ctx.db, {
          kind: 'adjustment',
          amount_micros: delta,
          order_id: order.id,
          campaign_id: order.campaign_id,
          note: `provider charge now ${state.chargeMicros} micros (${state.rawStatus})`,
          created_at: now,
        });
      }
    }

    if (statusChanged || progressChanged) {
      events.add(
        ctx.db,
        order.id,
        statusChanged ? 'status_changed' : 'progress',
        statusChanged ? `${order.status} → ${newStatus}` : null,
        { rawStatus: state.rawStatus, remains: state.remains, startCount: state.startCount, charge: state.chargeMicros },
        now,
      );
    }
  });

  if (statusChanged && terminal) {
    ctx.log.info({ orderId: order.id, status: newStatus, remains: state.remains }, 'order finished');
  }
  return statusChanged || progressChanged;
}

/** Poll every active order whose next_poll_at has passed. */
export async function pollDueOrders(ctx: ServiceContext): Promise<{ polled: number; changed: number }> {
  const due = orders.dueForPoll(ctx.db, ACTIVE_STATUSES, nowIso(ctx), POLL_BATCH);
  if (due.length === 0) return { polled: 0, changed: 0 };
  const states = await ctx.provider.getStatuses(due.map((o) => o.provider_order_id!));
  let changed = 0;
  for (const order of due) {
    const state = states.get(order.provider_order_id!);
    if (!state) {
      const backoff = Math.min(ctx.config.POLL_MAX_BACKOFF_MS, (order.poll_backoff_ms ?? ctx.config.POLL_MIN_BACKOFF_MS) * 2);
      orders.update(ctx.db, order.id, { next_poll_at: isoPlus(ctx, backoff), poll_backoff_ms: backoff }, nowIso(ctx));
      continue;
    }
    if (applyProviderState(ctx, order, state)) changed++;
  }
  flagStuckOrders(ctx);
  return { polled: due.length, changed };
}

/** Poll one order right now, regardless of schedule. */
export async function refreshOrder(ctx: ServiceContext, orderId: string): Promise<OrderRow> {
  const order = orders.get(ctx.db, orderId);
  if (!order) throw new NotFoundError('Order');
  if (!order.provider_order_id) return order;
  const states = await ctx.provider.getStatuses([order.provider_order_id]);
  const state = states.get(order.provider_order_id);
  if (state) applyProviderState(ctx, order, state);
  return orders.get(ctx.db, orderId)!;
}

/** Poll every active order in a campaign right now. */
export async function refreshCampaign(ctx: ServiceContext, campaignId: string): Promise<number> {
  const active = orders
    .byCampaign(ctx.db, campaignId)
    .filter((o) => ACTIVE_STATUSES.includes(o.status) && o.provider_order_id);
  if (active.length === 0) return 0;
  const states = await ctx.provider.getStatuses(active.map((o) => o.provider_order_id!));
  for (const o of active) {
    const state = states.get(o.provider_order_id!);
    if (state) applyProviderState(ctx, o, state);
  }
  return active.length;
}

export function flagStuckOrders(ctx: ServiceContext): number {
  const cutoff = new Date(ctx.clock.now().getTime() - ctx.config.STUCK_PENDING_HOURS * 3_600_000).toISOString();
  const stuck = orders.stuckPending(ctx.db, cutoff);
  const now = nowIso(ctx);
  for (const o of stuck) {
    orders.update(ctx.db, o.id, { stuck_flagged: 1 }, now);
    events.add(ctx.db, o.id, 'stuck', `Still pending after ${ctx.config.STUCK_PENDING_HOURS}h`, undefined, now);
    ctx.log.warn({ orderId: o.id, providerOrderId: o.provider_order_id }, 'order stuck in pending');
  }
  return stuck.length;
}
