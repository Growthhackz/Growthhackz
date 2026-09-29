import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const SOCIAL = { SOCIAL_ACTIVITY_URL: 'http://social.railway.internal:4010', SOCIAL_ACTIVITY_TOKEN: 'social-token-1234567890' };

const purchase = {
  purchase_id: 'orch-1',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/moonfrog',
  name: 'Moon Frog',
  symbol: 'MFROG',
  x_url: 'https://x.com/moonfrog',
  website_url: 'https://moonfrog.example',
  x_post_url: 'https://x.com/moonfrog/status/1234567890',
  logo_url: 'https://cdn.example.com/logo.png',
};

/** Social-activity fake: create + payment-received, then a package status the test controls. */
function socialFake(t: ReturnType<typeof makeApp>, state: { status: string; down?: boolean; lastError?: string }) {
  const seen: Array<{ url: string; body: any; headers: Headers }> = [];
  t.http.on('social.railway.internal', (u, init) => {
    seen.push({ url: String(u), body: init.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init.headers) });
    if (state.down) return new Response('down', { status: 503 });
    const path = new URL(String(u)).pathname;
    if (path === '/v1/wurk/packages') return json({ id: 'wpk_1', status: 'pending_payment' }, 201);
    if (path.endsWith('/payment-received')) return json({ id: 'wpk_1', status: 'queued' });
    return json({
      id: 'wpk_1',
      status: state.status,
      costSettledUsdc: state.status === 'in_progress' ? 1 : 0,
      components: [{ kind: 'small_raid', status: state.status, providerJobId: 'job9', jobLink: state.status === 'in_progress' ? 'https://wurk.fun/custom/job9' : null, lastError: state.lastError ?? null }],
    });
  });
  return seen;
}

function contentFakes(t: ReturnType<typeof makeApp>) {
  t.http
    .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
    .on('api.dexscreener.com/', () =>
      json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 }, pairCreatedAt: Date.parse('2026-09-20T10:00:00Z') }]),
    )
    .on('generativelanguage.googleapis.com/', (_u, init) =>
      JSON.parse(String(init.body)).generationConfig?.responseModalities
        ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
        : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
    );
}

const drain = async (t: ReturnType<typeof makeApp>) => {
  for (let i = 0; i < 40; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
};
const jobOf = (o: any, kind: string) => o.jobs.find((j: any) => j.kind === kind);

describe('trending orchestration', () => {
  it('gives trending orders the default channels and starts the $1 WURK raid independently', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    const state = { status: 'queued' };
    const seen = socialFake(t, state);
    await t.setSetting('GEMINI_API_KEY', 'G');
    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    expect(o.project.channels).toEqual(['binance', 'bitcointalk', 'call_channel', 'cmc_community', 'coinsniper', 'coinvote', 'press_1888', 'social_boost', 'telegraph']);
    expect(jobOf(o, 'reddit_moonshots').status).toBe('skipped');

    await drain(t);
    const create = seen.find((s) => s.url.endsWith('/v1/wurk/packages'))!;
    expect(create.body).toEqual({ preset: 'small_raid', bundled: true, xPost: purchase.x_post_url, customerRef: 'trending:orch-1' });
    expect(create.headers.get('idempotency-key')).toBe(`cm-${o.id}`);
    expect(create.headers.get('authorization')).toBe(`Bearer ${SOCIAL.SOCIAL_ACTIVITY_TOKEN}`);
    expect(seen.find((s) => s.url.endsWith('/payment-received'))!.body).toEqual({ paymentRef: 'trending:orch-1', actor: 'content-machine' });

    let now = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(jobOf(now, 'social_boost').status).toBe('submitted');
    expect(jobOf(now, 'copy').status).toBe('delivered');

    t.clock.advance(61_000);
    await t.api('POST', '/v1/tick');
    expect(jobOf((await t.api('GET', `/v1/orders/${o.id}`)).body, 'social_boost').status).toBe('submitted');

    state.status = 'in_progress';
    t.clock.advance(61_000);
    await t.api('POST', '/v1/tick');
    now = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(jobOf(now, 'social_boost').status).toBe('delivered');
    expect(jobOf(now, 'social_boost').result).toMatchObject({ package_id: 'wpk_1', url: 'https://wurk.fun/custom/job9', cost_usdc: 1 });
    const report = (await t.api('GET', `/v1/orders/by-external-id/trending:orch-1/report`)).body;
    expect(report.successes).toContainEqual({ source: 'social_boost', label: 'X raid (WURK)', url: 'https://wurk.fun/custom/job9' });
  });

  it('keeps content, publications and stickers moving when the social service is down', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    socialFake(t, { status: 'queued', down: true });
    await t.setSetting('GEMINI_API_KEY', 'G');
    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    await drain(t);
    const now = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    // Still retrying (attempts aren't used up by an outage), not failed.
    expect(jobOf(now, 'social_boost').status).toBe('queued');
    expect(jobOf(now, 'social_boost').attempts).toBe(0);
    for (const k of ["metadata", "copy", "hub", "campaign_image", "sticker_art_0", "sticker_art_4"]) expect(jobOf(now, k).status).toBe('delivered');
    // The worker can already claim publications.
    expect((await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body.job.kind).toBe('cmc_community');
  });

  it('skips the raid when the order has no X post', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    socialFake(t, { status: 'queued' });
    const o = (await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'no-post', x_post_url: undefined })).body;
    await t.api('POST', '/v1/tick');
    const job = jobOf((await t.api('GET', `/v1/orders/${o.id}`)).body, 'social_boost');
    expect(job.status).toBe('skipped');
    expect(job.result.reason).toContain('no X post');
    expect((await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'bad', x_post_url: 'https://x.com/moonfrog' })).status).toBe(400);
  });

  it('times items out, fails dependents at once, and reports everything when the order is final', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    const state = { status: 'needs_attention', lastError: 'Wallet holds 0.2 USDC; this purchase needs 1' };
    socialFake(t, state);
    const received: any[] = [];
    t.http.on('buybot.example.com/hooks', (_u, init) => {
      received.push(JSON.parse(String(init.body)));
      return new Response('ok');
    });
    await t.setSetting('CALLBACK_URL', 'https://buybot.example.com/hooks');
    await t.setSetting('CALLBACK_SECRET', 's');
    // No GEMINI_API_KEY: copy blocks.
    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    await drain(t);
    let now = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(jobOf(now, 'copy').status).toBe('blocked');

    // The raid problem is visible while it waits.
    t.clock.advance(61_000);
    await t.api('POST', '/v1/tick');
    let report = (await t.api('GET', `/v1/orders/${o.id}/report`)).body;
    expect(report.complete).toBe(false);
    expect(report.pending.find((p: any) => p.source === 'social_boost').note).toContain('Wallet holds');

    // Copy's deadline (2h) passes: it fails, and everything built on it fails immediately.
    t.clock.advance(2 * 60 * 60_000);
    await t.api('POST', '/v1/tick');
    now = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(jobOf(now, 'copy').error).toMatch(/^Timed out after 2h \(blocked: /);
    expect(jobOf(now, 'campaign_image').error).toBe('Not started: copy failed');
    expect(jobOf(now, 'binance').error).toBe('Not started: campaign_image failed');
    expect(jobOf(now, 'sticker_publish').error).toBe('Not started: stickers failed');
    expect(jobOf(now, 'social_boost').status).toBe('submitted');
    expect(received.some((e) => e.type === 'order.completed')).toBe(false);

    // The raid's own deadline (24h) ends the order.
    t.clock.advance(22 * 60 * 60_000);
    await t.api('POST', '/v1/tick');
    report = (await t.api('GET', `/v1/orders/${o.id}/report`)).body;
    expect(report.complete).toBe(true);
    expect(report.failures.find((f: any) => f.source === 'social_boost').error).toContain('Timed out after 24h (submitted: Wallet holds');
    expect(report.failures.find((f: any) => f.source === 'copy').label).toBe('Content (article and posts)');
    expect(report.failures.find((f: any) => f.source === 'cmc_community').error).toBe('Not started: campaign_image failed');
    const done = received.find((e) => e.type === 'order.completed');
    expect(done.external_order_id).toBe('trending:orch-1');
    expect(done.data.failures.length).toBe(report.failures.length);

    // An admin retry gets a fresh deadline and reopens the order.
    const copyJob = jobOf(now, 'copy');
    expect((await t.api('POST', `/v1/jobs/${copyJob.id}/retry`)).status).toBe(200);
    expect(jobOf((await t.api('GET', `/v1/orders/${o.id}`)).body, 'copy').status).toBe('queued');
    await t.api('POST', '/v1/tick');
    expect(jobOf((await t.api('GET', `/v1/orders/${o.id}`)).body, 'copy').status).toBe('blocked');
  });

  it('puts the Telegram link in every post and X/website in the long ones', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    socialFake(t, { status: 'queued' });
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.api('POST', '/v1/trending', purchase);
    await drain(t);
    const binance = (await t.api('POST', '/v1/publish/claim', { kinds: ['binance'] })).body.target;
    expect(binance.text.endsWith('Telegram: https://t.me/moonfrog\nX: https://x.com/moonfrog\nWebsite: https://moonfrog.example')).toBe(true);
    const cmc = (await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body.target;
    expect(cmc.text.endsWith('Telegram: https://t.me/moonfrog')).toBe(true);
    expect(cmc.text).not.toContain('x.com');
  });

  it('fails a dry-run raid at once instead of holding the order for 24h', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    socialFake(t, { status: 'needs_attention', lastError: 'Dry run: quoted 1 USDC; set WURK_SOLANA_PRIVATE_KEY and WURK_LIVE_PAYMENTS_ENABLED=true to pay' });
    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    await t.api('POST', '/v1/tick');
    t.clock.advance(61_000);
    await t.api('POST', '/v1/tick');
    const job = jobOf((await t.api('GET', `/v1/orders/${o.id}`)).body, 'social_boost');
    expect(job.status).toBe('failed');
    expect(job.error).toContain('WURK_SOLANA_PRIVATE_KEY');
  });

  it('returns the same order for a retried purchase even after the default channels change', async () => {
    const t = makeApp({ ...SOCIAL, TRENDING_CHANNELS: 'call_channel' });
    const first = await t.api('POST', '/v1/trending', purchase);
    expect(first.status).toBe(201);
    (t.ctx.config as any).TRENDING_CHANNELS = 'call_channel,telegraph';
    const again = await t.api('POST', '/v1/trending', purchase);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it('falls back to another Gemini model when the default one is overloaded', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    // Registered last, so it wins for the default text model only.
    t.http.on('generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:', () => json({ error: { code: 503 } }, 503));
    await t.setSetting('GEMINI_API_KEY', 'G');
    const o = (await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'fallback' })).body;
    await drain(t);
    const now = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(jobOf(now, 'copy').status).toBe('delivered');
    expect(t.http.count('generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:')).toBe(1);
    expect(t.http.count('generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:')).toBe(1);
  });

  it('leaves out links the coin does not have', async () => {
    const t = makeApp(SOCIAL);
    contentFakes(t);
    socialFake(t, { status: 'queued' });
    await t.setSetting('GEMINI_API_KEY', 'G');
    const o = (await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'no-tg', telegram_url: undefined, website_url: undefined })).body;
    expect(o.status).not.toBe(400);
    await drain(t);
    const binance = (await t.api('POST', '/v1/publish/claim', { kinds: ['binance'] })).body.target;
    expect(binance.text.endsWith('X: https://x.com/moonfrog')).toBe(true);
    expect(binance.text).not.toMatch(/Telegram|Website|undefined/);
    const cmc = (await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body.target;
    expect(cmc.text).toBe(liveCopy.social_post);
    const press = (await t.api('POST', '/v1/publish/claim', { kinds: ['press_1888'] })).body.target.release;
    expect(press.body).not.toMatch(/Telegram|undefined|null/);
    expect(press.website_url).toBe('https://x.com/moonfrog');
  });
});

