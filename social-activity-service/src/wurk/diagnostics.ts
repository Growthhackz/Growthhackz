import { run } from '../db/database.js';
import { newId } from '../lib/ids.js';
import { fromMicros, toMicros } from '../lib/money.js';
import { nowIso, type ServiceContext } from '../services/context.js';
import { componentPlans, normalizeTargets, smokeUrl } from './package.js';
import { spentToday } from './service.js';
import { assertApprovedUrl, checkQuote, readChallenge, readSettlement } from './x402.js';

export interface QuoteLine {
  component: string;
  url: string;
  httpStatus: number | null;
  quoteUsdc: number | null;
  ceilingUsdc: number;
  payTo: string | null;
  ok: boolean;
  /** Why WURK or our checks would refuse it (blocked target, cap reached, recipient changed…). */
  problem: string | null;
}

/** Calls each WURK route without a payment signature and reports the 402 quotes. Never signs, never spends. */
export async function quoteOnly(ctx: ServiceContext, targets: { xProfile: string; xPost: string; telegram: string }) {
  const plans = componentPlans(ctx.config, normalizeTargets(targets));
  const lines: QuoteLine[] = [];
  for (const plan of plans) {
    const line: QuoteLine = { component: plan.kind, url: plan.url, httpStatus: null, quoteUsdc: null, ceilingUsdc: fromMicros(plan.ceilingMicros), payTo: null, ok: false, problem: null };
    try {
      assertApprovedUrl(ctx.config, plan.url);
      const res = await ctx.wurk.fetch(plan.url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
      line.httpStatus = res.status;
      if (res.status !== 402) {
        line.problem = `WURK answered ${res.status}: ${(await res.text()).slice(0, 300) || 'no details'}`;
      } else {
        const challenge = await readChallenge(res);
        const accepted = challenge?.accepts?.[0];
        if (accepted && /^\d+$/.test(accepted.amount)) line.quoteUsdc = fromMicros(Number(accepted.amount));
        line.payTo = accepted?.payTo ?? null;
        const check = checkQuote(ctx.config, challenge, plan.ceilingMicros);
        line.ok = check.ok;
        if (!check.ok) line.problem = check.reason;
      }
    } catch (err) {
      line.problem = (err as Error).message;
    }
    lines.push(line);
  }
  const totalUsdc = lines.reduce((s, l) => s + (l.quoteUsdc ?? 0), 0);
  return {
    lines,
    totalUsdc: Math.round(totalUsdc * 1e6) / 1e6,
    packageCeilingUsdc: ctx.config.WURK_PACKAGE_MAX_USDC,
    allOk: lines.every((l) => l.ok) && totalUsdc <= ctx.config.WURK_PACKAGE_MAX_USDC,
    liveReady: ctx.wurk.missingForLive().length === 0,
    missingForLive: ctx.wurk.missingForLive(),
  };
}

/**
 * The $1 small X raid, as a standalone live check of the payment path. Requires `execute: true`, the live flag,
 * the key and a funded wallet. Use a test post, not a customer's package post (WURK may reject overlapping jobs).
 */
export async function smokeTest(ctx: ServiceContext, postUrl: string, execute: boolean) {
  const url = smokeUrl(ctx.config, postUrl);
  assertApprovedUrl(ctx.config, url);
  const res = await ctx.wurk.fetch(url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
  if (res.status !== 402) return { executed: false, url, problem: `WURK answered ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const check = checkQuote(ctx.config, await readChallenge(res), toMicros(ctx.config.WURK_SMOKE_MAX_USDC));
  if (!check.ok) return { executed: false, url, problem: check.reason };
  const quoteUsdc = fromMicros(check.quote.amountMicros);
  if (!execute) return { executed: false, url, quoteUsdc, problem: 'Quote only. Pass --execute to pay.' };
  const missing = ctx.wurk.missingForLive();
  if (missing.length) return { executed: false, url, quoteUsdc, problem: `Set ${missing.join(' and ')} first` };
  if (spentToday(ctx) + check.quote.amountMicros > toMicros(ctx.config.WURK_DAILY_MAX_USDC))
    return { executed: false, url, quoteUsdc, problem: 'Daily WURK spend ceiling reached' };
  const payer = await ctx.wurk.payer();
  const balance = await payer.usdcBalanceMicros();
  if (balance === null || balance < check.quote.amountMicros)
    return { executed: false, url, quoteUsdc, wallet: payer.address, problem: `Wallet USDC balance ${balance === null ? 'unreadable' : fromMicros(balance)} is not enough` };

  const id = newId('wpy');
  const t = nowIso(ctx);
  const q = check.quote;
  run(
    ctx.db,
    `INSERT INTO wurk_payments (id, component_id, purpose, request_url, status, amount_micros, pay_to, asset, network, created_at, updated_at)
     VALUES (:id, NULL, 'smoke_test', :url, 'intent', :amount, :payTo, :asset, :network, :t, :t)`,
    { id, url, amount: q.amountMicros, payTo: q.accepted.payTo, asset: q.accepted.asset, network: q.accepted.network, t },
  );
  const signature = await payer.sign(q.challenge, q.accepted);
  run(ctx.db, "UPDATE wurk_payments SET status = 'signed', updated_at = :t WHERE id = :id", { id, t: nowIso(ctx) });
  let paid: Response;
  try {
    paid = await ctx.wurk.fetch(url, { method: 'GET', headers: { 'PAYMENT-SIGNATURE': signature }, signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    run(ctx.db, "UPDATE wurk_payments SET status = 'reconcile_required', error = :e, updated_at = :t WHERE id = :id", { id, e: (err as Error).message, t: nowIso(ctx) });
    return { executed: true, url, quoteUsdc, paymentId: id, problem: 'No response after paying; check the wallet on a Solana explorer before trying again' };
  }
  const text = (await paid.text()).slice(0, 20_000);
  const settlement = readSettlement(paid);
  const status = paid.ok ? 'settled' : [400, 402, 409].includes(paid.status) ? 'failed' : 'reconcile_required';
  run(ctx.db, 'UPDATE wurk_payments SET status = :s, response_status = :h, response_body = :b, transaction_id = :tx, updated_at = :t WHERE id = :id', {
    id,
    s: status,
    h: paid.status,
    b: text,
    tx: settlement.transaction,
    t: nowIso(ctx),
  });
  let body: Record<string, unknown> | string = text;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // keep text
  }
  // Read back whatever WURK exposes for this job.
  let readBack: unknown = null;
  const statusUrl = typeof body === 'object' && typeof body.statusUrl === 'string' ? body.statusUrl : null;
  if (statusUrl && new URL(statusUrl).host === new URL(ctx.config.WURK_BASE_URL).host) {
    try {
      readBack = await (await ctx.wurk.fetch(statusUrl, { signal: AbortSignal.timeout(20_000) })).text();
    } catch (err) {
      readBack = `statusUrl read failed: ${(err as Error).message}`;
    }
  }
  return { executed: true, url, quoteUsdc, paymentId: id, httpStatus: paid.status, paymentStatus: status, transaction: settlement.transaction, response: body, statusUrl, readBack };
}
