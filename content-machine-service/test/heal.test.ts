import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const purchase = {
  purchase_id: 'heal-1',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/moonfrog',
  name: 'Moon Frog',
  symbol: 'MFROG',
  logo_url: 'https://cdn.example.com/logo.png',
};

const meme = (id: string, i: number) => ({
  template_id: id,
  emotion: `emotion ${i}`,
  project_hook: 'the frog',
  joke_subject: `subject ${i}`,
  setup: 'setup',
  punchline: 'punchline',
  scene: 'scene',
  logo_placement: 'on a mug',
  distinct_from_others: 'different',
  caption_candidates: [{ top: 'a' }, { top: 'b' }, { top: 'c' }],
  selected_caption: { top: `joke ${i} about the frog` },
  uses_claims: [],
});

describe('self-healing', () => {
  it('retries a failed content step (and what failed because of it) once, and reports caught → fixed', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'meme_pack' });
    const sent: string[] = [];
    let memeImagesWork = false;
    t.http
      .on('api.dexscreener.com/', () => json([]))
      .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
      .on('generativelanguage.googleapis.com/', (_u, init) => {
        const body = JSON.parse(String(init.body));
        const parts = body.contents[0].parts;
        if (body.generationConfig?.responseModalities) {
          // Meme renders send template + logo + prompt; they come back empty until the "outage" ends.
          if (parts.length === 3 && !memeImagesWork) return json({ candidates: [{ content: { parts: [{ text: 'no image today' }] } }] });
          return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] });
        }
        const text: string = parts[0].text;
        if (text.includes('SELECTED_TEMPLATES')) {
          const ids = JSON.parse(text.split('SELECTED_TEMPLATES: ')[1]!.split('\n')[0]!).map((x: any) => x.template_id);
          return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ memes: ids.map(meme), self_review: {}, approved_for_render: true }) }] } }] });
        }
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] });
      })
      .on('api.telegram.org/botSTK/sendMessage', (_u, init) => {
        sent.push(JSON.parse(String(init.body)).text);
        return json({ ok: true, result: {} });
      });
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'STK');
    await t.setSetting('STICKER_OWNER_ID', '777');
    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    const job = async (k: string) => (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.kind === k);
    const drain = async () => {
      for (let i = 0; i < 60; i++) {
        t.clock.advance(61_000); // past retry backoffs
        await t.api('POST', '/v1/tick');
      }
    };

    // Run until the failing memes have used their three attempts and are caught.
    for (let i = 0; i < 60 && !sent.join('\n').includes('🟡 Caught'); i++) {
      t.clock.advance(61_000);
      await t.api('POST', '/v1/tick');
    }
    // The memes failed their three attempts, were caught and put back: the order is still open.
    expect(sent.join('\n')).toContain('🟡 Caught: $MFROG');
    expect(sent.join('\n')).toContain('Retrying it automatically.');
    expect((await t.api('GET', `/v1/orders/${o.id}/events`)).body.events.some((e: any) => e.type === 'order.completed')).toBe(false);

    // The image outage ends: the second run goes through and the admins hear it was fixed.
    memeImagesWork = true;
    await drain();
    for (const k of ['meme_0', 'meme_1', 'meme_2', 'meme_3', 'meme_4', 'meme_pack']) expect((await job(k)).status).toBe('delivered');
    expect(sent.join('\n')).toContain('✅ Fixed: $MFROG');
    expect(sent.join('\n')).not.toContain('🔴');
  });

  it('asks a person when the automatic retry fails too, once', async () => {
    const t = makeApp({ TRENDING_CHANNELS: '' });
    const sent: string[] = [];
    t.http
      .on('api.dexscreener.com/', () => json([]))
      .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
      .on('generativelanguage.googleapis.com/', (_u, init) =>
        JSON.parse(String(init.body)).generationConfig?.responseModalities
          ? json({ candidates: [{ content: { parts: [{ text: 'never an image' }] } }] })
          : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
      )
      .on('api.telegram.org/botSTK/sendMessage', (_u, init) => {
        sent.push(JSON.parse(String(init.body)).text);
        return json({ ok: true, result: {} });
      });
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'STK');
    await t.setSetting('STICKER_OWNER_ID', '777');
    await t.api('POST', '/v1/trending', purchase);
    for (let i = 0; i < 80; i++) {
      t.clock.advance(61_000);
      await t.api('POST', '/v1/tick');
    }
    const all = sent.join('\n');
    expect(all).toContain('🟡 Caught: $MFROG');
    expect(all).toContain('🔴 Need you: $MFROG');
    expect(all.split('🔴 Need you: $MFROG (trending:heal-1): Campaign image').length - 1).toBe(1);
  });
});

describe('self-healing: uncertain publications', () => {
  it('re-posts an uncertain post that is not on our account, records one that is, and asks a person if the account never loads', async () => {
    const t = makeApp();
    const sent: string[] = [];
    t.http
      .on('api.dexscreener.com/', () => json([]))
      .on('generativelanguage.googleapis.com/', (_u, init) =>
        JSON.parse(String(init.body)).generationConfig?.responseModalities
          ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] })
          : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
      )
      .on('coinmarketcap.com/community/post/555', () => new Response(`<html><body>${'x'.repeat(200)}<p>${liveCopy.social_post}</p></body></html>`, { headers: { 'content-type': 'text/html' } }))
      .on('api.telegram.org/botSTK/sendMessage', (_u, init) => {
        sent.push(JSON.parse(String(init.body)).text);
        return json({ ok: true, result: {} });
      });
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'STK');
    await t.setSetting('STICKER_OWNER_ID', '777');
    const o = (await t.api('POST', '/v1/orders', { order_id: 'ver-1', chain: 'solana', contract_address: SOL, name: 'Moon Frog', symbol: 'MFROG', telegram_url: 'https://t.me/moonfrog', channels: ['cmc_community'] })).body;
    for (let i = 0; i < 10; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
    const cmcJob = async () => (await t.api('GET', `/v1/orders/${o.id}`)).body.jobs.find((j: any) => j.kind === 'cmc_community');

    // The worker clicked Post but could not confirm it: uncertain.
    let c = (await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body;
    await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, url: null, note: 'no post id' });
    expect((await cmcJob()).status).toBe('uncertain');
    // Not looked for until the site has had time to show it.
    expect((await t.api('POST', '/v1/verify/claim')).body).toBeNull();
    t.clock.advance(11 * 60_000);
    const v = (await t.api('POST', '/v1/verify/claim')).body;
    expect(v.job.id).toBe(c.job.id);
    expect(v.target.text).toContain(liveCopy.social_post.slice(0, 20));
    // Our post list loaded and it isn't there: nothing went out, so it is posted again.
    expect((await t.api('POST', `/v1/verify/${c.job.id}/result`, { absent: true })).body.status).toBe('queued');
    expect(sent.at(-1)).toContain('is not on our account. Posting it again automatically.');

    // Second attempt is uncertain too, but this time the post is on the account: its link is recorded.
    t.clock.advance(61_000);
    c = (await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body;
    await t.api('POST', `/v1/publish/${c.job.id}/complete`, { lease: c.job.lease, url: null });
    t.clock.advance(21 * 60_000);
    expect((await t.api('POST', '/v1/verify/claim')).body.job.id).toBe(c.job.id);
    expect((await t.api('POST', `/v1/verify/${c.job.id}/result`, { url: 'https://coinmarketcap.com/community/post/555/' })).body.status).toBe('delivered');
    expect(await cmcJob()).toMatchObject({ status: 'delivered', result: { url: 'https://coinmarketcap.com/community/post/555/' } });
    expect(sent.at(-1)).toContain('✅ Fixed: $MFROG (ver-1): CoinMarketCap community post was unconfirmed; found it on our account');
  });
});
