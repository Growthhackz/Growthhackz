import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const purchase = {
  purchase_id: 'trend-77',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/moonfrog',
  name: 'Moon Frog',
  symbol: 'MFROG',
  logo_url: 'https://cdn.example.com/logo.png',
  // Extra buybot fields are ignored.
  tier: 'top3',
  paid_sol: 2.5,
};

function wire(t: ReturnType<typeof makeApp>) {
  t.http
    .on('api.dexscreener.com/', () => json([]))
    .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
    .on('generativelanguage.googleapis.com/', (_u, init) =>
      JSON.parse(String(init.body)).generationConfig?.responseModalities
        ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
        : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
    )
    .on('api.telegram.org/botCALL/', (u) => {
      const method = u.pathname.split('/').pop();
      if (method === 'sendPhoto') return json({ ok: true, result: { message_id: 501, chat: { id: -1001, username: 'fullsendtrenches' } } });
      if (method === 'getMe') return json({ ok: true, result: { id: 9, username: 'Fullsendtrenchesbot' } });
      if (method === 'getChatMember') return json({ ok: true, result: { status: 'administrator', can_post_messages: true } });
      return json({ ok: false }, 404);
    });
}

async function drain(t: ReturnType<typeof makeApp>) {
  for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) return;
}

describe('trending purchase → call channel', () => {
  it('posts the X-sized post with the campaign image and the project Telegram link', async () => {
    const t = makeApp();
    wire(t);
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('CALL_CHANNEL_BOT_TOKEN', 'CALL');
    await t.setSetting('CALL_CHANNEL_ID', '@fullsendtrenches');
    const key = (await t.api('POST', '/v1/keys', { name: 'buybot' })).body.key;

    const created = await t.call(key, 'POST', '/v1/trending', purchase);
    expect(created.status).toBe(201);
    expect(created.body.order_id).toBe('trending:trend-77');
    expect(created.body.project.channels).toEqual(['call_channel']);
    // Retries are idempotent.
    const again = await t.call(key, 'POST', '/v1/trending', purchase);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);

    await drain(t);
    const o = (await t.api('GET', `/v1/orders/${created.body.id}`)).body;
    const job = o.jobs.find((j: any) => j.kind === 'call_channel');
    expect(job.status).toBe('delivered');
    expect(job.result.url).toBe('https://t.me/fullsendtrenches/501');

    const call = t.http.calls.find((c) => c.url.endsWith('/botCALL/sendPhoto'))!;
    const form = call.init.body as FormData;
    expect(form.get('chat_id')).toBe('@fullsendtrenches');
    expect(form.get('caption')).toBe(
      `🔥 TRENDING | Moon Frog ($MFROG)\n\n${liveCopy.social_post}\n\n💬 Telegram: https://t.me/moonfrog`,
    );
    expect((form.get('photo') as Blob).type).toBe('image/png');
    // Posted only once, and only after the campaign image existed.
    expect(t.http.calls.filter((c) => c.url.endsWith('/sendPhoto'))).toHaveLength(1);
    const imageCall = t.http.calls.findIndex((c) => JSON.parse(String(c.init.body ?? '{}') || '{}').generationConfig?.responseModalities);
    expect(imageCall).toBeGreaterThan(-1);
    expect(imageCall).toBeLessThan(t.http.calls.indexOf(call));
  });

  it('adds extra channels, uses a custom label, and rejects bad input', async () => {
    const t = makeApp();
    await t.setSetting('CALL_CHANNEL_LABEL', '📣 Sponsored trending');
    const r = await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'x2', channels: ['telegraph'] });
    expect(r.body.project.channels).toEqual(['call_channel', 'telegraph']);
    const withOwner = await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'x3', telegram_owner_id: 42 });
    expect(withOwner.body.project.telegram_owner_id).toBe(42);
    expect((await t.api('POST', '/v1/trending', { ...purchase, telegram_url: 'https://example.com/x' })).status).toBe(400);
    expect((await t.api('POST', '/v1/trending', { ...purchase, purchase_id: undefined })).status).toBe(400);
    expect((await t.api('PUT', '/v1/settings', { key: 'CALL_CHANNEL_ID', value: 'fullsendtrenches' })).status).toBe(400);
  });

  it('blocks without the call bot, and never reposts after an ambiguous failure', async () => {
    const t = makeApp();
    wire(t);
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('CALL_CHANNEL_ID', '@fullsendtrenches');
    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    await drain(t);
    let job = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.kind === 'call_channel');
    expect(job.status).toBe('blocked');
    expect(job.error).toMatch(/CALL_CHANNEL_BOT_TOKEN/);

    await t.setSetting('CALL_CHANNEL_BOT_TOKEN', 'CALL');
    t.http.on('api.telegram.org/botCALL/sendPhoto', () => new Response('gateway', { status: 504 }));
    await t.api('POST', `/v1/jobs/${job.id}/retry`);
    await drain(t);
    job = (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.kind === 'call_channel');
    expect(job.status).toBe('uncertain');
    await drain(t);
    expect(t.http.count('api.telegram.org/botCALL/sendPhoto')).toBe(1);
  });

  it('probes that the bot can post in the channel', async () => {
    const t = makeApp();
    wire(t);
    await t.setSetting('CALL_CHANNEL_BOT_TOKEN', 'CALL');
    await t.setSetting('CALL_CHANNEL_ID', '@fullsendtrenches');
    const r = await t.api('POST', '/v1/connectors/call_channel/probe', {});
    expect(r.body).toMatchObject({ ok: true, bot: 'Fullsendtrenchesbot', can_post_messages: true });
    const list = (await t.api('GET', '/v1/connectors')).body.sources;
    expect(list.find((s: any) => s.id === 'call_channel').status).toBe('configured');
  });
});

describe('sticker pack for trending orders', () => {
  it('uses one bot, a team-owned pack, and tells the buybot where to DM the link', async () => {
    const t = makeApp();
    wire(t);
    const sets = new Set<string>();
    t.http.on('api.telegram.org/botCALL/', async (u, init) => {
      const method = u.pathname.split('/').pop();
      if (method === 'sendPhoto') return json({ ok: true, result: { message_id: 501, chat: { id: -1001, username: 'fullsendtrenches' } } });
      if (method === 'getMe') return json({ ok: true, result: { id: 9, username: 'Fullsendtrenchesbot' } });
      if (method === 'uploadStickerFile') {
        expect((init.body as FormData).get('user_id')).toBe('777');
        return json({ ok: true, result: { file_id: 'f' } });
      }
      if (method === 'createNewStickerSet') {
        const b = JSON.parse(String(init.body));
        expect(b.user_id).toBe(777);
        sets.add(b.name);
        return json({ ok: true, result: true });
      }
      if (method === 'getStickerSet') {
        const { name } = JSON.parse(String(init.body));
        return sets.has(name) ? json({ ok: true, result: { stickers: [1, 2, 3, 4, 5] } }) : json({ ok: false }, 400);
      }
      return json({ ok: false }, 404);
    });
    const received: any[] = [];
    t.http.on('buybot.example.com/hooks', (_u, init) => {
      received.push(JSON.parse(String(init.body)));
      return new Response('ok');
    });
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('CALL_CHANNEL_BOT_TOKEN', 'CALL'); // no TELEGRAM_BOT_TOKEN: one bot does both
    await t.setSetting('CALL_CHANNEL_ID', '@fullsendtrenches');
    await t.setSetting('STICKER_OWNER_ID', '777');
    await t.setSetting('CALLBACK_URL', 'https://buybot.example.com/hooks');
    await t.setSetting('CALLBACK_SECRET', 's');

    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    await drain(t);
    const pngs = Array.from({ length: 5 }, (_, i) => ({ kind: `sticker_png_${i}`, mime: 'image/png', base64: pngBytes(512, 512).toString('base64') }));
    // Media render first (memes/trailers), then stickers.
    for (;;) {
      const c = (await t.api('POST', '/v1/render/claim')).body;
      if (!c) break;
      const files =
        c.job.kind === 'stickers'
          ? pngs
          : [
              ...Array.from({ length: 8 }, (_, i) => ({ kind: `meme_${i}`, mime: 'image/png', base64: pngBytes().toString('base64') })),
              ...['trailer_square', 'trailer_vertical'].map((kind) => ({ kind, mime: 'video/mp4', base64: Buffer.from('\0\0\0\x18ftypisom').toString('base64') })),
            ];
      expect((await t.api('POST', `/v1/render/${c.job.id}/complete`, { lease: c.job.lease, files })).status).toBe(200);
      await drain(t);
    }
    const done = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    expect(done.status).toBe('delivered');
    const ready = received.find((e) => e.type === 'sticker_pack.ready');
    expect(ready.external_order_id).toBe('trending:trend-77');
    expect(ready.data.url).toMatch(/^https:\/\/t\.me\/addstickers\/p.+_by_Fullsendtrenchesbot$/);
    expect(received.every((e) => e.external_order_id === 'trending:trend-77')).toBe(true);
  });
});
