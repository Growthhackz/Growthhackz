import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, mp4Bytes, pngBytes, SOL } from './helpers.js';

const liveInput = {
  order_id: 'order-1001',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/moonfrog',
  logo_url: 'https://cdn.example.com/logo.png',
  channels: ['telegraph', 'call_channel', 'binance'],
  telegram_owner_id: 42,
  budget_cents: 100,
};

const articleHtml = `<html><body><h1>${liveCopy.headline}</h1>${'<p>Moon Frog community article body.</p>'.repeat(10)}</body></html>`;

function wireProviders(t: ReturnType<typeof makeApp>) {
  t.http
    .on('api.dexscreener.com/token-pairs/v1/solana/', () =>
      json([
        { chainId: 'solana', baseToken: { address: SOL, name: 'Low Liq', symbol: 'LOW' }, liquidity: { usd: 10 } },
        { chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 5000 }, url: 'https://dexscreener.com/x' },
      ]),
    )
    .on('generativelanguage.googleapis.com/', (_u, init) => {
      const body = JSON.parse(String(init.body));
      if (body.generationConfig?.responseModalities)
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] });
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] });
    })
    .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
    .on('api.telegra.ph/createPage', () => json({ ok: true, result: { url: 'https://telegra.ph/Moon-Frog-01-01', path: 'Moon-Frog-01-01' } }))
    .on('telegra.ph/Moon-Frog-01-01', () => new Response(articleHtml))
    .on('www.binance.com/en/square/post/123456', () => new Response(articleHtml))
    .on('api.telegram.org/', (u) => {
      const method = u.pathname.split('/').pop();
      if (method === 'sendPhoto') return json({ ok: true, result: { message_id: 7, chat: { id: -100, username: 'fullsendtrenches' } } });
      if (method === 'getMe') return json({ ok: true, result: { id: 1, username: 'sticker_bot' } });
      if (method === 'uploadStickerFile') return json({ ok: true, result: { file_id: 'file' } });
      if (method === 'createNewStickerSet') return json({ ok: true, result: true });
      if (method === 'getStickerSet') {
        const created = t.http.count('api.telegram.org/botTG/createNewStickerSet') > 0;
        return created ? json({ ok: true, result: { stickers: [1, 2, 3, 4, 5] } }) : json({ ok: false }, 400);
      }
      return json({ ok: false }, 404);
    });
}

async function drain(t: ReturnType<typeof makeApp>) {
  for (let i = 0; i < 10; i++) {
    const r = await t.api('POST', '/v1/tick');
    if (!r.body.processed) return;
  }
}

describe('live pipeline (providers faked at the HTTP layer)', () => {
  it('runs an order from intake to verified delivery with the companion worker contract', async () => {
    const t = makeApp({ PUBLIC_HUB_ENABLED: 'true' });
    wireProviders(t);
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAPH_TOKEN', 'TP');
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'TG');
    await t.setSetting('CALL_CHANNEL_BOT_TOKEN', 'TG');
    await t.setSetting('CALL_CHANNEL_ID', '@fullsendtrenches');
    await t.setSetting('CALLBACK_URL', 'https://buybot.example.com/hooks/content');
    await t.setSetting('CALLBACK_SECRET', 'cb-secret');
    const received: Array<{ body: string; headers: Record<string, string> }> = [];
    t.http.on('buybot.example.com/hooks/content', (_u, init) => {
      received.push({ body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response('ok');
    });

    const order = (await t.api('POST', '/v1/orders', liveInput)).body;
    await drain(t);

    let o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    const status = (k: string) => o.jobs.find((j: any) => j.kind === k).status;
    expect(o.project.name).toBe('Moon Frog');
    expect(o.project.symbol).toBe('MFROG');
    expect(o.copy.headline).toBe(liveCopy.headline);
    expect(status('campaign_image')).toBe('delivered');
    expect(status('telegraph')).toBe('delivered');
    expect(o.jobs.find((j: any) => j.kind === 'telegraph').result.url).toBe('https://telegra.ph/Moon-Frog-01-01');
    expect(status('call_channel')).toBe('delivered');
    expect(o.jobs.find((j: any) => j.kind === 'call_channel').result.url).toBe('https://t.me/fullsendtrenches/7');
    expect(status('binance')).toBe('queued');
    // Stickers wait while primary work (media render) is still queued.
    expect(status('sticker_art_0')).toBe('queued');
    expect(t.http.count('api.telegra.ph/createPage')).toBe(1);

    // All three posts carry the same campaign image.
    const imageAsset = o.assets.find((a: any) => a.kind === 'campaign_image');
    const page = JSON.parse(String(t.http.calls.find((c) => c.url.includes('api.telegra.ph/createPage'))!.init.body));
    expect(page.content[0]).toEqual({
      tag: 'figure',
      children: [{ tag: 'img', attrs: { src: `https://content.example.test/projects/${order.id}/assets/${imageAsset.id}` } }],
    });
    const photo = t.http.calls.find((c) => c.url.includes('/sendPhoto'))!.init.body as FormData;
    expect(photo.get('chat_id')).toBe('@fullsendtrenches');
    expect(photo.get('caption')).toBe(`🔥 TRENDING | Moon Frog ($MFROG)\n\n${liveCopy.social_post}\n\n💬 Telegram: https://t.me/moonfrog`);
    expect((photo.get('photo') as Blob).type).toBe('image/png');
    expect(o.x_handoff).toBeUndefined();

    // Companion worker renders media.
    const media = (await t.api('POST', '/v1/render/claim')).body;
    expect(media.job.kind).toBe('media');
    expect(media.order.assets.some((a: any) => a.kind === 'campaign_image')).toBe(true);
    const img = await t.api('GET', media.order.assets[0].url);
    expect(img.status).toBe(200);
    const incomplete = await t.api('POST', `/v1/render/${media.job.id}/complete`, { lease: media.job.lease, files: [] });
    expect(incomplete.status).toBe(400);
    const files = [
      ...Array.from({ length: 8 }, (_, i) => ({ kind: `meme_${i}`, mime: 'image/png', base64: pngBytes(1080, 1080).toString('base64') })),
      { kind: 'trailer_square', mime: 'video/mp4', base64: mp4Bytes().toString('base64') },
      { kind: 'trailer_vertical', mime: 'video/mp4', base64: mp4Bytes().toString('base64') },
    ];
    expect((await t.api('POST', `/v1/render/${media.job.id}/complete`, { lease: 'wrong', files })).status).toBe(409);
    expect((await t.api('POST', `/v1/render/${media.job.id}/complete`, { lease: media.job.lease, files })).status).toBe(200);

    // Binance via worker: publish claim, then a verified URL.
    const pub = (await t.api('POST', '/v1/publish/claim')).body;
    expect(pub.job.kind).toBe('binance');
    expect(pub.order.copy.headline).toBe(liveCopy.headline);
    expect(pub.order.assets.some((a: any) => a.kind === 'campaign_image')).toBe(true);
    const done = await t.api('POST', `/v1/publish/${pub.job.id}/complete`, { lease: pub.job.lease, url: 'https://www.binance.com/en/square/post/123456' });
    expect(done.body.status).toBe('delivered');

    // Sticker art now runs, then the worker renders the sticker PNGs.
    await drain(t);
    const stickers = (await t.api('POST', '/v1/render/claim')).body;
    expect(stickers.job.kind).toBe('stickers');
    const wrongSize = Array.from({ length: 5 }, (_, i) => ({ kind: `sticker_png_${i}`, mime: 'image/png', base64: pngBytes(600, 600).toString('base64') }));
    expect((await t.api('POST', `/v1/render/${stickers.job.id}/complete`, { lease: stickers.job.lease, files: wrongSize })).status).toBe(400);
    const pngs = Array.from({ length: 5 }, (_, i) => ({ kind: `sticker_png_${i}`, mime: 'image/png', base64: pngBytes(512, 512).toString('base64') }));
    expect((await t.api('POST', `/v1/render/${stickers.job.id}/complete`, { lease: stickers.job.lease, files: pngs })).status).toBe(200);

    await drain(t);
    o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    expect(o.jobs.filter((j: any) => !['delivered', 'skipped'].includes(j.status))).toEqual([]);
    expect(o.status).toBe('delivered');
    expect(o.jobs.find((j: any) => j.kind === 'sticker_publish').result.url).toMatch(/^https:\/\/t\.me\/addstickers\/p.+_by_sticker_bot$/);
    // 5 text + 6 images * 12
    expect(o.reserved_cents).toBe(77);
    expect(t.http.count('api.telegram.org/botTG/uploadStickerFile')).toBe(5);

    // Callbacks: signed, one per event, all delivered.
    await t.api('POST', '/v1/tick');
    const events = (await t.api('GET', `/v1/orders/${order.id}/events`)).body.events;
    expect(events.every((e: any) => e.delivered)).toBe(true);
    expect(received.length).toBe(events.length);
    for (const r of received) {
      const expected = createHmac('sha256', 'cb-secret').update(r.headers['X-Timestamp'] + '.' + r.body).digest('hex');
      expect(r.headers['X-Signature']).toBe(expected);
      expect(JSON.parse(r.body).order_id).toBe(order.id);
    }

    // Public hub lists the delivered assets and publications.
    const hub = await t.call(null, 'GET', `/projects/${order.id}`, undefined, { accept: 'application/json' });
    expect(hub.body.assets.length).toBe(1 + 5 + 10 + 5);
    expect(hub.body.publications.map((p: any) => p.kind).sort()).toEqual(['binance', 'sticker_publish', 'telegraph']);
    const asset = hub.body.assets[0];
    expect((await t.call(null, 'GET', asset.url)).status).toBe(200);
    expect((await t.call(null, 'GET', `/projects/other-order/assets/${asset.id}`)).status).toBe(404);
  });

  it('blocks on missing setup without spending retries, then resumes', async () => {
    const t = makeApp();
    wireProviders(t);
    const order = (await t.api('POST', '/v1/orders', { ...liveInput, channels: [] })).body;
    await drain(t);
    let o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    const copy = o.jobs.find((j: any) => j.kind === 'copy');
    expect(copy.status).toBe('blocked');
    expect(copy.attempts).toBe(0);
    expect(copy.error).toMatch(/Connect Gemini/);
    expect(o.status).toBe('attention');
    expect(o.reserved_cents).toBe(0);

    await t.setSetting('GEMINI_API_KEY', 'G');
    expect((await t.api('POST', `/v1/jobs/${copy.id}/retry`)).status).toBe(200);
    await drain(t);
    o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    expect(o.jobs.find((j: any) => j.kind === 'copy').status).toBe('delivered');
  });

  it('stops generating when the allowance runs out', async () => {
    const t = makeApp();
    wireProviders(t);
    await t.setSetting('GEMINI_API_KEY', 'G');
    const order = (await t.api('POST', '/v1/orders', { ...liveInput, order_id: 'tight', channels: [], budget_cents: 10 })).body;
    await drain(t);
    const o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    expect(o.jobs.find((j: any) => j.kind === 'copy').status).toBe('delivered');
    const img = o.jobs.find((j: any) => j.kind === 'campaign_image');
    expect(img.status).toBe('blocked');
    expect(img.error).toMatch(/allowance/);
    expect(t.http.count('generativelanguage.googleapis.com/')).toBe(1);
  });

  it('holds publications until the campaign image exists, and Telegraph until the image is public', async () => {
    const t = makeApp();
    wireProviders(t);
    t.http.on('generativelanguage.googleapis.com/', (_u, init) =>
      JSON.parse(String(init.body)).generationConfig?.responseModalities
        ? json({ candidates: [] })
        : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
    );
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAPH_TOKEN', 'TP');
    const order = (await t.api('POST', '/v1/orders', { ...liveInput, order_id: 'noimg', channels: ['telegraph', 'binance'] })).body;
    await drain(t);
    let o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    expect(o.jobs.find((j: any) => j.kind === 'campaign_image').status).not.toBe('delivered');
    expect(o.jobs.find((j: any) => j.kind === 'telegraph').status).toBe('queued');
    expect((await t.api('POST', '/v1/publish/claim')).body).toBeNull();
    expect(t.http.count('api.telegra.ph/')).toBe(0);

    const hubOff = makeApp();
    wireProviders(hubOff);
    await hubOff.setSetting('GEMINI_API_KEY', 'G');
    await hubOff.setSetting('TELEGRAPH_TOKEN', 'TP');
    const o2 = (await hubOff.api('POST', '/v1/orders', { ...liveInput, order_id: 'private', channels: ['telegraph'] })).body;
    await drain(hubOff);
    o = (await hubOff.api('GET', `/v1/orders/${o2.id}`)).body;
    const tp = o.jobs.find((j: any) => j.kind === 'telegraph');
    expect(tp.status).toBe('blocked');
    expect(tp.error).toMatch(/PUBLIC_HUB_ENABLED/);
    expect(hubOff.http.count('api.telegra.ph/')).toBe(0);
  });

  it('marks a publication uncertain when verification fails and requires reconciliation', async () => {
    const t = makeApp({ PUBLIC_HUB_ENABLED: 'true' });
    wireProviders(t);
    t.http.on('telegra.ph/Moon-Frog-01-01', () => new Response('not yet', { status: 404 }));
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAPH_TOKEN', 'TP');
    const order = (await t.api('POST', '/v1/orders', { ...liveInput, order_id: 'unsure', channels: ['telegraph'] })).body;
    await drain(t);
    let o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    const job = o.jobs.find((j: any) => j.kind === 'telegraph');
    expect(job.status).toBe('uncertain');
    expect(job.result.url).toBe('https://telegra.ph/Moon-Frog-01-01');
    await drain(t);
    expect(t.http.count('api.telegra.ph/createPage')).toBe(1);

    expect((await t.api('POST', `/v1/jobs/${job.id}/retry`)).status).toBe(409);

    t.http.on('telegra.ph/Moon-Frog-01-01', () => new Response(articleHtml));
    const key = (await t.api('POST', '/v1/keys', { name: 'svc' })).body.key;
    expect((await t.call(key, 'POST', `/v1/jobs/${job.id}/reconcile`, { url: 'https://telegra.ph/Moon-Frog-01-01' })).status).toBe(403);
    const rec = await t.api('POST', `/v1/jobs/${job.id}/reconcile`, { url: 'https://telegra.ph/Moon-Frog-01-01' });
    expect(rec.status).toBe(200);
    o = rec.body;
    expect(o.jobs.find((j: any) => j.kind === 'telegraph').result.manual_reconciliation).toBe(true);
  });

  it('holds a Binance post as uncertain when the worker returns no verifiable URL', async () => {
    const t = makeApp();
    wireProviders(t);
    await t.setSetting('GEMINI_API_KEY', 'G');
    const order = (await t.api('POST', '/v1/orders', { ...liveInput, order_id: 'bn', channels: ['binance'] })).body;
    await drain(t);
    const pub = (await t.api('POST', '/v1/publish/claim')).body;
    const r = await t.api('POST', `/v1/publish/${pub.job.id}/complete`, { lease: pub.job.lease, url: null });
    expect(r.body.status).toBe('uncertain');
    expect((await t.api('POST', '/v1/publish/claim')).body).toBeNull();
    const o = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    expect(o.jobs.find((j: any) => j.kind === 'binance').status).toBe('uncertain');
  });

  it('probes connectors read-only', async () => {
    const t = makeApp();
    wireProviders(t);
    const list = (await t.api('GET', '/v1/connectors')).body.sources;
    expect(list.find((s: any) => s.id === 'gemini').status).toBe('needs_key');
    expect(list.find((s: any) => s.id === 'binance').status).toBe('needs_worker');
    const dex = await t.api('POST', '/v1/connectors/dexscreener/probe', { chain: 'solana', contract_address: SOL });
    expect(dex.body.pairs[1].symbol).toBe('MFROG');
    expect((await t.api('POST', '/v1/connectors/gemini/probe', {})).status).toBe(424);
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'TG');
    expect((await t.api('POST', '/v1/connectors/sticker_pack/probe', {})).body.bot.username).toBe('sticker_bot');
    expect(list.map((s: any) => s.id)).toEqual(['dexscreener', 'gemini', 'intake', 'binance', 'telegraph', 'call_channel', 'sticker_pack', 'reddit', 'coinsniper', 'coinvote']);
    expect(JSON.stringify(list).toLowerCase()).not.toContain('peak');
    expect((await t.api('POST', '/v1/connectors/x/probe', {})).status).toBe(400);
  });
});
