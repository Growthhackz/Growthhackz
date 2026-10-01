import { all, get, run } from '../db/database.js';
import { deadlineMs, IRREVERSIBLE, SOURCE_LABELS, STEP_LABELS } from '../domain/schemas.js';
import { nowMs, type ServiceContext } from './context.js';
import { notifyAdmins } from './healthService.js';
import { recordEvent, type JobRow } from './orderService.js';

/**
 * Self-healing for order items. A content step that failed (an image or copy call, a render) gets one automatic
 * second run, together with everything that failed only because it did. Publications are never re-run here: one
 * that may have gone out is checked on the account first (verifyService). Admins hear when an item is caught,
 * when it is fixed, and only if it fails again do they need to do anything.
 */

/** In-process steps that are safe to run again (nothing external is published by them). */
const healable = (kind: string, worker: string[]) => !IRREVERSIBLE.includes(kind) && !worker.includes(kind) && kind !== 'social_boost';
/** Not worth a second run: the budget is spent, or the item only failed because another did (healed with it). */
const NOT_TRANSIENT = /^(Not started:|Timed out after)|Generation allowance reached/;

/** The second run waits this long, so a short provider outage doesn't take both chances. */
export const HEAL_RETRY_DELAY_MS = 10 * 60_000;

const label = (kind: string) => SOURCE_LABELS[kind] ?? STEP_LABELS[kind] ?? kind;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function orderName(ctx: ServiceContext, orderId: string): string {
  const o = get<{ order_id: string; project: string }>(ctx.db, 'SELECT order_id, project FROM orders WHERE id = :id', { id: orderId });
  const p = o ? JSON.parse(o.project) : {};
  return `${p.symbol ? `$${p.symbol}` : (p.name ?? 'order')} (${o?.order_id ?? orderId})`;
}

const marked = (ctx: ServiceContext, jobId: string, type: string) =>
  !!get(ctx.db, 'SELECT 1 AS x FROM events WHERE type = :type AND json_extract(data, \'$.job_id\') = :j', { type, j: jobId });

/** Puts a job back in the queue with fresh attempts and a fresh deadline. */
export function requeue(ctx: ServiceContext, j: JobRow, delayMs = 60_000): boolean {
  const t = nowMs(ctx);
  const r = run(
    ctx.db,
    `UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, lease = NULL, lease_until = NULL, available_at = :a,
       deadline_at = :d, updated_at = :t WHERE id = :id AND status IN ('failed', 'uncertain', 'blocked')`,
    { a: t + delayMs, d: t + deadlineMs(j.kind), t, id: j.id },
  );
  if (r.changes) recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'queued', note: 'retried automatically' });
  return r.changes > 0;
}

/** Runs before orders are settled, so a healed item keeps its order open. */
export async function healOrders(ctx: ServiceContext, workerKinds: string[]): Promise<number> {
  const lines: string[] = [];
  let healed = 0;
  const failed = all<JobRow>(
    ctx.db,
    `SELECT j.* FROM jobs j JOIN orders o ON o.id = j.order_id WHERE j.status = 'failed' AND o.completed_at IS NULL ORDER BY j.rank`,
  );
  for (const j of failed) {
    if (!healable(j.kind, workerKinds) || NOT_TRANSIENT.test(j.error ?? '')) continue;
    if (marked(ctx, j.id, 'heal.retry')) {
      // Already had its second run: ask a person, once.
      if (!marked(ctx, j.id, 'heal.escalated')) {
        recordEvent(ctx, j.order_id, 'heal.escalated', { job_id: j.id, kind: j.kind, error: j.error });
        lines.push(`🔴 Need you: ${esc(orderName(ctx, j.order_id))}: ${esc(label(j.kind))} failed again after an automatic retry: ${esc((j.error ?? '').slice(0, 200))}`);
      }
      continue;
    }
    // After a pause, so a short provider outage is over before the second run.
    if (!requeue(ctx, j, HEAL_RETRY_DELAY_MS)) continue;
    // Everything that failed only because of it goes back too (its dependents, and theirs).
    const reopened: string[] = [j.kind];
    for (let i = 0; i < reopened.length; i++)
      for (const d of all<JobRow>(ctx.db, "SELECT * FROM jobs WHERE order_id = :o AND status = 'failed' AND error = :e", { o: j.order_id, e: `Not started: ${reopened[i]} failed` }))
        if (requeue(ctx, d, 0)) reopened.push(d.kind);
    recordEvent(ctx, j.order_id, 'heal.retry', { job_id: j.id, kind: j.kind, error: j.error, reopened: reopened.slice(1) });
    lines.push(`🟡 Caught: ${esc(orderName(ctx, j.order_id))}: ${esc(label(j.kind))} failed (${esc((j.error ?? '').slice(0, 160))}). Retrying it automatically.`);
    healed++;
  }
  // Retries spend generation allowance too: an order that ran out gets one top-up and its stuck items go back.
  const stuck = all<JobRow>(
    ctx.db,
    `SELECT j.* FROM jobs j JOIN orders o ON o.id = j.order_id WHERE j.status = 'blocked' AND o.completed_at IS NULL AND j.error LIKE 'Generation allowance reached%'`,
  );
  for (const orderId of [...new Set(stuck.map((j) => j.order_id))]) {
    const jobs = stuck.filter((j) => j.order_id === orderId);
    // Only when retries used it up; an order that was simply given a small budget keeps its limit.
    if (!get(ctx.db, 'SELECT 1 AS x FROM jobs WHERE order_id = :o AND attempts > 1', { o: orderId }) && !get(ctx.db, "SELECT 1 AS x FROM events WHERE order_id = :o AND type = 'heal.retry'", { o: orderId }))
      continue;
    if (get(ctx.db, "SELECT 1 AS x FROM events WHERE order_id = :o AND type = 'heal.budget'", { o: orderId })) {
      if (!get(ctx.db, "SELECT 1 AS x FROM events WHERE order_id = :o AND type = 'heal.budget_escalated'", { o: orderId })) {
        recordEvent(ctx, orderId, 'heal.budget_escalated', { jobs: jobs.map((j) => j.kind) });
        lines.push(`🔴 Need you: ${esc(orderName(ctx, orderId))} used its extra generation allowance too (provider keeps failing). Check Gemini, then retry: ${esc(jobs.map((j) => label(j.kind)).join(', '))}.`);
      }
      continue;
    }
    run(ctx.db, 'UPDATE orders SET budget_cents = budget_cents + :c WHERE id = :id', { c: ctx.config.HEAL_BUDGET_CENTS, id: orderId });
    for (const j of jobs) requeue(ctx, j, 0);
    recordEvent(ctx, orderId, 'heal.budget', { cents: ctx.config.HEAL_BUDGET_CENTS, jobs: jobs.map((j) => j.kind) });
    lines.push(`🟡 Caught: ${esc(orderName(ctx, orderId))} ran out of generation allowance on retries. Added ${ctx.config.HEAL_BUDGET_CENTS}¢ and resumed ${esc(jobs.map((j) => label(j.kind)).join(', '))}.`);
  }
  // Second runs that went through since the last pass.
  for (const e of all<{ order_id: string; data: string }>(ctx.db, "SELECT order_id, data FROM events WHERE type = 'heal.retry'")) {
    const { job_id: jobId, kind } = JSON.parse(e.data) as { job_id: string; kind: string };
    if (marked(ctx, jobId, 'heal.done')) continue;
    const j = get<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE id = :id', { id: jobId });
    if (j?.status !== 'delivered') continue;
    recordEvent(ctx, e.order_id, 'heal.done', { job_id: jobId, kind });
    lines.push(`✅ Fixed: ${esc(orderName(ctx, e.order_id))}: ${esc(label(kind))} went through on the automatic retry.`);
  }
  if (lines.length) await notifyAdmins(ctx, lines);
  return healed;
}

// ---- uncertain publications: look on the account, then record the link or post again ----

/** Publications the worker can look up on our own account. */
export const VERIFIABLE = ['cmc_community', 'gemfinder'];
/** Give the site this long after an uncertain post before looking (feeds and "My coins" lag). */
const VERIFY_AFTER_MS = 10 * 60_000;
const VERIFY_EVERY_MS = 20 * 60_000;
const MAX_INCONCLUSIVE = 3;

const verifyEvents = (ctx: ServiceContext, jobId: string) =>
  all<{ type: string; created_at: number }>(ctx.db, "SELECT type, created_at FROM events WHERE type LIKE 'heal.verify%' AND json_extract(data, '$.job_id') = :j ORDER BY created_at", { j: jobId });

/** Hands the worker an uncertain publication to look for, or null. */
export function verifyClaim(ctx: ServiceContext, publishTarget: (kind: string, orderId: string) => unknown, wanted?: unknown) {
  const kinds = (Array.isArray(wanted) ? wanted : VERIFIABLE).filter((k): k is string => typeof k === 'string' && VERIFIABLE.includes(k));
  if (!kinds.length) return null;
  const t = nowMs(ctx);
  for (const j of all<JobRow>(
    ctx.db,
    `SELECT * FROM jobs WHERE status = 'uncertain' AND kind IN (${kinds.map((k) => `'${k}'`).join(', ')}) AND updated_at <= :t ORDER BY updated_at`,
    { t: t - VERIFY_AFTER_MS },
  )) {
    const seen = verifyEvents(ctx, j.id);
    if (seen.filter((e) => e.type === 'heal.verify_inconclusive').length >= MAX_INCONCLUSIVE) continue;
    if (seen.length && t - seen[seen.length - 1]!.created_at < VERIFY_EVERY_MS) continue;
    recordEvent(ctx, j.order_id, 'heal.verify_claimed', { job_id: j.id, kind: j.kind });
    return { job: { id: j.id, kind: j.kind, order_id: j.order_id }, target: publishTarget(j.kind, j.order_id) };
  }
  return null;
}

/**
 * The worker looked on our account. Found: the link is recorded (delivered). Confirmed absent (the account's list
 * loaded and it isn't there): nothing went out, so it is queued to post again. Otherwise it is looked for again later.
 */
export async function verifyResult(
  ctx: ServiceContext,
  jobId: string,
  body: { url?: unknown; absent?: unknown; note?: unknown },
  reconcile: (jobId: string, url: string) => Promise<unknown>,
) {
  const j = get<JobRow>(ctx.db, "SELECT * FROM jobs WHERE id = :id AND status = 'uncertain'", { id: jobId });
  if (!j || !VERIFIABLE.includes(j.kind)) return { status: 'ignored' };
  const name = esc(orderName(ctx, j.order_id));
  if (typeof body.url === 'string' && body.url) {
    await reconcile(jobId, body.url);
    recordEvent(ctx, j.order_id, 'heal.verify_found', { job_id: jobId, kind: j.kind, url: body.url });
    await notifyAdmins(ctx, [`✅ Fixed: ${name}: ${esc(label(j.kind))} was unconfirmed; found it on our account: ${esc(body.url)}`]);
    return { status: 'delivered' };
  }
  if (body.absent === true) {
    requeue(ctx, j, 0);
    recordEvent(ctx, j.order_id, 'heal.verify_absent', { job_id: jobId, kind: j.kind });
    await notifyAdmins(ctx, [`🟡 Caught: ${name}: ${esc(label(j.kind))} was unconfirmed and is not on our account. Posting it again automatically.`]);
    return { status: 'queued' };
  }
  recordEvent(ctx, j.order_id, 'heal.verify_inconclusive', { job_id: jobId, kind: j.kind, note: String(body.note ?? '').slice(0, 200) });
  if (verifyEvents(ctx, jobId).filter((e) => e.type === 'heal.verify_inconclusive').length === MAX_INCONCLUSIVE)
    await notifyAdmins(ctx, [`🔴 Need you: ${name}: ${esc(label(j.kind))} is unconfirmed and our account page didn't load ${MAX_INCONCLUSIVE} times. Check the account, then reconcile or retry it.`]);
  return { status: 'uncertain' };
}
