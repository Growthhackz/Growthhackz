import type { CampaignRow, CatalogRow, LedgerRow, MappingRow, OrderEventRow, OrderRow, RefillRow } from '../db/repositories.js';
import { ACTIVE_STATUSES, type OrderStatus } from '../domain/products.js';
import { fromMicros } from '../lib/money.js';

const usd = (micros: number | null) => (micros === null ? null : fromMicros(micros));
const parse = (json: string | null) => (json ? (JSON.parse(json) as unknown) : null);

export function presentOrder(o: OrderRow) {
  return {
    id: o.id,
    campaignId: o.campaign_id,
    product: o.product,
    type: o.order_type,
    status: o.status,
    provider: o.provider,
    serviceId: o.service_id,
    geo: o.geo,
    premium: o.premium === 1,
    link: o.link,
    quantity: o.quantity,
    params: parse(o.params),
    ratePer1000Usd: usd(o.rate_per_1000_micros),
    estimatedCostUsd: usd(o.estimated_cost_micros),
    chargeUsd: usd(o.charge_micros),
    currency: o.currency,
    providerOrderId: o.provider_order_id,
    providerStatus: o.provider_status_raw,
    startCount: o.start_count,
    remains: o.remains,
    delivered: o.remains === null ? null : Math.max(0, o.quantity - o.remains),
    lastError: o.last_error,
    stuck: o.stuck_flagged === 1,
    autoRefill: o.auto_refill === 1,
    refillDays: o.refill_days,
    refillUntil: o.refill_until,
    lastRefillAt: o.last_refill_at,
    submittedAt: o.submitted_at,
    completedAt: o.completed_at,
    nextPollAt: o.next_poll_at,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

export function deriveCampaignStatus(orders: OrderRow[]): string {
  const statuses = new Set<OrderStatus>(orders.map((o) => o.status));
  if (statuses.has('needs_review') || statuses.has('failed')) return 'attention';
  if ([...statuses].some((s) => ACTIVE_STATUSES.includes(s) || s === 'submitting')) return 'active';
  if (statuses.has('draft')) return 'draft';
  return 'finished';
}

export function presentCampaign(c: CampaignRow, orders: OrderRow[], spentMicros: number) {
  const counts: Record<string, number> = {};
  for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
  return {
    id: c.id,
    name: c.name,
    notes: c.notes,
    status: deriveCampaignStatus(orders),
    budgetUsd: usd(c.budget_micros),
    estimatedCostUsd: fromMicros(orders.reduce((s, o) => s + o.estimated_cost_micros, 0)),
    spentUsd: fromMicros(spentMicros),
    autoRefill: c.auto_refill === 1,
    metadata: parse(c.metadata),
    orderCounts: counts,
    orders: orders.map(presentOrder),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export function presentEvent(e: OrderEventRow) {
  return { id: e.id, type: e.type, message: e.message, data: parse(e.data), createdAt: e.created_at };
}

export function presentRefill(r: RefillRow) {
  return {
    id: r.id,
    providerRefillId: r.provider_refill_id,
    status: r.status,
    error: r.error,
    requestedAt: r.requested_at,
    updatedAt: r.updated_at,
  };
}

export function presentCatalog(s: CatalogRow) {
  return {
    serviceId: s.service_id,
    name: s.name,
    category: s.category,
    type: s.raw_type,
    orderType: s.order_type,
    ratePer1000Usd: fromMicros(s.rate_per_1000_micros),
    min: s.min_qty,
    max: s.max_qty,
    refill: s.refill === 1,
    refillDays: s.refill_days,
    cancel: s.cancel === 1,
    dripfeed: s.dripfeed === 1,
    active: s.active === 1,
    syncedAt: s.synced_at,
  };
}

export function presentMapping(m: MappingRow, svc?: CatalogRow) {
  return {
    product: m.product,
    geo: m.geo,
    premium: m.premium === 1,
    serviceId: m.service_id,
    serviceName: svc?.name ?? null,
    serviceActive: svc ? svc.active === 1 : false,
    updatedAt: m.updated_at,
  };
}

export function presentLedger(l: LedgerRow) {
  return {
    id: l.id,
    kind: l.kind,
    amountUsd: fromMicros(l.amount_micros),
    orderId: l.order_id,
    campaignId: l.campaign_id,
    note: l.note,
    createdAt: l.created_at,
  };
}
