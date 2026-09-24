import type { FastifyInstance } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { campaigns, catalog, events, ledger, mappings, orders, providerCalls, refills } from '../db/repositories.js';
import { GEOS, ORDER_STATUSES, PRODUCTS, PRODUCT_SPECS } from '../domain/products.js';
import { PACKAGES } from '../domain/packages.js';
import {
  CreateCampaignSchema,
  FundingSchema,
  PackageOrderSchema,
  PackageRequestSchema,
  ResolveReviewSchema,
  UpsertMappingSchema,
} from '../domain/schemas.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { getBalanceSummary, recordFunding } from '../services/balanceService.js';
import { syncCatalog } from '../services/catalogService.js';
import { nowIso, type ServiceContext } from '../services/context.js';
import { cancelOrder, createCampaign, resolveReview, submitCampaign, submitOrder } from '../services/orderService.js';
import { packageToCampaign, planPackage } from '../services/packageService.js';
import { applyRecommendations, recommendForPackage } from '../services/recommendService.js';
import { refreshCampaign, refreshOrder } from '../services/pollingService.js';
import {
  presentCampaign,
  presentCatalog,
  presentEvent,
  presentLedger,
  presentMapping,
  presentOrder,
  presentRefill,
} from '../services/presenters.js';
import { requestRefill } from '../services/refillService.js';

function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw new ValidationError(
      'Invalid request',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const IdParam = z.object({ id: z.string().min(1) });

export function registerRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  const loadCampaign = (id: string) => {
    const c = campaigns.get(ctx.db, id);
    if (!c) throw new NotFoundError('Campaign');
    return presentCampaign(c, orders.byCampaign(ctx.db, id), ledger.campaignSpend(ctx.db, id));
  };
  const loadOrder = (id: string) => {
    const o = orders.get(ctx.db, id);
    if (!o) throw new NotFoundError('Order');
    return {
      ...presentOrder(o),
      events: events.forOrder(ctx.db, id).map(presentEvent),
      refills: refills.forOrder(ctx.db, id).map(presentRefill),
    };
  };

  // ------------------------------------------------------------ reference

  app.get('/v1/products', async () => ({
    products: PRODUCTS.map((p) => ({ product: p, ...PRODUCT_SPECS[p] })),
    geos: GEOS,
  }));

  // -------------------------------------------------------------- catalog

  app.get('/v1/catalog/services', async (req) => {
    const q = parse(z.object({ q: z.string().optional(), includeInactive: z.enum(['true', 'false']).optional() }), req.query);
    const rows = catalog.search(ctx.db, ctx.provider.name, q.q, q.includeInactive === 'true');
    return { provider: ctx.provider.name, services: rows.map(presentCatalog) };
  });

  app.post('/v1/catalog/sync', async () => syncCatalog(ctx));

  /** Rank catalog services for each package item (keyword match on names; review before applying). */
  app.get('/v1/catalog/recommendations', async (req) => {
    const q = parse(z.object({ package: z.string().default('starter'), limit: z.coerce.number().int().min(1).max(20).default(5) }), req.query);
    return { package: q.package, items: recommendForPackage(ctx, q.package, q.limit) };
  });

  app.post('/v1/catalog/recommendations/apply', async (req) => {
    const body = parse(z.object({ package: z.string().default('starter'), overwrite: z.boolean().default(false) }).strict(), req.body);
    return { package: body.package, results: applyRecommendations(ctx, body.package, body.overwrite) };
  });

  app.get('/v1/catalog/mappings', async () => ({
    mappings: mappings
      .list(ctx.db, ctx.provider.name)
      .map((m) => presentMapping(m, catalog.get(ctx.db, ctx.provider.name, m.service_id))),
  }));

  app.put('/v1/catalog/mappings', async (req) => {
    const body = parse(UpsertMappingSchema, req.body);
    const svc = catalog.get(ctx.db, ctx.provider.name, body.serviceId);
    if (!svc) throw new ValidationError(`Service ${body.serviceId} is not in the catalog; run POST /v1/catalog/sync first`);
    const spec = PRODUCT_SPECS[body.product];
    if (body.premium && !spec.supportsPremium) throw new ValidationError(`${body.product} has no premium variant`);
    const row = {
      product: body.product,
      geo: body.geo,
      premium: body.premium ? 1 : 0,
      provider: ctx.provider.name,
      service_id: body.serviceId,
      updated_at: nowIso(ctx),
    };
    mappings.upsert(ctx.db, row);
    return presentMapping(row, svc);
  });

  app.delete('/v1/catalog/mappings', async (req, reply) => {
    const q = parse(
      z.object({
        product: z.enum(PRODUCTS),
        geo: z.enum(GEOS).default('any'),
        premium: z.enum(['true', 'false']).default('false'),
      }),
      req.query,
    );
    if (!mappings.remove(ctx.db, ctx.provider.name, q.product, q.geo, q.premium === 'true')) throw new NotFoundError('Mapping');
    return reply.code(204).send();
  });

  // --------------------------------------------------------------- money

  app.get('/v1/balance', async () => getBalanceSummary(ctx));

  app.get('/v1/ledger', async (req) => {
    const { limit } = parse(Paging, req.query);
    return { entries: ledger.recent(ctx.db, limit).map(presentLedger) };
  });

  app.post('/v1/ledger/funding', async (req, reply) => {
    const body = parse(FundingSchema, req.body);
    recordFunding(ctx, body.amountUsd, body.note);
    return reply.code(201).send({ ok: true });
  });

  // ------------------------------------------------------------ packages

  app.get('/v1/packages', async () => ({ packages: Object.values(PACKAGES) }));

  /** Show what a package would order against the current catalog, without ordering. */
  app.post('/v1/packages/:name/preview', async (req) => {
    const { name } = parse(z.object({ name: z.string() }), req.params);
    return planPackage(ctx, name, parse(PackageRequestSchema, req.body));
  });

  app.post('/v1/packages/:name/order', async (req, reply) => {
    const { name } = parse(z.object({ name: z.string() }), req.params);
    const { name: campaignName, notes, budgetUsd, autoRefill, metadata, submit, ...request } = parse(PackageOrderSchema, req.body);
    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (key !== undefined && (key.length < 8 || key.length > 200)) {
      throw new ValidationError('Idempotency-Key must be 8–200 characters');
    }
    const plan = await planPackage(ctx, name, request);
    const input = packageToCampaign(plan, { name: campaignName, notes, budgetUsd, autoRefill, metadata, submit });
    const { campaign, replayed } = await createCampaign(ctx, input, key);
    return reply
      .code(replayed ? 200 : 201)
      .header('idempotent-replayed', String(replayed))
      .send({ ...loadCampaign(campaign.id), packageLines: plan.lines });
  });

  // ----------------------------------------------------------- campaigns

  app.post('/v1/campaigns', async (req, reply) => {
    const body = parse(CreateCampaignSchema, req.body);
    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (key !== undefined && (key.length < 8 || key.length > 200)) {
      throw new ValidationError('Idempotency-Key must be 8–200 characters');
    }
    const { campaign, replayed } = await createCampaign(ctx, body, key);
    return reply.code(replayed ? 200 : 201).header('idempotent-replayed', String(replayed)).send(loadCampaign(campaign.id));
  });

  app.get('/v1/campaigns', async (req) => {
    const { limit, offset } = parse(Paging, req.query);
    return {
      campaigns: campaigns
        .list(ctx.db, limit, offset)
        .map((c) => presentCampaign(c, orders.byCampaign(ctx.db, c.id), ledger.campaignSpend(ctx.db, c.id))),
    };
  });

  app.get('/v1/campaigns/:id', async (req) => loadCampaign(parse(IdParam, req.params).id));

  app.post('/v1/campaigns/:id/submit', async (req) => {
    const { id } = parse(IdParam, req.params);
    await submitCampaign(ctx, id);
    return loadCampaign(id);
  });

  app.post('/v1/campaigns/:id/refresh', async (req) => {
    const { id } = parse(IdParam, req.params);
    if (!campaigns.get(ctx.db, id)) throw new NotFoundError('Campaign');
    await refreshCampaign(ctx, id);
    return loadCampaign(id);
  });

  // -------------------------------------------------------------- orders

  app.get('/v1/orders', async (req) => {
    const q = parse(Paging.extend({ status: z.enum(ORDER_STATUSES).optional() }), req.query);
    return { orders: orders.list(ctx.db, q.status, q.limit, q.offset).map(presentOrder) };
  });

  app.get('/v1/orders/:id', async (req) => loadOrder(parse(IdParam, req.params).id));

  app.post('/v1/orders/:id/submit', async (req) => {
    const { id } = parse(IdParam, req.params);
    await submitOrder(ctx, id);
    return loadOrder(id);
  });

  app.post('/v1/orders/:id/refresh', async (req) => {
    const { id } = parse(IdParam, req.params);
    await refreshOrder(ctx, id);
    return loadOrder(id);
  });

  app.post('/v1/orders/:id/cancel', async (req) => {
    const { id } = parse(IdParam, req.params);
    await cancelOrder(ctx, id);
    return loadOrder(id);
  });

  app.post('/v1/orders/:id/refill', async (req) => {
    const { id } = parse(IdParam, req.params);
    await requestRefill(ctx, id, 'manual');
    return loadOrder(id);
  });

  app.post('/v1/orders/:id/resolve', async (req) => {
    const { id } = parse(IdParam, req.params);
    resolveReview(ctx, id, parse(ResolveReviewSchema, req.body));
    return loadOrder(id);
  });

  // --------------------------------------------------------------- audit

  app.get('/v1/provider-calls', async (req) => {
    const q = parse(Paging.extend({ action: z.string().optional() }), req.query);
    const rows = providerCalls.recent(ctx.db, q.limit, q.action);
    return {
      calls: rows.map((r) => ({ ...r, request: JSON.parse(String(r.request)) as unknown })),
    };
  });
}
