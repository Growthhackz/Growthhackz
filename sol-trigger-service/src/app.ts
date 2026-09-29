import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { get, openDatabase, type Db } from './db/database.js';
import { systemClock, type Clock } from './lib/clock.js';
import { safeEqual, Sessions, Vault } from './lib/crypto.js';
import { readCookie, SESSION_COOKIE } from './lib/cookies.js';
import { AppError } from './lib/errors.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerTriggerRoutes } from './routes/trigger.js';
import { RpcChain, type Chain } from './solana/chain.js';
import { JupiterSwapper, type Swapper } from './solana/jupiter.js';
import type { ServiceContext } from './services/context.js';

export interface BuildAppOptions {
  config: Config;
  db?: Db;
  clock?: Clock;
  chain?: Chain;
  swapper?: Swapper;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: ServiceContext;
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export function buildApp(opts: BuildAppOptions): BuiltApp {
  const { config } = opts;
  const app = Fastify({
    bodyLimit: 50_000,
    trustProxy: true,
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
    },
  });
  const db = opts.db ?? openDatabase(config.DATABASE_PATH);
  const ctx: ServiceContext = {
    db,
    config,
    clock: opts.clock ?? systemClock,
    log: app.log,
    vault: new Vault(config.ENCRYPTION_KEY),
    chain: opts.chain ?? new RpcChain(config.SOLANA_RPC_URL),
    swapper: opts.swapper ?? new JupiterSwapper(config.JUPITER_API_URL, config.JUPITER_API_KEY),
  };
  const sessions = new Sessions(config.ENCRYPTION_KEY);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/v1/')) {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /i, '') || String(req.headers['x-api-key'] ?? '');
      if (!token || !safeEqual(token, config.TRIGGER_API_TOKEN))
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid trigger token' } });
      return;
    }
    if (!path.startsWith('/api/')) return;
    // CSRF: browsers can only send JSON cross-site after a CORS preflight, which this service never grants.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
        return reply.code(415).send({ error: { code: 'unsupported_media_type', message: 'Send JSON' } });
      const origin = req.headers.origin;
      if (origin && originHost(origin) !== req.headers.host)
        return reply.code(403).send({ error: { code: 'forbidden', message: 'Cross-origin request' } });
    }
    if (path === '/api/login') return;
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || !sessions.verify(token, ctx.clock.now().getTime()))
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Log in first' } });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
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
    service: 'sol-trigger-service',
    pending_txs: get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM txs WHERE status = 'pending'")?.n ?? 0,
  }));

  registerTriggerRoutes(app, ctx);
  registerDashboardRoutes(app, ctx, sessions);
  app.addHook('onClose', async () => {
    if (!opts.db) db.close();
  });
  return { app, ctx };
}
