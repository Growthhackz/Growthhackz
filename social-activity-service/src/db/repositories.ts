import type { OrderStatus, OrderType, Product } from '../domain/products.js';
import type { ProviderCallRecord } from '../providers/followiz/client.js';
import type { ProviderService } from '../providers/types.js';
import { all, get, run, type Db } from './database.js';

export interface CampaignRow {
  id: string;
  name: string;
  notes: string | null;
  budget_micros: number | null;
  auto_refill: number;
  metadata: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderRow {
  id: string;
  campaign_id: string;
  product: Product;
  order_type: OrderType;
  provider: string;
  service_id: string;
  geo: string;
  premium: number;
  link: string | null;
  link_key: string | null;
  quantity: number;
  params: string;
  rate_per_1000_micros: number;
  estimated_cost_micros: number;
  status: OrderStatus;
  provider_order_id: string | null;
  provider_status_raw: string | null;
  start_count: number | null;
  remains: number | null;
  charge_micros: number | null;
  currency: string | null;
  last_error: string | null;
  submit_attempted_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  next_poll_at: string | null;
  poll_backoff_ms: number | null;
  stuck_flagged: number;
  refill_days: number | null;
  refill_until: string | null;
  auto_refill: number;
  last_refill_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderEventRow {
  id: number;
  order_id: string;
  type: string;
  message: string | null;
  data: string | null;
  created_at: string;
}

export interface RefillRow {
  id: string;
  order_id: string;
  provider_refill_id: string | null;
  status: string;
  error: string | null;
  requested_at: string;
  updated_at: string;
}

export interface CatalogRow {
  provider: string;
  service_id: string;
  name: string;
  category: string;
  raw_type: string;
  order_type: string;
  rate_per_1000_micros: number;
  min_qty: number;
  max_qty: number;
  refill: number;
  cancel: number;
  dripfeed: number;
  refill_days: number | null;
  active: number;
  synced_at: string;
}

export interface MappingRow {
  product: Product;
  geo: string;
  premium: number;
  provider: string;
  service_id: string;
  updated_at: string;
}

export interface LedgerRow {
  id: number;
  kind: 'funding' | 'estimate' | 'adjustment';
  amount_micros: number;
  order_id: string | null;
  campaign_id: string | null;
  note: string | null;
  created_at: string;
}

// ---------------------------------------------------------------- campaigns

export const campaigns = {
  insert(db: Db, row: CampaignRow): void {
    run(
      db,
      `INSERT INTO campaigns (id, name, notes, budget_micros, auto_refill, metadata, idempotency_key, created_at, updated_at)
       VALUES (:id, :name, :notes, :budget_micros, :auto_refill, :metadata, :idempotency_key, :created_at, :updated_at)`,
      { ...row },
    );
  },
  get(db: Db, id: string): CampaignRow | undefined {
    return get<CampaignRow>(db, 'SELECT * FROM campaigns WHERE id = :id', { id });
  },
  getByIdempotencyKey(db: Db, key: string): CampaignRow | undefined {
    return get<CampaignRow>(db, 'SELECT * FROM campaigns WHERE idempotency_key = :key', { key });
  },
  list(db: Db, limit: number, offset: number): CampaignRow[] {
    return all<CampaignRow>(db, 'SELECT * FROM campaigns ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset', {
      limit,
      offset,
    });
  },
};

// ------------------------------------------------------------------- orders

export const orders = {
  insert(db: Db, row: OrderRow): void {
    const cols = Object.keys(row);
    run(db, `INSERT INTO orders (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`, { ...row });
  },
  get(db: Db, id: string): OrderRow | undefined {
    return get<OrderRow>(db, 'SELECT * FROM orders WHERE id = :id', { id });
  },
  byCampaign(db: Db, campaignId: string): OrderRow[] {
    return all<OrderRow>(db, 'SELECT * FROM orders WHERE campaign_id = :campaignId ORDER BY created_at, id', {
      campaignId,
    });
  },
  /** Patch columns; only keys present in `patch` are written. */
  update(db: Db, id: string, patch: Partial<Omit<OrderRow, 'id'>>, now: string): void {
    const entries = Object.entries({ ...patch, updated_at: now });
    const set = entries.map(([k]) => `${k} = :${k}`).join(', ');
    run(db, `UPDATE orders SET ${set} WHERE id = :__id`, { ...Object.fromEntries(entries), __id: id });
  },
  /** Compare-and-set on status, so two workers can't both act on the same transition. */
  transition(db: Db, id: string, from: OrderStatus, patch: Partial<Omit<OrderRow, 'id'>>, now: string): boolean {
    const entries = Object.entries({ ...patch, updated_at: now });
    const set = entries.map(([k]) => `${k} = :${k}`).join(', ');
    return (
      run(db, `UPDATE orders SET ${set} WHERE id = :__id AND status = :__from`, {
        ...Object.fromEntries(entries),
        __id: id,
        __from: from,
      }).changes === 1
    );
  },
  dueForPoll(db: Db, statuses: readonly OrderStatus[], now: string, limit: number): OrderRow[] {
    const placeholders = statuses.map((_, i) => `:s${i}`).join(', ');
    const params: Record<string, unknown> = { now, limit };
    statuses.forEach((s, i) => (params[`s${i}`] = s));
    return all<OrderRow>(
      db,
      `SELECT * FROM orders
       WHERE status IN (${placeholders}) AND provider_order_id IS NOT NULL
         AND (next_poll_at IS NULL OR next_poll_at <= :now)
       ORDER BY next_poll_at IS NOT NULL, next_poll_at LIMIT :limit`,
      params,
    );
  },
  activeWithLinkKey(db: Db, linkKey: string, product: string): OrderRow[] {
    return all<OrderRow>(
      db,
      `SELECT * FROM orders WHERE link_key = :linkKey AND product = :product
         AND status IN ('draft', 'submitting', 'pending', 'in_progress', 'processing', 'needs_review')`,
      { linkKey, product },
    );
  },
  list(db: Db, status: OrderStatus | undefined, limit: number, offset: number): OrderRow[] {
    return all<OrderRow>(
      db,
      `SELECT * FROM orders WHERE (:status IS NULL OR status = :status)
       ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset`,
      { status: status ?? null, limit, offset },
    );
  },
  withStatus(db: Db, status: OrderStatus): OrderRow[] {
    return all<OrderRow>(db, 'SELECT * FROM orders WHERE status = :status ORDER BY created_at', { status });
  },
  /** Delivered orders still inside their refill guarantee with auto-refill on. */
  dueForAutoRefill(db: Db, now: string, lastRefillBefore: string): OrderRow[] {
    return all<OrderRow>(
      db,
      `SELECT * FROM orders
       WHERE auto_refill = 1 AND status IN ('completed', 'partial')
         AND refill_until IS NOT NULL AND refill_until > :now
         AND COALESCE(last_refill_at, completed_at) <= :lastRefillBefore`,
      { now, lastRefillBefore },
    );
  },
  stuckPending(db: Db, submittedBefore: string): OrderRow[] {
    return all<OrderRow>(
      db,
      `SELECT * FROM orders WHERE status = 'pending' AND stuck_flagged = 0 AND submitted_at <= :submittedBefore`,
      { submittedBefore },
    );
  },
  countByStatus(db: Db): Array<{ status: OrderStatus; count: number }> {
    return all(db, 'SELECT status, COUNT(*) AS count FROM orders GROUP BY status');
  },
};

// ------------------------------------------------------------------- events

export const events = {
  add(db: Db, orderId: string, type: string, message: string | null, data: unknown, now: string): void {
    run(
      db,
      'INSERT INTO order_events (order_id, type, message, data, created_at) VALUES (:orderId, :type, :message, :data, :now)',
      { orderId, type, message, data: data === undefined ? null : JSON.stringify(data), now },
    );
  },
  forOrder(db: Db, orderId: string): OrderEventRow[] {
    return all<OrderEventRow>(db, 'SELECT * FROM order_events WHERE order_id = :orderId ORDER BY id', { orderId });
  },
};

// ------------------------------------------------------------------ refills

export const refills = {
  insert(db: Db, row: RefillRow): void {
    run(
      db,
      `INSERT INTO refills (id, order_id, provider_refill_id, status, error, requested_at, updated_at)
       VALUES (:id, :order_id, :provider_refill_id, :status, :error, :requested_at, :updated_at)`,
      { ...row },
    );
  },
  forOrder(db: Db, orderId: string): RefillRow[] {
    return all<RefillRow>(db, 'SELECT * FROM refills WHERE order_id = :orderId ORDER BY requested_at', { orderId });
  },
  open(db: Db): RefillRow[] {
    return all<RefillRow>(
      db,
      `SELECT * FROM refills WHERE provider_refill_id IS NOT NULL
         AND lower(status) NOT IN ('completed', 'rejected', 'error', 'canceled', 'failed')`,
    );
  },
  updateStatus(db: Db, id: string, status: string, error: string | null, now: string): void {
    run(db, 'UPDATE refills SET status = :status, error = :error, updated_at = :now WHERE id = :id', {
      id,
      status,
      error,
      now,
    });
  },
};

// ------------------------------------------------------------------ catalog

export const catalog = {
  replaceForProvider(db: Db, provider: string, services: ProviderService[], now: string): void {
    run(db, 'UPDATE catalog_services SET active = 0 WHERE provider = :provider', { provider });
    for (const s of services) {
      run(
        db,
        `INSERT INTO catalog_services
           (provider, service_id, name, category, raw_type, order_type, rate_per_1000_micros, min_qty, max_qty,
            refill, cancel, dripfeed, refill_days, active, synced_at)
         VALUES (:provider, :serviceId, :name, :category, :rawType, :orderType, :rate, :min, :max,
            :refill, :cancel, :dripfeed, :refillDays, 1, :now)
         ON CONFLICT (provider, service_id) DO UPDATE SET
           name = excluded.name, category = excluded.category, raw_type = excluded.raw_type,
           order_type = excluded.order_type, rate_per_1000_micros = excluded.rate_per_1000_micros,
           min_qty = excluded.min_qty, max_qty = excluded.max_qty, refill = excluded.refill,
           cancel = excluded.cancel, dripfeed = excluded.dripfeed, refill_days = excluded.refill_days,
           active = 1, synced_at = excluded.synced_at`,
        {
          provider,
          serviceId: s.serviceId,
          name: s.name,
          category: s.category,
          rawType: s.rawType,
          orderType: s.orderType,
          rate: s.ratePer1000Micros,
          min: s.min,
          max: s.max,
          refill: s.refill,
          cancel: s.cancel,
          dripfeed: s.dripfeed,
          refillDays: s.refillDays,
          now,
        },
      );
    }
  },
  get(db: Db, provider: string, serviceId: string): CatalogRow | undefined {
    return get<CatalogRow>(db, 'SELECT * FROM catalog_services WHERE provider = :provider AND service_id = :serviceId', {
      provider,
      serviceId,
    });
  },
  search(db: Db, provider: string, q: string | undefined, includeInactive: boolean): CatalogRow[] {
    return all<CatalogRow>(
      db,
      `SELECT * FROM catalog_services WHERE provider = :provider
         AND (:q IS NULL OR name LIKE :like OR category LIKE :like)
         AND (:includeInactive = 1 OR active = 1)
       ORDER BY category, name`,
      { provider, q: q ?? null, like: `%${q ?? ''}%`, includeInactive },
    );
  },
  count(db: Db, provider: string): number {
    return get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM catalog_services WHERE provider = :provider AND active = 1', {
      provider,
    })!.n;
  },
};

// ----------------------------------------------------------------- mappings

export const mappings = {
  upsert(db: Db, row: MappingRow): void {
    run(
      db,
      `INSERT INTO product_mappings (product, geo, premium, provider, service_id, updated_at)
       VALUES (:product, :geo, :premium, :provider, :service_id, :updated_at)
       ON CONFLICT (product, geo, premium, provider) DO UPDATE SET
         service_id = excluded.service_id, updated_at = excluded.updated_at`,
      { ...row },
    );
  },
  find(db: Db, provider: string, product: string, geo: string, premium: boolean): MappingRow | undefined {
    return get<MappingRow>(
      db,
      'SELECT * FROM product_mappings WHERE provider = :provider AND product = :product AND geo = :geo AND premium = :premium',
      { provider, product, geo, premium },
    );
  },
  list(db: Db, provider: string): MappingRow[] {
    return all<MappingRow>(db, 'SELECT * FROM product_mappings WHERE provider = :provider ORDER BY product, geo, premium', {
      provider,
    });
  },
  remove(db: Db, provider: string, product: string, geo: string, premium: boolean): boolean {
    return (
      run(
        db,
        'DELETE FROM product_mappings WHERE provider = :provider AND product = :product AND geo = :geo AND premium = :premium',
        { provider, product, geo, premium },
      ).changes === 1
    );
  },
};

// ------------------------------------------------------------------- ledger

export const ledger = {
  add(db: Db, entry: Omit<LedgerRow, 'id'>): void {
    run(
      db,
      `INSERT INTO ledger_entries (kind, amount_micros, order_id, campaign_id, note, created_at)
       VALUES (:kind, :amount_micros, :order_id, :campaign_id, :note, :created_at)`,
      { ...entry },
    );
  },
  /** Recorded spend for an order: estimate + every adjustment so far. */
  orderSpend(db: Db, orderId: string): number {
    return get<{ n: number | null }>(
      db,
      `SELECT SUM(amount_micros) AS n FROM ledger_entries WHERE order_id = :orderId AND kind IN ('estimate', 'adjustment')`,
      { orderId },
    )!.n ?? 0;
  },
  campaignSpend(db: Db, campaignId: string): number {
    return get<{ n: number | null }>(
      db,
      `SELECT SUM(amount_micros) AS n FROM ledger_entries WHERE campaign_id = :campaignId AND kind IN ('estimate', 'adjustment')`,
      { campaignId },
    )!.n ?? 0;
  },
  totals(db: Db): { fundedMicros: number; spentMicros: number } {
    const row = get<{ funded: number | null; spent: number | null }>(
      db,
      `SELECT SUM(CASE WHEN kind = 'funding' THEN amount_micros END) AS funded,
              SUM(CASE WHEN kind IN ('estimate', 'adjustment') THEN amount_micros END) AS spent
       FROM ledger_entries`,
    )!;
    return { fundedMicros: row.funded ?? 0, spentMicros: row.spent ?? 0 };
  },
  recent(db: Db, limit: number): LedgerRow[] {
    return all<LedgerRow>(db, 'SELECT * FROM ledger_entries ORDER BY id DESC LIMIT :limit', { limit });
  },
};

// ----------------------------------------------------------- provider calls

export const providerCalls = {
  add(db: Db, rec: ProviderCallRecord, now: string): void {
    run(
      db,
      `INSERT INTO provider_calls (provider, action, request, http_status, response_body, duration_ms, error, created_at)
       VALUES (:provider, :action, :request, :httpStatus, :responseBody, :durationMs, :error, :now)`,
      {
        provider: rec.provider,
        action: rec.action,
        request: JSON.stringify(rec.request),
        httpStatus: rec.httpStatus,
        // Status and service listings can be large; keep enough to debug.
        responseBody: rec.responseBody === null ? null : rec.responseBody.slice(0, 20_000),
        durationMs: rec.durationMs,
        error: rec.error,
        now,
      },
    );
  },
  recent(db: Db, limit: number, action?: string): Array<Record<string, unknown>> {
    return all(
      db,
      `SELECT * FROM provider_calls WHERE (:action IS NULL OR action = :action) ORDER BY id DESC LIMIT :limit`,
      { limit, action: action ?? null },
    );
  },
};
