import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const input = {
  order_id: 'dist-1',
  chain: 'solana',
  contract_address: SOL,
  name: 'Moon Frog',
  symbol: 'MFROG',
  telegram_url: 'https://t.me/moonfrog',
  x_url: 'https://x.com/moonfrog',
  channels: ['cmc_community', 'press_1888'],
};

async function setup() {
  const t = makeApp();
  t.http
    .on('api.dexscreener.com/', () =>
      json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 }, pairCreatedAt: Date.parse('2026-09-20T10:00:00Z') }]),
    )
    .on('generativelanguage.googleapis.com/', (_u, init) =>
      JSON.parse(String(init.body)).generationConfig?.responseModalities
        ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
        : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
    )
    .on('coinmarketcap.com/community/post/379681088', () =>
      new Response(`<html><body>${'x'.repeat(200)}<p>${liveCopy.social_post}</p></body></html>`, { headers: { 'content-type': 'text/html' } }),
    );
  await t.setSetting('GEMINI_API_KEY', 'G');
  const o = (await t.api('POST', '/v1/orders', input)).body;
  for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
  return { t, o };
}

describe('CoinMarketCap community post', () => {
  it('hands the worker the social post and image, then verifies the public post page', async () => {
    const { t, o } = await setup();
    const c = (await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body;
    expect(c.job.kind).toBe('cmc_community');
    expect(c.target.text).toBe(`${liveCopy.social_post}\n\nTelegram: https://t.me/moonfrog`);
    expect(c.target.image_asset_url).toMatch(/^\/v1\/assets\//);

    const done = await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, url: 'https://coinmarketcap.com/community/post/379681088/' });
    expect(done.body.status).toBe('delivered');
    const job = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.kind === 'cmc_community');
    expect(job.result.url).toBe('https://coinmarketcap.com/community/post/379681088/');
  });

  it('marks an unconfirmed or off-site URL uncertain', async () => {
    const { t } = await setup();
    const c = (await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body;
    expect((await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, url: 'https://coinmarketcap.com/community/profile/x/' })).body.status).toBe('uncertain');
  });
});

describe('1888PressRelease', () => {
  it('builds a valid release, waits for review, and delivers the release page', async () => {
    const { t, o } = await setup();
    const c = (await t.api('POST', '/v1/publish/claim', { kinds: ['press_1888'] })).body;
    const r = c.target.release;
    expect(r.headline.split(/\s+/).length).toBeLessThanOrEqual(22);
    expect(r.body.length).toBeGreaterThanOrEqual(750);
    expect(r.body).toContain(SOL);
    expect(r.body).not.toMatch(/[<>]/);
    expect(r.summary).toBe(liveCopy.short_post);
    expect(r.keywords).toContain('Moon Frog');
    expect(c.target.listing.contract_address).toBe(SOL);

    expect((await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, submitted: true })).body.status).toBe('submitted');
    t.clock.advance(31 * 60_000);
    // A directory worker doesn't get press checks, and vice versa.
    expect((await t.api('POST', '/v1/listings/check-claim', { kinds: ['coinsniper', 'coinvote'] })).body).toBeNull();
    const check = (await t.api('POST', '/v1/listings/check-claim', { kinds: ['press_1888'] })).body;
    expect(check.job.id).toBe(c.job.id);
    expect(check.target.release.headline).toBe(r.headline);

    expect((await t.api('POST', `/v1/listings/${c.job.id}/checked`, { live: true, url: 'https://www.1888pressrelease.com/coin/1' })).body.status).toBe('submitted');
    const url = 'https://www.1888pressrelease.com/moon-frog-squad-launches-community-kit-pr-771999.html';
    expect((await t.api('POST', `/v1/listings/${c.job.id}/checked`, { live: true, url })).body).toEqual({ status: 'delivered', url });
    const job = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.kind === 'press_1888');
    expect(job.status).toBe('delivered');
  });
});
