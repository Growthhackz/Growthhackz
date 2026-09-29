import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const purchase = {
  purchase_id: 'cb-1',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/moonfrog',
  name: 'Moon Frog',
  symbol: 'MFROG',
  channels: ['telegraph'],
};

async function intakeKey(t: ReturnType<typeof makeApp>) {
  const r = await t.api('POST', '/v1/keys', { name: 'core-bot', scope: 'intake' });
  expect(r.status).toBe(201);
  expect(r.body.scope).toBe('intake');
  return r.body.key as string;
}

describe('core bot intake key', () => {
  it('can only create trending orders and read trending status and reports', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'telegraph' });
    const key = await intakeKey(t);
    const created = await t.call(key, 'POST', '/v1/trending', purchase);
    expect(created.status).toBe(201);
    expect((await t.call(key, 'POST', '/v1/trending', purchase)).status).toBe(200);
    expect((await t.call(key, 'GET', '/v1/orders/by-external-id/trending:cb-1')).status).toBe(200);
    const report = await t.call(key, 'GET', '/v1/orders/by-external-id/trending%3Acb-1/report');
    expect(report.status).toBe(200);
    expect(report.body.order_id).toBe('trending:cb-1');

    for (const [method, url] of [
      ['GET', '/v1/orders'],
      ['GET', `/v1/orders/${created.body.id}`],
      ['GET', `/v1/orders/${created.body.id}/report`],
      ['GET', '/v1/orders/by-external-id/other-order'],
      ['POST', '/v1/orders'],
      ['POST', '/v1/tick'],
      ['POST', '/v1/publish/claim'],
      ['GET', '/v1/settings'],
      ['PUT', '/v1/settings'],
      ['POST', '/v1/keys'],
      ['GET', '/v1/trending'],
    ] as const)
      expect((await t.call(key, method, url, method === 'GET' ? undefined : {})).status, `${method} ${url}`).toBe(403);
  });

  it('rejects bad scopes, revoked keys and unknown tokens', async () => {
    const t = makeApp();
    expect((await t.api('POST', '/v1/keys', { name: 'x', scope: 'admin' })).status).toBe(400);
    const r = (await t.api('POST', '/v1/keys', { name: 'core-bot', scope: 'intake' })).body;
    await t.api('DELETE', `/v1/keys/${r.id}`);
    expect((await t.call(r.key, 'POST', '/v1/trending', purchase)).status).toBe(401);
    expect((await t.call('pk_nope', 'POST', '/v1/trending', purchase)).status).toBe(401);
    // Service keys keep the full order API.
    const svc = (await t.api('POST', '/v1/keys', { name: 'svc' })).body;
    expect(svc.scope).toBe('service');
    expect((await t.call(svc.key, 'GET', '/v1/orders')).status).toBe(200);
  });
});

describe('core bot callbacks', () => {
  it('sends signed link.published events with only public URLs, and nothing internal', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'telegraph', PUBLIC_HUB_ENABLED: 'true' });
    const received: Array<{ headers: Record<string, string>; body: string }> = [];
    t.http
      .on('bot.example.com/hooks/content', (_u, init) => {
        received.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
        return json({ ok: true });
      })
      .on('api.dexscreener.com/', () => json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 } }]))
      .on('generativelanguage.googleapis.com/', (_u, init) =>
        JSON.parse(String(init.body)).generationConfig?.responseModalities
          ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
          : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
      )
      .on('api.telegra.ph/createPage', () => json({ ok: true, result: { url: 'https://telegra.ph/Moon-Frog-09-29', path: 'Moon-Frog-09-29' } }))
      .on('telegra.ph/Moon-Frog-09-29', () =>
        new Response(`<html><body><h1>${liveCopy.headline}</h1>${'<p>Moon Frog community article body.</p>'.repeat(10)}</body></html>`),
      );
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAPH_TOKEN', 'T');
    await t.setSetting('CALLBACK_URL', 'https://bot.example.com/hooks/content');
    await t.setSetting('CALLBACK_SECRET', 'cb-secret');
    const key = await intakeKey(t);
    await t.call(key, 'POST', '/v1/trending', purchase);
    for (let i = 0; i < 30; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
    await t.api('POST', '/v1/tick');

    const bodies = received.map((r) => {
      const sig = createHmac('sha256', 'cb-secret').update(r.headers['X-Timestamp'] + '.' + r.body).digest('hex');
      expect(r.headers['X-Signature']).toBe(sig);
      return JSON.parse(r.body);
    });
    expect(bodies.every((b) => ['order.accepted', 'link.published', 'sticker_pack.ready', 'order.completed'].includes(b.type))).toBe(true);
    expect(bodies.every((b) => b.purchase_id === 'cb-1' && b.external_order_id === 'trending:cb-1')).toBe(true);
    const link = bodies.find((b) => b.type === 'link.published' && b.data.source === 'telegraph');
    expect(link?.data).toEqual({ source: 'telegraph', label: 'Telegraph article', url: 'https://telegra.ph/Moon-Frog-09-29', project: { name: 'Moon Frog', symbol: 'MFROG' } });
    for (const b of bodies.filter((x) => x.type === 'order.completed'))
      for (const f of b.data.failures) expect(Object.keys(f).sort()).toEqual(['label', 'source', 'status']);
  });
});

describe('global pause', () => {
  it('accepts orders but runs, publishes and sends nothing until resumed, then shifts deadlines', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'telegraph' });
    await t.setSetting('CALLBACK_URL', 'https://bot.example.com/hooks/content');
    await t.setSetting('CALLBACK_SECRET', 'cb-secret');
    expect((await t.api('POST', '/v1/pause')).body.paused).toBe(true);
    const key = await intakeKey(t);
    expect((await t.call(key, 'POST', '/v1/pause')).status).toBe(403);

    const o = (await t.call(key, 'POST', '/v1/trending', purchase)).body;
    expect(o.id).toBeTruthy();
    t.clock.advance(48 * 3_600_000);
    const r = await t.api('POST', '/v1/tick');
    expect(r.body).toMatchObject({ paused: true, processed: 0 });
    expect(t.http.calls).toEqual([]); // no Gemini, no DEX, no callbacks
    for (const path of ['/v1/publish/claim', '/v1/render/claim', '/v1/listings/check-claim'])
      expect((await t.api('POST', path, { kinds: ['telegraph', 'coinsniper'] })).body).toBeNull();
    const held = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(held.jobs.every((j: any) => ['queued', 'skipped'].includes(j.status))).toBe(true);

    // Survives a restart: the flag is in the database.
    expect((await t.api('GET', '/v1/pause')).body.paused).toBe(true);

    expect((await t.api('POST', '/v1/resume')).body.paused).toBe(false);
    const report = (await t.api('GET', `/v1/orders/${o.id}/report`)).body;
    const meta = report.pending.find((p: any) => p.source === 'metadata' || p.label === 'Token metadata');
    expect(Date.parse(meta.deadline_at) - t.clock.now().getTime()).toBeGreaterThan(0);
  });
});
