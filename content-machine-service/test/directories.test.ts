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

describe('order report with listings under review', () => {
  it('goes out once every listing is submitted with its coin page URL, marked in review; waits while a URL is unknown', async () => {
    const t = makeApp();
    t.http
      .on('api.dexscreener.com/', () =>
        json([{ chainId: 'solana', url: 'https://dexscreener.com/solana/pair123', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 } }]),
      )
      .on('generativelanguage.googleapis.com/', (_u, init) =>
        JSON.parse(String(init.body)).generationConfig?.responseModalities
          ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
          : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
      );
    await t.setSetting('GEMINI_API_KEY', 'G');
    // No website, X or Telegram: sites that require a link get the DEX Screener chart.
    const o = (await t.api('POST', '/v1/orders', { order_id: 'rev-1', chain: 'solana', contract_address: SOL, channels: ['top100token', 'gemfinder'], test: true })).body;
    const tick = async () => { for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break; };
    await tick();
    const completed = async () => (await t.api('GET', `/v1/orders/${o.id}/events`)).body.events.filter((e: any) => e.type === 'order.completed');

    const a = (await t.api('POST', '/v1/publish/claim', { kinds: ['top100token'] })).body;
    expect(a.target.listing.chart_url).toBe('https://dexscreener.com/solana/pair123');
    await t.api('POST', `/v1/publish/${a.job.id}/complete`, { lease: a.job.lease, submitted: true, url: `https://top100token.com/solana/${SOL}` });
    const b = (await t.api('POST', '/v1/publish/claim', { kinds: ['gemfinder'] })).body;
    await t.api('POST', `/v1/publish/${b.job.id}/complete`, { lease: b.job.lease, submitted: true, url: null });
    await tick();
    expect(await completed()).toHaveLength(0); // GemFinder's page is not known yet

    expect((await t.api('POST', `/v1/listings/${b.job.id}/checked`, { live: true, url: 'https://gemfinder.cc/gem/42' })).body.status).toBe('delivered');
    await tick();
    // Peak bot gets each listing's link once: at submission when the page is known ("in review"), else when it is live.
    expect((await t.api('POST', `/v1/listings/${a.job.id}/checked`, { live: true, url: `https://top100token.com/solana/${SOL}` })).body.status).toBe('delivered');
    const links = (await t.api('GET', `/v1/orders/${o.id}/events`)).body.events.filter((e: any) => e.type === 'link.published').map((e: any) => [e.data.source, e.data.label]);
    expect(links).toEqual([
      ['top100token', 'Top100Token listing (in review)'],
      ['gemfinder', 'GemFinder listing'],
    ]);
    const [done] = await completed();
    expect(done.data.successes).toEqual(
      expect.arrayContaining([
        { source: 'top100token', label: 'Top100Token listing (in review)', url: `https://top100token.com/solana/${SOL}` },
        { source: 'gemfinder', label: 'GemFinder listing', url: 'https://gemfinder.cc/gem/42' },
      ]),
    );
  });

  it('request listings (CoinCodex, CNToken, Blockspot): off for trending orders; done with no link once the site accepts', async () => {
    const t = makeApp();
    t.http
      .on('api.dexscreener.com/', () => json([]))
      .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
      .on('generativelanguage.googleapis.com/', (_u, init) =>
        JSON.parse(String(init.body)).generationConfig?.responseModalities
          ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
          : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
      );
    await t.setSetting('GEMINI_API_KEY', 'G');
    // A trending sale never includes them.
    const sale = (await t.api('POST', '/v1/trending', { purchase_id: 'req-sale', chain: 'solana', contract_address: SOL, name: 'Moon Frog', symbol: 'MFROG', telegram_url: 'https://t.me/moonfrog' })).body;
    for (const k of ['coincodex', 'cntoken', 'blockspot', 'okx_wallet', 'bitget_wallet']) expect(sale.jobs.find((j: any) => j.kind === k).status).toBe('skipped');
    // An admin test order (no buybot callback) with only the new sites.
    const o = (await t.api('POST', '/v1/orders', { ...input, order_id: 'req-1', channels: ['coincodex', 'cntoken', 'blockspot'] })).body;
    for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
    const c = (await t.api('POST', '/v1/publish/claim', { kinds: ['coincodex'] })).body;
    expect(c.job.kind).toBe('coincodex');
    expect(c.target.listing).toMatchObject({ name: 'Moon Frog', logo_public_url: 'https://cdn.example.com/logo.png' });
    expect((await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, submitted: true, url: null, note: 'request recorded' })).body.status).toBe('delivered');
    // CNToken refused (nothing sent): failed for a retry, never "uncertain".
    const d = (await t.api('POST', '/v1/publish/claim', { kinds: ['cntoken'] })).body;
    await t.api('POST', `/v1/publish/${d.job.id}/fail`, { lease: d.job.lease, error: 'cntoken: CNToken requires a Telegram link; nothing was sent.' });
    const order = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(order.jobs.find((j: any) => j.kind === 'coincodex')).toMatchObject({ status: 'delivered', result: { url: null, note: 'request recorded' } });
    expect(['queued', 'failed', 'blocked']).toContain(order.jobs.find((j: any) => j.kind === 'cntoken').status);
    const report = (await t.api('GET', `/v1/orders/${o.id}/report`)).body;
    expect(report.successes).toContainEqual({ source: 'coincodex', label: 'CoinCodex listing request (submitted, in review)', url: null });
    // Proof captured afterwards (read-only) can be attached by an admin; the report then links the screenshot.
    const cc = order.jobs.find((j: any) => j.kind === 'coincodex');
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64');
    expect((await t.call(null, 'POST', `/v1/jobs/${cc.id}/proof`, { proof: jpeg })).status).toBe(401);
    expect((await t.api('POST', `/v1/jobs/${d.job.id}/proof`, { proof: jpeg })).status).toBe(409);
    const attached = (await t.api('POST', `/v1/jobs/${cc.id}/proof`, { proof: jpeg })).body;
    expect(attached.result).toMatchObject({ note: 'request recorded', proof_url: expect.stringMatching(/\/media\/[0-9a-f]{40}$/) });
    expect((await t.api('GET', `/v1/orders/${o.id}/report`)).body.successes).toContainEqual({
      source: 'coincodex',
      label: 'CoinCodex listing request (submitted, in review)',
      url: attached.result.proof_url,
    });
  });

  it('wallet listings (OKX, Bitget): the submission screenshot is kept as proof and linked in the report', async () => {
    const t = makeApp();
    t.http
      .on('api.dexscreener.com/', () => json([]))
      .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
      .on('generativelanguage.googleapis.com/', (_u, init) =>
        JSON.parse(String(init.body)).generationConfig?.responseModalities
          ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
          : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
      );
    await t.setSetting('GEMINI_API_KEY', 'G');
    const o = (await t.api('POST', '/v1/orders', { ...input, order_id: 'req-2', channels: ['okx_wallet', 'bitget_wallet'] })).body;
    for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
    const okx = (await t.api('POST', '/v1/publish/claim', { kinds: ['okx_wallet'] })).body;
    const shot = pngBytes().toString('base64');
    const review = `https://web3.okx.com/token/solana/${SOL}`;
    expect((await t.api('POST', `/v1/publish/${okx.job.id}/complete`, { lease: okx.job.lease, submitted: true, url: null, note: 'submitted', review_url: review, proof: shot })).body.status).toBe('delivered');
    // A review link off the site's own host is dropped; a non-image "proof" is ignored.
    const bg = (await t.api('POST', '/v1/publish/claim', { kinds: ['bitget_wallet'] })).body;
    await t.api('POST', `/v1/publish/${bg.job.id}/complete`, { lease: bg.job.lease, submitted: true, url: null, review_url: 'https://evil.example.com/x', proof: Buffer.from('nope').toString('base64') });
    const jobs = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs;
    const okxResult = jobs.find((j: any) => j.kind === 'okx_wallet').result;
    expect(okxResult).toMatchObject({ url: null, review_url: review, proof_url: expect.stringMatching(/\/media\/[0-9a-f]{40}$/) });
    expect(jobs.find((j: any) => j.kind === 'bitget_wallet')).toMatchObject({ status: 'delivered', result: { url: null } });
    expect(jobs.find((j: any) => j.kind === 'bitget_wallet').result).not.toHaveProperty('review_url');
    expect(jobs.find((j: any) => j.kind === 'bitget_wallet').result).not.toHaveProperty('proof_url');
    const img = await t.call(null, 'GET', `/media/${okxResult.proof_url.split('/media/')[1]}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const report = (await t.api('GET', `/v1/orders/${o.id}/report`)).body;
    expect(report.successes).toContainEqual({ source: 'okx_wallet', label: 'OKX Wallet token info update (submitted, in review)', url: okxResult.proof_url });
  });
});
