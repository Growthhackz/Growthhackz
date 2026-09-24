import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const input = {
  order_id: 'rd-1',
  chain: 'solana',
  contract_address: SOL,
  name: 'Moon Frog',
  symbol: 'MFROG',
  telegram_url: 'https://t.me/moonfrog',
  logo_url: 'https://cdn.example.com/logo.png',
  channels: ['reddit'],
};

async function setup(env: Record<string, string> = {}) {
  const t = makeApp(env);
  t.http
    .on('api.dexscreener.com/', () => json([]))
    .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
    .on('generativelanguage.googleapis.com/', (_u, init) =>
      JSON.parse(String(init.body)).generationConfig?.responseModalities
        ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
        : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
    );
  await t.setSetting('GEMINI_API_KEY', 'G');
  const o = (await t.api('POST', '/v1/orders', input)).body;
  for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
  return { t, o };
}

const kindsOf = (o: any) => Object.fromEntries(o.jobs.map((j: any) => [j.kind, j.status]));

describe('Reddit via the companion worker', () => {
  it('queues one post per subreddit with headline + article, and delivers the verified URL', async () => {
    const { t, o } = await setup({ PUBLIC_HUB_ENABLED: 'true' });
    expect(kindsOf((await t.api('GET', `/v1/orders/${o.id}`)).body)).toMatchObject({ reddit_moonshots: 'queued', reddit_solanamemecoins: 'queued', binance: 'skipped' });
    // A worker that only does Binance never gets Reddit work.
    expect((await t.api('POST', '/v1/publish/claim', { kinds: ['binance'] })).body).toBeNull();

    const seen: string[] = [];
    for (;;) {
      const c = (await t.api('POST', '/v1/publish/claim', { kinds: ['reddit_moonshots', 'reddit_solanamemecoins'] })).body;
      if (!c) break;
      seen.push(c.target.subreddit);
      expect(c.target.title).toBe(liveCopy.headline);
      expect(c.target.text).toContain(liveCopy.article.trim().split('\n')[0]);
      expect(c.target.text).toMatch(/^!\[Moon Frog\]\(https:\/\/content\.example\.test\/projects\/.+\/assets\/.+\)/);
      expect(c.target.text).toContain('Telegram: https://t.me/moonfrog');
      // Wrong subreddit in the URL is not accepted as delivered.
      const url = `https://www.reddit.com/r/${c.target.subreddit}/comments/abc123/moon_frog/`;
      const r = await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, url, verified: true });
      expect(r.body.status).toBe('delivered');
    }
    expect(seen.sort()).toEqual(['moonshots', 'solanamemecoins']);
    const done = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(done.jobs.find((j: any) => j.kind === 'reddit_moonshots').result.url).toBe('https://www.reddit.com/r/moonshots/comments/abc123/moon_frog/');
  });

  it('holds unconfirmed or mismatched posts as uncertain, and retries failures from before submitting', async () => {
    const { t } = await setup();
    const kinds = { kinds: ['reddit_moonshots', 'reddit_solanamemecoins'] };

    const a = (await t.api('POST', '/v1/publish/claim', kinds)).body;
    expect(a.target.text.startsWith('![')).toBe(false); // no public image URL without the hub
    const wrongSub = `https://www.reddit.com/r/somewhereelse/comments/zz9/x/`;
    expect((await t.api('POST', `/v1/publish/${a.job.id}/complete`, { lease: a.job.lease, url: wrongSub, verified: true })).body.status).toBe('uncertain');

    const b = (await t.api('POST', '/v1/publish/claim', kinds)).body;
    expect((await t.api('POST', `/v1/publish/${b.job.id}/fail`, { lease: b.job.lease, error: 'Login failed' })).body.status).toBe('blocked');
    // Backs off before trying again.
    expect((await t.api('POST', '/v1/publish/claim', kinds)).body).toBeNull();
    t.clock.advance(5 * 60_000);
    const again = (await t.api('POST', '/v1/publish/claim', kinds)).body;
    expect(again.job.id).toBe(b.job.id);
    expect((await t.api('POST', '/v1/publish/claim', kinds)).body).toBeNull();

    // An admin can reconcile the uncertain one once they find the real post.
    const sub = a.target.subreddit;
    const rec = await t.api('POST', `/v1/jobs/${a.job.id}/reconcile`, { url: `https://old.reddit.com/r/${sub}/comments/q1w2e3/moon_frog/` });
    expect(rec.status).toBe(200);
    expect(rec.body.jobs.find((j: any) => j.id === a.job.id).result.url).toBe(`https://www.reddit.com/r/${sub}/comments/q1w2e3/moon_frog/`);
  });
});
