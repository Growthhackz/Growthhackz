import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const input = {
  order_id: 'dir-1',
  chain: 'solana',
  contract_address: SOL,
  name: 'Moon Frog',
  symbol: 'MFROG',
  telegram_url: 'https://t.me/moonfrog',
  website_url: 'https://moonfrog.example',
  logo_url: 'https://cdn.example.com/logo.png',
  channels: ['coinsniper', 'coinvote'],
};

async function setup() {
  const t = makeApp();
  t.http
    .on('api.dexscreener.com/', () =>
      json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 }, pairCreatedAt: Date.parse('2026-09-20T10:00:00Z') }]),
    )
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
const kinds = { kinds: ['coinsniper', 'coinvote'] };

describe('directory listings', () => {
  it('submits, waits for review, and delivers the live coin page URL', async () => {
    const { t, o } = await setup();
    const c = (await t.api('POST', '/v1/publish/claim', kinds)).body;
    expect(c.target.listing).toMatchObject({
      name: 'Moon Frog',
      symbol: 'MFROG',
      chain: 'solana',
      contract_address: SOL,
      telegram_url: 'https://t.me/moonfrog',
      website_url: 'https://moonfrog.example',
      launch_date: '2026-09-20',
      logo_url: 'https://cdn.example.com/logo.png',
    });
    expect(c.target.listing.description.length).toBeLessThanOrEqual(1000);
    expect(c.target.site).toBe(c.job.kind);

    const sub = await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, submitted: true, url: null });
    expect(sub.body.status).toBe('submitted');
    // Not due for a check yet.
    expect((await t.api('POST', '/v1/listings/check-claim')).body).toBeNull();
    t.clock.advance(31 * 60_000);
    const check = (await t.api('POST', '/v1/listings/check-claim')).body;
    expect(check.job.id).toBe(c.job.id);
    expect(check.target.listing.name).toBe('Moon Frog');
    // Claimed checks aren't handed out twice.
    expect((await t.api('POST', '/v1/listings/check-claim')).body).toBeNull();
    expect((await t.api('POST', `/v1/listings/${c.job.id}/checked`, { live: false })).body.status).toBe('submitted');

    const host = c.job.kind === 'coinsniper' ? 'coinsniper.net' : 'coinvote.cc';
    // A URL on another host or not a coin page is not accepted.
    expect((await t.api('POST', `/v1/listings/${c.job.id}/checked`, { live: true, url: 'https://evil.example/coin/1' })).body.status).toBe('submitted');
    const live = await t.api('POST', `/v1/listings/${c.job.id}/checked`, { live: true, url: `https://${host}/coin/12345` });
    expect(live.body).toEqual({ status: 'delivered', url: `https://${host}/coin/12345` });
    const job = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.id === c.job.id);
    expect(job.result).toMatchObject({ url: `https://${host}/coin/12345`, verified_by: 'worker' });
  });

  it('shows in_review, fails after a week without approval, and lets an admin record the URL', async () => {
    const { t, o } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = (await t.api('POST', '/v1/publish/claim', kinds)).body;
      ids.push(c.job.id);
      await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, submitted: true });
    }
    // Everything else skipped or delivered for this order except media/stickers, which are still queued.
    const statuses = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.filter((j: any) => j.status === 'submitted');
    expect(statuses).toHaveLength(2);

    t.clock.advance(8 * 24 * 60 * 60_000);
    const c = (await t.api('POST', '/v1/listings/check-claim')).body;
    expect((await t.api('POST', `/v1/listings/${c.job.id}/checked`, { live: false })).body.status).toBe('failed');

    const other = ids.find((id) => id !== c.job.id)!;
    const otherKind = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.id === other).kind;
    const host = otherKind === 'coinsniper' ? 'coinsniper.net' : 'coinvote.cc';
    expect((await t.api('POST', `/v1/jobs/${other}/reconcile`, { url: `https://${host}/about` })).status).toBe(400);
    const rec = await t.api('POST', `/v1/jobs/${other}/reconcile`, { url: `https://www.${host}/coin/moon-frog` });
    expect(rec.status).toBe(200);
  });

  it('treats a submit it could not confirm as uncertain', async () => {
    const { t } = await setup();
    const c = (await t.api('POST', '/v1/publish/claim', kinds)).body;
    expect((await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, url: null })).body.status).toBe('uncertain');
  });
});
