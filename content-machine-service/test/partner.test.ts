import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const TOKEN = 'p'.repeat(48);
const PARTNER = 'https://partner.example/listings';
const input = {
  order_id: 'trending:partner-1',
  chain: 'solana',
  contract_address: SOL,
  name: 'Moon Frog',
  symbol: 'MFROG',
  telegram_url: 'https://t.me/moonfrog',
  x_url: 'https://x.com/moonfrog',
  website_url: 'https://moonfrog.example',
  channels: ['partner_listings'],
};
const COINVOTE = 'https://coinvote.cc/coin/Moon-Frog';
const COINSNIPER = 'https://coinsniper.net/coin/12345';

async function setup(env: Record<string, string> = { PARTNER_LISTINGS_URL: PARTNER, PARTNER_LISTINGS_TOKEN: TOKEN }, partner: (body: any, headers: Headers) => Response = () => json({ received: true })) {
  const t = makeApp(env);
  const sent: Array<{ body: any; headers: Headers; raw: string }> = [];
  t.http
    .on('api.dexscreener.com/', () =>
      json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 5000 }, volume: { h24: 900 }, url: 'https://dexscreener.com/solana/pair1', pairCreatedAt: Date.UTC(2026, 8, 20), info: { imageUrl: 'https://cdn.example/logo.png' } }]),
    )
    .on('generativelanguage.googleapis.com/', (_u, init) =>
      JSON.parse(String(init.body)).generationConfig?.responseModalities
        ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
        : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
    )
    .on('cdn.example/', () => new Response(new Uint8Array(pngBytes()), { headers: { 'content-type': 'image/png' } }))
    .on('partner.example/', (_u, init) => {
      const raw = String(init.body);
      const headers = new Headers(init.headers as Record<string, string>);
      sent.push({ body: JSON.parse(raw), headers, raw });
      return partner(JSON.parse(raw), headers);
    });
  await t.setSetting('GEMINI_API_KEY', 'G');
  const o = (await t.api('POST', '/v1/orders', input)).body;
  const tick = async (n = 12) => { for (let i = 0; i < n; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break; await t.api('POST', '/v1/tick'); };
  const job = async () => (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.kind === 'partner_listings');
  const events = (type: string) => t.db.prepare('SELECT data FROM events WHERE order_id = ? AND type = ?').all(o.id, type).map((r: any) => JSON.parse(r.data));
  const answer = (body: unknown, token = TOKEN) => t.call(token, 'POST', '/v1/partner/listings', body);
  return { t, o, sent, tick, job, events, answer };
}

describe('outside listing service (Coinvote & CoinSniper)', () => {
  it('sends every coin detail once the metadata and copy are in, signed, and waits without holding the order', async () => {
    const { o, sent, tick, job, events } = await setup();
    await tick();
    expect(sent).toHaveLength(1);
    const { body, headers, raw } = sent[0]!;
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('x-signature')).toBe(createHmac('sha256', TOKEN).update(`${headers.get('x-timestamp')}.${raw}`).digest('hex'));
    expect(headers.get('idempotency-key')).toBe(body.request_id);
    expect(body).toMatchObject({
      event: 'listing.request',
      order_id: 'trending:partner-1',
      purchase_number: 1,
      test: false,
      sites: ['coinvote', 'coinsniper'],
      results_url: 'https://content.example.test/v1/partner/listings',
      coin: {
        name: 'Moon Frog', symbol: 'MFROG', chain: 'solana', chain_name: 'Solana', contract_address: SOL,
        logo_url: 'https://cdn.example/logo.png', website_url: 'https://moonfrog.example', telegram_url: 'https://t.me/moonfrog', x_url: 'https://x.com/moonfrog',
        launch_date: '2026-09-20', chart_url: 'https://dexscreener.com/solana/pair1',
        market: { liquidity_usd: 5000, volume_24h_usd: 900, pair_created_at: '2026-09-20T00:00:00.000Z' },
      },
    });
    expect(body.coin.description.length).toBeGreaterThan(20);
    expect(body.coin.short_description).toBeTruthy();
    expect((await job()).status).toBe('submitted');
    // Everything else is done: the report goes out without waiting for the listing service.
    const report = events('order.completed');
    expect(report).toHaveLength(1);
    expect(report[0].pending.map((p: any) => p.source)).toContain('partner_listings');
    expect(o.id).toBeTruthy();
  });

  it('delivers both URLs to the core bot as one link with both pages', async () => {
    const { tick, job, events, answer } = await setup();
    await tick();
    const id = (await job()).id;
    expect((await answer({ request_id: id, coinvote_url: COINVOTE })).body).toEqual({ status: 'waiting', links: [{ name: 'Coinvote', url: COINVOTE }] });
    expect((await job()).status).toBe('submitted');
    expect((await answer({ order_id: 'trending:partner-1', coinsniper_url: COINSNIPER })).body.status).toBe('delivered');
    const j = await job();
    expect(j.status).toBe('delivered');
    expect(j.result.links).toEqual([{ name: 'Coinvote', url: COINVOTE }, { name: 'CoinSniper', url: COINSNIPER }]);
    const link = events('link.published').find((l: any) => l.source === 'partner_listings');
    expect(link).toMatchObject({ label: 'Coinvote & CoinSniper listings', url: COINVOTE, links: [{ name: 'Coinvote', url: COINVOTE }, { name: 'CoinSniper', url: COINSNIPER }] });
    // Repeated answers are harmless.
    expect((await answer({ request_id: id, coinvote_url: COINVOTE, coinsniper_url: COINSNIPER })).body.status).toBe('delivered');
    expect(events('link.published').filter((l: any) => l.source === 'partner_listings')).toHaveLength(1);
  });

  it('checks the token and the URLs', async () => {
    const { t, tick, job, answer } = await setup();
    await tick();
    const id = (await job()).id;
    expect((await answer({ request_id: id, coinvote_url: COINVOTE }, 'x'.repeat(48))).status).toBe(401);
    // The service's token opens this route only.
    expect((await t.call(TOKEN, 'GET', '/v1/orders')).status).toBe(401);
    expect((await answer({ request_id: id, coinvote_url: 'https://evil.example/coin/x' })).status).toBe(400);
    expect((await answer({ request_id: id, coinsniper_url: 'http://coinsniper.net/coin/1' })).status).toBe(400);
    expect((await answer({ request_id: 'nope', coinvote_url: COINVOTE })).status).toBe(404);
    expect((await answer({ coinvote_url: COINVOTE })).status).toBe(400);
  });

  it('delivers what came back when the wait is over, or fails only this item', async () => {
    const partial = await setup();
    await partial.tick();
    await partial.answer({ request_id: (await partial.job()).id, coinsniper_url: COINSNIPER });
    partial.t.clock.advance(16 * 60_000);
    await partial.tick(1);
    const p = await partial.job();
    expect(p.status).toBe('delivered');
    expect(p.result.links).toEqual([{ name: 'CoinSniper', url: COINSNIPER }]);
    expect(p.result.note).toMatch(/Coinvote did not come back within 15 minutes/);

    const silent = await setup();
    await silent.tick();
    silent.t.clock.advance(16 * 60_000);
    await silent.tick(1);
    expect((await silent.job()).status).toBe('failed');
    expect((await silent.job()).error).toMatch(/no URLs within 15 minutes/);
    // A late answer is acknowledged (no retries from the service) and changes nothing: the order has moved on.
    const late = await silent.answer({ request_id: (await silent.job()).id, coinvote_url: COINVOTE });
    expect(late.status).toBe(200);
    expect(late.body.status).toBe('closed');
    expect((await silent.job()).status).toBe('failed');
    expect(silent.events('link.published').filter((l: any) => l.source === 'partner_listings')).toHaveLength(0);
    // A final "done" with nothing ends it too.
    const done = await setup();
    await done.tick();
    expect((await done.answer({ request_id: (await done.job()).id, status: 'failed', error: 'site down' })).body.status).toBe('failed');
  });

  it('takes URLs from the immediate answer, and an outage never touches the rest of the order', async () => {
    const fast = await setup(undefined, () => json({ coinvote_url: COINVOTE, coinsniper_url: COINSNIPER }));
    await fast.tick();
    expect((await fast.job()).status).toBe('delivered');

    const down = await setup(undefined, () => new Response('nope', { status: 503 }));
    await down.tick();
    const j = await down.job();
    expect(j.status).toBe('queued');
    expect(j.error).toMatch(/refused the request \(503\)/);
    const jobs = (await down.t.api('GET', `/v1/orders/${down.o.id}`)).body.jobs;
    for (const k of ['metadata', 'copy', 'campaign_image']) expect(jobs.find((x: any) => x.kind === k).status).toBe('delivered');
    expect(down.events('order.completed')).toHaveLength(1);
  });

  it('calls the service with its own key when it gave us one; it still answers with ours', async () => {
    const OUT = 'plw_' + 'k'.repeat(40);
    const { sent, tick, job, answer } = await setup({ PARTNER_LISTINGS_URL: PARTNER, PARTNER_LISTINGS_TOKEN: TOKEN, PARTNER_LISTINGS_OUT_TOKEN: OUT });
    await tick();
    const { headers, raw } = sent[0]!;
    expect(headers.get('authorization')).toBe(`Bearer ${OUT}`);
    expect(headers.get('x-signature')).toBe(createHmac('sha256', OUT).update(`${headers.get('x-timestamp')}.${raw}`).digest('hex'));
    expect((await answer({ request_id: (await job()).id, coinvote_url: COINVOTE, coinsniper_url: COINSNIPER }, OUT)).status).toBe(401);
    expect((await answer({ request_id: (await job()).id, coinvote_url: COINVOTE, coinsniper_url: COINSNIPER })).body.status).toBe('delivered');
  });

  it('is skipped while the service is not set up', async () => {
    const { tick, job, sent, events } = await setup({});
    await tick();
    expect((await job()).status).toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(events('order.completed')).toHaveLength(1);
  });
});
