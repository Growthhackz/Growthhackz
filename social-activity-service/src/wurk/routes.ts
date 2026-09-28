import type { FastifyInstance } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { fromMicros } from '../lib/money.js';
import type { ServiceContext } from '../services/context.js';
import { quoteOnly } from './diagnostics.js';
import { COMPONENT_STATUSES, PRESETS, WURK_PACKAGE, type ComponentKind, type PackageStatus } from './package.js';
import {
  auditTrail,
  componentsOf,
  correctStatus,
  createPackage,
  getPackage,
  getSettings,
  listPackages,
  markPaid,
  packageStatus,
  paymentsOf,
  reconcileComponent,
  retryComponent,
  runComponent,
  setPaused,
  spentToday,
  updateSettings,
  type WurkComponentRow,
  type WurkPackageRow,
} from './service.js';

function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ValidationError('Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

const usd = (m: number | null) => (m === null ? null : fromMicros(m));
const json = (s: string | null) => {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
};

const TargetsSchema = z.object({ xProfile: z.string().min(1).max(200), xPost: z.string().min(1).max(300), telegram: z.string().min(1).max(200) });
const ActorSchema = z.object({ actor: z.string().min(1).max(100).default('admin'), note: z.string().max(1000).optional() });
const IdParam = z.object({ id: z.string().min(1) });

function presentComponentAdmin(ctx: ServiceContext, c: WurkComponentRow) {
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    target: c.request_url,
    quantities: json(c.quantities),
    ceilingUsdc: usd(c.ceiling_micros),
    quoteUsdc: usd(c.quoted_micros),
    settledUsdc: usd(c.settled_micros),
    providerJobId: c.provider_job_id,
    jobLink: c.job_link,
    statusUrl: c.status_url ? '(stored)' : null,
    providerStatusRaw: json(c.provider_raw),
    lastError: c.last_error,
    scheduledFor: c.scheduled_for,
    deferrals: c.defer_count,
    attempts: c.attempts,
    completedAt: c.completed_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    payments: paymentsOf(ctx, c.id).map((p) => ({
      id: p.id,
      status: p.status,
      amountUsdc: usd(p.amount_micros),
      payTo: p.pay_to,
      transaction: p.transaction_id,
      httpStatus: p.response_status,
      error: p.error,
      createdAt: p.created_at,
    })),
  };
}

function presentPackageAdmin(ctx: ServiceContext, p: WurkPackageRow) {
  const comps = componentsOf(ctx, p.id);
  return {
    id: p.id,
    status: packageStatus(p, comps),
    paused: p.paused === 1,
    test: p.test === 1,
    preset: p.preset,
    bundled: p.bundled === 1,
    customerRef: p.customer_ref,
    targets: { xProfile: p.x_handle ? `https://x.com/${p.x_handle}` : null, xPost: p.x_post_url, telegram: p.tg_url || null },
    retailPriceUsd: usd(p.retail_price_micros),
    costCeilingUsdc: usd(p.cost_ceiling_micros),
    costSettledUsdc: comps.reduce((s, c) => s + (c.settled_micros ?? 0), 0) / 1e6,
    paymentRef: p.payment_ref,
    paidAt: p.paid_at,
    createdAt: p.created_at,
    components: comps.map((c) => presentComponentAdmin(ctx, c)),
  };
}

const LABELS: Record<ComponentKind, string> = {
  verified_followers: `${WURK_PACKAGE.followers} followers from X blue-verified accounts`,
  post_mix: `${WURK_PACKAGE.likes} likes, ${WURK_PACKAGE.reposts} reposts and ${WURK_PACKAGE.comments} comments on your post`,
  tg_batch_1: `${WURK_PACKAGE.tgBatch} Telegram members (first batch)`,
  tg_batch_2: `${WURK_PACKAGE.tgBatch} Telegram members (second batch)`,
  small_raid: 'Engagement on your X post (25 likes, 10 reposts, 10 comments, 70 views)',
};

const CUSTOMER_STATUS: Record<PackageStatus, string> = {
  pending_payment: 'Awaiting payment',
  queued: 'Starting',
  quoting: 'Starting',
  paid_job_created: 'Started',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  partial: 'Partially delivered',
  needs_attention: 'Being reviewed by our team',
  reconcile_required: 'Being reviewed by our team',
};

/** Customer-safe view: no costs, wallets, job IDs or provider responses. */
function presentPackageCustomer(ctx: ServiceContext, p: WurkPackageRow) {
  const comps = componentsOf(ctx, p.id);
  return {
    id: p.id,
    status: CUSTOMER_STATUS[packageStatus(p, comps)],
    note: 'Delivery pace depends on WURK workers; there is no guaranteed completion time.',
    items: comps.map((c) => ({
      item: LABELS[c.kind],
      status: c.status === 'scheduled' && c.scheduled_for ? `Scheduled to start at ${c.scheduled_for}` : CUSTOMER_STATUS[c.status],
    })),
  };
}

export function registerWurkRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  /** Wallet, live-mode and spend status for the admin settings screen. The key itself is never returned. */
  app.get('/v1/wurk/status', async () => {
    let wallet: string | null = null;
    let walletError: string | null = null;
    let usdcBalance: number | null = null;
    if (ctx.config.WURK_SOLANA_PRIVATE_KEY) {
      try {
        const payer = await ctx.wurk.payer();
        wallet = payer.address;
        const b = await payer.usdcBalanceMicros();
        usdcBalance = b === null ? null : fromMicros(b);
      } catch (err) {
        walletError = (err as Error).message;
      }
    }
    return {
      wallet,
      walletError,
      usdcBalance,
      liveReady: ctx.wurk.missingForLive().length === 0,
      missingForLive: ctx.wurk.missingForLive(),
      settings: getSettings(ctx),
      ceilings: {
        verifiedFollowersUsdc: ctx.config.WURK_MAX_FOLLOWERS_USDC,
        postMixUsdc: ctx.config.WURK_MAX_POST_MIX_USDC,
        tgBatchUsdc: ctx.config.WURK_MAX_TG_BATCH_USDC,
        packageUsdc: ctx.config.WURK_PACKAGE_MAX_USDC,
        dailyUsdc: ctx.config.WURK_DAILY_MAX_USDC,
      },
      spentTodayUsdc: fromMicros(spentToday(ctx)),
      payToAllowlist: ctx.config.WURK_PAYTO_ALLOWLIST.split(',').map((s) => s.trim()),
    };
  });

  app.put('/v1/wurk/settings', async (req) => {
    const b = parse(
      z
        .object({
          killSwitch: z.boolean().optional(),
          tgSecondBatchDelayMinutes: z.number().int().min(0).max(24 * 60).optional(),
          retailPriceUsd: z.number().positive().max(10_000).optional(),
          actor: z.string().min(1).max(100).default('admin'),
        })
        .strict(),
      req.body,
    );
    const { actor, ...patch } = b;
    return updateSettings(ctx, patch, actor);
  });

  /** Quote-only diagnostic: the four live 402 quotes for these targets. Never signs or spends. */
  app.post('/v1/wurk/quote', async (req) => quoteOnly(ctx, parse(TargetsSchema, req.body)));

  app.post('/v1/wurk/packages', async (req, reply) => {
    const b = parse(
      z
        .object({
          preset: z.enum(PRESETS).default('full'),
          xProfile: z.string().min(1).max(200).optional(),
          xPost: z.string().min(1).max(300),
          telegram: z.string().min(1).max(200).optional(),
          customerRef: z.string().max(200).optional(),
          test: z.boolean().default(false),
          bundled: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (key !== undefined && (key.length < 8 || key.length > 200)) throw new ValidationError('Idempotency-Key must be 8–200 characters');
    const { pkg, replayed } = createPackage(ctx, b, key);
    return reply.code(replayed ? 200 : 201).header('idempotent-replayed', String(replayed)).send(presentPackageAdmin(ctx, pkg));
  });

  app.get('/v1/wurk/packages', async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    return { packages: listPackages(ctx, q.limit, q.offset).map((p) => presentPackageAdmin(ctx, p)) };
  });

  app.get('/v1/wurk/packages/:id', async (req) => {
    const p = getPackage(ctx, parse(IdParam, req.params).id);
    return { ...presentPackageAdmin(ctx, p), audit: auditTrail(ctx, p.id) };
  });

  /** Customer-facing progress for the storefront. */
  app.get('/v1/wurk/packages/:id/progress', async (req) => presentPackageCustomer(ctx, getPackage(ctx, parse(IdParam, req.params).id)));

  /** Checkout handoff: call once the customer's payment for this package is confirmed. */
  app.post('/v1/wurk/packages/:id/payment-received', async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(z.object({ paymentRef: z.string().min(1).max(200), actor: z.string().max(100).default('checkout') }).strict(), req.body);
    return presentPackageAdmin(ctx, markPaid(ctx, id, b.paymentRef, b.actor));
  });

  app.post('/v1/wurk/packages/:id/pause', async (req) => {
    const { id } = parse(IdParam, req.params);
    setPaused(ctx, id, true, parse(ActorSchema, req.body).actor);
    return presentPackageAdmin(ctx, getPackage(ctx, id));
  });

  app.post('/v1/wurk/packages/:id/resume', async (req) => {
    const { id } = parse(IdParam, req.params);
    setPaused(ctx, id, false, parse(ActorSchema, req.body).actor);
    return presentPackageAdmin(ctx, getPackage(ctx, id));
  });

  const componentPackage = (componentId: string) => {
    const p = componentsOfPackageFor(ctx, componentId);
    return presentPackageAdmin(ctx, p);
  };

  app.post('/v1/wurk/components/:id/retry', async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(ActorSchema, req.body);
    retryComponent(ctx, id, b.actor, b.note);
    return componentPackage(id);
  });

  /** Runs one due component now instead of waiting for the background tick. */
  app.post('/v1/wurk/components/:id/run', async (req) => {
    const { id } = parse(IdParam, req.params);
    await runComponent(ctx, id);
    return componentPackage(id);
  });

  app.post('/v1/wurk/components/:id/reconcile', async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(
      z
        .object({
          settled: z.boolean(),
          jobId: z.string().max(200).optional(),
          jobLink: z.string().url().max(500).optional(),
          transaction: z.string().max(200).optional(),
          note: z.string().min(3).max(1000),
          actor: z.string().min(1).max(100).default('admin'),
        })
        .strict(),
      req.body,
    );
    const { actor, ...input } = b;
    reconcileComponent(ctx, id, input, actor);
    return componentPackage(id);
  });

  app.post('/v1/wurk/components/:id/status', async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(z.object({ status: z.enum(COMPONENT_STATUSES), note: z.string().min(3).max(1000), actor: z.string().min(1).max(100).default('admin') }).strict(), req.body);
    correctStatus(ctx, id, b.status, b.note, b.actor);
    return componentPackage(id);
  });
}

function componentsOfPackageFor(ctx: ServiceContext, componentId: string): WurkPackageRow {
  const row = ctx.db.prepare('SELECT package_id FROM wurk_components WHERE id = ?').get(componentId) as { package_id: string } | undefined;
  if (!row) throw new NotFoundError('WURK component');
  return getPackage(ctx, row.package_id);
}
