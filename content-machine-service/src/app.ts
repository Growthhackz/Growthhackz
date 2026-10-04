import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { get, openDatabase, type Db } from './db/database.js';
import { systemClock, type Clock } from './lib/clock.js';
import { safeEqual, Vault } from './lib/crypto.js';
import { AppError } from './lib/errors.js';
import type { HttpFetch } from './lib/http.js';
import { registerRoutes } from './routes/index.js';
import { authenticateKey, type KeyScope } from './services/apiKeyService.js';
import { FsAssetStore, type AssetStore } from './services/assetStore.js';
import type { ServiceContext } from './services/context.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: 'admin' | KeyScope | null;
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

/** Intake keys (the core bot): create a trending order, read a trending order and its report. Nothing else. */
export function intakeAllowed(method: string, path: string): boolean {
  if (method === 'POST') return path === '/v1/trending';
  if (method === 'GET') return /^\/v1\/orders\/by-external-id\/trending(:|%3A)[^/]{1,100}(\/report)?$/i.test(path);
  return false;
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
    // Public images for Telegraph and meme pages. Asset ids derive from the order's random id, so they can't be guessed.
    if (/^\/media\/[0-9a-f]{40}$/.test(path) && req.method === 'GET') return;
    // Articles published before /media embed their image at the old hub asset address; keep images there working.
    if (/^\/projects\/[0-9a-f-]{36}\/assets\/[0-9a-f]{40}$/.test(path) && req.method === 'GET') return;
    // Posting pages for the operator: the random token in the link is the access (sent only in their Telegram DM).
    if (/^\/assist\/[A-Za-z0-9_-]{32}$/.test(path) && req.method === 'GET') return;
    if (/^\/assist\/[A-Za-z0-9_-]{32}\/done$/.test(path) && req.method === 'POST') return;
    if (path.startsWith('/projects/')) {
      if (config.PUBLIC_HUB_ENABLED) return;
      return reply.code(404).send({ error: { code: 'not_found', message: 'Public hubs are disabled' } });
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const scope = token && !safeEqual(token, config.ADMIN_API_TOKEN) ? authenticateKey(ctx, token) : null;
    if (token && safeEqual(token, config.ADMIN_API_TOKEN)) req.principal = 'admin';
    else if (scope) req.principal = scope;
    else return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid bearer token' } });
    if (req.principal === 'intake' && !intakeAllowed(req.method, path))
      return reply.code(403).send({ error: { code: 'forbidden', message: 'This key can only create trending orders and read their status' } });
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
