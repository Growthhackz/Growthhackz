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
  reconcile,
  renderClaim,
  renderFailed,
  tick,
} from '../services/engine.js';
import { publicHub, renderHub } from '../services/hubService.js';
import { createOrder, createTrendingOrder, findByExternalId, getOrder, listOrders, presentOrder, readAsset, retryJob } from '../services/orderService.js';
import { saveSetting, settingsSummary } from '../services/settingsService.js';

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

  app.post<{ Params: Params }>('/v1/jobs/:id/retry', async (req) => retryJob(ctx, req.params.id));
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
  app.post('/v1/publish/claim', async () => publishClaim(ctx));
  app.post<{ Params: Params }>('/v1/publish/:id/complete', async (req) => {
    const b = (req.body ?? {}) as { lease?: unknown; url?: unknown };
    return publishComplete(ctx, req.params.id, b.lease, b.url);
  });

  // ---- admin ----
  app.get('/v1/settings', admin, async () => settingsSummary(ctx));
  app.put('/v1/settings', admin, async (req) => {
    const b = parse(z.object({ key: z.string(), value: z.string() }), req.body);
    saveSetting(ctx, b.key, b.value);
    return { saved: true, key: b.key };
  });

  app.get('/v1/keys', admin, async () => ({ keys: listKeys(ctx) }));
  app.post('/v1/keys', admin, async (req, reply) => reply.code(201).send(issueKey(ctx, (req.body as { name?: unknown } | null)?.name)));
  app.delete<{ Params: Params }>('/v1/keys/:id', admin, async (req) => revokeKey(ctx, req.params.id));

  app.get('/v1/connectors', admin, async () => ({ sources: connectorList(ctx) }));
  app.post<{ Params: Params }>('/v1/connectors/:id/probe', admin, async (req) =>
    probeConnector(ctx, req.params.id, (req.body ?? {}) as Record<string, unknown>),
  );

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
    return sendAsset(reply, req, asset, bytes, 'public, max-age=3600');
  });
}
