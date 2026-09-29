import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all } from '../db/database.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { safeEqual, type Sessions } from '../lib/crypto.js';
import { AppError, ValidationError } from '../lib/errors.js';
import { lamportsToSol } from '../lib/money.js';
import type { ServiceContext } from '../services/context.js';
import {
  cancelPosition,
  receiveTrigger,
  sellNow,
  sweep,
  type PositionRow,
  type TriggerRow,
  type TxRow,
} from '../services/engine.js';
import { getSettings, updateSettings } from '../services/settings.js';
import { archiveWallet, createWallet, listWallets, updateWallet, type WalletRow } from '../services/wallets.js';
import { DASHBOARD_HTML } from '../dashboard/page.js';

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_PER_IP = 5;
const LOGIN_MAX_GLOBAL = 30;

class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly nowMs: () => number) {}
  private recent(key: string): number[] {
    const cutoff = this.nowMs() - LOGIN_WINDOW_MS;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    this.failures.set(key, list);
    return list;
  }
  blocked(ip: string): boolean {
    return this.recent(ip).length >= LOGIN_MAX_PER_IP || this.recent('*').length >= LOGIN_MAX_GLOBAL;
  }
  fail(ip: string): void {
    for (const k of [ip, '*']) this.recent(k).push(this.nowMs());
  }
}

function presentWallet(w: WalletRow, balance: bigint | null) {
  return {
    id: w.id,
    role: w.role,
    label: w.label,
    address: w.address,
    buyPct: w.buy_pct,
    sellPct: w.sell_pct,
    sellIntervalHours: w.sell_interval_hours,
    enabled: Boolean(w.enabled),
    balanceSol: balance === null ? null : lamportsToSol(balance),
    createdAt: w.created_at,
  };
}

const idParam = (req: FastifyRequest) => (req.params as { id: string }).id;

export function registerDashboardRoutes(app: FastifyInstance, ctx: ServiceContext, sessions: Sessions): void {
  const throttle = new LoginThrottle(() => ctx.clock.now().getTime());

  app.get('/', async (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .send(DASHBOARD_HTML),
  );

  app.post('/api/login', async (req, reply) => {
    if (throttle.blocked(req.ip))
      throw new AppError('Too many failed attempts; wait 15 minutes', 429, 'rate_limited');
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || !safeEqual(password, ctx.config.DASHBOARD_PASSWORD)) {
      throttle.fail(req.ip);
      throw new AppError('Wrong password', 401, 'unauthorized');
    }
    const maxAge = Math.round(ctx.config.SESSION_TTL_HOURS * 3600);
    const token = sessions.issue(ctx.clock.now().getTime() + maxAge * 1000);
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${ctx.config.COOKIE_SECURE ? '; Secure' : ''}`,
    );
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/state', async () => {
    const wallets = listWallets(ctx);
    const balances = await Promise.all(wallets.map((w) => ctx.chain.getBalance(w.address).catch(() => null)));
    const labels = new Map(
      all<{ id: string; label: string }>(ctx.db, 'SELECT id, label FROM wallets').map((w) => [w.id, w.label]),
    );
    const triggers = all<TriggerRow>(ctx.db, 'SELECT * FROM triggers ORDER BY received_at DESC LIMIT 50');
    const positions = all<PositionRow>(
      ctx.db,
      `SELECT * FROM positions ORDER BY status IN ('closed', 'failed', 'cancelled'), created_at DESC LIMIT 100`,
    );
    const txs = all<TxRow>(ctx.db, 'SELECT * FROM txs ORDER BY created_at DESC LIMIT 100');
    const settings = getSettings(ctx);
    return {
      now: ctx.clock.now().getTime(),
      settings,
      wallets: wallets.map((w, i) => presentWallet(w, balances[i] ?? null)),
      triggers: triggers.map((t) => ({
        id: t.id,
        contractAddress: t.mint,
        eventId: t.event_id,
        source: t.source,
        status: t.status,
        note: t.note,
        funding: t.funding_status,
        fundingTo: t.funding_to,
        fundingSol: t.funding_lamports ? lamportsToSol(BigInt(t.funding_lamports)) : null,
        receivedAt: t.received_at,
        buysAt: t.received_at + Math.round(settings.buyDelayMinutes * 60_000),
      })),
      positions: positions.map((p) => ({
        id: p.id,
        triggerId: p.trigger_id,
        wallet: labels.get(p.wallet_id) ?? p.wallet_id,
        contractAddress: p.mint,
        status: p.status,
        buyAttempts: p.buy_attempts,
        solSpent: lamportsToSol(BigInt(p.sol_spent)),
        tokensBought: p.tokens_bought,
        tokensSold: p.tokens_sold,
        solReceived: lamportsToSol(BigInt(p.sol_received)),
        sells: p.sells,
        nextActionAt: p.next_action_at,
        lastError: p.last_error,
      })),
      activity: txs.map((t) => ({
        id: t.id,
        kind: t.kind,
        wallet: labels.get(t.wallet_id) ?? t.wallet_id,
        to: t.to_address,
        amountIn: t.kind === 'sell' ? t.amount_in : lamportsToSol(BigInt(t.amount_in)),
        expectedOut: t.expected_out === null ? null : t.kind === 'sell' ? lamportsToSol(BigInt(t.expected_out)) : t.expected_out,
        signature: t.signature,
        status: t.status,
        error: t.error,
        createdAt: t.created_at,
      })),
    };
  });

  app.put('/api/settings', async (req) => ({ settings: updateSettings(ctx, req.body) }));

  app.post('/api/wallets', async (req, reply) => {
    const r = await createWallet(ctx, req.body);
    return reply.code(201).send({ wallet: presentWallet(r.wallet, null), generatedSecret: r.generatedSecret });
  });

  app.patch('/api/wallets/:id', async (req) => ({ wallet: presentWallet(updateWallet(ctx, idParam(req), req.body), null) }));

  // POST (not DELETE) so the JSON content-type CSRF guard applies.
  app.post('/api/wallets/:id/remove', async (req) => {
    archiveWallet(ctx, idParam(req));
    return { ok: true };
  });

  app.post('/api/trigger', async (req, reply) => {
    const body = z.object({ contractAddress: z.string().min(1) }).safeParse(req.body);
    if (!body.success) throw new ValidationError('contractAddress is required');
    const r = receiveTrigger(ctx, { mint: body.data.contractAddress, source: 'dashboard' });
    return reply.code(202).send({ triggerId: r.trigger.id, status: r.trigger.status, scheduledBuys: r.positions, note: r.trigger.note });
  });

  app.post('/api/positions/:id/sell-now', async (req) => {
    const pct = (req.body as { pct?: unknown } | undefined)?.pct;
    return { position: sellNow(ctx, idParam(req), typeof pct === 'number' ? pct : 100) };
  });

  app.post('/api/positions/:id/cancel', async (req) => ({ position: cancelPosition(ctx, idParam(req)) }));

  app.post('/api/sweep', async (req) => {
    const body = z.object({ walletIds: z.array(z.string()).min(1).max(100) }).safeParse(req.body);
    if (!body.success) throw new ValidationError('Select at least one wallet');
    return { results: await sweep(ctx, body.data.walletIds) };
  });
}
