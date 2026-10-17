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

describe('listing sites tried by the worker first (ASSIST_ON_CHECK)', () => {
  async function tried() {
    const t = makeApp();
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
    const o = (await t.api('POST', '/v1/orders', { ...input, order_id: 'assist-check-1', channels: ['coinsniper', 'coinvote'] })).body;
    for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
    const job = (kind: string) => t.api('GET', `/v1/orders/${o.id}`).then((r) => r.body.jobs.find((j: any) => j.kind === kind));
    return { t, o, dms, job };
  }
  const claim = (t: any) => t.api('POST', '/v1/publish/claim', { kinds: ['coinvote', 'coinsniper'] }).then((r: any) => r.body);

  it('hands an item over on a human check, with one DM once both sites have tried', async () => {
    const { t, o, dms, job } = await tried();
    const first = await claim(t);
    expect(first.job.kind).toBeTruthy();
    await t.api('POST', `/v1/publish/${first.job.id}/fail`, { lease: first.job.lease, error: 'check', human_check: true });
    await t.api('POST', '/v1/tick');
    expect(dms).toHaveLength(0); // the other site is still being tried
    const second = await claim(t);
    expect(second.job.kind).not.toBe(first.job.kind);
    await t.api('POST', `/v1/publish/${second.job.id}/fail`, { lease: second.job.lease, error: 'check', human_check: true });
    await t.api('POST', '/v1/tick');
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toContain('CoinSniper listing');
    expect(dms[0].text).toContain('Coinvote listing');
    const link = (await t.api('GET', `/v1/admin/orders/${o.id}/assist`)).body;
    expect(link.url).toBe(dms[0].reply_markup.inline_keyboard[0][0].url);
    expect(link.dm_sent_at).toBeTruthy();
    expect((await t.call('nope', 'GET', `/v1/admin/orders/${o.id}/assist`)).status).toBe(401);
    // Handed items are the person's: never claimed by the worker again, never swept as out of attempts.
    t.clock.advance(10 * 60_000);
    expect(await claim(t)).toBeNull();
    await t.api('POST', '/v1/tick');
    expect((await job('coinvote')).status).toBe('blocked');
    const page = await t.call(null, 'GET', new URL(dms[0].reply_markup.inline_keyboard[0][0].url).pathname);
    expect(page.body).toContain('https://coinvote.cc/add-coin/released');
    expect(page.body).toContain('Yes, it is live');
    expect(page.body).toContain('cv-ac-manual-chains');
    // Coinvote's check finds the listing the person submitted, in review: recorded with its link, no pasting.
    const due = (await t.api('POST', '/v1/listings/check-claim', { kinds: ['coinvote', 'coinsniper'] })).body;
    expect(due.job.kind).toBe('coinvote');
    expect((await t.api('POST', `/v1/listings/${due.job.id}/checked`, { live: false })).body.status).toBe('blocked');
    t.clock.advance(3 * 60_000);
    const again = (await t.api('POST', '/v1/listings/check-claim', { kinds: ['coinvote', 'coinsniper'] })).body;
    expect(again.job.id).toBe(due.job.id);
    expect((await t.api('POST', `/v1/listings/${due.job.id}/checked`, { live: false, url: 'https://coinvote.cc/coin/Moon-Frog' })).body).toEqual({ status: 'submitted', url: 'https://coinvote.cc/coin/Moon-Frog' });
    expect((await job('coinvote')).result.url).toBe('https://coinvote.cc/coin/Moon-Frog');
    // CoinSniper's link is pasted on the page; then the order reports both.
    const path = new URL(dms[0].reply_markup.inline_keyboard[0][0].url).pathname;
    expect((await t.call(null, 'POST', `${path}/done`, { kind: 'coinsniper', url: 'https://coinsniper.net/coin/12345' })).body.status).toBe('delivered');
    await t.api('POST', '/v1/tick');
    const report = (await t.api('GET', `/v1/orders/${o.id}/report`)).body;
    expect(report.successes.map((s: any) => s.url)).toEqual(expect.arrayContaining(['https://coinsniper.net/coin/12345', 'https://coinvote.cc/coin/Moon-Frog']));
  });

  it('retries other failures as before, and an admin retry takes the item back from the person', async () => {
    const { t, job } = await tried();
    const c = await claim(t);
    await t.api('POST', `/v1/publish/${c.job.id}/fail`, { lease: c.job.lease, error: 'slow page' });
    expect((await job(c.job.kind)).error).toBe('slow page');
    t.clock.advance(3 * 60_000);
    const again = await claim(t);
    await t.api('POST', `/v1/publish/${again.job.id}/fail`, { lease: again.job.lease, error: 'check', human_check: true });
    expect((await job(again.job.kind)).handed_at).toBeTruthy();
    await t.api('POST', `/v1/jobs/${again.job.id}/retry`, { reset_attempts: true });
    expect((await job(again.job.kind)).handed_at).toBeNull();
    expect((await t.api('POST', '/v1/publish/claim', { kinds: [again.job.kind] })).body.job.id).toBe(again.job.id);
  });

  it('is off for sites not listed in ASSIST_ON_CHECK', async () => {
    const t = makeApp({ ASSIST_ON_CHECK: '' });
    t.http
      .on('api.dexscreener.com/', () => json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 } }]))
      .on('generativelanguage.googleapis.com/', (_u, init) =>
        JSON.parse(String(init.body)).generationConfig?.responseModalities
          ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
          : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
      );
    await t.setSetting('GEMINI_API_KEY', 'G');
    const o = (await t.api('POST', '/v1/orders', { ...input, order_id: 'assist-check-off', channels: ['coinvote'] })).body;
    for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
    const c = await claim(t);
    await t.api('POST', `/v1/publish/${c.job.id}/fail`, { lease: c.job.lease, error: 'check', human_check: true });
    const j = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((x: any) => x.kind === 'coinvote');
    expect(j.handed_at).toBeNull();
    expect(j.error).toBe('check');
  });
});
