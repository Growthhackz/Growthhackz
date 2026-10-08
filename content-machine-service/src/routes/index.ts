import { pause, pauseStatus, resume } from '../services/pauseService.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, NotFoundError, ValidationError } from '../lib/errors.js';
import { issueKey, listKeys, revokeKey } from '../services/apiKeyService.js';
import { connectorList, probeConnector } from '../services/connectorService.js';
import type { ServiceContext } from '../services/context.js';
import {
  acceptRender,
  listEvents,
  processOrder,
  publishClaim,
  publishComplete,
  attachListingProof,
  publishFailed,
  listingCheckClaim,
  listingChecked,
  publishTarget,
  reconcile,
  renderClaim,
  renderFailed,
  tick,
  orderReport,
} from '../services/engine.js';
import { publicHub, renderHub } from '../services/hubService.js';
import { createOrder, createTrendingOrder, findByExternalId, getOrder, listOrders, loadOrder, presentOrder, readAsset, recentProblems, retryJob } from '../services/orderService.js';
import { saveSetting, settingsSummary } from '../services/settingsService.js';
import { apiHealthChecks, notifyAdmins, recordChecks, sourceHealth } from '../services/healthService.js';
import { verifyClaim, verifyResult } from '../services/healService.js';
import { assistDone, assistView, renderAssist } from '../services/assistService.js';

type Params = { id: string };
type AssetParams = { id: string; assetId: string };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), r.error.issues);
  return r.data;
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (req.principal !== 'admin') throw new AppError('Admin token required', 403, 'forbidden');
}

const admin = { preHandler: requireAdmin };

function sendAsset(reply: FastifyReply, req: FastifyRequest, a: { mime: string; name: string }, bytes: Buffer, cache: string) {
  const disposition = 'download' in ((req.query as object) ?? {}) ? 'attachment' : 'inline';
  return reply
    .header('content-type', a.mime)
    .header('content-disposition', `${disposition}; filename="${a.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`)
    .header('cache-control', cache)
    .header('x-content-type-options', 'nosniff')
    .send(bytes);
}

export function registerRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  // ---- orders (service key or admin) ----
  app.post('/v1/orders', async (req, reply) => {
    if ((req.body as { test?: unknown } | null)?.test === true) await requireAdmin(req);
    const { order, created } = createOrder(ctx, req.body);
    return reply.code(created ? 201 : 200).send(presentOrder(ctx, order));
  });

  /** The buybot calls this after a confirmed trending purchase; the order posts to the call channel. */
  app.post('/v1/trending', async (req, reply) => {
    const { order, created } = createTrendingOrder(ctx, req.body);
    return reply.code(created ? 201 : 200).send(presentOrder(ctx, order));
  });

  app.get('/v1/orders', async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().optional(), status: z.string().optional() }), req.query);
    return { orders: listOrders(ctx, q) };
  });

  app.get<{ Params: Params }>('/v1/orders/by-external-id/:id', async (req) => findByExternalId(ctx, req.params.id));
  app.get<{ Params: Params }>('/v1/orders/:id', async (req) => getOrder(ctx, req.params.id));
  /** Final report: success URLs, failures with reasons, and anything still pending with its deadline. */
  app.get<{ Params: Params }>('/v1/orders/:id/report', async (req) => orderReport(ctx, loadOrder(ctx, req.params.id)));
  app.get<{ Params: Params }>('/v1/orders/by-external-id/:id/report', async (req) =>
    orderReport(ctx, loadOrder(ctx, findByExternalId(ctx, req.params.id).id)),
  );
  app.get<{ Params: Params }>('/v1/orders/:id/events', async (req) => {
    getOrder(ctx, req.params.id);
    return { events: listEvents(ctx, req.params.id) };
  });

  /** Runs one ready job now instead of waiting for the background loop. */
  app.post<{ Params: Params }>('/v1/orders/:id/process', async (req) => {
    getOrder(ctx, req.params.id);
    const processed = await processOrder(ctx, req.params.id);
    return { processed, order: getOrder(ctx, req.params.id) };
  });

  app.post<{ Params: Params }>('/v1/jobs/:id/retry', async (req) => {
    const b = (req.body ?? {}) as { reset_attempts?: unknown; confirm_not_posted?: unknown };
    const reset = b.reset_attempts === true;
    const notPosted = b.confirm_not_posted === true;
    if (reset || notPosted) await requireAdmin(req);
    return retryJob(ctx, req.params.id, reset, notPosted);
  });
  app.post<{ Params: Params }>('/v1/jobs/:id/reconcile', admin, async (req) => {
    const b = parse(z.object({ url: z.string() }), req.body);
    return reconcile(ctx, req.params.id, b.url);
  });

  app.post('/v1/tick', async () => tick(ctx));

  app.get<{ Params: Params }>('/v1/assets/:id', async (req, reply) => {
    const { asset, bytes } = await readAsset(ctx, req.params.id);
    return sendAsset(reply, req, asset, bytes, 'private, max-age=3600');
  });

  // ---- companion worker ----
  app.post('/v1/render/claim', async () => renderClaim(ctx));
  app.post<{ Params: Params }>('/v1/render/:id/complete', { bodyLimit: 30_000_000 }, async (req) => {
    const b = (req.body ?? {}) as { lease?: unknown; files?: unknown };
    return acceptRender(ctx, req.params.id, b.lease, b.files);
  });
  app.post<{ Params: Params }>('/v1/render/:id/fail', async (req) => {
    const b = (req.body ?? {}) as { lease?: unknown; error?: unknown };
    return renderFailed(ctx, req.params.id, b.lease, b.error);
  });
  app.post('/v1/publish/claim', async (req) => publishClaim(ctx, (req.body as { kinds?: unknown } | null)?.kinds));
  // Listing requests may carry a screenshot of the submission as proof.
  app.post<{ Params: Params }>('/v1/publish/:id/complete', { bodyLimit: 3_000_000 }, async (req) => {
    const b = (req.body ?? {}) as { lease?: unknown; url?: unknown; verified?: unknown; submitted?: unknown; note?: unknown; proof?: unknown; review_url?: unknown };
    return publishComplete(ctx, req.params.id, b.lease, b.url, b.verified, b.submitted, b.note, { proof: b.proof, review_url: b.review_url });
  });
  app.post<{ Params: Params }>('/v1/jobs/:id/proof', { bodyLimit: 3_000_000, preHandler: requireAdmin }, async (req) => {
    const b = (req.body ?? {}) as { proof?: unknown; review_url?: unknown };
    return attachListingProof(ctx, req.params.id, b.proof, b.review_url);
  });
  /** Directory listings waiting on the site's review: the worker checks whether the coin page is live yet. */
  /** The worker's source checks (logins and forms); the API adds its own and alerts admins on changes. */
  app.post('/v1/health/report', async (req) => ({ sources: await recordChecks(ctx, (req.body as { checks?: unknown } | null)?.checks, 'worker') }));
  app.get('/v1/health/sources', admin, async () => ({ sources: sourceHealth(ctx) }));
  /** The ops agent's messages to the admins (caught / fixed / need you), through the same bot. */
  app.post('/v1/ops/notify', admin, async (req) => {
    const lines = (req.body as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(lines) || !lines.length || lines.length > 20 || lines.some((l) => typeof l !== 'string' || l.length > 800))
      throw new ValidationError('lines: 1-20 strings');
    return { sent: await notifyAdmins(ctx, lines as string[]) };
  });
  app.post('/v1/health/run', admin, async () => {
    await apiHealthChecks(ctx, true);
    return { sources: sourceHealth(ctx) };
  });
  /** Self-healing: the worker looks for an uncertain post on our account and reports what it found. */
  app.post('/v1/verify/claim', async (req) => verifyClaim(ctx, (kind, orderId) => publishTarget(ctx, kind, loadOrder(ctx, orderId)), (req.body as { kinds?: unknown } | null)?.kinds));
  app.post<{ Params: Params }>('/v1/verify/:id/result', async (req) =>
    verifyResult(ctx, req.params.id, (req.body ?? {}) as { url?: unknown; absent?: unknown; note?: unknown }, (id, url) => reconcile(ctx, id, url)),
  );
  app.post('/v1/listings/check-claim', async (req) => listingCheckClaim(ctx, (req.body as { kinds?: unknown } | null)?.kinds));
  app.post<{ Params: Params }>('/v1/listings/:id/checked', async (req) => {
    const b = (req.body ?? {}) as { url?: unknown; live?: unknown };
    return listingChecked(ctx, req.params.id, b.url, b.live);
  });
  app.post<{ Params: Params }>('/v1/publish/:id/fail', async (req) => {
    const b = (req.body ?? {}) as { lease?: unknown; error?: unknown };
    return publishFailed(ctx, req.params.id, b.lease, b.error);
  });

  // ---- admin ----
  /** Global pause: orders are still accepted, but nothing is generated, published or sent until resumed. */
  /** Failures, blocks and unconfirmed publications across all orders (admin). `since` is an ISO time. */
  app.get('/v1/errors', admin, async (req) => {
    const q = parse(z.object({ since: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query);
    return { errors: recentProblems(ctx, q.since ? Date.parse(q.since) : 0, q.limit ?? 100) };
  });
  app.get('/v1/pause', admin, async () => pauseStatus(ctx));
  app.post('/v1/pause', admin, async () => pause(ctx));
  app.post('/v1/resume', admin, async () => resume(ctx));
  app.get('/v1/settings', admin, async () => settingsSummary(ctx));
  app.put('/v1/settings', admin, async (req) => {
    const b = parse(z.object({ key: z.string(), value: z.string() }), req.body);
    saveSetting(ctx, b.key, b.value);
    return { saved: true, key: b.key };
  });

  app.get('/v1/keys', admin, async () => ({ keys: listKeys(ctx) }));
  app.post('/v1/keys', admin, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; scope?: unknown };
    return reply.code(201).send(issueKey(ctx, body.name, body.scope ?? 'service'));
  });
  app.delete<{ Params: Params }>('/v1/keys/:id', admin, async (req) => revokeKey(ctx, req.params.id));

  app.get('/v1/connectors', admin, async () => ({ sources: connectorList(ctx) }));
  app.post<{ Params: Params }>('/v1/connectors/:id/probe', admin, async (req) =>
    probeConnector(ctx, req.params.id, (req.body ?? {}) as Record<string, unknown>),
  );

  // ---- public images (embedded by Telegraph pages); images only, nothing else about the order ----
  app.get<{ Params: { assetId: string } }>('/media/:assetId', async (req, reply) => {
    const { asset, bytes } = await readAsset(ctx, req.params.assetId);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) throw new NotFoundError('Asset');
    return sendAsset(reply, req, asset, bytes, 'public, max-age=86400');
  });

  // ---- operator posting pages (token in the DM'd link) ----
  app.get<{ Params: { token: string } }>('/assist/:token', async (req, reply) => {
    try {
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('referrer-policy', 'no-referrer')
        .header(
          'content-security-policy',
          "default-src 'none'; img-src 'self' https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .send(renderAssist(assistView(ctx, req.params.token)));
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).type('text/plain').send('This posting link has expired.');
      throw err;
    }
  });
  app.post<{ Params: { token: string } }>('/assist/:token/done', async (req) => assistDone(ctx, req.params.token, req.body));

  // ---- public project hub (only when PUBLIC_HUB_ENABLED) ----
  app.get<{ Params: Params }>('/projects/:id', async (req, reply) => {
    try {
      const hub = publicHub(ctx, req.params.id);
      if ((req.headers.accept ?? '').includes('application/json')) return hub;
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'")
        .send(renderHub(hub));
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).type('text/plain').send('Project not available');
      throw err;
    }
  });
  app.get<{ Params: AssetParams }>('/projects/:id/assets/:assetId', async (req, reply) => {
    const { asset, bytes } = await readAsset(ctx, req.params.assetId);
    if (asset.order_id !== req.params.id) throw new NotFoundError('Asset');
    // With the hub off, this legacy address serves images only (for articles that already embed it).
    if (!ctx.config.PUBLIC_HUB_ENABLED && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) throw new NotFoundError('Asset');
    return sendAsset(reply, req, asset, bytes, 'public, max-age=3600');
  });
}
