import { all, get, run } from '../db/database.js';
import { EXPECTED_RENDER_FILES, IRREVERSIBLE, MAX_ATTEMPTS, RENDER_KINDS } from '../domain/schemas.js';
import { AppError, ConflictError, isBlocking, NotVerifiedError, SetupRequiredError, UpstreamError, ValidationError } from '../lib/errors.js';
import { signCallback } from '../lib/crypto.js';
import { safeRemote } from '../lib/http.js';
import { uid } from '../lib/ids.js';
import { enrich } from '../providers/dexscreener.js';
import { generateCopy, generateImage } from '../providers/gemini.js';
import { botToken, telegram, uploadStickerFile } from '../providers/telegram.js';
import { createPage } from '../providers/telegraph.js';
import { verifyPublication } from '../providers/verify.js';
import { hubUrl, nowMs, type ServiceContext } from './context.js';
import { getOrder, loadOrder, recordEvent, saveAsset, type JobRow, type Order } from './orderService.js';
import { setRawSetting, setting } from './settingsService.js';

const IRREVERSIBLE_SQL = IRREVERSIBLE.map((k) => `'${k}'`).join(', ');
const RENDER_LEASE_MS = 10 * 60_000;
const JOB_LEASE_MS = 2 * 60_000;
const PUBLISH_LEASE_MS = 3 * 60_000;
const STICKER_EMOJI = ['🚀', '💪', '👋', '🛒', '🤩'];

type Leased = JobRow & { lease: string };

function touchOrder(ctx: ServiceContext, orderId: string) {
  run(ctx.db, 'UPDATE orders SET updated_at = :t WHERE id = :id', { id: orderId, t: nowMs(ctx) });
}

/** Completes a leased job. A stale lease (expired and re-claimed) is a no-op. */
export function finish(ctx: ServiceContext, job: Leased, result: unknown, status: 'delivered' | 'skipped' = 'delivered') {
  const r = run(
    ctx.db,
    `UPDATE jobs SET status = :status, result = :result, error = NULL, lease = NULL, lease_until = NULL, updated_at = :t
     WHERE id = :id AND lease = :lease AND status = 'running'`,
    { status, result, t: nowMs(ctx), id: job.id, lease: job.lease },
  );
  if (r.changes) recordEvent(ctx, job.order_id, 'delivery.updated', { job_id: job.id, kind: job.kind, status, result });
}

function fail(ctx: ServiceContext, job: Leased, err: unknown) {
  const blocked = isBlocking(err);
  const uncertain = IRREVERSIBLE.includes(job.kind) && !blocked;
  const status = uncertain ? 'uncertain' : blocked ? 'blocked' : job.attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
  const message = err instanceof AppError ? err.message : 'Processing interrupted. Check the provider and retry safely.';
  if (!(err instanceof AppError)) ctx.log.error({ job: job.id, kind: job.kind, err: String(err) }, 'job failed unexpectedly');
  run(
    ctx.db,
    `UPDATE jobs SET status = :status, error = :error, available_at = :available,
       attempts = CASE WHEN :refund = 1 THEN attempts - 1 ELSE attempts END,
       lease = NULL, lease_until = NULL, updated_at = :t
     WHERE id = :id AND lease = :lease`,
    {
      status,
      error: message,
      available: nowMs(ctx) + Math.min(300_000, 15_000 * 2 ** job.attempts),
      // Missing setup or budget is not the job's fault, so it doesn't spend a retry.
      refund: blocked,
      t: nowMs(ctx),
      id: job.id,
      lease: job.lease,
    },
  );
  recordEvent(ctx, job.order_id, 'delivery.updated', { job_id: job.id, kind: job.kind, status, error: message });
}

/** Leases that outlived their worker: publications become uncertain, everything else is retried or failed. */
export function expireLeases(ctx: ServiceContext): number {
  return run(
    ctx.db,
    `UPDATE jobs SET status = CASE WHEN kind IN (${IRREVERSIBLE_SQL}) THEN 'uncertain' WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
       error = 'The worker stopped before completion. External publications must be reconciled.',
       lease = NULL, lease_until = NULL, updated_at = :t
     WHERE status = 'running' AND lease_until < :t`,
    { t: nowMs(ctx) },
  ).changes;
}

function ready(j: JobRow, o: Order): boolean {
  const done = (kind: string) => o.jobs.some((x) => x.kind === kind && x.status === 'delivered');
  if (j.kind === 'metadata') return true;
  if (!done('metadata')) return false;
  if (j.kind === 'copy') return true;
  if (!done('copy')) return false;
  if (j.rank >= 100 && o.jobs.some((x) => x.rank < 100 && ['queued', 'running'].includes(x.status))) return false;
  if (j.kind === 'media') return done('campaign_image');
  if (j.kind === 'stickers') return [0, 1, 2, 3, 4].every((i) => done('sticker_art_' + i));
  if (j.kind === 'sticker_publish') return done('stickers');
  return true;
}

/** Atomically leases the next ready job on an order. `render` selects renderer-only kinds. */
export function claim(ctx: ServiceContext, orderId: string, render = false): { job: Leased; order: Order } | null {
  expireLeases(ctx);
  const o = loadOrder(ctx, orderId);
  const t = nowMs(ctx);
  const candidates = o.jobs.filter(
    (j) => j.status === 'queued' && j.available_at <= t && RENDER_KINDS.includes(j.kind) === render && ready(j, o),
  );
  for (const j of candidates) {
    const lease = uid();
    const r = run(
      ctx.db,
      `UPDATE jobs SET status = 'running', lease = :lease, lease_until = :until, attempts = attempts + 1, updated_at = :t
       WHERE id = :id AND status = 'queued'`,
      { lease, until: t + (render ? RENDER_LEASE_MS : JOB_LEASE_MS), t, id: j.id },
    );
    if (r.changes) return { job: { ...j, lease, attempts: j.attempts + 1, status: 'running' }, order: o };
  }
  return null;
}

/** Runs at most one ready in-process job on the order. */
export async function processOrder(ctx: ServiceContext, orderId: string): Promise<boolean> {
  const c = claim(ctx, orderId);
  if (!c) return false;
  try {
    await runJob(ctx, c.job, c.order);
  } catch (err) {
    fail(ctx, c.job, err);
  }
  touchOrder(ctx, orderId);
  return true;
}

async function runJob(ctx: ServiceContext, j: Leased, o: Order): Promise<void> {
  const p = o.project;
  switch (j.kind) {
    case 'metadata': {
      const project = await enrich(ctx, p, o.demo);
      run(ctx.db, 'UPDATE orders SET project = :p WHERE id = :id', { p: project, id: o.id });
      return finish(ctx, j, { source: project.source, fetched_at: new Date(nowMs(ctx)).toISOString() });
    }
    case 'copy': {
      const copy = await generateCopy(ctx, o);
      run(ctx.db, 'UPDATE orders SET copy = :c WHERE id = :id', { c: copy, id: o.id });
      return finish(ctx, j, {
        formats: ['article', 'press_release', 'telegram', 'x_posts', 'share_caption', 'meme_captions', 'trailer_lines'],
        demo: o.demo,
      });
    }
    case 'hub':
      return finish(ctx, j, {
        url: hubUrl(ctx, o.id),
        visibility: ctx.config.PUBLIC_HUB_ENABLED ? 'public' : 'private_until_hub_is_enabled',
        label: 'Project announcement and community kit',
      });
  }
  if (j.kind === 'campaign_image' || j.kind.startsWith('sticker_art_')) {
    if (o.demo) return finish(ctx, j, { demo: true, note: 'Demo uses supplied artwork; no generation charged.' }, 'skipped');
    const m = await generateImage(ctx, o, j.kind);
    const ext = m.mime === 'image/jpeg' ? 'jpg' : m.mime.split('/')[1];
    return finish(ctx, j, await saveAsset(ctx, o.id, j.kind, `${j.kind}.${ext}`, m.mime, m.bytes));
  }
  if (o.demo) return finish(ctx, j, { demo: true, note: 'External publication disabled for demo orders.' }, 'skipped');
  const copy = o.copy;
  if (!copy) throw new SetupRequiredError('Copy has not been generated yet.');

  switch (j.kind) {
    case 'telegraph': {
      const page = await createPage(ctx, {
        title: copy.headline,
        author: p.name ?? '',
        paragraphs: copy.article.split(/\n+/).filter(Boolean),
        telegramUrl: p.telegram_url,
      });
      // Record the URL before verifying so an uncertain outcome can be reconciled without republishing.
      run(ctx.db, 'UPDATE jobs SET result = :r WHERE id = :id AND lease = :lease', { r: page, id: j.id, lease: j.lease });
      return finish(ctx, j, await verifyPublication(ctx, page.url, 'telegraph', copy.headline));
    }
    case 'binance':
      throw new SetupRequiredError('Binance Square requires the official publishing adapter in the companion worker and a Square API key.');
    case 'telegram': {
      if (!p.telegram_chat_id) throw new SetupRequiredError('Add an authorized Telegram delivery destination.');
      botToken(ctx);
      const r = await telegram(ctx, 'sendMessage', {
        chat_id: p.telegram_chat_id,
        text: `Project announcement\n\n${copy.telegram}\n\n${hubUrl(ctx, o.id)}`,
        link_preview_options: { is_disabled: false },
      });
      const username = r.chat?.username;
      return finish(ctx, j, {
        message_id: r.message_id,
        chat_id: r.chat?.id,
        url: username ? `https://t.me/${username}/${r.message_id}` : null,
        visibility: username ? 'public_channel' : 'private_message',
      });
    }
    case 'sticker_publish':
      return finish(ctx, j, await publishStickers(ctx, o));
  }
  throw new ValidationError(`Unknown job type ${j.kind}`);
}

async function publishStickers(ctx: ServiceContext, o: Order) {
  const p = o.project;
  if (!p.telegram_owner_id) throw new SetupRequiredError('Add the Telegram sticker-owner user ID.');
  botToken(ctx);
  const me = await telegram(ctx, 'getMe', {});
  const name = `p${o.id.replaceAll('-', '').slice(0, 24)}_by_${me.username}`;
  let existing: any;
  try {
    existing = await telegram(ctx, 'getStickerSet', { name });
  } catch {
    // Not created yet.
  }
  if (existing?.stickers?.length === 5) return { url: `https://t.me/addstickers/${name}`, name, count: 5 };
  const pngs = o.assets.filter((a) => a.kind.startsWith('sticker_png_')).sort((a, b) => a.kind.localeCompare(b.kind));
  if (pngs.length !== 5) throw new SetupRequiredError('Five normalized 512px sticker PNGs are required.');
  const stickers = [];
  for (const [i, a] of pngs.entries()) {
    const bytes = await ctx.assets.get(a.path);
    if (!bytes) throw new SetupRequiredError('Sticker asset missing.');
    stickers.push({ sticker: await uploadStickerFile(ctx, p.telegram_owner_id, bytes, a.name), format: 'static', emoji_list: [STICKER_EMOJI[i]] });
  }
  await telegram(ctx, 'createNewStickerSet', { user_id: p.telegram_owner_id, name, title: `${(p.name ?? '').slice(0, 48)} Community`, stickers });
  const check = await telegram(ctx, 'getStickerSet', { name });
  if (check.stickers?.length !== 5) throw new NotVerifiedError('Sticker set creation needs verification.');
  return { url: `https://t.me/addstickers/${name}`, name, count: 5 };
}

/** Advances queued in-process work across orders, up to JOBS_PER_TICK jobs. */
export async function tick(ctx: ServiceContext, limit = ctx.config.JOBS_PER_TICK) {
  expireLeases(ctx);
  const touched = new Set<string>();
  let processed = 0;
  while (processed < limit) {
    const rows = all<{ order_id: string }>(
      ctx.db,
      `SELECT order_id FROM jobs WHERE status = 'queued' AND available_at <= :t AND kind NOT IN (${RENDER_KINDS.map((k) => `'${k}'`).join(', ')})
       GROUP BY order_id ORDER BY MIN(updated_at) LIMIT 25`,
      { t: nowMs(ctx) },
    );
    let progressed = false;
    for (const r of rows) {
      if (processed >= limit) break;
      if (await processOrder(ctx, r.order_id)) {
        processed++;
        progressed = true;
        touched.add(r.order_id);
      }
    }
    if (!progressed) break;
  }
  const callbacks = await deliverCallbacks(ctx);
  return { processed, orders: [...touched].map((id) => ({ id, status: getOrder(ctx, id).status })), callbacks };
}

// ---- companion renderer ----

export function renderClaim(ctx: ServiceContext) {
  setRawSetting(ctx, 'renderer_last_seen', String(nowMs(ctx)));
  const rows = all<{ order_id: string }>(
    ctx.db,
    `SELECT order_id FROM jobs WHERE status = 'queued' AND kind IN ('media', 'stickers') GROUP BY order_id ORDER BY MIN(updated_at) LIMIT 25`,
  );
  for (const r of rows) {
    const c = claim(ctx, r.order_id, true);
    if (c) return { job: { id: c.job.id, kind: c.job.kind, lease: c.job.lease, order_id: c.job.order_id }, order: getOrder(ctx, r.order_id) };
  }
  return null;
}

interface RenderFile {
  kind: string;
  mime: string;
  base64: string;
}

function leasedJob(ctx: ServiceContext, jobId: string, lease: unknown, kinds: string[]): Leased {
  if (typeof lease !== 'string') throw new ValidationError('lease is required');
  const j = get<JobRow>(
    ctx.db,
    "SELECT * FROM jobs WHERE id = :id AND lease = :lease AND status = 'running' AND lease_until > :t",
    { id: jobId, lease, t: nowMs(ctx) },
  );
  if (!j || !kinds.includes(j.kind)) throw new ConflictError('Lease expired or invalid');
  return j as Leased;
}

export async function acceptRender(ctx: ServiceContext, jobId: string, lease: unknown, files: unknown) {
  const j = leasedJob(ctx, jobId, lease, RENDER_KINDS);
  const expected = EXPECTED_RENDER_FILES[j.kind]!;
  if (!Array.isArray(files) || files.length !== expected.length || expected.some((k) => files.filter((f: RenderFile) => f?.kind === k).length !== 1))
    throw new ValidationError('Render output is incomplete', { expected });
  const decoded = (files as RenderFile[]).map((f) => {
    const mime = f.kind.startsWith('trailer_') ? 'video/mp4' : 'image/png';
    if (f.mime !== mime || typeof f.base64 !== 'string' || f.base64.length > 18_000_000) throw new ValidationError(`Invalid render file ${f.kind}`);
    const bytes = Buffer.from(f.base64, 'base64');
    if (mime === 'image/png' && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new ValidationError(`Invalid PNG ${f.kind}`);
    if (mime === 'video/mp4' && bytes.subarray(4, 8).toString() !== 'ftyp') throw new ValidationError(`Invalid MP4 ${f.kind}`);
    if (j.kind === 'stickers' && (bytes.length < 24 || bytes.readUInt32BE(16) !== 512 || bytes.readUInt32BE(20) !== 512 || bytes.length > 512_000))
      throw new ValidationError('Sticker must be 512×512 and under 512 KB');
    return { kind: f.kind, mime, bytes };
  });
  const results = [];
  for (const f of decoded) results.push(await saveAsset(ctx, j.order_id, f.kind, f.kind + (f.mime === 'video/mp4' ? '.mp4' : '.png'), f.mime, f.bytes));
  finish(ctx, j, { assets: results });
  touchOrder(ctx, j.order_id);
  return getOrder(ctx, j.order_id);
}

export function renderFailed(ctx: ServiceContext, jobId: string, lease: unknown, error: unknown) {
  const j = leasedJob(ctx, jobId, lease, RENDER_KINDS);
  const message = String(error || 'Render failed').slice(0, 300);
  const status = j.attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
  run(
    ctx.db,
    `UPDATE jobs SET status = :status, error = :error, lease = NULL, lease_until = NULL, available_at = :available, updated_at = :t
     WHERE id = :id AND lease = :lease`,
    { status, error: message, available: nowMs(ctx) + 60_000, t: nowMs(ctx), id: j.id, lease: j.lease },
  );
  recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status, error: message });
  return { ok: true, status };
}

// ---- Binance Square via companion worker ----

export function publishClaim(ctx: ServiceContext) {
  expireLeases(ctx);
  const rows = all<JobRow>(
    ctx.db,
    `SELECT * FROM jobs WHERE kind = 'binance' AND status IN ('queued', 'blocked') AND attempts < ${MAX_ATTEMPTS} ORDER BY updated_at LIMIT 20`,
  );
  for (const j of rows) {
    const o = loadOrder(ctx, j.order_id);
    if (o.demo || !o.copy) continue;
    const lease = uid();
    const t = nowMs(ctx);
    const r = run(
      ctx.db,
      `UPDATE jobs SET status = 'running', lease = :lease, lease_until = :until, attempts = attempts + 1, updated_at = :t
       WHERE id = :id AND status IN ('queued', 'blocked')`,
      { lease, until: t + PUBLISH_LEASE_MS, t, id: j.id },
    );
    if (r.changes) return { job: { id: j.id, kind: j.kind, lease, order_id: j.order_id }, order: getOrder(ctx, o.id) };
  }
  return null;
}

export async function publishComplete(ctx: ServiceContext, jobId: string, lease: unknown, url: unknown) {
  const j = leasedJob(ctx, jobId, lease, ['binance']);
  if (typeof url === 'string' && url) {
    run(ctx.db, 'UPDATE jobs SET result = :r WHERE id = :id', { r: { url }, id: j.id });
    try {
      finish(ctx, j, await verifyPublication(ctx, url, 'binance', loadOrder(ctx, j.order_id).copy?.headline));
      return { status: 'delivered' };
    } catch {
      // Fall through: the post may exist but isn't verified.
    }
  }
  run(
    ctx.db,
    `UPDATE jobs SET status = 'uncertain', lease = NULL, lease_until = NULL,
       error = 'Publication may exist; reconcile the article URL before any retry.', updated_at = :t WHERE id = :id`,
    { t: nowMs(ctx), id: j.id },
  );
  recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'uncertain' });
  return { status: 'uncertain' };
}

/** Admin records the real article URL for an uncertain/blocked publication after checking the account. */
export async function reconcile(ctx: ServiceContext, jobId: string, url: unknown) {
  const j = get<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE id = :id', { id: jobId });
  if (!j || !['uncertain', 'blocked'].includes(j.status) || !['binance', 'telegraph'].includes(j.kind))
    throw new ConflictError('This job cannot be reconciled with an article URL');
  if (typeof url !== 'string') throw new ValidationError('url is required');
  const result = await verifyPublication(ctx, url, j.kind, loadOrder(ctx, j.order_id).copy?.headline);
  const full = { ...result, manual_reconciliation: true };
  run(ctx.db, "UPDATE jobs SET status = 'delivered', result = :r, error = NULL, updated_at = :t WHERE id = :id", {
    r: full,
    t: nowMs(ctx),
    id: j.id,
  });
  recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'delivered', result: full });
  return getOrder(ctx, j.order_id);
}

// ---- signed callbacks ----

interface EventRow {
  id: string;
  order_id: string;
  type: string;
  data: string;
  created_at: number;
  attempts: number;
}

/** At-least-once delivery with exponential backoff; gives up after 8 attempts. */
export async function deliverCallbacks(ctx: ServiceContext, batch = 20): Promise<{ sent: number; failed: number }> {
  const url = setting(ctx, 'CALLBACK_URL');
  const secret = setting(ctx, 'CALLBACK_SECRET');
  if (!url || !secret) return { sent: 0, failed: 0 };
  safeRemote(url);
  const rows = all<EventRow>(
    ctx.db,
    'SELECT * FROM events WHERE sent = 0 AND attempts < 8 AND available_at <= :t ORDER BY created_at LIMIT :batch',
    { t: nowMs(ctx), batch },
  );
  let sent = 0;
  let failed = 0;
  for (const e of rows) {
    const payload = JSON.stringify({ id: e.id, type: e.type, order_id: e.order_id, created: e.created_at, data: JSON.parse(e.data) });
    const ts = String(Math.floor(nowMs(ctx) / 1000));
    try {
      const r = await ctx.http(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Peak-Event-ID': e.id,
          'X-Peak-Timestamp': ts,
          'X-Peak-Signature': signCallback(secret, ts, payload),
        },
        body: payload,
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new UpstreamError(`Callback returned ${r.status}`);
      run(ctx.db, 'UPDATE events SET sent = 1 WHERE id = :id', { id: e.id });
      sent++;
    } catch {
      run(ctx.db, 'UPDATE events SET attempts = attempts + 1, available_at = :a WHERE id = :id', {
        id: e.id,
        a: nowMs(ctx) + Math.min(3_600_000, 30_000 * 2 ** e.attempts),
      });
      failed++;
    }
  }
  return { sent, failed };
}

export function listEvents(ctx: ServiceContext, orderId: string) {
  return all<EventRow & { sent: number }>(ctx.db, 'SELECT * FROM events WHERE order_id = :o ORDER BY created_at', { o: orderId }).map((e) => ({
    id: e.id,
    type: e.type,
    data: JSON.parse(e.data),
    created_at: new Date(e.created_at).toISOString(),
    delivered: !!e.sent,
    attempts: e.attempts,
  }));
}
