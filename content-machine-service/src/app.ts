import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { get, openDatabase, type Db } from './db/database.js';
import { systemClock, type Clock } from './lib/clock.js';
import { safeEqual, Vault } from './lib/crypto.js';
import { AppError } from './lib/errors.js';
import type { HttpFetch } from './lib/http.js';
import { registerRoutes } from './routes/index.js';
import { authenticateKey } from './services/apiKeyService.js';
import { FsAssetStore, type AssetStore } from './services/assetStore.js';
import type { ServiceContext } from './services/context.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: 'admin' | 'service' | null;
  }
}

export interface BuildAppOptions {
  config: Config;
  db?: Db;
  clock?: Clock;
  http?: HttpFetch;
  assets?: AssetStore;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: ServiceContext;
}

export function buildApp(opts: BuildAppOptions): BuiltApp {
  const { config } = opts;
  const app = Fastify({
    bodyLimit: 100_000,
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization'],
    },
  });
  const db = opts.db ?? openDatabase(config.DATABASE_PATH);
  const ctx: ServiceContext = {
    db,
    config,
    clock: opts.clock ?? systemClock,
    log: app.log,
    http: opts.http ?? fetch,
    assets: opts.assets ?? new FsAssetStore(config.ASSET_DIR),
    vault: new Vault(config.CONFIG_ENCRYPTION_KEY),
  };

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path === '/health') return;
    if (path.startsWith('/projects/')) {
      if (config.PUBLIC_HUB_ENABLED) return;
      return reply.code(404).send({ error: { code: 'not_found', message: 'Public hubs are disabled' } });
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (token && safeEqual(token, config.ADMIN_API_TOKEN)) req.principal = 'admin';
    else if (token && authenticateKey(ctx, token)) req.principal = 'service';
    else return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid bearer token' } });
  });

  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
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
    service: 'content-machine-service',
    orders: get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM orders')?.n ?? 0,
    queued_jobs: get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'")?.n ?? 0,
  }));

  registerRoutes(app, ctx);
  app.addHook('onClose', async () => {
    if (!opts.db) db.close();
  });
  return { app, ctx };
}
