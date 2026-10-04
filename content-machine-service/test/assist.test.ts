import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const input = {
  order_id: 'assist-1',
  chain: 'solana',
  contract_address: SOL,
  name: 'Moon Frog',
  symbol: 'MFROG',
  telegram_url: 'https://t.me/moonfrog',
  x_url: 'https://x.com/moonfrog',
  channels: ['coinsniper', 'reddit'],
};

async function setup() {
  const t = makeApp({ ASSIST_KINDS: 'coinsniper,coinvote,reddit' });
  const dms: any[] = [];
  t.http
    .on('api.dexscreener.com/', () => json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 } }]))
    .on('generativelanguage.googleapis.com/', (_u, init) =>
      JSON.parse(String(init.body)).generationConfig?.responseModalities
        ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
        : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
    )
    .on('api.telegram.org/', (_u, init) => {
      dms.push(JSON.parse(String(init.body)));
      return json({ ok: true, result: { message_id: 1 } });
    });
  await t.setSetting('GEMINI_API_KEY', 'G');
  await t.setSetting('CALL_CHANNEL_BOT_TOKEN', '1:abc');
  await t.setSetting('ASSIST_CHAT_ID', '42');
  const o = (await t.api('POST', '/v1/orders', input)).body;
  for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
  await t.api('POST', '/v1/tick');
  return { t, o, dms };
}

describe('posts handed to a person', () => {
  it('keeps them from the worker and DMs one posting link per order', async () => {
    const { t, o, dms } = await setup();
    expect((await t.api('POST', '/v1/publish/claim', { kinds: ['coinsniper', 'reddit_moonshots'] })).body).toBeNull();
    const jobs = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs;
    expect(jobs.find((j: any) => j.kind === 'coinsniper').status).toBe('blocked');
    expect(dms).toHaveLength(1);
    expect(dms[0].chat_id).toBe('42');
    expect(dms[0].text).toContain('CoinSniper listing');
    expect(dms[0].reply_markup.inline_keyboard[0][0].url).toMatch(/^https:\/\/content\.example\.test\/assist\/[A-Za-z0-9_-]{32}$/);
    await t.api('POST', '/v1/tick');
    expect(dms).toHaveLength(1);
  });

  it('serves the page without auth and delivers the pasted links', async () => {
    const { t, o, dms } = await setup();
    const path = new URL(dms[0].reply_markup.inline_keyboard[0][0].url).pathname;
    const page = await t.call(null, 'GET', path);
    expect(page.status).toBe(200);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('https://www.reddit.com/r/moonshots/submit?type=TEXT&amp;title=');
    expect(page.body).toContain('https://coinsniper.net/submit');
    expect(page.body).toContain('javascript:');

    expect((await t.call(null, 'POST', `${path}/done`, { kind: 'reddit_moonshots', url: 'https://www.reddit.com/r/other/comments/abc/x/' })).status).toBe(400);
    const r = await t.call(null, 'POST', `${path}/done`, { kind: 'reddit_moonshots', url: 'https://www.reddit.com/r/moonshots/comments/abc123/moon_frog/' });
    expect(r.body).toEqual({ status: 'delivered', url: 'https://www.reddit.com/r/moonshots/comments/abc123/moon_frog/' });
    expect((await t.call(null, 'POST', `${path}/done`, { kind: 'coinsniper', submitted: true })).body.status).toBe('submitted');
    expect((await t.call(null, 'POST', `${path}/done`, { kind: 'coinvote', url: 'x' })).status).toBe(404);

    const jobs = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs;
    expect(jobs.find((j: any) => j.kind === 'coinsniper').status).toBe('submitted');
    expect((await t.call(null, 'GET', '/assist/' + 'A'.repeat(32))).status).toBe(404);
  });
});
