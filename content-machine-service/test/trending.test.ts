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
  // Extra Peak fields are ignored.
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

describe('Peak trending purchase → call channel', () => {
  it('posts the X-sized post with the campaign image and the Peak Telegram link', async () => {
    const t = makeApp();
    wire(t);
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('CALL_CHANNEL_BOT_TOKEN', 'CALL');
    await t.setSetting('CALL_CHANNEL_ID', '@fullsendtrenches');
    const key = (await t.api('POST', '/v1/keys', { name: 'peak' })).body.key;

    const created = await t.call(key, 'POST', '/v1/peak/trending', purchase);
    expect(created.status).toBe(201);
    expect(created.body.order_id).toBe('trending:trend-77');
    expect(created.body.project.channels).toEqual(['call_channel']);
    // Peak retries are idempotent.
    const again = await t.call(key, 'POST', '/v1/peak/trending', purchase);
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
      `🔥 TRENDING on Peak Buybot | Moon Frog ($MFROG)\n\n${liveCopy.x_post}\n\n💬 Telegram: https://t.me/moonfrog`,
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
    const r = await t.api('POST', '/v1/peak/trending', { ...purchase, purchase_id: 'x2', channels: ['telegraph'] });
    expect(r.body.project.channels).toEqual(['call_channel', 'telegraph']);
    expect((await t.api('POST', '/v1/peak/trending', { ...purchase, telegram_url: 'https://example.com/x' })).status).toBe(400);
    expect((await t.api('POST', '/v1/peak/trending', { ...purchase, purchase_id: undefined })).status).toBe(400);
    expect((await t.api('PUT', '/v1/settings', { key: 'CALL_CHANNEL_ID', value: 'fullsendtrenches' })).status).toBe(400);
  });

  it('blocks without the call bot, and never reposts after an ambiguous failure', async () => {
    const t = makeApp();
    wire(t);
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('CALL_CHANNEL_ID', '@fullsendtrenches');
    const o = (await t.api('POST', '/v1/peak/trending', purchase)).body;
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
