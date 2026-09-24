import { transaction } from '../db/database.js';
import { campaigns, events, ledger, orders, type CampaignRow, type OrderRow } from '../db/repositories.js';
import { LinkError, normalizeLink, normalizeTwitterHandle, type NormalizedLink } from '../domain/links.js';
import { PRODUCT_SPECS, type Geo, type OrderType } from '../domain/products.js';
import type { CreateCampaignInput, OrderInput } from '../domain/schemas.js';
import { ConflictError, InsufficientFundsError, NotFoundError, ValidationError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { costForUnits, fromMicros, toMicros } from '../lib/money.js';
import { ProviderRejectedError, type AddOrderRequest } from '../providers/types.js';
import { resolveService } from './catalogService.js';
import { isoPlus, nowIso, type ServiceContext } from './context.js';

interface PlannedOrder {
  row: OrderRow;
}

/** Validate an order against the catalog and turn it into a draft row. Makes no provider calls except catalog sync. */
async function planOrder(
  ctx: ServiceContext,
  campaign: { id: string; name: string; autoRefill: boolean; geo?: Geo; premium?: boolean },
  input: OrderInput,
  index: number,
): Promise<PlannedOrder> {
  const spec = PRODUCT_SPECS[input.product];
  const orderType: OrderType = input.type ?? spec.defaultType;
  const geo: Geo = input.geo ?? campaign.geo ?? 'any';
  const premium = spec.supportsPremium ? (input.premium ?? campaign.premium ?? false) : false;
  const at = `orders[${index}]`;

  const svc = await resolveService(ctx, {
    product: input.product,
    orderType,
    geo,
    premium,
    serviceIdOverride: input.serviceId,
  });

  let target: NormalizedLink | null = null;
  const params: Record<string, unknown> = {};
  try {
    if (orderType === 'subscription') {
      const handle = normalizeTwitterHandle(input.username!);
      params.username = handle;
      target = { link: `https://x.com/${handle}`, key: `twitter:@${handle.toLowerCase()}` };
    } else {
      const utm =
        input.product === 'website_traffic' && input.utm !== false
          ? { source: ctx.config.TRAFFIC_UTM_SOURCE, medium: ctx.config.TRAFFIC_UTM_MEDIUM, campaign: slug(campaign.name) }
          : undefined;
      target = normalizeLink(spec.linkKind, input.link!, utm);
    }
  } catch (err) {
    if (err instanceof LinkError) throw new ValidationError(`${at}: ${err.message}`);
    throw err;
  }

  // Units delivered, used for min/max checks and the cost estimate.
  let quantity: number;
  let billedUnits: number;
  switch (orderType) {
    case 'default':
      quantity = billedUnits = input.quantity!;
      checkRange(at, 'quantity', quantity, svc.min_qty, svc.max_qty);
      break;
    case 'drip_feed':
      checkRange(at, 'quantity per run', input.quantity!, svc.min_qty, svc.max_qty);
      params.runs = input.runs;
      params.intervalMinutes = input.intervalMinutes;
      params.quantityPerRun = input.quantity;
      quantity = billedUnits = input.quantity! * input.runs!;
      break;
    case 'custom_comments':
      params.comments = input.comments;
      quantity = billedUnits = input.comments!.length;
      checkRange(at, 'number of comments', quantity, svc.min_qty, svc.max_qty);
      break;
    case 'subscription':
      checkRange(at, 'min', input.min!, svc.min_qty, svc.max_qty);
      checkRange(at, 'max', input.max!, svc.min_qty, svc.max_qty);
      Object.assign(params, {
        min: input.min,
        max: input.max,
        posts: input.posts,
        delayMinutes: input.delayMinutes ?? 0,
        expiry: input.expiry,
      });
      quantity = input.max! * input.posts!;
      // Worst case: every post gets `max`.
      billedUnits = quantity;
      break;
  }

  const now = nowIso(ctx);
  const refillDays = svc.refill ? (svc.refill_days ?? (ctx.config.DEFAULT_REFILL_DAYS || null)) : null;
  const row: OrderRow = {
    id: newId('ord'),
    campaign_id: campaign.id,
    product: input.product,
    order_type: orderType,
    provider: ctx.provider.name,
    service_id: svc.service_id,
    geo,
    premium: premium ? 1 : 0,
    link: target.link,
    link_key: target.key,
    quantity,
    params: JSON.stringify(params),
    rate_per_1000_micros: svc.rate_per_1000_micros,
    estimated_cost_micros: costForUnits(svc.rate_per_1000_micros, billedUnits),
    status: 'draft',
    provider_order_id: null,
    provider_status_raw: null,
    start_count: null,
    remains: null,
    charge_micros: null,
    currency: null,
    last_error: null,
    submit_attempted_at: null,
    submitted_at: null,
    completed_at: null,
    next_poll_at: null,
    poll_backoff_ms: null,
    stuck_flagged: 0,
    refill_days: refillDays,
    refill_until: null,
    auto_refill: (input.autoRefill ?? campaign.autoRefill) && refillDays ? 1 : 0,
    last_refill_at: null,
    created_at: now,
    updated_at: now,
  };
  return { row };
}

function checkRange(at: string, label: string, value: number, min: number, max: number): void {
  if ((min && value < min) || (max && value > max)) {
    throw new ValidationError(`${at}: ${label} ${value} is outside the service range ${min}–${max}`);
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'campaign';
}

export interface CreateCampaignResult {
  campaign: CampaignRow;
  replayed: boolean;
}

export async function createCampaign(
  ctx: ServiceContext,
  input: CreateCampaignInput,
  idempotencyKey?: string,
): Promise<CreateCampaignResult> {
  if (idempotencyKey) {
    const existing = campaigns.getByIdempotencyKey(ctx.db, idempotencyKey);
    if (existing) return { campaign: existing, replayed: true };
  }

  const campaignId = newId('cmp');
  const planned: PlannedOrder[] = [];
  for (const [i, orderInput] of input.orders.entries()) {
    planned.push(
      await planOrder(
        ctx,
        {
          id: campaignId,
          name: input.name,
          autoRefill: input.autoRefill ?? false,
          geo: input.targeting?.geo,
          premium: input.targeting?.premium,
        },
        orderInput,
        i,
      ),
    );
  }

  // Panels reject (or mis-count) a second active order on the same target for the same product.
  const seen = new Set<string>();
  for (const [i, { row }] of planned.entries()) {
    const key = `${row.product}|${row.link_key}`;
    if (seen.has(key)) throw new ConflictError(`orders[${i}]: duplicate ${row.product} order for ${row.link} in this campaign`);
    seen.add(key);
    const clash = orders.activeWithLinkKey(ctx.db, row.link_key!, row.product);
    if (clash.length > 0) {
      throw new ConflictError(`orders[${i}]: ${row.product} for ${row.link} already has an active order`, {
        orderIds: clash.map((o) => o.id),
      });
    }
  }

  const estimate = planned.reduce((s, p) => s + p.row.estimated_cost_micros, 0);
  const budgetMicros = input.budgetUsd === undefined ? null : toMicros(input.budgetUsd);
  if (budgetMicros !== null && estimate > budgetMicros) {
    throw new ValidationError(
      `Estimated cost $${fromMicros(estimate).toFixed(4)} exceeds budget $${fromMicros(budgetMicros).toFixed(2)}`,
    );
  }

  const now = nowIso(ctx);
  const campaign: CampaignRow = {
    id: campaignId,
    name: input.name,
    notes: input.notes ?? null,
    budget_micros: budgetMicros,
    auto_refill: input.autoRefill ? 1 : 0,
    metadata: JSON.stringify({ ...(input.metadata ?? {}), targeting: input.targeting ?? {} }),
    idempotency_key: idempotencyKey ?? null,
    created_at: now,
    updated_at: now,
  };
  try {
    transaction(ctx.db, () => {
      campaigns.insert(ctx.db, campaign);
      for (const { row } of planned) {
        orders.insert(ctx.db, row);
        events.add(ctx.db, row.id, 'created', null, { serviceId: row.service_id, estimate: row.estimated_cost_micros }, now);
      }
    });
  } catch (err) {
    // Two concurrent requests with the same key: the loser returns the winner's campaign.
    if (idempotencyKey && String(err).includes('UNIQUE')) {
      const existing = campaigns.getByIdempotencyKey(ctx.db, idempotencyKey);
      if (existing) return { campaign: existing, replayed: true };
    }
    throw err;
  }

  if (input.submit !== false) await submitCampaign(ctx, campaignId);
  return { campaign, replayed: false };
}

/** Submit every draft order in a campaign. Checks the provider balance covers the whole batch first. */
export async function submitCampaign(ctx: ServiceContext, campaignId: string): Promise<OrderRow[]> {
  if (!campaigns.get(ctx.db, campaignId)) throw new NotFoundError('Campaign');
  const drafts = orders.byCampaign(ctx.db, campaignId).filter((o) => o.status === 'draft');
  if (drafts.length === 0) return [];
  await assertFunds(ctx, drafts.reduce((s, o) => s + o.estimated_cost_micros, 0));
  const out: OrderRow[] = [];
  for (const d of drafts) out.push(await submitDraft(ctx, d.id));
  return out;
}

export async function submitOrder(ctx: ServiceContext, orderId: string): Promise<OrderRow> {
  const order = orders.get(ctx.db, orderId);
  if (!order) throw new NotFoundError('Order');
  if (order.status !== 'draft') throw new ConflictError(`Order is ${order.status}; only draft orders can be submitted`);
  await assertFunds(ctx, order.estimated_cost_micros);
  return submitDraft(ctx, orderId);
}

async function assertFunds(ctx: ServiceContext, neededMicros: number): Promise<void> {
  const { balanceMicros } = await ctx.provider.getBalance();
  const buffer = toMicros(ctx.config.MIN_BALANCE_BUFFER_USD);
  if (balanceMicros - neededMicros < buffer) {
    throw new InsufficientFundsError(
      `Provider balance $${fromMicros(balanceMicros).toFixed(4)} does not cover estimated $${fromMicros(neededMicros).toFixed(4)}` +
        (buffer ? ` plus the $${fromMicros(buffer).toFixed(2)} buffer` : ''),
      { balanceUsd: fromMicros(balanceMicros), neededUsd: fromMicros(neededMicros) },
    );
  }
}

function toAddRequest(o: OrderRow): AddOrderRequest {
  const p = JSON.parse(o.params) as Record<string, unknown>;
  switch (o.order_type) {
    case 'default':
      return { type: 'default', serviceId: o.service_id, link: o.link!, quantity: o.quantity };
    case 'drip_feed':
      return {
        type: 'drip_feed',
        serviceId: o.service_id,
        link: o.link!,
        quantity: p.quantityPerRun as number,
        runs: p.runs as number,
        intervalMinutes: p.intervalMinutes as number,
      };
    case 'custom_comments':
      return { type: 'custom_comments', serviceId: o.service_id, link: o.link!, comments: p.comments as string[] };
    case 'subscription':
      return {
        type: 'subscription',
        serviceId: o.service_id,
        username: p.username as string,
        min: p.min as number,
        max: p.max as number,
        posts: p.posts as number,
        delayMinutes: (p.delayMinutes as number) ?? 0,
        expiry: p.expiry as string | undefined,
      };
  }
}

/**
 * Send one draft to the provider.
 *
 * `add` is not idempotent on the panel side, so the order is marked `submitting`
 * before the call and is never retried automatically. If we can't tell whether
 * the panel created it, the order goes to `needs_review` for a human to reconcile.
 */
async function submitDraft(ctx: ServiceContext, orderId: string): Promise<OrderRow> {
  const claimed = orders.transition(ctx.db, orderId, 'draft', { status: 'submitting', submit_attempted_at: nowIso(ctx) }, nowIso(ctx));
  if (!claimed) return orders.get(ctx.db, orderId)!;
  const order = orders.get(ctx.db, orderId)!;

  try {
    const { providerOrderId } = await ctx.provider.addOrder(toAddRequest(order));
    const now = nowIso(ctx);
    transaction(ctx.db, () => {
      orders.update(
        ctx.db,
        orderId,
        {
          status: 'pending',
          provider_order_id: providerOrderId,
          submitted_at: now,
          last_error: null,
          next_poll_at: isoPlus(ctx, ctx.config.POLL_MIN_BACKOFF_MS),
          poll_backoff_ms: ctx.config.POLL_MIN_BACKOFF_MS,
        },
        now,
      );
      ledger.add(ctx.db, {
        kind: 'estimate',
        amount_micros: order.estimated_cost_micros,
        order_id: orderId,
        campaign_id: order.campaign_id,
        note: `estimate at submit (provider order ${providerOrderId})`,
        created_at: now,
      });
      events.add(ctx.db, orderId, 'submitted', `Provider order ${providerOrderId}`, { providerOrderId }, now);
    });
    ctx.log.info({ orderId, providerOrderId }, 'order submitted');
  } catch (err) {
    const now = nowIso(ctx);
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderRejectedError) {
      orders.update(ctx.db, orderId, { status: 'failed', last_error: message }, now);
      events.add(ctx.db, orderId, 'rejected', message, undefined, now);
      ctx.log.warn({ orderId, err: message }, 'provider rejected order');
    } else {
      orders.update(ctx.db, orderId, { status: 'needs_review', last_error: message }, now);
      events.add(
        ctx.db,
        orderId,
        'needs_review',
        'Submission outcome unknown; check the provider dashboard before resubmitting',
        { error: message },
        now,
      );
      ctx.log.error({ orderId, err: message }, 'order submission outcome unknown');
    }
  }
  return orders.get(ctx.db, orderId)!;
}

/** Reconcile an order in `needs_review` after checking the provider dashboard. */
export function resolveReview(
  ctx: ServiceContext,
  orderId: string,
  resolution: { resolution: 'exists'; providerOrderId: string } | { resolution: 'not_created'; note?: string },
): OrderRow {
  const order = orders.get(ctx.db, orderId);
  if (!order) throw new NotFoundError('Order');
  if (order.status !== 'needs_review') throw new ConflictError(`Order is ${order.status}, not needs_review`);
  const now = nowIso(ctx);
  transaction(ctx.db, () => {
    if (resolution.resolution === 'exists') {
      orders.update(
        ctx.db,
        orderId,
        {
          status: 'pending',
          provider_order_id: resolution.providerOrderId,
          submitted_at: order.submit_attempted_at ?? now,
          last_error: null,
          next_poll_at: now,
          poll_backoff_ms: ctx.config.POLL_MIN_BACKOFF_MS,
        },
        now,
      );
      ledger.add(ctx.db, {
        kind: 'estimate',
        amount_micros: order.estimated_cost_micros,
        order_id: orderId,
        campaign_id: order.campaign_id,
        note: `estimate after manual reconcile (provider order ${resolution.providerOrderId})`,
        created_at: now,
      });
      events.add(ctx.db, orderId, 'reconciled', `Linked to provider order ${resolution.providerOrderId}`, undefined, now);
    } else {
      // Back to draft so it can be resubmitted deliberately.
      orders.update(ctx.db, orderId, { status: 'draft', last_error: null, submit_attempted_at: null }, now);
      events.add(ctx.db, orderId, 'reconciled', resolution.note ?? 'Confirmed not created; returned to draft', undefined, now);
    }
  });
  return orders.get(ctx.db, orderId)!;
}

/** Orders left in `submitting` by a crash can't be trusted either way. */
export function recoverInterruptedSubmissions(ctx: ServiceContext): number {
  const stuck = orders.withStatus(ctx.db, 'submitting');
  const now = nowIso(ctx);
  for (const o of stuck) {
    if (orders.transition(ctx.db, o.id, 'submitting', { status: 'needs_review', last_error: 'Interrupted during submission' }, now)) {
      events.add(ctx.db, o.id, 'needs_review', 'Service restarted during submission; check the provider dashboard', undefined, now);
    }
  }
  if (stuck.length) ctx.log.warn({ count: stuck.length }, 'interrupted submissions moved to needs_review');
  return stuck.length;
}

export async function cancelOrder(ctx: ServiceContext, orderId: string): Promise<OrderRow> {
  const order = orders.get(ctx.db, orderId);
  if (!order) throw new NotFoundError('Order');
  const now = nowIso(ctx);
  if (order.status === 'draft') {
    orders.transition(ctx.db, orderId, 'draft', { status: 'canceled', completed_at: now }, now);
    events.add(ctx.db, orderId, 'canceled', 'Canceled before submission', undefined, now);
    return orders.get(ctx.db, orderId)!;
  }
  if (!['pending', 'in_progress', 'processing'].includes(order.status) || !order.provider_order_id) {
    throw new ConflictError(`Order is ${order.status} and cannot be canceled`);
  }
  const res = await ctx.provider.cancel([order.provider_order_id]);
  const outcome = res.get(order.provider_order_id);
  if (!outcome?.ok) {
    const reason = outcome?.error ?? 'no response for this order';
    events.add(ctx.db, orderId, 'cancel_rejected', reason, undefined, now);
    throw new ConflictError(`Provider refused cancel: ${reason}`);
  }
  // Final status and refund arrive through the next poll.
  orders.update(ctx.db, orderId, { next_poll_at: now }, now);
  events.add(ctx.db, orderId, 'cancel_requested', null, undefined, now);
  return orders.get(ctx.db, orderId)!;
}
