import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { MockProvider } from '../src/providers/mock/provider.js';
import { SOLANA_MAINNET, SOLANA_USDC_MINT } from '../src/wurk/package.js';
import { componentsOf, packageStatus, processWurk, recoverInterruptedWurk, runComponent } from '../src/wurk/service.js';
import type { WurkPayer, WurkRuntime } from '../src/wurk/x402.js';
import { FakeClock, TOKEN } from './helpers.js';

const PAY_TO = 'SAT8g2xU7AFy7eUmNJ9SNrM6yYo7LDCi13GXJ8Ez9kC';
const PRICES: Record<string, string> = {
  '/solana/xfollowers/xverified': '1400000',
  '/solana/xraid/custom': '2250000',
  '/solana/tgmembers': '450000',
  '/solana/xraid/small': '1000000',
};

type PaidBehaviour = 'ok' | 'timeout' | '409' | '409-stale' | '409-kept' | '500' | '503' | 'no-json';

/** A fake WURK: 402 with a v2 challenge when unpaid; job JSON when PAYMENT-SIGNATURE is present. */
function fakeWurk() {
  const state = {
    requests: [] as Array<{ url: string; paid: boolean }>,
    price: { ...PRICES } as Record<string, string>,
    payTo: PAY_TO,
    network: SOLANA_MAINNET,
    quoteStatus: {} as Record<string, number>,
    paid: {} as Record<string, PaidBehaviour>,
    jobs: 0,
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const paid = headers.has('payment-signature');
    state.requests.push({ url: url.href, paid });
    const route = url.pathname;
    if (!paid) {
      const forced = state.quoteStatus[route];
      if (forced) return new Response(JSON.stringify({ message: 'forced', errorCode: 'X' }), { status: forced });
      const challenge = {
        x402Version: 2,
        resource: { url: `https://wurkapi.fun/api/x402/jobs/abc/pay`, description: 'Pay', mimeType: 'application/json' },
        accepts: [{ scheme: 'exact', network: state.network, amount: state.price[route], asset: SOLANA_USDC_MINT, payTo: state.payTo, maxTimeoutSeconds: 60, extra: {} }],
      };
      return new Response(JSON.stringify(challenge), {
        status: 402,
        headers: { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') },
      });
    }
    const b = state.paid[route] ?? 'ok';
    if (b === 'timeout') throw new Error('The operation was aborted due to timeout');
    if (b === '409') return new Response(JSON.stringify({ message: 'job already active for this group' }), { status: 409 });
    if (b === '409-stale') {
      state.paid[route] = 'ok'; // the next, freshly quoted payment goes through
      return new Response(JSON.stringify({ message: 'The requested payment differs from its sealed component manifest.', errorCode: 'X402_REWARD_SOURCE_INVALID' }), { status: 409 });
    }
    if (b === '409-kept') {
      // Seen live (Oct 1 and 3): WURK settles the USDC, then refuses the job.
      state.paid[route] = 'ok';
      const settle = { success: true, transaction: 'txKept', network: SOLANA_MAINNET };
      return new Response(JSON.stringify({ message: 'The requested payment differs from its sealed component manifest.', errorCode: 'X402_REWARD_SOURCE_INVALID' }), {
        status: 409,
        headers: { 'payment-response': Buffer.from(JSON.stringify(settle)).toString('base64') },
      });
    }
    if (b === '500') return new Response('upstream', { status: 500 });
    if (b === '503') return new Response('unavailable', { status: 503 });
    if (b === 'no-json') return new Response('ok', { status: 200 });
    state.jobs++;
    const settle = { success: true, transaction: `tx${state.jobs}`, network: SOLANA_MAINNET };
    return new Response(JSON.stringify({ ok: true, paid: true, jobId: `job${state.jobs}`, jobLink: `https://wurk.fun/custom/job${state.jobs}` }), {
      status: 200,
      headers: { 'payment-response': Buffer.from(JSON.stringify(settle)).toString('base64') },
    });
  }) as typeof fetch;
  return { state, fetchFn };
}

function setup(env: Record<string, string> = {}, walletUsdcMicros: number | null = 100_000_000) {
  const wurk = fakeWurk();
  const signed: string[] = [];
  const payer: WurkPayer = {
    address: 'PeakTestWa11et1111111111111111111111111111111',
    async sign(_challenge, accepted) {
      signed.push(accepted.amount);
      return `sig-${accepted.amount}`;
    },
    usdcBalanceMicros: async () => walletUsdcMicros,
  };
  const live = { WURK_SOLANA_PRIVATE_KEY: 'test-key', WURK_LIVE_PAYMENTS_ENABLED: 'true' };
  const config = loadConfig({ LOG_LEVEL: 'silent', SERVICE_API_TOKEN: TOKEN, PROVIDER: 'mock', ...live, ...env });
  const runtime: WurkRuntime = {
    fetch: wurk.fetchFn,
    missingForLive: () => [
      ...(config.WURK_SOLANA_PRIVATE_KEY ? [] : ['WURK_SOLANA_PRIVATE_KEY']),
      ...(config.WURK_LIVE_PAYMENTS_ENABLED ? [] : ['WURK_LIVE_PAYMENTS_ENABLED=true']),
    ],
    payer: async () => payer,
  };
  const clock = new FakeClock(new Date('2026-09-28T12:00:00Z'));
  const { app, ctx } = buildApp({ config, db: openDatabase(':memory:'), provider: new MockProvider(), clock, wurk: runtime });
  const api = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, payload: body as object, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
  };
  const targets = { xProfile: '@peakbuybot', xPost: 'https://twitter.com/peakbuybot/status/1234567890', telegram: 'https://t.me/peakgroup' };
  const createPaid = async (extra: Record<string, unknown> = {}) => {
    await api('PUT', '/v1/wurk/settings', { retailPriceUsd: 19 });
    const created = await api('POST', '/v1/wurk/packages', { ...targets, ...extra });
    expect(created.status).toBe(201);
    const paid = await api('POST', `/v1/wurk/packages/${created.body.id}/payment-received`, { paymentRef: 'chk_1' });
    expect(paid.status).toBe(200);
    return created.body.id as string;
  };
  const byKind = (packageId: string) => Object.fromEntries(componentsOf(ctx, packageId).map((c) => [c.kind, c]));
  return { app, ctx, api, clock, wurk, signed, targets, createPaid, byKind };
}

describe('WURK targets', () => {
  it('normalizes the three targets and builds the four WURK requests', async () => {
    const { api } = setup();
    await api('PUT', '/v1/wurk/settings', { retailPriceUsd: 19 });
    const r = await api('POST', '/v1/wurk/packages', { xProfile: 'https://x.com/PeakBuyBot', xPost: 'x.com/PeakBuyBot/status/42?s=20', telegram: '@peakgroup' });
    expect(r.status).toBe(201);
    expect(r.body.targets).toEqual({ xProfile: 'https://x.com/PeakBuyBot', xPost: 'https://x.com/PeakBuyBot/status/42', telegram: 'https://t.me/peakgroup' });
    const urls = r.body.components.map((c: any) => c.target);
    expect(urls).toContain('https://wurkapi.fun/solana/xfollowers/xverified?handle=PeakBuyBot&amount=20');
    expect(urls).toContain('https://wurkapi.fun/solana/xraid/custom?url=https%3A%2F%2Fx.com%2FPeakBuyBot%2Fstatus%2F42&likes=30&reposts=30&comments=30&bookmarks=0');
    expect(urls.filter((u: string) => u === 'https://wurkapi.fun/solana/tgmembers?join=https%3A%2F%2Ft.me%2Fpeakgroup&amount=15')).toHaveLength(2);
    expect(r.body.status).toBe('pending_payment');
  });

  it('rejects invalid targets before checkout', async () => {
    const { api } = setup();
    await api('PUT', '/v1/wurk/settings', { retailPriceUsd: 19 });
    for (const bad of [
      { xProfile: 'https://x.com/a/b', xPost: 'https://x.com/a/status/1', telegram: '@group' },
      { xProfile: '@ok', xPost: 'https://x.com/ok', telegram: '@group' },
      { xProfile: '@ok', xPost: 'https://x.com/ok/status/1', telegram: 'https://t.me/c/123' },
    ])
      expect((await api('POST', '/v1/wurk/packages', bad)).status).toBe(400);
  });

  it('requires an admin retail price for customer packages (test packages exempt)', async () => {
    const { api, targets } = setup();
    expect((await api('POST', '/v1/wurk/packages', targets)).status).toBe(400);
    const t = await api('POST', '/v1/wurk/packages', { ...targets, test: true });
    expect(t.status).toBe(201);
    expect(t.body.retailPriceUsd).toBeNull();
  });
});

describe('quote-only diagnostic', () => {
  it('shows the four live quotes and never signs', async () => {
    const { api, signed, wurk, targets } = setup();
    const r = await api('POST', '/v1/wurk/quote', targets);
    expect(r.status).toBe(200);
    expect(r.body.lines.map((l: any) => [l.component, l.quoteUsdc])).toEqual([
      ['verified_followers', 1.4],
      ['post_mix', 2.25],
      ['tg_batch_1', 0.45],
      ['tg_batch_2', 0.45],
    ]);
    expect(r.body.totalUsdc).toBe(4.55);
    expect(r.body.allOk).toBe(true);
    expect(signed).toHaveLength(0);
    expect(wurk.state.requests.every((q) => !q.paid)).toBe(true);
  });

  it('reports a blocked or capped target', async () => {
    const { api, wurk, targets } = setup();
    wurk.state.quoteStatus['/solana/tgmembers'] = 409;
    const r = await api('POST', '/v1/wurk/quote', targets);
    const tg = r.body.lines.find((l: any) => l.component === 'tg_batch_1');
    expect(tg.ok).toBe(false);
    expect(tg.problem).toContain('409');
    expect(r.body.allOk).toBe(false);
  });
});

describe('WURK fulfillment', () => {
  it('pays the first three components, then the second Telegram batch after the delay', async () => {
    const { ctx, api, clock, wurk, signed, createPaid, byKind } = setup();
    const id = await createPaid();
    let c = byKind(id);
    expect(c.tg_batch_2!.status).toBe('scheduled');
    expect(c.tg_batch_2!.scheduled_for).toBe('2026-09-28T12:30:00.000Z');

    expect((await processWurk(ctx)).processed).toBe(3);
    c = byKind(id);
    expect(c.verified_followers!.status).toBe('paid_job_created');
    expect(c.post_mix!.settled_micros).toBe(2_250_000);
    expect(c.tg_batch_1!.provider_job_id).toBeTruthy();
    expect(c.tg_batch_2!.status).toBe('scheduled');
    expect(signed).toEqual(['1400000', '2250000', '450000']);

    // The paid retry is the exact challenged URL with PAYMENT-SIGNATURE.
    const paidReqs = wurk.state.requests.filter((r) => r.paid);
    const unpaid = wurk.state.requests.filter((r) => !r.paid);
    expect(paidReqs.map((r) => r.url)).toEqual(unpaid.map((r) => r.url));

    const progress = (await api('GET', `/v1/wurk/packages/${id}/progress`)).body;
    expect(progress.status).toBe('In progress');
    expect(progress.items.find((i: any) => i.item.includes('second batch')).status).toBe('Scheduled to start at 2026-09-28T12:30:00.000Z');
    expect(JSON.stringify(progress)).not.toMatch(/usdc|wallet|job1|payTo|wurkapi/i);

    expect((await processWurk(ctx)).processed).toBe(0);
    clock.advance(30 * 60_000);
    expect((await processWurk(ctx)).processed).toBe(1);
    expect(byKind(id).tg_batch_2!.status).toBe('paid_job_created');
    expect(signed).toHaveLength(4);

    const detail = (await api('GET', `/v1/wurk/packages/${id}`)).body;
    expect(detail.costSettledUsdc).toBe(4.55);
    expect(detail.components.flatMap((x: any) => x.payments).every((p: any) => p.status === 'settled' && p.transaction)).toBe(true);
    expect(detail.audit.map((a: any) => a.action)).toContain('package.paid');
  });

  it('uses the admin-configured delay for the second batch', async () => {
    const { api, createPaid, byKind } = setup();
    await api('PUT', '/v1/wurk/settings', { tgSecondBatchDelayMinutes: 90 });
    const id = await createPaid();
    expect(byKind(id).tg_batch_2!.scheduled_for).toBe('2026-09-28T13:30:00.000Z');
  });

  it('is idempotent for package creation, payment handoff and component runs', async () => {
    const { ctx, api, signed, createPaid, targets } = setup();
    await api('PUT', '/v1/wurk/settings', { retailPriceUsd: 19 });
    const a = await api('POST', '/v1/wurk/packages', targets, { 'idempotency-key': 'order-12345' });
    const b = await api('POST', '/v1/wurk/packages', targets, { 'idempotency-key': 'order-12345' });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    await api('POST', `/v1/wurk/packages/${a.body.id}/payment-received`, { paymentRef: 'chk_9' });
    expect((await api('POST', `/v1/wurk/packages/${a.body.id}/payment-received`, { paymentRef: 'chk_9' })).status).toBe(200);
    expect((await api('POST', `/v1/wurk/packages/${a.body.id}/payment-received`, { paymentRef: 'other' })).status).toBe(409);

    const followers = componentsOf(ctx, a.body.id).find((c) => c.kind === 'verified_followers')!;
    await Promise.all([runComponent(ctx, followers.id), runComponent(ctx, followers.id)]);
    await runComponent(ctx, followers.id);
    expect(signed).toEqual(['1400000']);
    void createPaid;
  });

  it('stops at the quote in dry-run mode and names the missing env var', async () => {
    const { ctx, signed, createPaid, byKind } = setup({ WURK_SOLANA_PRIVATE_KEY: '', WURK_LIVE_PAYMENTS_ENABLED: 'false' });
    const id = await createPaid();
    await processWurk(ctx);
    const f = byKind(id).verified_followers!;
    expect(f.status).toBe('needs_attention');
    expect(f.quoted_micros).toBe(1_400_000);
    expect(f.last_error).toContain('WURK_SOLANA_PRIVATE_KEY');
    expect(f.last_error).toContain('WURK_LIVE_PAYMENTS_ENABLED=true');
    expect(signed).toHaveLength(0);
  });

  it('refuses a raised quote, a changed recipient and a changed network without signing', async () => {
    for (const [mutate, expected] of [
      [(s: any) => (s.price['/solana/xfollowers/xverified'] = '1400001'), 'above the 1.4 USDC ceiling'],
      [(s: any) => (s.payTo = 'Evi1Recipient11111111111111111111111111111111'), 'not on WURK_PAYTO_ALLOWLIST'],
      [(s: any) => (s.network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'), 'network or asset changed'],
    ] as const) {
      const { ctx, wurk, signed, createPaid, byKind } = setup();
      mutate(wurk.state);
      const id = await createPaid();
      await processWurk(ctx);
      const f = byKind(id).verified_followers!;
      expect(f.status).toBe('needs_attention');
      expect(f.last_error).toContain(expected);
      expect(signed).not.toContain('1400001');
      expect(packageStatus((ctx.db.prepare('SELECT * FROM wurk_packages WHERE id = ?').get(id) as any), componentsOf(ctx, id))).toBe('needs_attention');
    }
  });

  it('enforces the package cost ceiling and the daily ceiling', async () => {
    {
      const { ctx, createPaid, byKind } = setup({ WURK_PACKAGE_MAX_USDC: '3' });
      const id = await createPaid();
      await processWurk(ctx);
      expect(byKind(id).post_mix!.last_error).toContain('above its 3 USDC ceiling');
    }
    {
      const { ctx, createPaid, byKind, signed } = setup({ WURK_DAILY_MAX_USDC: '2' });
      const id = await createPaid();
      await processWurk(ctx);
      // 1.40 + 0.45 fit under 2 USDC; the 2.25 raid does not.
      expect(signed).toEqual(['1400000', '450000']);
      expect(byKind(id).post_mix!.last_error).toContain('Daily WURK spend ceiling');
    }
  });

  it('checks the wallet balance before signing', async () => {
    const { ctx, signed, createPaid, byKind } = setup({}, 1_000_000);
    const id = await createPaid();
    await processWurk(ctx);
    expect(byKind(id).verified_followers!.last_error).toContain('holds 1 USDC');
    expect(signed).toEqual(['450000']); // only the TG batch fits in 1 USDC
  });

  it('marks a lost paid response reconcile_required and never pays again', async () => {
    const { ctx, api, wurk, signed, createPaid, byKind } = setup();
    wurk.state.paid['/solana/xfollowers/xverified'] = 'timeout';
    const id = await createPaid();
    await processWurk(ctx);
    let f = byKind(id).verified_followers!;
    expect(f.status).toBe('reconcile_required');
    expect((await api('GET', `/v1/wurk/packages/${id}`)).body.status).toBe('reconcile_required');

    wurk.state.paid['/solana/xfollowers/xverified'] = 'ok';
    await processWurk(ctx);
    expect(signed.filter((a) => a === '1400000')).toHaveLength(1);
    expect((await api('POST', `/v1/wurk/components/${f.id}/retry`, {})).status).toBe(409);
    expect((await api('POST', `/v1/wurk/components/${f.id}/status`, { status: 'queued', note: 'try again' })).status).toBe(409);

    const r = await api('POST', `/v1/wurk/components/${f.id}/reconcile`, { settled: true, jobId: 'wurk-777', note: 'Found the job in WURK; tx confirmed', actor: 'justin' });
    expect(r.status).toBe(200);
    f = byKind(id).verified_followers!;
    expect(f.status).toBe('paid_job_created');
    expect(f.provider_job_id).toBe('wurk-777');
    expect(signed.filter((a) => a === '1400000')).toHaveLength(1);
    const audit = (await api('GET', `/v1/wurk/packages/${id}`)).body.audit;
    expect(audit.find((a: any) => a.action === 'component.reconciled').actor).toBe('justin');
  });

  it('treats 5xx and non-JSON after payment as possibly settled', async () => {
    for (const b of ['500', 'no-json'] as const) {
      const { ctx, wurk, createPaid, byKind } = setup();
      wurk.state.paid['/solana/xraid/custom'] = b;
      const id = await createPaid();
      await processWurk(ctx);
      expect(byKind(id).post_mix!.status).toBe('reconcile_required');
    }
  });

  it('recovers a crash after signing as reconcile_required, and before signing as queued', async () => {
    const { ctx, createPaid, byKind } = setup();
    const id = await createPaid();
    const k = byKind(id);
    const t = '2026-09-28T12:00:00.000Z';
    ctx.db.prepare("UPDATE wurk_components SET status = 'quoting' WHERE id IN (?, ?)").run(k.verified_followers!.id, k.post_mix!.id);
    ctx.db
      .prepare(
        `INSERT INTO wurk_payments (id, component_id, purpose, request_url, status, amount_micros, pay_to, asset, network, created_at, updated_at)
         VALUES ('p1', ?, 'verified_followers', 'u', 'signed', 1400000, ?, ?, ?, ?, ?)`,
      )
      .run(k.verified_followers!.id, PAY_TO, SOLANA_USDC_MINT, SOLANA_MAINNET, t, t);
    expect(recoverInterruptedWurk(ctx)).toBe(2);
    expect(byKind(id).verified_followers!.status).toBe('reconcile_required');
    expect(byKind(id).post_mix!.status).toBe('queued');
  });

  it('defers the second Telegram batch on a 409 instead of paying for a duplicate', async () => {
    const { ctx, clock, wurk, signed, createPaid, byKind } = setup();
    const id = await createPaid();
    await processWurk(ctx);
    clock.advance(30 * 60_000);
    wurk.state.quoteStatus['/solana/tgmembers'] = 409;
    await processWurk(ctx);
    let tg2 = byKind(id).tg_batch_2!;
    expect(tg2.status).toBe('scheduled');
    expect(tg2.defer_count).toBe(1);
    expect(tg2.scheduled_for).toBe('2026-09-28T12:40:00.000Z');
    expect(signed).toHaveLength(3);

    delete wurk.state.quoteStatus['/solana/tgmembers'];
    clock.advance(10 * 60_000);
    await processWurk(ctx);
    tg2 = byKind(id).tg_batch_2!;
    expect(tg2.status).toBe('paid_job_created');
    expect(signed).toHaveLength(4);
  });

  it('pauses, resumes and honours the kill switch', async () => {
    const { ctx, api, signed, createPaid } = setup();
    const id = await createPaid();
    await api('POST', `/v1/wurk/packages/${id}/pause`, { actor: 'ops' });
    expect((await processWurk(ctx)).processed).toBe(0);
    await api('POST', `/v1/wurk/packages/${id}/resume`, { actor: 'ops' });
    await api('PUT', '/v1/wurk/settings', { killSwitch: true });
    expect((await processWurk(ctx)).processed).toBe(0);
    await api('PUT', '/v1/wurk/settings', { killSwitch: false });
    expect((await processWurk(ctx)).processed).toBe(3);
    expect(signed).toHaveLength(3);
  });

  it('retries a pre-payment failure after admin review and supports audited manual completion', async () => {
    const { ctx, api, wurk, createPaid, byKind } = setup();
    wurk.state.quoteStatus['/solana/xfollowers/xverified'] = 400;
    const id = await createPaid();
    await processWurk(ctx);
    const f = byKind(id).verified_followers!;
    expect(f.status).toBe('needs_attention');
    delete wurk.state.quoteStatus['/solana/xfollowers/xverified'];
    expect((await api('POST', `/v1/wurk/components/${f.id}/retry`, { note: 'profile made public' })).status).toBe(200);
    await processWurk(ctx);
    expect(byKind(id).verified_followers!.status).toBe('paid_job_created');

    for (const c of componentsOf(ctx, id).filter((x) => x.kind !== 'tg_batch_2'))
      await api('POST', `/v1/wurk/components/${c.id}/status`, { status: 'completed', note: 'checked on X/TG' });
    await api('POST', `/v1/wurk/components/${byKind(id).tg_batch_2!.id}/status`, { status: 'partial', note: 'group went private' });
    expect((await api('GET', `/v1/wurk/packages/${id}`)).body.status).toBe('partial');
  });

  it('exposes wallet status without the key', async () => {
    const { api } = setup();
    const s = (await api('GET', '/v1/wurk/status')).body;
    expect(s.wallet).toBe('PeakTestWa11et1111111111111111111111111111111');
    expect(s.usdcBalance).toBe(100);
    expect(JSON.stringify(s)).not.toContain('test-key');
  });

  it('small_raid preset: bundled package from just the post, one $1 purchase', async () => {
    const { ctx, api, signed, wurk } = setup();
    const created = await api('POST', '/v1/wurk/packages', { preset: 'small_raid', bundled: true, xPost: 'https://x.com/peakbuybot/status/99', customerRef: 'trending:1' }, { 'idempotency-key': 'cm-order-1' });
    expect(created.status).toBe(201);
    expect(created.body.preset).toBe('small_raid');
    expect(created.body.retailPriceUsd).toBeNull();
    expect(created.body.costCeilingUsdc).toBe(1);
    expect(created.body.components.map((c: any) => [c.kind, c.target])).toEqual([
      ['small_raid', 'https://wurkapi.fun/solana/xraid/small?url=https%3A%2F%2Fx.com%2Fpeakbuybot%2Fstatus%2F99'],
    ]);
    await api('POST', `/v1/wurk/packages/${created.body.id}/payment-received`, { paymentRef: 'trending:1' });
    await processWurk(ctx);
    const detail = (await api('GET', `/v1/wurk/packages/${created.body.id}`)).body;
    expect(detail.status).toBe('in_progress');
    expect(detail.components[0].jobLink).toMatch(/^https:\/\/wurk\.fun\/custom\//);
    expect(signed).toEqual(['1000000']);
    expect(wurk.state.requests.every((r) => r.url.includes('/solana/xraid/small'))).toBe(true);
    const progress = (await api('GET', `/v1/wurk/packages/${created.body.id}/progress`)).body;
    expect(progress.items[0].item).toContain('25 likes');
  });

  it('trending preset: 50 likes, 50 reposts and 20 comments, 50 followers and 50 Telegram members ($6.00); no Telegram leaves the members out', async () => {
    const { ctx, api, signed, wurk } = setup();
    wurk.state.price['/solana/xraid/custom'] = '3000000';
    wurk.state.price['/solana/xfollowers'] = '1500000';
    wurk.state.price['/solana/tgmembers'] = '1500000';
    const created = await api(
      'POST',
      '/v1/wurk/packages',
      { preset: 'trending', bundled: true, xPost: 'https://x.com/moonfrog/status/7', xProfile: 'https://x.com/moonfrog', telegram: 'https://t.me/moonfrog' },
      { 'idempotency-key': 'cm-order-7' },
    );
    expect(created.status).toBe(201);
    expect(created.body.costCeilingUsdc).toBe(6.5);
    expect(created.body.components.map((c: any) => [c.kind, c.target, c.ceilingUsdc])).toEqual([
      ['engagement', 'https://wurkapi.fun/solana/xraid/custom?url=https%3A%2F%2Fx.com%2Fmoonfrog%2Fstatus%2F7&likes=50&reposts=50&comments=20&bookmarks=0', 3.25],
      ['tg_members', 'https://wurkapi.fun/solana/tgmembers?join=https%3A%2F%2Ft.me%2Fmoonfrog&amount=50', 1.5],
      ['x_followers', 'https://wurkapi.fun/solana/xfollowers?handle=moonfrog&amount=50', 1.5],
    ]);
    await api('POST', `/v1/wurk/packages/${created.body.id}/payment-received`, { paymentRef: 'trending:7' });
    await processWurk(ctx);
    expect((await api('GET', `/v1/wurk/packages/${created.body.id}`)).body.status).toBe('in_progress');
    expect([...signed].sort()).toEqual(['1500000', '1500000', '3000000']);
    const progress = (await api('GET', `/v1/wurk/packages/${created.body.id}/progress`)).body;
    expect(progress.items.map((i: any) => i.item)).toEqual(expect.arrayContaining(['50 likes, 50 reposts and 20 comments on your X post', '50 X followers', '50 Telegram members']));

    // A follower price rise is refused, not paid.
    wurk.state.price['/solana/xfollowers'] = '1600000';
    const noTg = (await api('POST', '/v1/wurk/packages', { preset: 'trending', bundled: true, xPost: 'https://x.com/moonfrog/status/8' })).body;
    expect(noTg.components.map((c: any) => c.kind).sort()).toEqual(['engagement', 'x_followers']);
    await api('POST', `/v1/wurk/packages/${noTg.id}/payment-received`, { paymentRef: 'trending:8' });
    await processWurk(ctx);
    const after = (await api('GET', `/v1/wurk/packages/${noTg.id}`)).body;
    expect(after.components.find((c: any) => c.kind === 'x_followers').status).toBe('needs_attention');
    expect(signed).toHaveLength(4);
  });

  it('a stale-quote refusal (409, nothing paid) is retried with a fresh quote instead of waiting for a person', async () => {
    const { ctx, api, clock, signed, wurk } = setup();
    wurk.state.paid['/solana/xraid/small'] = '409-stale';
    const p = (await api('POST', '/v1/wurk/packages', { preset: 'small_raid', bundled: true, xPost: 'https://x.com/a/status/5' })).body;
    await api('POST', `/v1/wurk/packages/${p.id}/payment-received`, { paymentRef: 'stale' });
    await processWurk(ctx);
    let detail = (await api('GET', `/v1/wurk/packages/${p.id}`)).body;
    expect(detail.components[0]).toMatchObject({ status: 'queued', lastError: expect.stringContaining('stale quote') });
    expect(detail.components[0].payments[0].status).toBe('failed');
    clock.advance(10 * 60_000);
    await processWurk(ctx);
    detail = (await api('GET', `/v1/wurk/packages/${p.id}`)).body;
    expect(detail.status).toBe('in_progress');
    expect(detail.components[0].payments.map((x: any) => x.status)).toEqual(['failed', 'settled']);
    expect(signed).toHaveLength(2);
  });

  it('trending without an X post still buys the followers and Telegram members (BABYPIMPIN, Oct 5)', async () => {
    const { ctx, api, signed, wurk } = setup();
    wurk.state.price['/solana/xfollowers'] = '1500000';
    wurk.state.price['/solana/tgmembers'] = '1500000';
    const p = await api('POST', '/v1/wurk/packages', { preset: 'trending', bundled: true, xProfile: 'https://x.com/BabyPimpin21Fla', telegram: 'https://t.me/BabyPimpin21flavorssol' });
    expect(p.status).toBe(201);
    expect(p.body.components.map((c: any) => c.kind).sort()).toEqual(['tg_members', 'x_followers']);
    expect(p.body.targets.xPost).toBeNull();
    await api('POST', `/v1/wurk/packages/${p.body.id}/payment-received`, { paymentRef: 'nopost-1' });
    await processWurk(ctx);
    expect((await api('GET', `/v1/wurk/packages/${p.body.id}`)).body.status).toBe('in_progress');
    expect(signed).toHaveLength(2);
    // Presets that are only engagement still need the post; nothing at all to target is refused.
    expect((await api('POST', '/v1/wurk/packages', { preset: 'engagement', bundled: true, xProfile: 'https://x.com/a' })).status).toBe(400);
    expect((await api('POST', '/v1/wurk/packages', { preset: 'trending', bundled: true, telegram: 'https://t.me/abcdef' })).status).toBe(400);
  });

  it('an unpaid component can be cancelled (replaced); a paid one cannot', async () => {
    const { ctx, api, wurk } = setup();
    wurk.state.paid['/solana/xraid/small'] = '503'; // 503 after "payment": left for reconciling
    wurk.state.price['/solana/xfollowers'] = '1500000';
    const p = (await api('POST', '/v1/wurk/packages', { preset: 'trending', bundled: true, xPost: 'https://x.com/a/status/9' })).body;
    // Swap the engagement for the old small raid to reproduce JUGS (Oct 4).
    ctx.db.prepare("UPDATE wurk_components SET kind = 'small_raid', request_url = 'https://wurkapi.fun/solana/xraid/small?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F9' WHERE package_id = ? AND kind = 'engagement'").run(p.id);
    await api('POST', `/v1/wurk/packages/${p.id}/payment-received`, { paymentRef: 'cancel-1' });
    await processWurk(ctx);
    let detail = (await api('GET', `/v1/wurk/packages/${p.id}`)).body;
    expect(detail.status).toBe('reconcile_required');
    const raid = detail.components.find((c: any) => c.kind === 'small_raid');
    const followers = detail.components.find((c: any) => c.kind === 'x_followers');
    expect((await api('POST', `/v1/wurk/components/${followers.id}/status`, { status: 'cancelled', note: 'test' })).status).toBe(409);
    expect((await api('POST', `/v1/wurk/components/${raid.id}/status`, { status: 'cancelled', note: 'no transfer on-chain; replaced by engagement' })).status).toBe(200);
    detail = (await api('GET', `/v1/wurk/packages/${p.id}`)).body;
    expect(detail.status).toBe('in_progress');
    expect(detail.components.find((c: any) => c.kind === 'small_raid').payments[0].status).toBe('failed');
    const progress = (await api('GET', `/v1/wurk/packages/${p.id}/progress`)).body;
    expect(progress.items.find((i: any) => i.item.startsWith('Engagement')).status).toBe('Replaced');
  });

  it('a refusal that kept the USDC is never paid again, and holds paid requests of that kind for 2 hours', async () => {
    const { ctx, api, clock, signed, wurk } = setup();
    wurk.state.paid['/solana/xraid/small'] = '409-kept';
    const make = async (n: number) => {
      const p = (await api('POST', '/v1/wurk/packages', { preset: 'small_raid', bundled: true, xPost: `https://x.com/a/status/${n}` })).body;
      await api('POST', `/v1/wurk/packages/${p.id}/payment-received`, { paymentRef: `kept${n}` });
      return p.id as string;
    };
    const first = await make(1);
    await processWurk(ctx);
    let detail = (await api('GET', `/v1/wurk/packages/${first}`)).body;
    expect(detail.components[0]).toMatchObject({ status: 'reconcile_required', lastError: expect.stringContaining('WURK kept the payment (transaction txKept)') });
    expect(signed).toHaveLength(1);
    // The next order's raid waits instead of paying into it.
    const second = await make(2);
    clock.advance(10 * 60_000);
    await processWurk(ctx);
    detail = (await api('GET', `/v1/wurk/packages/${second}`)).body;
    expect(detail.components[0]).toMatchObject({ status: 'queued', lastError: expect.stringContaining('holding paid requests') });
    expect(signed).toHaveLength(1);
    // After the hold it goes through; the first is still left for reconciling, never re-paid.
    clock.advance(2 * 3600_000);
    await processWurk(ctx);
    expect((await api('GET', `/v1/wurk/packages/${second}`)).body.status).toBe('in_progress');
    expect((await api('GET', `/v1/wurk/packages/${first}`)).body.components[0].status).toBe('reconcile_required');
    expect(signed).toHaveLength(2);
  });

  it('small_raid refuses a quote above $1; the full preset drops Telegram members when there is no Telegram', async () => {
    const { ctx, api, wurk, signed } = setup();
    wurk.state.price['/solana/xraid/small'] = '1500000';
    const p = (await api('POST', '/v1/wurk/packages', { preset: 'small_raid', bundled: true, xPost: 'https://x.com/a/status/1' })).body;
    await api('POST', `/v1/wurk/packages/${p.id}/payment-received`, { paymentRef: 'x' });
    await processWurk(ctx);
    expect((await api('GET', `/v1/wurk/packages/${p.id}`)).body.status).toBe('needs_attention');
    expect(signed).toHaveLength(0);
    // No Telegram and no profile: verified followers go to the post's author, and there are no Telegram batches.
    const full = await api('POST', '/v1/wurk/packages', { preset: 'full', bundled: true, xPost: 'https://x.com/moonfrog/status/1' });
    expect(full.status).toBe(201);
    expect(full.body.components.map((c: any) => c.kind).sort()).toEqual(['post_mix', 'verified_followers']);
    expect(full.body.components.find((c: any) => c.kind === 'verified_followers').target).toContain('handle=moonfrog');
    const withTg = await api('POST', '/v1/wurk/packages', { preset: 'full', bundled: true, xPost: 'https://x.com/moonfrog/status/2', xProfile: 'https://x.com/moonfrog', telegram: 'https://t.me/moonfrog' });
    expect(withTg.body.components.map((c: any) => c.kind).sort()).toEqual(['post_mix', 'tg_batch_1', 'tg_batch_2', 'verified_followers']);
    expect((await api('POST', '/v1/wurk/packages', { preset: 'full', bundled: true, xPost: 'https://x.com/moonfrog' })).status).toBe(400);
  });
});

