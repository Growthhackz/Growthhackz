import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { json, makeApp, SOL } from './helpers.js';
import { deliverCallbacks } from '../src/services/engine.js';
import { recordEvent } from '../src/services/orderService.js';
import { RECEIVER_HOSTS, RECEIVER_SOURCES } from '../src/services/callbackShape.js';

/**
 * The core bot's receiver as docs/core-bot-prompt.md tells it to be built: a closed schema per event
 * type (unknown keys dropped), and a URL allowlist. Anything this refuses, the real bot refuses too.
 */
const source = z.enum(RECEIVER_SOURCES as [string, ...string[]]);
const label = z.string().max(100);
const project = z.object({ name: label.nullable(), symbol: z.string().max(20).nullable() });
const allowed = (u: string) => {
  const url = new URL(u);
  const own = 'content.example.test';
  return url.protocol === 'https:' && !url.username && !url.port && [...RECEIVER_HOSTS, own].some((h) => url.hostname === h || url.hostname.endsWith('.' + h));
};
const shownUrl = z.string().max(500).url().refine(allowed, 'host not allowlisted');
const schemas: Record<string, z.ZodType> = {
  'order.accepted': z.object({}),
  'link.published': z.object({ source, label, url: shownUrl, project }),
  'sticker_pack.ready': z.object({ url: shownUrl, name: label, project }),
  'order.completed': z.object({
    complete: z.boolean(),
    project,
    successes: z.array(z.object({ source, label, url: shownUrl.nullable() })),
    failures: z.array(z.object({ source, label, status: z.enum(['failed', 'unconfirmed']) })),
    pending: z.array(z.never()),
  }),
};

const purchase = { purchase_id: 'shape-1', chain: 'solana', contract_address: SOL, telegram_url: 'https://t.me/moonfrog', name: 'Moon Frog', symbol: 'MFROG' };

async function botAndOrder(t: ReturnType<typeof makeApp>, respond: () => Response = () => json({ ok: true })) {
  const received: any[] = [];
  t.http.on('bot.example.com/hooks/content', (_u, init) => {
    received.push(JSON.parse(String(init.body)));
    return respond();
  });
  await t.setSetting('CALLBACK_URL', 'https://bot.example.com/hooks/content');
  await t.setSetting('CALLBACK_SECRET', 'cb-secret');
  const o = (await t.api('POST', '/v1/trending', purchase)).body;
  return { received, orderId: o.id as string };
}

describe('callbacks fit the core bot', () => {
  it('sends only sources, statuses and hosts the bot accepts, keeping the real destination in the label', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'telegraph' });
    const { received, orderId } = await botAndOrder(t);
    const proj = { name: 'Moon Frog', symbol: 'MFROG', chain: 'solana', contract_address: SOL };
    recordEvent(t.ctx, orderId, 'link.published', { source: 'coinboom', label: 'CoinBoom listing (in review)', url: `https://coinboom.net/solana/${SOL}`, project: proj });
    recordEvent(t.ctx, orderId, 'order.completed', {
      order_id: 'trending:shape-1',
      complete: true,
      project: proj,
      successes: [
        { source: 'telegraph', label: 'Telegraph article', url: 'https://telegra.ph/Moon-Frog-10-19' },
        { source: 'top100token', label: 'Top100Token listing (in review)', url: `https://top100token.com/solana/${SOL}` },
        { source: 'web3_listings', label: 'Web3 Listing Updates', url: `https://web3.binance.com/en/token/sol/${SOL}`, links: [{ name: 'Binance Wallet', url: `https://web3.binance.com/en/token/sol/${SOL}` }] },
        { source: 'okx_wallet', label: 'OKX Wallet token info update (submitted, in review)', url: 'https://content.example.test/v1/assets/abc' },
        { source: 'sticker_publish', label: 'Telegram sticker pack', url: null },
      ],
      failures: [
        { source: 'social_boost', label: 'X likes, reposts and comments, followers and Telegram members (WURK)', status: 'needs checking', error: 'WURK: needs_attention' },
        { source: 'copy', label: 'Content (article and posts)', status: 'failed', error: 'Gemini: quota' },
        { source: 'coinvote', label: 'Coinvote listing', status: 'unconfirmed', error: 'May have been published' },
      ],
      pending: [{ source: 'partner_listings', label: 'Coinvote & CoinSniper listings', status: 'in_progress', deadline_at: null, note: 'waiting' }],
    });
    expect(await deliverCallbacks(t.ctx)).toEqual({ sent: 3, failed: 0 });

    for (const b of received) {
      const r = schemas[b.type]!.safeParse(b.data);
      expect(r.success, `${b.type}: ${JSON.stringify(r.success ? null : r.error.issues)}`).toBe(true);
    }
    const link = received.find((b) => b.type === 'link.published');
    expect(link.data.source).toBe('coinsniper');
    expect(link.data.label).toBe('CoinBoom listing (in review)');
    expect(link.data.url).toMatch(/^https:\/\/content\.example\.test\/go\/[A-Za-z0-9_-]+$/);
    const r = await t.app.inject({ method: 'GET', url: new URL(link.data.url).pathname });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`https://coinboom.net/solana/${SOL}`);
    expect((await t.app.inject({ method: 'GET', url: '/go/nope-nope-nope' })).statusCode).toBe(404);

    const done = received.find((b) => b.type === 'order.completed');
    expect(done.data.successes.map((s: any) => [s.source, s.label])).toEqual([
      ['telegraph', 'Telegraph article'],
      ['coinsniper', 'Top100Token listing (in review)'],
      ['coinsniper', 'Web3 Listing Updates'],
      ['coinsniper', 'OKX Wallet token info update (submitted, in review)'],
      ['sticker_publish', 'Telegram sticker pack'],
    ]);
    expect(done.data.successes[0].url).toBe('https://telegra.ph/Moon-Frog-10-19'); // allowlisted: untouched
    expect(done.data.successes[1].url).toMatch(/\/go\//); // not allowlisted: our short link
    expect(done.data.successes[2].url).toBe(`https://web3.binance.com/en/token/sol/${SOL}`); // subdomain of an allowlisted host
    expect(done.data.successes[3].url).toBe('https://content.example.test/v1/assets/abc'); // our own host
    expect(done.data.failures).toEqual([
      { source: 'social_boost', label: 'X likes, reposts and comments, followers and Telegram members (WURK)', status: 'unconfirmed' },
      { source: 'telegraph', label: 'Content (article and posts)', status: 'failed' },
      { source: 'coinvote', label: 'Coinvote listing', status: 'unconfirmed' },
    ]);
    expect(done.data.pending).toEqual([]);
    // The report API still has the real names and reasons.
    const ev = (await t.api('GET', `/v1/orders/${orderId}/events`)).body.events.find((e: any) => e.type === 'order.completed');
    expect(ev.data.failures[1]).toMatchObject({ source: 'copy', error: 'Gemini: quota' });
    // The same URL always gets the same short link.
    recordEvent(t.ctx, orderId, 'link.published', { source: 'coinboom', label: 'CoinBoom listing', url: `https://coinboom.net/solana/${SOL}`, project: proj });
    await deliverCallbacks(t.ctx);
    expect(received.at(-1).data.url).toBe(link.data.url);
  });

  it('gives a callback the receiver kept refusing one more delivery as a new event, once (when replay is on)', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'telegraph', CALLBACK_REPLAY_ENABLED: 'true' });
    let status = 400;
    const { received, orderId } = await botAndOrder(t, () => json({ error: 'bad shape' }, status));
    const proj = { name: 'Moon Frog', symbol: 'MFROG' };
    recordEvent(t.ctx, orderId, 'order.completed', { complete: true, project: proj, successes: [{ source: 'telegraph', label: 'Telegraph article', url: 'https://telegra.ph/x' }], failures: [], pending: [] });
    // order.accepted + order.completed refused on every attempt (backoff is capped at an hour).
    for (let i = 0; i < 8; i++) {
      await deliverCallbacks(t.ctx);
      t.clock.advance(3_600_000);
    }
    const before = (await t.api('GET', `/v1/orders/${orderId}/events`)).body.events;
    expect(before.map((e: any) => [e.type, e.attempts, e.delivered])).toEqual([
      ['order.accepted', 8, false],
      ['order.completed', 8, false],
    ]);
    expect(received).toHaveLength(16);
    received.length = 0;

    // Given up. The next delivery run (e.g. right after a deploy that changed the shape) sends the completion
    // once more under a fresh id; the old "accepted" is not worth repeating.
    status = 200;
    expect(await deliverCallbacks(t.ctx)).toEqual({ sent: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('order.completed');
    expect(received[0].id).not.toBe(before[1].id);
    expect(received[0].data.successes[0].url).toBe('https://telegra.ph/x');
    const after = (await t.api('GET', `/v1/orders/${orderId}/events`)).body.events;
    expect(after).toHaveLength(3);
    expect(after.find((e: any) => e.id === before[1].id)).toMatchObject({ delivered: false, replayed_by: received[0].id });
    expect(after.find((e: any) => e.id === received[0].id)).toMatchObject({ delivered: true, replay_of: before[1].id, attempts: 0 });
    expect(after.find((e: any) => e.type === 'order.accepted').replayed_by).toBeUndefined();

    // A replay that is refused too is not replayed again.
    status = 400;
    recordEvent(t.ctx, orderId, 'link.published', { source: 'telegraph', label: 'Telegraph article', url: 'https://telegra.ph/y', project: proj });
    for (let i = 0; i < 9; i++) {
      await deliverCallbacks(t.ctx);
      t.clock.advance(3_600_000);
    }
    for (let i = 0; i < 9; i++) {
      await deliverCallbacks(t.ctx);
      t.clock.advance(3_600_000);
    }
    const links = (await t.api('GET', `/v1/orders/${orderId}/events`)).body.events.filter((e: any) => e.type === 'link.published');
    expect(links).toHaveLength(2);
    expect(links.every((e: any) => e.attempts === 8 && !e.delivered)).toBe(true);
    expect(await deliverCallbacks(t.ctx)).toEqual({ sent: 0, failed: 0 });
    expect((await t.api('GET', `/v1/orders/${orderId}/events`)).body.events.filter((e: any) => e.type === 'link.published')).toHaveLength(2);
  });

  it('replays nothing on its own by default; an admin replays one order at a time', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'telegraph' });
    let status = 400;
    const { received, orderId } = await botAndOrder(t, () => json({ error: 'bad shape' }, status));
    const proj = { name: 'Moon Frog', symbol: 'MFROG' };
    recordEvent(t.ctx, orderId, 'order.completed', { complete: true, project: proj, successes: [], failures: [], pending: [] });
    for (let i = 0; i < 8; i++) {
      await deliverCallbacks(t.ctx);
      t.clock.advance(3_600_000);
    }
    status = 200;
    received.length = 0;
    expect(await deliverCallbacks(t.ctx)).toEqual({ sent: 0, failed: 0 }); // dead events stay dead
    expect(received).toEqual([]);
    const other = (await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'shape-2' })).body;
    await deliverCallbacks(t.ctx);
    received.length = 0;

    const r = await t.api('POST', `/v1/orders/${orderId}/callbacks/replay`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ replayed: 1, sent: 1, failed: 0 }); // the completion, not the stale "accepted"
    expect(received.map((b) => [b.type, b.order_id])).toEqual([['order.completed', orderId]]);
    expect((await t.api('POST', `/v1/orders/${orderId}/callbacks/replay`)).body).toEqual({ replayed: 0, sent: 0, failed: 0 });
    expect((await t.api('POST', `/v1/orders/${other.id}/callbacks/replay`)).body.replayed).toBe(0);
    expect((await t.call(null, 'POST', `/v1/orders/${orderId}/callbacks/replay`)).status).toBe(401);
  });
});
