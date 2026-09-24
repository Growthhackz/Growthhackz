import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import { orders, providerCalls } from './db/repositories.js';
import { systemClock, type Clock } from './lib/clock.js';
import { AppError } from './lib/errors.js';
import { createProvider } from './providers/registry.js';
import { ProviderAmbiguousError, ProviderRejectedError, type SocialProvider } from './providers/types.js';
import { registerRoutes } from './routes/index.js';
import type { ServiceContext } from './services/context.js';

export interface BuildAppOptions {
  config: Config;
  db?: Db;
  provider?: SocialProvider;
  clock?: Clock;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: ServiceContext;
}

export function buildApp(opts: BuildAppOptions): BuiltApp {
  const { config } = opts;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization'],
    },
  });
  const db = opts.db ?? openDatabase(config.DATABASE_PATH);
  const clock = opts.clock ?? systemClock;
  const provider =
    opts.provider ??
    createProvider(config, (rec) => {
      try {
        providerCalls.add(db, rec, clock.now().toISOString());
      } catch (err) {
        app.log.error({ err: String(err) }, 'failed to record provider call');
      }
    });
  const ctx: ServiceContext = { db, provider, config, clock, log: app.log };

  if (config.SERVICE_API_TOKEN) {
    const expected = Buffer.from(`Bearer ${config.SERVICE_API_TOKEN}`);
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/health') return;
      const got = Buffer.from(req.headers.authorization ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid bearer token' } });
      }
    });
  } else {
    app.log.warn('SERVICE_API_TOKEN is not set; API is unauthenticated');
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ProviderRejectedError) {
      return reply.code(502).send({ error: { code: 'provider_rejected', message: err.message, action: err.action } });
    }
    if (err instanceof ProviderAmbiguousError) {
      return reply.code(504).send({ error: { code: 'provider_unavailable', message: err.message, action: err.action } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.get('/health', async () => ({
    ok: true,
    provider: provider.name,
    orders: Object.fromEntries(orders.countByStatus(db).map((r) => [r.status, r.count])),
  }));

  registerRoutes(app, ctx);
  app.addHook('onClose', async () => {
    if (!opts.db) db.close();
  });
  return { app, ctx };
}
