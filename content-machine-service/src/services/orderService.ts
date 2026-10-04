import { all, get, run, transaction } from '../db/database.js';
import { canonical, sha256 } from '../lib/crypto.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { uid } from '../lib/ids.js';
import { CHANNELS, channelOf, DIRECTORY_HOSTS, deadlineMs, IRREVERSIBLE, MAX_ATTEMPTS, orderInputSchema, REDDIT_SUBREDDITS, SOURCE_LABELS, STAGES, trendingPurchaseSchema, type Copy, type Project } from '../domain/schemas.js';
import { hubUrl, iso, nowMs, type ServiceContext } from './context.js';

export interface OrderRow {
  id: string;
  order_id: string;
  input_hash: string;
  input: string;
  project: string;
  copy: string | null;
  reserved_cents: number;
  budget_cents: number;
  demo: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface JobRow {
  id: string;
  order_id: string;
  kind: string;
  rank: number;
  status: string;
  attempts: number;
  available_at: number;
  lease: string | null;
  lease_until: number | null;
  result: string | null;
  error: string | null;
  deadline_at: number | null;
  updated_at: number;
}

export interface AssetRow {
  id: string;
  order_id: string;
  kind: string;
  path: string;
  mime: string;
  name: string;
  size: number;
  created_at: number;
}

/** Loaded order used by the engine: parsed JSON plus its jobs and assets. */
export interface Order {
  id: string;
  order_id: string;
  project: Project;
  copy: Copy | null;
  demo: boolean;
  reserved_cents: number;
  budget_cents: number;
  created_at: number;
  updated_at: number;
  jobs: JobRow[];
  assets: AssetRow[];
}

export function recordEvent(ctx: ServiceContext, orderId: string, type: string, data: unknown): void {
  run(ctx.db, 'INSERT INTO events (id, order_id, type, data, created_at) VALUES (:id, :order_id, :type, :data, :t)', {
    id: uid(),
    order_id: orderId,
    type,
    data: JSON.stringify(data),
    t: nowMs(ctx),
  });
  logProblem(ctx, orderId, type, data);
  const link = type === 'delivery.updated' ? publishedLink(ctx, orderId, data) : null;
  if (link) {
    const p = JSON.parse(get<{ project: string }>(ctx.db, 'SELECT project FROM orders WHERE id = :id', { id: orderId })?.project ?? '{}');
    recordEvent(ctx, orderId, 'link.published', { ...link, project: { name: p.name ?? null, symbol: p.symbol ?? null } });
  }
}

const PROBLEM_STATUSES = ['failed', 'blocked', 'uncertain'];

/** Every failure, block or unconfirmed publication goes to the service log with its order and destination. */
function logProblem(ctx: ServiceContext, orderId: string, type: string, data: unknown) {
  const d = data as { kind?: string; status?: string; error?: string };
  if (type === 'delivery.updated' && d?.status && PROBLEM_STATUSES.includes(d.status)) {
    const external = get<{ order_id: string }>(ctx.db, 'SELECT order_id FROM orders WHERE id = :id', { id: orderId })?.order_id;
    const entry = { order: external, order_id: orderId, source: d.kind, status: d.status, reason: d.error ?? null };
    if (d.status === 'blocked') ctx.log.warn(entry, 'delivery blocked');
    else ctx.log.error(entry, `delivery ${d.status}`);
  } else if (type === 'link.published') ctx.log.info({ order_id: orderId, ...(data as object) }, 'link published');
  else if (type === 'order.completed') {
    const r = data as { successes?: unknown[]; failures?: unknown[] };
    ctx.log.info({ order_id: orderId, successes: r.successes?.length ?? 0, failures: r.failures?.length ?? 0 }, 'order completed');
  }
}

/** Recent failures, blocks and unconfirmed publications across all orders, newest first. */
export function recentProblems(ctx: ServiceContext, sinceMs = 0, limit = 100) {
  return all<{ id: string; order_id: string; data: string; created_at: number; external: string }>(
    ctx.db,
    `SELECT e.id, e.order_id, e.data, e.created_at, o.order_id AS external FROM events e JOIN orders o ON o.id = e.order_id
     WHERE e.type = 'delivery.updated' AND e.created_at >= :since ORDER BY e.created_at DESC LIMIT 500`,
    { since: sinceMs },
  )
    .map((e) => ({ ...e, d: JSON.parse(e.data) }))
    .filter((e) => PROBLEM_STATUSES.includes(e.d.status))
    .slice(0, limit)
    .map((e) => ({ at: new Date(e.created_at).toISOString(), order: e.external, order_id: e.order_id, source: e.d.kind, status: e.d.status, reason: e.d.error ?? null }));
}

/**
 * A live public URL for one destination, for the core bot to DM the buyer. The sticker pack has its own
 * sticker_pack.ready event, so it isn't repeated here; the hub is only linked when it is public.
 */
function publishedLink(ctx: ServiceContext, orderId: string, data: unknown): { source: string; label: string; url: string } | null {
  const d = data as { kind?: string; status?: string; result?: { url?: unknown } };
  // A listing's coin page is known at submission: it goes out then ("in review"), not again when the site approves it.
  const listing = !!d?.kind && !!DIRECTORY_HOSTS[d.kind];
  if (listing && d.status === 'submitted') return linkOf(d.kind!, `${SOURCE_LABELS[d.kind!]} (in review)`, d.result?.url);
  if (d?.status !== 'delivered' || !d.kind || d.kind === 'sticker_publish' || !SOURCE_LABELS[d.kind]) return null;
  if (listing && get(ctx.db, "SELECT 1 AS x FROM events WHERE order_id = :o AND type = 'link.published' AND json_extract(data, '$.source') = :k", { o: orderId, k: d.kind }))
    return null;
  if (d.kind === 'hub' && !ctx.config.PUBLIC_HUB_ENABLED) return null;
  return linkOf(d.kind, SOURCE_LABELS[d.kind]!, d.result?.url);
}

function linkOf(source: string, label: string, url: unknown): { source: string; label: string; url: string } | null {
  if (typeof url !== 'string' || url.length > 500) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return { source, label, url: u.href };
  } catch {
    return null;
  }
}

/** Idempotent on `order_id`: the same payload returns the existing order, a different one is a 409. */
export function createOrder(ctx: ServiceContext, body: unknown): { order: Order; created: boolean } {
  const parsed = orderInputSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      parsed.error.issues,
    );
  const input = parsed.data;
  if (input.chain !== 'solana') input.contract_address = input.contract_address.toLowerCase();
  input.channels = [...new Set(input.channels)].sort();
  const digest = sha256(canonical(input));

  return transaction(ctx.db, () => {
    const existing = get<{ id: string; input_hash: string }>(ctx.db, 'SELECT id, input_hash FROM orders WHERE order_id = :o', {
      o: input.order_id,
    });
    if (existing) {
      if (existing.input_hash !== digest) throw new ConflictError('Order ID already exists with different content');
      return { order: loadOrder(ctx, existing.id), created: false };
    }
    const id = uid();
    const t = nowMs(ctx);
    const project: Project = { ...input, enriched_at: null };
    run(
      ctx.db,
      `INSERT INTO orders (id, order_id, input_hash, input, project, budget_cents, demo, created_at, updated_at)
       VALUES (:id, :order_id, :hash, :input, :project, :budget, :demo, :t, :t)`,
      { id, order_id: input.order_id, hash: digest, input, project, budget: input.budget_cents, demo: input.demo, t },
    );
    for (const [kind, rank] of STAGES) {
      const skipped =
        (input.demo && !['metadata', 'copy', 'hub'].includes(kind)) ||
        (input.test && channelOf(kind) === null && !['metadata', 'copy', 'campaign_image'].includes(kind)) ||
        (channelOf(kind) !== null && !(input.channels as string[]).includes(channelOf(kind)!)) ||
        (!!REDDIT_SUBREDDITS[kind] && !redditTargets(ctx).includes(kind));
      run(
        ctx.db,
        'INSERT INTO jobs (id, order_id, kind, rank, status, deadline_at, updated_at) VALUES (:id, :o, :kind, :rank, :status, :deadline, :t)',
        { id: uid(), o: id, kind, rank, status: skipped ? 'skipped' : 'queued', deadline: skipped ? null : t + deadlineMs(kind), t },
      );
    }
    recordEvent(ctx, id, 'order.accepted', { order_id: input.order_id });
    return { order: loadOrder(ctx, id), created: true };
  });
}

/** Channels every trending order gets (TRENDING_CHANNELS), plus whatever the buybot asks for, minus PAUSED_CHANNELS. */
export function trendingChannels(ctx: ServiceContext, extra: string[] = []): string[] {
  return [...new Set(listed(ctx, [ctx.config.TRENDING_CHANNELS, ...extra, 'call_channel'].join(',')))];
}

/** Maps a trending purchase to an order with the default trending channels. */
export function createTrendingOrder(ctx: ServiceContext, body: unknown) {
  const parsed = trendingPurchaseSchema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      parsed.error.issues,
    );
  const { purchase_id, channels = [], ...rest } = parsed.data;
  // A purchase is one order: a retried webhook gets the existing order even if TRENDING_CHANNELS changed since.
  const existing = get<{ id: string }>(ctx.db, 'SELECT id FROM orders WHERE order_id = :o', { o: `trending:${purchase_id}` });
  if (existing) return { order: loadOrder(ctx, existing.id), created: false };
  // Earlier trending purchases of the same token make this a repeat: new posts, boost and stickers only.
  const earlier = earlierTrendingOrders(ctx, rest.chain, rest.contract_address);
  const purchase_number = earlier.length + 1;
  // One-time items (Telegraph, Bitcointalk, listing sites) an earlier purchase never delivered (it failed, e.g. in
  // an outage) are owed: a repeat includes them too, so the token isn't left without them.
  const jobsBefore = earlier.flatMap((o) => o.jobs);
  const done = new Set(jobsBefore.filter((j) => j.status === 'delivered' || j.status === 'submitted').map((j) => channelOf(j.kind)));
  const ordered = new Set(jobsBefore.filter((j) => j.status !== 'skipped').map((j) => channelOf(j.kind)));
  const owed = trendingChannels(ctx).filter((c) => c !== 'call_channel' && ordered.has(c) && !done.has(c));
  // Trending orders include the campaign art, stickers and the five-meme pack: about $1.40 of generation at list rates.
  return createOrder(ctx, {
    budget_cents: 250,
    ...rest,
    order_id: `trending:${purchase_id}`,
    channels: purchase_number > 1 ? [...new Set([...repeatChannels(ctx), ...owed])] : trendingChannels(ctx, channels),
    purchase_number,
  });
}

/** Trending orders already placed for this token, oldest first (only purchases numbered below `before`, when given). */
export function earlierTrendingOrders(ctx: ServiceContext, chain: string, contract: string, before?: number): Order[] {
  const ca = chain === 'solana' ? contract : contract.toLowerCase();
  // Orders from before purchase numbers existed count as first purchases.
  return all<{ id: string }>(
    ctx.db,
    `SELECT id FROM orders WHERE order_id LIKE 'trending:%' AND json_extract(project, '$.chain') = :chain
       AND json_extract(project, '$.contract_address') = :ca AND COALESCE(json_extract(project, '$.purchase_number'), 1) < :before
     ORDER BY COALESCE(json_extract(project, '$.purchase_number'), 1), created_at`,
    { chain, ca, before: before ?? Number.MAX_SAFE_INTEGER },
  ).map((r) => loadOrder(ctx, r.id));
}

const paused = (ctx: ServiceContext) => ctx.config.PAUSED_CHANNELS.split(',').map((c) => c.trim()).filter(Boolean);
const listed = (ctx: ServiceContext, csv: string) => csv.split(',').map((c) => c.trim()).filter((c) => (CHANNELS as readonly string[]).includes(c) && !paused(ctx).includes(c));

/** What a repeat purchase gets (REPEAT_CHANNELS, minus paused channels). */
export function repeatChannels(ctx: ServiceContext): string[] {
  return [...new Set(listed(ctx, ctx.config.REPEAT_CHANNELS))];
}

/** REDDIT_TARGETS as item kinds. */
export function redditTargets(ctx: ServiceContext): string[] {
  const listed = ctx.config.REDDIT_TARGETS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return Object.entries(REDDIT_SUBREDDITS).filter(([, s]) => listed.includes('all') || listed.includes(s.toLowerCase())).map(([k]) => k);
}

export function loadOrder(ctx: ServiceContext, id: string): Order {
  const o = get<OrderRow>(ctx.db, 'SELECT * FROM orders WHERE id = :id', { id });
  if (!o) throw new NotFoundError('Order');
  return {
    id: o.id,
    order_id: o.order_id,
    project: JSON.parse(o.project),
    copy: o.copy ? JSON.parse(o.copy) : null,
    demo: !!o.demo,
    reserved_cents: o.reserved_cents,
    budget_cents: o.budget_cents,
    created_at: o.created_at,
    updated_at: o.updated_at,
    jobs: all<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE order_id = :id ORDER BY rank', { id }),
    assets: all<AssetRow>(ctx.db, 'SELECT * FROM assets WHERE order_id = :id ORDER BY created_at, kind', { id }),
  };
}

export function orderStatus(o: Order): string {
  const s = o.jobs.map((j) => j.status);
  if (s.every((x) => x === 'delivered' || x === 'skipped')) return 'delivered';
  if (s.includes('running')) return 'running';
  if (s.some((x) => ['failed', 'uncertain', 'blocked'].includes(x))) return 'attention';
  if (s.every((x) => ['delivered', 'skipped', 'submitted'].includes(x))) return 'in_review';
  return 'queued';
}

export const assetUrl = (id: string) => `/v1/assets/${id}`;

export function presentOrder(ctx: ServiceContext, o: Order) {
  return {
    id: o.id,
    order_id: o.order_id,
    status: orderStatus(o),
    demo: o.demo,
    project: o.project,
    copy: o.copy,
    budget_cents: o.budget_cents,
    reserved_cents: o.reserved_cents,
    hub_url: hubUrl(ctx, o.id),
    created_at: iso(o.created_at),
    updated_at: iso(o.updated_at),
    jobs: o.jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      rank: j.rank,
      status: j.status,
      attempts: j.attempts,
      error: j.error,
      result: j.result ? JSON.parse(j.result) : null,
      available_at: iso(j.available_at),
      updated_at: iso(j.updated_at),
    })),
    assets: o.assets.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, name: a.name, size: a.size, url: assetUrl(a.id), created_at: iso(a.created_at) })),
  };
}

export function getOrder(ctx: ServiceContext, id: string) {
  return presentOrder(ctx, loadOrder(ctx, id));
}

export function listOrders(ctx: ServiceContext, opts: { limit?: number; status?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const ids = all<{ id: string }>(ctx.db, 'SELECT id FROM orders ORDER BY created_at DESC LIMIT :limit', { limit });
  const orders = ids.map((r) => presentOrder(ctx, loadOrder(ctx, r.id)));
  return opts.status ? orders.filter((o) => o.status === opts.status) : orders;
}

export function findByExternalId(ctx: ServiceContext, orderId: string) {
  const row = get<{ id: string }>(ctx.db, 'SELECT id FROM orders WHERE order_id = :o', { o: orderId });
  if (!row) throw new NotFoundError('Order');
  return getOrder(ctx, row.id);
}

export function getJob(ctx: ServiceContext, id: string): JobRow {
  const j = get<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE id = :id', { id });
  if (!j) throw new NotFoundError('Job');
  return j;
}

/** Re-queues blocked/failed work. Uncertain publications must be reconciled instead. */
/**
 * `resetAttempts` (admin, after fixing the cause) is only allowed where nothing was sent: blocked work, or a failed
 * content step (a render or generation publishes nothing), so a fresh set of attempts can't double-post. `confirmNotPosted` (admin) retries an uncertain publication after
 * someone has checked that it did not go out.
 */
export function retryJob(ctx: ServiceContext, id: string, resetAttempts = false, confirmNotPosted = false) {
  const j = getJob(ctx, id);
  if (j.status === 'uncertain' && confirmNotPosted) resetAttempts = true;
  else if (!['blocked', 'failed'].includes(j.status))
    throw new ConflictError('Only blocked or failed work can be retried. Uncertain publications require reconciliation.');
  const nothingSent = ['blocked', 'uncertain'].includes(j.status) || (j.status === 'failed' && !IRREVERSIBLE.includes(j.kind));
  if (resetAttempts && !nothingSent) throw new ConflictError('Attempts can only be reset on blocked work (nothing was sent).');
  if (j.attempts >= MAX_ATTEMPTS && !resetAttempts) throw new ConflictError('Three-attempt limit reached; inspect the provider before proceeding.');
  run(
    ctx.db,
    // A retry gets a fresh deadline, and the order reports again when everything is final.
    `UPDATE jobs SET status = 'queued', error = NULL, available_at = 0, deadline_at = :deadline, updated_at = :t,
       attempts = CASE WHEN :reset = 1 THEN 0 ELSE attempts END
     WHERE id = :id AND status IN ('blocked', 'failed', 'uncertain')`,
    { id, t: nowMs(ctx), deadline: nowMs(ctx) + deadlineMs(j.kind), reset: resetAttempts ? 1 : 0 },
  );
  run(ctx.db, 'UPDATE orders SET completed_at = NULL WHERE id = :id', { id: j.order_id });
  return getOrder(ctx, j.order_id);
}

/** Stores an asset under a deterministic ID per (order, kind) so re-renders replace rather than duplicate. */
export async function saveAsset(ctx: ServiceContext, orderId: string, kind: string, name: string, mime: string, bytes: Uint8Array) {
  const id = sha256(orderId + ':' + kind).slice(0, 40);
  const path = `${orderId}/${id}`;
  await ctx.assets.put(path, bytes);
  run(
    ctx.db,
    `INSERT INTO assets (id, order_id, kind, path, mime, name, size, created_at) VALUES (:id, :o, :kind, :path, :mime, :name, :size, :t)
     ON CONFLICT(id) DO UPDATE SET path = excluded.path, mime = excluded.mime, name = excluded.name, size = excluded.size, created_at = excluded.created_at`,
    { id, o: orderId, kind, path, mime, name, size: bytes.byteLength, t: nowMs(ctx) },
  );
  return { id, url: assetUrl(id), name, mime, kind };
}

export async function readAsset(ctx: ServiceContext, id: string) {
  const a = get<AssetRow>(ctx.db, 'SELECT * FROM assets WHERE id = :id', { id });
  if (!a) throw new NotFoundError('Asset');
  const bytes = await ctx.assets.get(a.path);
  if (!bytes) throw new NotFoundError('Asset');
  return { asset: a, bytes };
}
