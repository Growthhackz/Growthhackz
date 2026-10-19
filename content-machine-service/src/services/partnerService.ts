import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { all, get, run } from '../db/database.js';
import { chainName, DIRECTORY_HOSTS, LISTING_PATHS, PARTNER_LISTINGS } from '../domain/schemas.js';
import { ConflictError, NotFoundError, UpstreamError, ValidationError } from '../lib/errors.js';
import { iso, nowMs, publicAssetUrl, type ServiceContext } from './context.js';
import { recordEvent, type JobRow, type Order } from './orderService.js';

/**
 * Coinvote and CoinSniper listings made by an outside service. Each order's coin details are POSTed to it (Bearer
 * PARTNER_LISTINGS_TOKEN, plus an HMAC signature); it answers on /v1/partner/listings with the coin page URLs, which
 * go to the core bot like any other link. Nothing waits on this item: it needs no other step, the order report
 * doesn't wait for it, and when the service fails or stays silent only this item fails.
 */

const SITES = [
  { key: 'coinvote', field: 'coinvote_url', name: 'Coinvote' },
  { key: 'coinsniper', field: 'coinsniper_url', name: 'CoinSniper' },
] as const;
/** At most this long after the order, the request waits for the token details and copy so it can carry them. */
export const PARTNER_DETAILS_WAIT_MS = 2 * 60_000;

type Link = { name: string; url: string };
type Leased = JobRow & { lease: string };

export const partnerConfigured = (ctx: ServiceContext) => !!(ctx.config.PARTNER_LISTINGS_URL && ctx.config.PARTNER_LISTINGS_TOKEN);
const waitMs = (ctx: ServiceContext) => ctx.config.PARTNER_LISTINGS_WAIT_MINUTES * 60_000;
const settledStatus = ['delivered', 'failed', 'skipped'];

/** Ready once the token details and copy are settled (whatever their outcome), or two minutes in regardless. */
export function partnerReady(o: Order, now: number): boolean {
  const settled = (kind: string) => !o.jobs.some((x) => x.kind === kind) || o.jobs.some((x) => x.kind === kind && settledStatus.includes(x.status));
  return (settled('metadata') && settled('copy')) || now - o.created_at >= PARTNER_DETAILS_WAIT_MS;
}

/** Up to ~1000 characters of whole paragraphs. */
function excerpt(text: string | undefined | null, max = 1000): string | null {
  let out = '';
  for (const para of String(text ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
    if ((out ? out.length + 2 : 0) + para.length > max) break;
    out = out ? `${out}\n\n${para}` : para;
  }
  return out || null;
}

/** Everything known about the coin when the request goes out. */
export function partnerRequest(ctx: ServiceContext, j: JobRow, o: Order) {
  const p = o.project as typeof o.project & { purchase_number?: number; test?: boolean; description?: string; launch_date?: string; x_post_url?: string };
  const image = o.assets.find((a) => a.kind === 'campaign_image');
  const created = Number(p.market?.pair_created_at) || 0;
  const t = nowMs(ctx);
  return {
    event: 'listing.request',
    request_id: j.id,
    order_id: o.order_id,
    purchase_number: p.purchase_number ?? 1,
    test: p.test === true,
    sites: SITES.map((s) => s.key),
    requested_at: iso(t),
    reply_by: iso(t + waitMs(ctx)),
    results_url: `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/partner/listings`,
    coin: {
      name: p.name ?? null,
      symbol: p.symbol ?? null,
      chain: p.chain,
      chain_name: chainName(p.chain),
      contract_address: p.contract_address,
      description: excerpt(p.description) ?? excerpt(o.copy?.article),
      short_description: o.copy?.short_post ?? null,
      logo_url: p.logo_url ?? (image ? publicAssetUrl(ctx, o.id, image.id) : null),
      website_url: p.website_url ?? null,
      telegram_url: p.telegram_url ?? null,
      x_url: p.x_url ?? null,
      launch_date: p.launch_date ?? (created ? new Date(created).toISOString().slice(0, 10) : null),
      chart_url: typeof p.market?.pair_url === 'string' ? p.market.pair_url : `https://dexscreener.com/${p.chain}/${p.contract_address}`,
      market: p.market
        ? {
            liquidity_usd: p.market.liquidity_usd ?? null,
            volume_24h_usd: p.market.volume_24h ?? null,
            pair_created_at: created ? new Date(created).toISOString() : null,
          }
        : null,
    },
  };
}

/** A coin page on the site: HTTPS, the site's own host, its coin-page path. */
function siteUrl(site: (typeof SITES)[number], raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ValidationError(`${site.field} is not a URL`);
  }
  if (u.protocol !== 'https:' || !DIRECTORY_HOSTS[site.key]!.includes(u.hostname) || !LISTING_PATHS[site.key]!.test(u.pathname))
    throw new ValidationError(`${site.field} must be a ${site.name} coin page (https://${DIRECTORY_HOSTS[site.key]![0]}/coin/...)`);
  return u.href;
}

/** Adds URLs to what the item already has (one per site, the first one kept), in site order. */
function merged(existing: Link[] | undefined, found: Partial<Record<string, string | null>>): Link[] {
  const have = new Map((existing ?? []).map((l) => [l.name, l.url]));
  for (const s of SITES) if (found[s.key] && !have.has(s.name)) have.set(s.name, found[s.key]!);
  return SITES.filter((s) => have.has(s.name)).map((s) => ({ name: s.name, url: have.get(s.name)! }));
}

const resultOf = (j: JobRow) => (j.result ? (JSON.parse(j.result) as Record<string, unknown> & { links?: Link[] }) : {});

function deliver(ctx: ServiceContext, j: JobRow, links: Link[], extra: Record<string, unknown> = {}) {
  const result = { ...resultOf(j), ...extra, url: links[0]!.url, links, delivered_at: iso(nowMs(ctx)) };
  const r = run(
    ctx.db,
    `UPDATE jobs SET status = 'delivered', result = :r, error = NULL, lease = NULL, lease_until = NULL, updated_at = :t
     WHERE id = :id AND status IN ('running', 'submitted')`,
    { r: result, t: nowMs(ctx), id: j.id },
  );
  if (r.changes) recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'delivered', result });
}

function failNoUrls(ctx: ServiceContext, j: JobRow, error: string) {
  const r = run(
    ctx.db,
    `UPDATE jobs SET status = 'failed', error = :e, lease = NULL, lease_until = NULL, updated_at = :t WHERE id = :id AND status IN ('running', 'submitted')`,
    { e: error.slice(0, 400), t: nowMs(ctx), id: j.id },
  );
  if (r.changes) recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'failed', error });
}

/** Sends the order's coin details; then the item waits (submitted) for the URLs. Its answer may already carry them. */
export async function sendPartnerListing(ctx: ServiceContext, j: Leased, o: Order): Promise<void> {
  if (!partnerConfigured(ctx) || o.demo) {
    const result = { reason: o.demo ? 'Demo order.' : 'The outside listing service is not set up.' };
    const r = run(ctx.db, "UPDATE jobs SET status = 'skipped', result = :r, lease = NULL, lease_until = NULL, updated_at = :t WHERE id = :id AND lease = :lease", { r: result, t: nowMs(ctx), id: j.id, lease: j.lease });
    if (r.changes) recordEvent(ctx, o.id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'skipped', result });
    return;
  }
  const token = ctx.config.PARTNER_LISTINGS_TOKEN!;
  const body = JSON.stringify(partnerRequest(ctx, j, o));
  const ts = String(Math.floor(nowMs(ctx) / 1000));
  let res: Response;
  try {
    res = await ctx.http(ctx.config.PARTNER_LISTINGS_URL!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-timestamp': ts,
        'x-signature': createHmac('sha256', token).update(`${ts}.${body}`).digest('hex'),
        // The same request_id on a retry: the service lists each order once.
        'idempotency-key': j.id,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new UpstreamError(`The listing service was unreachable (network or timeout): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new UpstreamError(`The listing service refused the request (${res.status})`);
  // A fast service may answer with the URLs straight away.
  const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const now = nowMs(ctx);
  const row = get<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE id = :id', { id: j.id })!;
  let links = resultOf(row).links ?? [];
  if (answer) links = merged(links, Object.fromEntries(SITES.map((s) => [s.key, safeSiteUrl(s, answer[s.field])])));
  if (row.status !== 'running') return; // The URLs already came back (and were delivered) while this request was out.
  const result = { request_id: j.id, sent_at: iso(now), wait_until: iso(now + waitMs(ctx)), links };
  if (links.length === SITES.length) return deliver(ctx, { ...row, result: JSON.stringify(result) }, links);
  const r = run(
    ctx.db,
    `UPDATE jobs SET status = 'submitted', result = :r, error = NULL, lease = NULL, lease_until = NULL, available_at = :a, updated_at = :t
     WHERE id = :id AND lease = :lease AND status = 'running'`,
    { r: result, a: now + waitMs(ctx), t: now, id: j.id, lease: j.lease },
  );
  if (r.changes) recordEvent(ctx, o.id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'submitted', result });
}

/** In the request's own answer a malformed URL is ignored (it can be sent again on /v1/partner/listings). */
function safeSiteUrl(site: (typeof SITES)[number], raw: unknown): string | null {
  try {
    return siteUrl(site, raw);
  } catch {
    return null;
  }
}

const resultSchema = z
  .object({
    request_id: z.string().max(64).optional(),
    order_id: z.string().max(120).optional(),
    coinvote_url: z.string().max(500).nullable().optional(),
    coinsniper_url: z.string().max(500).nullable().optional(),
    /** "done": nothing more is coming (deliver what was sent, or fail if none). Otherwise both URLs end the wait. */
    status: z.enum(['ok', 'partial', 'done', 'failed']).optional(),
    error: z.string().max(500).optional(),
  })
  .refine((v) => v.request_id || v.order_id, 'request_id or order_id is required');

/** The service sends URLs (one or both, in one call or several). Both, or a final status, settle the item. */
export function partnerResult(ctx: ServiceContext, body: unknown) {
  const parsed = resultSchema.safeParse(body ?? {});
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const b = parsed.data;
  const j = b.request_id
    ? get<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE id = :id AND kind = :k', { id: b.request_id, k: PARTNER_LISTINGS })
    : get<JobRow>(ctx.db, 'SELECT j.* FROM jobs j JOIN orders o ON o.id = j.order_id WHERE o.order_id = :o AND j.kind = :k', { o: b.order_id, k: PARTNER_LISTINGS });
  if (!j) throw new NotFoundError('Listing request');
  const found = Object.fromEntries(SITES.map((s) => [s.key, siteUrl(s, b[s.field])]));
  if (j.status === 'delivered') return { status: 'delivered', links: resultOf(j).links ?? [] };
  if (!['running', 'submitted'].includes(j.status)) throw new ConflictError(`This request is no longer waiting (${j.status})`);
  const links = merged(resultOf(j).links, found);
  const final = b.status === 'done' || b.status === 'failed' || b.status === 'partial';
  if (links.length === SITES.length || (final && links.length)) {
    deliver(ctx, j, links, b.error ? { note: b.error } : {});
    return { status: 'delivered', links };
  }
  if (final) {
    failNoUrls(ctx, j, `The listing service returned no URLs${b.error ? `: ${b.error}` : '.'}`);
    return { status: 'failed', links: [] };
  }
  run(ctx.db, 'UPDATE jobs SET result = :r, updated_at = :t WHERE id = :id', { r: { ...resultOf(j), links }, t: nowMs(ctx), id: j.id });
  return { status: 'waiting', links };
}

/** Items whose wait is over: what came back is delivered, or the item fails. Nothing else depends on it. */
export function settlePartnerListings(ctx: ServiceContext): number {
  let n = 0;
  for (const j of all<JobRow>(ctx.db, "SELECT * FROM jobs WHERE kind = :k AND status = 'submitted' AND available_at <= :t LIMIT 50", { k: PARTNER_LISTINGS, t: nowMs(ctx) })) {
    const links = resultOf(j).links ?? [];
    const missing = SITES.filter((s) => !links.some((l) => l.name === s.name)).map((s) => s.name);
    if (links.length) deliver(ctx, j, links, { note: `${missing.join(' and ')} did not come back within ${ctx.config.PARTNER_LISTINGS_WAIT_MINUTES} minutes.` });
    else failNoUrls(ctx, j, `The listing service sent no URLs within ${ctx.config.PARTNER_LISTINGS_WAIT_MINUTES} minutes.`);
    n++;
  }
  return n;
}
