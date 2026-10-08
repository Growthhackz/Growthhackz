import { all, get, run, transaction } from '../db/database.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { fromMicros, toMicros } from '../lib/money.js';
import { isoPlus, nowIso, type ServiceContext } from '../services/context.js';
import {
  COMPONENT_STATUSES,
  componentPlans,
  normalizeTargets,
  packageCeilingMicros,
  TargetError,
  type ComponentKind,
  type ComponentStatus,
  type PackageStatus,
  type Preset,
} from './package.js';
import { assertApprovedUrl, checkQuote, readChallenge, readSettlement, WurkSetupError } from './x402.js';

// ------------------------------------------------------------------ rows

export interface WurkPackageRow {
  id: string;
  idempotency_key: string | null;
  customer_ref: string | null;
  test: number;
  preset: Preset;
  bundled: number;
  x_handle: string;
  x_post_url: string;
  tg_url: string;
  retail_price_micros: number | null;
  cost_ceiling_micros: number;
  payment_ref: string | null;
  paid_at: string | null;
  paused: number;
  created_at: string;
  updated_at: string;
}

export interface WurkComponentRow {
  id: string;
  package_id: string;
  kind: ComponentKind;
  request_url: string;
  quantities: string;
  status: ComponentStatus;
  ceiling_micros: number;
  quoted_micros: number | null;
  settled_micros: number | null;
  provider_job_id: string | null;
  job_link: string | null;
  status_url: string | null;
  provider_raw: string | null;
  last_error: string | null;
  scheduled_for: string | null;
  defer_count: number;
  attempts: number;
  next_check_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WurkPaymentRow {
  id: string;
  component_id: string | null;
  purpose: string;
  request_url: string;
  status: 'intent' | 'signed' | 'settled' | 'failed' | 'reconcile_required';
  amount_micros: number;
  pay_to: string;
  asset: string;
  network: string;
  transaction_id: string | null;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Payments that may have moved money. They count toward every ceiling and block a second payment. */
const COMMITTED = "('signed', 'settled', 'reconcile_required')";
/** Give up deferring the second Telegram batch after this many 409s (at 10 minutes apart). */
const MAX_TG_DEFERRALS = 12;
const TG_DEFER_MS = 10 * 60_000;
const MAX_QUOTE_ATTEMPTS = 5;
const STATUS_POLL_LIMIT_MS = 7 * 24 * 60 * 60_000;

// -------------------------------------------------------------- settings

export interface WurkSettings {
  killSwitch: boolean;
  tgSecondBatchDelayMinutes: number;
  retailPriceUsd: number | null;
}

export function getSettings(ctx: ServiceContext): WurkSettings {
  const rows = all<{ key: string; value: string }>(ctx.db, 'SELECT key, value FROM wurk_settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    killSwitch: s.kill_switch === '1',
    tgSecondBatchDelayMinutes: s.tg_delay_minutes !== undefined ? Number(s.tg_delay_minutes) : ctx.config.WURK_TG_SECOND_BATCH_DELAY_MIN,
    retailPriceUsd: s.retail_price_micros !== undefined ? fromMicros(Number(s.retail_price_micros)) : null,
  };
}

export function updateSettings(ctx: ServiceContext, patch: Partial<WurkSettings>, actor: string): WurkSettings {
  const put = (key: string, value: string) =>
    run(
      ctx.db,
      `INSERT INTO wurk_settings (key, value, updated_at) VALUES (:key, :value, :t)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key, value, t: nowIso(ctx) },
    );
  if (patch.killSwitch !== undefined) put('kill_switch', patch.killSwitch ? '1' : '0');
  if (patch.tgSecondBatchDelayMinutes !== undefined) put('tg_delay_minutes', String(patch.tgSecondBatchDelayMinutes));
  if (patch.retailPriceUsd !== undefined && patch.retailPriceUsd !== null) put('retail_price_micros', String(toMicros(patch.retailPriceUsd)));
  audit(ctx, { actor, action: 'settings.updated', detail: patch });
  return getSettings(ctx);
}

// ----------------------------------------------------------------- audit

function audit(ctx: ServiceContext, e: { packageId?: string; componentId?: string; actor: string; action: string; detail?: unknown }) {
  run(
    ctx.db,
    `INSERT INTO wurk_audit (package_id, component_id, actor, action, detail, created_at)
     VALUES (:p, :c, :actor, :action, :detail, :t)`,
    { p: e.packageId, c: e.componentId, actor: e.actor, action: e.action, detail: e.detail === undefined ? null : JSON.stringify(e.detail), t: nowIso(ctx) },
  );
}

// --------------------------------------------------------------- queries

export function getPackage(ctx: ServiceContext, id: string): WurkPackageRow {
  const p = get<WurkPackageRow>(ctx.db, 'SELECT * FROM wurk_packages WHERE id = :id', { id });
  if (!p) throw new NotFoundError('WURK package');
  return p;
}

export function componentsOf(ctx: ServiceContext, packageId: string): WurkComponentRow[] {
  return all<WurkComponentRow>(ctx.db, 'SELECT * FROM wurk_components WHERE package_id = :p ORDER BY created_at, kind', { p: packageId });
}

function getComponent(ctx: ServiceContext, id: string): WurkComponentRow {
  const c = get<WurkComponentRow>(ctx.db, 'SELECT * FROM wurk_components WHERE id = :id', { id });
  if (!c) throw new NotFoundError('WURK component');
  return c;
}

export function paymentsOf(ctx: ServiceContext, componentId: string): WurkPaymentRow[] {
  return all<WurkPaymentRow>(ctx.db, 'SELECT * FROM wurk_payments WHERE component_id = :c ORDER BY created_at', { c: componentId });
}

function committedForPackage(ctx: ServiceContext, packageId: string): number {
  return (
    get<{ s: number | null }>(
      ctx.db,
      `SELECT SUM(p.amount_micros) AS s FROM wurk_payments p JOIN wurk_components c ON c.id = p.component_id
       WHERE c.package_id = :p AND p.status IN ${COMMITTED}`,
      { p: packageId },
    )?.s ?? 0
  );
}

export function spentToday(ctx: ServiceContext): number {
  const dayStart = `${nowIso(ctx).slice(0, 10)}T00:00:00.000Z`;
  return (
    get<{ s: number | null }>(ctx.db, `SELECT SUM(amount_micros) AS s FROM wurk_payments WHERE status IN ${COMMITTED} AND created_at >= :d`, {
      d: dayStart,
    })?.s ?? 0
  );
}

/** Package status rolled up from its components (a paused package keeps its status and reports `paused`). */
export function packageStatus(p: WurkPackageRow, all: WurkComponentRow[]): PackageStatus {
  if (!p.paid_at) return 'pending_payment';
  const comps = all.filter((c) => c.status !== 'cancelled');
  if (!comps.length) return 'cancelled';
  const has = (s: ComponentStatus) => comps.some((c) => c.status === s);
  if (has('reconcile_required')) return 'reconcile_required';
  if (has('needs_attention')) return 'needs_attention';
  if (comps.every((c) => c.status === 'completed')) return 'completed';
  if (comps.every((c) => c.status === 'completed' || c.status === 'partial')) return 'partial';
  if (has('quoting')) return 'quoting';
  if (has('in_progress') || has('paid_job_created') || has('completed') || has('partial')) return 'in_progress';
  if (comps.every((c) => c.status === 'scheduled')) return 'scheduled';
  return has('queued') ? 'queued' : 'scheduled';
}

// -------------------------------------------------------------- creation

export interface CreatePackageInput {
  preset?: Preset;
  xProfile?: string;
  xPost?: string;
  telegram?: string;
  customerRef?: string;
  /** Admin test orders skip the retail price requirement. */
  test?: boolean;
  /** Included in another product (e.g. a trending purchase): no retail price of its own. */
  bundled?: boolean;
}

export function createPackage(ctx: ServiceContext, input: CreatePackageInput, idempotencyKey?: string): { pkg: WurkPackageRow; replayed: boolean } {
  if (idempotencyKey) {
    const existing = get<WurkPackageRow>(ctx.db, 'SELECT * FROM wurk_packages WHERE idempotency_key = :k', { k: idempotencyKey });
    if (existing) return { pkg: existing, replayed: true };
  }
  let targets;
  try {
    targets = normalizeTargets(input, input.preset ?? 'full');
  } catch (err) {
    if (err instanceof TargetError) throw new ValidationError(err.message);
    throw err;
  }
  const settings = getSettings(ctx);
  const preset = input.preset ?? 'full';
  if (!input.test && !input.bundled && settings.retailPriceUsd === null)
    throw new ValidationError('Set the WURK package retail price first (PUT /v1/wurk/settings retailPriceUsd)');

  const id = newId('wpk');
  const t = nowIso(ctx);
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO wurk_packages (id, idempotency_key, customer_ref, test, preset, bundled, x_handle, x_post_url, tg_url,
         retail_price_micros, cost_ceiling_micros, created_at, updated_at)
       VALUES (:id, :key, :ref, :test, :preset, :bundled, :h, :post, :tg, :retail, :ceiling, :t, :t)`,
      {
        id,
        key: idempotencyKey,
        ref: input.customerRef,
        test: !!input.test,
        preset,
        bundled: !!input.bundled,
        h: targets.xHandle,
        post: targets.xPostUrl,
        tg: targets.tgUrl,
        retail: input.test || input.bundled || settings.retailPriceUsd === null ? null : toMicros(settings.retailPriceUsd),
        ceiling: packageCeilingMicros(ctx.config, preset),
        t,
      },
    );
    for (const plan of componentPlans(ctx.config, targets, preset)) {
      run(
        ctx.db,
        `INSERT INTO wurk_components (id, package_id, kind, request_url, quantities, status, ceiling_micros, created_at, updated_at)
         VALUES (:id, :p, :kind, :url, :q, 'pending_payment', :ceiling, :t, :t)`,
        { id: newId('wcm'), p: id, kind: plan.kind, url: plan.url, q: plan.quantities, ceiling: plan.ceilingMicros, t },
      );
    }
  });
  audit(ctx, { packageId: id, actor: 'api', action: 'package.created', detail: { customerRef: input.customerRef, test: !!input.test, preset, bundled: !!input.bundled } });
  return { pkg: getPackage(ctx, id), replayed: false };
}

/**
 * Checkout handoff: the customer's payment for this package is confirmed. Queues the first three purchases and
 * schedules the second Telegram batch. Idempotent.
 */
export function markPaid(ctx: ServiceContext, packageId: string, paymentRef: string, actor = 'checkout'): WurkPackageRow {
  const p = getPackage(ctx, packageId);
  if (p.paid_at) {
    if (p.payment_ref !== paymentRef) throw new ConflictError(`Package already marked paid with reference ${p.payment_ref}`);
    return p;
  }
  const t = nowIso(ctx);
  const delayMs = getSettings(ctx).tgSecondBatchDelayMinutes * 60_000;
  transaction(ctx.db, () => {
    run(ctx.db, 'UPDATE wurk_packages SET paid_at = :t, payment_ref = :ref, updated_at = :t WHERE id = :id', { t, ref: paymentRef, id: p.id });
    run(
      ctx.db,
      `UPDATE wurk_components SET status = 'queued', scheduled_for = :t, updated_at = :t
       WHERE package_id = :p AND kind != 'tg_batch_2' AND status = 'pending_payment'`,
      { p: p.id, t },
    );
    run(
      ctx.db,
      `UPDATE wurk_components SET status = 'scheduled', scheduled_for = :at, updated_at = :t
       WHERE package_id = :p AND kind = 'tg_batch_2' AND status = 'pending_payment'`,
      { p: p.id, at: isoPlus(ctx, delayMs), t },
    );
  });
  audit(ctx, { packageId: p.id, actor, action: 'package.paid', detail: { paymentRef, tgSecondBatchDelayMinutes: delayMs / 60_000 } });
  return getPackage(ctx, p.id);
}

// ------------------------------------------------------------ processing

function setComponent(ctx: ServiceContext, id: string, fields: Partial<WurkComponentRow>) {
  const sets = Object.keys(fields).map((k) => `${k} = :${k}`);
  run(ctx.db, `UPDATE wurk_components SET ${[...sets, 'updated_at = :updated_at'].join(', ')} WHERE id = :id`, {
    ...fields,
    updated_at: nowIso(ctx),
    id,
  });
}

function needsAttention(ctx: ServiceContext, c: WurkComponentRow, reason: string, extra: Partial<WurkComponentRow> = {}) {
  setComponent(ctx, c.id, { status: 'needs_attention', last_error: reason, ...extra });
  audit(ctx, { packageId: c.package_id, componentId: c.id, actor: 'system', action: 'component.needs_attention', detail: { reason } });
}

/** A component that was mid-payment when the process stopped. Anything possibly signed must be reconciled. */
export function recoverInterruptedWurk(ctx: ServiceContext): number {
  let n = 0;
  for (const c of all<WurkComponentRow>(ctx.db, "SELECT * FROM wurk_components WHERE status = 'quoting'")) {
    const signed = paymentsOf(ctx, c.id).some((p) => p.status === 'signed');
    if (signed) {
      run(ctx.db, "UPDATE wurk_payments SET status = 'reconcile_required', updated_at = :t WHERE component_id = :c AND status = 'signed'", {
        c: c.id,
        t: nowIso(ctx),
      });
      setComponent(ctx, c.id, { status: 'reconcile_required', last_error: 'Stopped after signing; the payment may have settled.' });
    } else {
      run(ctx.db, "UPDATE wurk_payments SET status = 'failed', error = 'never sent', updated_at = :t WHERE component_id = :c AND status = 'intent'", {
        c: c.id,
        t: nowIso(ctx),
      });
      setComponent(ctx, c.id, { status: 'queued' });
    }
    n++;
  }
  return n;
}

/** Background tick: runs due components one at a time and polls documented status URLs. */
export async function processWurk(ctx: ServiceContext): Promise<{ processed: number; polled: number }> {
  if (getSettings(ctx).killSwitch) return { processed: 0, polled: 0 };
  const due = all<WurkComponentRow>(
    ctx.db,
    `SELECT c.* FROM wurk_components c JOIN wurk_packages p ON p.id = c.package_id
     WHERE c.status IN ('queued', 'scheduled') AND c.scheduled_for <= :t AND p.paid_at IS NOT NULL AND p.paused = 0
     ORDER BY c.scheduled_for LIMIT 10`,
    { t: nowIso(ctx) },
  );
  let processed = 0;
  for (const c of due) {
    if (getSettings(ctx).killSwitch) break;
    if (await runComponent(ctx, c.id)) processed++;
  }
  return { processed, polled: await pollStatuses(ctx) };
}

/** Quote → validate → persist intent → sign → paid retry, for one component. Returns false if it wasn't claimable. */
export async function runComponent(ctx: ServiceContext, componentId: string): Promise<boolean> {
  const claimed = run(
    ctx.db,
    `UPDATE wurk_components SET status = 'quoting', attempts = attempts + 1, updated_at = :t
     WHERE id = :id AND status IN ('queued', 'scheduled') AND scheduled_for <= :t`,
    { id: componentId, t: nowIso(ctx) },
  );
  if (!claimed.changes) return false;
  const c = getComponent(ctx, componentId);
  const pkg = getPackage(ctx, c.package_id);
  const wurk = ctx.wurk;

  if (paymentsOf(ctx, c.id).some((p) => ['signed', 'settled', 'reconcile_required'].includes(p.status))) {
    needsAttention(ctx, c, 'A payment for this component already exists; reconcile it instead of paying again.');
    return true;
  }

  // WURK's paid endpoint for this kind misbehaved recently (kept a payment, refused or errored after paying):
  // wait it out instead of paying again into it. Doesn't use up an attempt.
  const held = holdUntil(ctx, c.kind);
  if (held) {
    setComponent(ctx, c.id, { status: 'queued', attempts: Math.max(0, c.attempts - 1), scheduled_for: held, last_error: `WURK ${c.kind} is failing after payment; holding paid requests until ${held}` });
    return true;
  }

  try {
    assertApprovedUrl(ctx.config, c.request_url);
  } catch (err) {
    needsAttention(ctx, c, (err as Error).message);
    return true;
  }

  // 1. Unpaid request: WURK answers 402 with the live quote (or an error if the target is blocked/capped).
  let res: Response;
  try {
    res = await wurk.fetch(c.request_url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return retryLater(ctx, c, `Quote request failed: ${(err as Error).message}`);
  }
  if (res.status !== 402) {
    const body = (await res.text().catch(() => '')).slice(0, 2000);
    setComponent(ctx, c.id, { provider_raw: body });
    if (res.status === 409 && c.kind === 'tg_batch_2') return defer(ctx, c, `WURK reported an overlapping Telegram job (409): ${body}`);
    if (res.status === 429 || res.status >= 500) return retryLater(ctx, c, `WURK returned ${res.status} on quote`);
    needsAttention(ctx, c, `WURK refused the quote (${res.status}): ${body || 'no details'}`);
    return true;
  }
  const check = checkQuote(ctx.config, await readChallenge(res), c.ceiling_micros);
  if (!check.ok) {
    needsAttention(ctx, c, check.reason);
    return true;
  }
  const { quote } = check;
  setComponent(ctx, c.id, { quoted_micros: quote.amountMicros });

  // 2. Spend controls, before anything is signed.
  const committed = committedForPackage(ctx, pkg.id);
  if (committed + quote.amountMicros > pkg.cost_ceiling_micros) {
    needsAttention(ctx, c, `Package cost would reach ${fromMicros(committed + quote.amountMicros)} USDC, above its ${fromMicros(pkg.cost_ceiling_micros)} USDC ceiling`);
    return true;
  }
  if (spentToday(ctx) + quote.amountMicros > toMicros(ctx.config.WURK_DAILY_MAX_USDC)) {
    needsAttention(ctx, c, `Daily WURK spend ceiling (${ctx.config.WURK_DAILY_MAX_USDC} USDC) reached`);
    return true;
  }
  const missing = wurk.missingForLive();
  if (missing.length) {
    needsAttention(ctx, c, `Dry run: quoted ${fromMicros(quote.amountMicros)} USDC; set ${missing.join(' and ')} to pay`);
    return true;
  }
  let payer;
  try {
    payer = await wurk.payer();
  } catch (err) {
    needsAttention(ctx, c, err instanceof WurkSetupError ? err.message : 'Wallet unavailable');
    return true;
  }
  const balance = await payer.usdcBalanceMicros();
  if (balance === null) return retryLater(ctx, c, 'Could not read the wallet USDC balance from SOLANA_RPC_URL');
  if (balance < quote.amountMicros) {
    needsAttention(ctx, c, `Wallet ${payer.address} holds ${fromMicros(balance)} USDC; this purchase needs ${fromMicros(quote.amountMicros)}`);
    return true;
  }

  // 3. Persist intent, sign, mark signed, then send. A crash after "signed" is always reconciled, never re-paid.
  const paymentId = newId('wpy');
  const t = nowIso(ctx);
  run(
    ctx.db,
    `INSERT INTO wurk_payments (id, component_id, purpose, request_url, status, amount_micros, pay_to, asset, network, created_at, updated_at)
     VALUES (:id, :c, :purpose, :url, 'intent', :amount, :payTo, :asset, :network, :t, :t)`,
    { id: paymentId, c: c.id, purpose: c.kind, url: c.request_url, amount: quote.amountMicros, payTo: quote.accepted.payTo, asset: quote.accepted.asset, network: quote.accepted.network, t },
  );
  let signature: string;
  try {
    signature = await payer.sign(quote.challenge, quote.accepted);
  } catch (err) {
    run(ctx.db, "UPDATE wurk_payments SET status = 'failed', error = :e, updated_at = :t WHERE id = :id", { id: paymentId, e: 'signing failed', t: nowIso(ctx) });
    needsAttention(ctx, c, `Could not sign the payment: ${(err as Error).message.slice(0, 200)}`);
    return true;
  }
  run(ctx.db, "UPDATE wurk_payments SET status = 'signed', updated_at = :t WHERE id = :id", { id: paymentId, t: nowIso(ctx) });

  let paid: Response;
  try {
    paid = await wurk.fetch(c.request_url, { method: 'GET', headers: { 'PAYMENT-SIGNATURE': signature }, signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    return ambiguous(ctx, c, paymentId, null, `Paid request got no response (${(err as Error).message}); the payment may have settled`);
  }
  const text = (await paid.text().catch(() => '')).slice(0, 20_000);
  const settlement = readSettlement(paid);
  run(ctx.db, 'UPDATE wurk_payments SET response_status = :s, response_body = :b, transaction_id = :tx, updated_at = :t WHERE id = :id', {
    id: paymentId,
    s: paid.status,
    b: text,
    tx: settlement.transaction,
    t: nowIso(ctx),
  });

  if (paid.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return ambiguous(ctx, c, paymentId, paid.status, 'WURK answered 200 without JSON; check the job on WURK');
    }
    run(ctx.db, "UPDATE wurk_payments SET status = 'settled', updated_at = :t WHERE id = :id", { id: paymentId, t: nowIso(ctx) });
    const statusUrl = safeStatusUrl(ctx, body.statusUrl);
    setComponent(ctx, c.id, {
      status: 'paid_job_created',
      settled_micros: quote.amountMicros,
      provider_job_id: body.jobId == null ? null : String(body.jobId),
      job_link: typeof body.jobLink === 'string' ? body.jobLink : null,
      status_url: statusUrl,
      provider_raw: text,
      last_error: null,
      next_check_at: statusUrl ? isoPlus(ctx, ctx.config.WURK_STATUS_POLL_MS) : null,
    });
    audit(ctx, { packageId: pkg.id, componentId: c.id, actor: 'system', action: 'component.paid', detail: { jobId: body.jobId, amountUsdc: fromMicros(quote.amountMicros), transaction: settlement.transaction } });
    return true;
  }
  // A settlement header with a transaction means the USDC moved, whatever the status says: never pay again for it.
  if (!paid.ok && settlement.transaction)
    return ambiguous(ctx, c, paymentId, paid.status, `WURK kept the payment (transaction ${settlement.transaction}) but answered ${paid.status}: ${text.slice(0, 200)}. Ask WURK for the job or a refund.`);
  if (paid.status === 402 || paid.status === 400 || paid.status === 409) {
    // x402 settles only after the resource succeeds; a definite refusal means the signed payment was not used.
    run(ctx.db, "UPDATE wurk_payments SET status = 'failed', error = :e, updated_at = :t WHERE id = :id", { id: paymentId, e: `refused ${paid.status}`, t: nowIso(ctx) });
    if (paid.status === 409 && c.kind === 'tg_batch_2') return defer(ctx, c, `WURK refused an overlapping Telegram job (409): ${text.slice(0, 300)}`);
    // A repeat purchase on the same post: WURK already has engagement running there. Nothing was paid; the rest of
    // the package (followers, Telegram members) goes ahead.
    if (/already exists for the tweet/i.test(text)) {
      setComponent(ctx, c.id, { status: 'cancelled', last_error: `Skipped: WURK already has a job on this post (${paid.status})` });
      audit(ctx, { packageId: c.package_id, componentId: c.id, actor: 'system', action: 'component.cancelled', detail: { reason: 'post already boosted' } });
      return true;
    }
    // The quote went stale between the challenge and the payment (WURK: "differs from its sealed component manifest"):
    // nothing was paid, so a fresh quote and a new payment are safe.
    if (paid.status === 409 && /X402_REWARD_SOURCE_INVALID|sealed component manifest/i.test(text))
      return retryLater(ctx, c, `WURK refused a stale quote (409); trying again with a fresh one: ${text.slice(0, 200)}`);
    needsAttention(ctx, c, `WURK refused the paid request (${paid.status}): ${text.slice(0, 300)}`);
    return true;
  }
  return ambiguous(ctx, c, paymentId, paid.status, `WURK returned ${paid.status} after payment was sent; it may have settled`);
}

function safeStatusUrl(ctx: ServiceContext, v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.host === new URL(ctx.config.WURK_BASE_URL).host ? u.href : null;
  } catch {
    return null;
  }
}

/** How long paid requests of one kind wait after WURK failed one after payment (a 5xx, or a refusal that kept the USDC). */
export const PAID_FAILURE_HOLD_MS = 2 * 3600_000;

function holdUntil(ctx: ServiceContext, kind: string): string | null {
  const since = new Date(Date.parse(nowIso(ctx)) - PAID_FAILURE_HOLD_MS).toISOString();
  const last = get<{ t: string | null }>(
    ctx.db,
    `SELECT MAX(p.updated_at) AS t FROM wurk_payments p JOIN wurk_components c ON c.id = p.component_id
     WHERE c.kind = :k AND p.updated_at > :since AND (p.response_status >= 500 OR (p.response_status >= 400 AND p.transaction_id IS NOT NULL))`,
    { k: kind, since },
  )?.t;
  return last ? new Date(Date.parse(last) + PAID_FAILURE_HOLD_MS).toISOString() : null;
}

function retryLater(ctx: ServiceContext, c: WurkComponentRow, reason: string): boolean {
  if (c.attempts >= MAX_QUOTE_ATTEMPTS) {
    needsAttention(ctx, c, `${reason} (gave up after ${c.attempts} attempts)`);
    return true;
  }
  setComponent(ctx, c.id, { status: 'queued', last_error: reason, scheduled_for: isoPlus(ctx, Math.min(30 * 60_000, 60_000 * 2 ** c.attempts)) });
  return true;
}

function defer(ctx: ServiceContext, c: WurkComponentRow, reason: string): boolean {
  if (c.defer_count + 1 > MAX_TG_DEFERRALS) {
    needsAttention(ctx, c, `${reason}. Still overlapping after ${c.defer_count} deferrals; check the first batch on WURK before retrying.`);
    return true;
  }
  setComponent(ctx, c.id, {
    status: 'scheduled',
    last_error: reason,
    defer_count: c.defer_count + 1,
    attempts: Math.max(0, c.attempts - 1),
    scheduled_for: isoPlus(ctx, TG_DEFER_MS),
  });
  audit(ctx, { packageId: c.package_id, componentId: c.id, actor: 'system', action: 'component.deferred', detail: { reason } });
  return true;
}

function ambiguous(ctx: ServiceContext, c: WurkComponentRow, paymentId: string, status: number | null, reason: string): boolean {
  run(ctx.db, "UPDATE wurk_payments SET status = 'reconcile_required', error = :e, response_status = COALESCE(:s, response_status), updated_at = :t WHERE id = :id", {
    id: paymentId,
    e: reason,
    s: status,
    t: nowIso(ctx),
  });
  setComponent(ctx, c.id, { status: 'reconcile_required', last_error: reason });
  audit(ctx, { packageId: c.package_id, componentId: c.id, actor: 'system', action: 'component.reconcile_required', detail: { reason } });
  return true;
}

/** Reads only the statusUrl WURK itself returned. Completion is taken only from an explicit field. */
async function pollStatuses(ctx: ServiceContext): Promise<number> {
  const rows = all<WurkComponentRow>(
    ctx.db,
    `SELECT * FROM wurk_components WHERE status IN ('paid_job_created', 'in_progress') AND status_url IS NOT NULL AND next_check_at <= :t LIMIT 20`,
    { t: nowIso(ctx) },
  );
  for (const c of rows) {
    const next = isoPlus(ctx, ctx.config.WURK_STATUS_POLL_MS);
    try {
      const res = await ctx.wurk.fetch(c.status_url!, { signal: AbortSignal.timeout(20_000) });
      const text = (await res.text()).slice(0, 20_000);
      let done = false;
      try {
        const b = JSON.parse(text) as Record<string, unknown>;
        done = b.completed === true || ['completed', 'complete', 'finished', 'done'].includes(String(b.status ?? '').toLowerCase());
      } catch {
        // keep raw text
      }
      const expired = ctx.clock.now().getTime() - Date.parse(c.created_at) > STATUS_POLL_LIMIT_MS;
      setComponent(ctx, c.id, {
        status: done ? 'completed' : 'in_progress',
        provider_raw: text,
        completed_at: done ? nowIso(ctx) : null,
        next_check_at: done || expired ? null : next,
      });
    } catch {
      setComponent(ctx, c.id, { next_check_at: next });
    }
  }
  return rows.length;
}

// ---------------------------------------------------------- admin actions

export function setPaused(ctx: ServiceContext, packageId: string, paused: boolean, actor: string) {
  getPackage(ctx, packageId);
  run(ctx.db, 'UPDATE wurk_packages SET paused = :v, updated_at = :t WHERE id = :id', { v: paused, t: nowIso(ctx), id: packageId });
  audit(ctx, { packageId, actor, action: paused ? 'package.paused' : 'package.resumed' });
}

/** Re-queues a component that stopped before paying. Refused while any payment may have settled. */
export function retryComponent(ctx: ServiceContext, componentId: string, actor: string, note?: string) {
  const c = getComponent(ctx, componentId);
  if (c.status !== 'needs_attention') throw new ConflictError(`Only needs_attention components can be retried (this one is ${c.status})`);
  if (paymentsOf(ctx, c.id).some((p) => ['signed', 'settled', 'reconcile_required'].includes(p.status)))
    throw new ConflictError('A payment for this component may have settled; reconcile it instead');
  setComponent(ctx, c.id, { status: 'queued', scheduled_for: nowIso(ctx), attempts: 0, last_error: null });
  audit(ctx, { packageId: c.package_id, componentId: c.id, actor, action: 'component.retried', detail: { note } });
}

export interface ReconcileInput {
  /** true: WURK has the job (paid). false: the payment did not settle (checked on-chain / with WURK support). */
  settled: boolean;
  jobId?: string;
  jobLink?: string;
  transaction?: string;
  note: string;
}

export function reconcileComponent(ctx: ServiceContext, componentId: string, input: ReconcileInput, actor: string) {
  const c = getComponent(ctx, componentId);
  if (c.status !== 'reconcile_required') throw new ConflictError(`Component is ${c.status}, not reconcile_required`);
  const t = nowIso(ctx);
  const pending = paymentsOf(ctx, c.id).filter((p) => p.status === 'reconcile_required');
  transaction(ctx.db, () => {
    for (const p of pending)
      run(ctx.db, 'UPDATE wurk_payments SET status = :s, transaction_id = COALESCE(:tx, transaction_id), updated_at = :t WHERE id = :id', {
        s: input.settled ? 'settled' : 'failed',
        tx: input.transaction,
        t,
        id: p.id,
      });
    if (input.settled)
      setComponent(ctx, c.id, {
        status: 'paid_job_created',
        settled_micros: pending[0]?.amount_micros ?? c.quoted_micros,
        provider_job_id: input.jobId ?? c.provider_job_id,
        job_link: input.jobLink ?? c.job_link,
        last_error: null,
      });
    else setComponent(ctx, c.id, { status: 'queued', scheduled_for: t, attempts: 0, last_error: null });
  });
  audit(ctx, { packageId: c.package_id, componentId: c.id, actor, action: 'component.reconciled', detail: input });
}

/** Manual correction after checking WURK directly (e.g. marking delivery complete). Audited. */
export function correctStatus(ctx: ServiceContext, componentId: string, status: ComponentStatus, note: string, actor: string) {
  const c = getComponent(ctx, componentId);
  if (!(COMPONENT_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Unknown status ${status}`);
  if (status === 'quoting') throw new ValidationError('quoting is set only by the worker');
  if (['queued', 'scheduled'].includes(status) && paymentsOf(ctx, c.id).some((p) => ['signed', 'settled', 'reconcile_required'].includes(p.status)))
    throw new ConflictError('This component has a payment that may have settled; it cannot be queued to pay again');
  if (status === 'cancelled') {
    const pays = paymentsOf(ctx, c.id);
    if (pays.some((p) => p.status === 'settled' || p.status === 'signed')) throw new ConflictError('This component was paid; reconcile it instead of cancelling');
    // An unconfirmed payment the admin checked on-chain (the note says so) never settled.
    run(ctx.db, "UPDATE wurk_payments SET status = 'failed', error = :e, updated_at = :t WHERE component_id = :c AND status = 'reconcile_required'", {
      c: c.id,
      e: `Not settled (checked by ${actor}): ${note}`.slice(0, 500),
      t: nowIso(ctx),
    });
  }
  setComponent(ctx, c.id, {
    status,
    completed_at: status === 'completed' ? nowIso(ctx) : c.completed_at,
    scheduled_for: ['queued', 'scheduled'].includes(status) ? (c.scheduled_for ?? nowIso(ctx)) : c.scheduled_for,
  });
  audit(ctx, { packageId: c.package_id, componentId: c.id, actor, action: 'component.status_corrected', detail: { from: c.status, to: status, note } });
}

export function auditTrail(ctx: ServiceContext, packageId: string) {
  return all<{ id: number; component_id: string | null; actor: string; action: string; detail: string | null; created_at: string }>(
    ctx.db,
    'SELECT * FROM wurk_audit WHERE package_id = :p ORDER BY id',
    { p: packageId },
  ).map((a) => ({ ...a, detail: a.detail ? (JSON.parse(a.detail) as unknown) : null }));
}

export function listPackages(ctx: ServiceContext, limit: number, offset: number): WurkPackageRow[] {
  return all<WurkPackageRow>(ctx.db, 'SELECT * FROM wurk_packages ORDER BY created_at DESC LIMIT :limit OFFSET :offset', { limit, offset });
}
