import { describe, expect, it } from 'vitest';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const purchase = {
  purchase_id: 'rep-1',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/moonfrog',
  name: 'Moon Frog',
  symbol: 'MFROG',
  logo_url: 'https://cdn.example.com/logo.png',
};

const meme = (id: string, i: number, round: number) => ({
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
  selected_caption: { top: `round ${round} joke ${i}` },
  uses_claims: [],
});

function setup() {
  const t = makeApp({ TRENDING_CHANNELS: 'meme_pack' });
  const prompts = { copy: [] as string[], plan: [] as string[], images: [] as string[] };
  const sets = new Map<string, number>();
  const calls: Array<{ method: string; name?: string; stickers?: number }> = [];
  let copies = 0;
  t.http
    .on('api.dexscreener.com/', () => json([]))
    .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
    .on('generativelanguage.googleapis.com/', (_u, init) => {
      const body = JSON.parse(String(init.body));
      const parts = body.contents[0].parts;
      if (body.generationConfig?.responseModalities) {
        prompts.images.push(parts.at(-1).text);
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes().toString('base64') } }] } }] });
      }
      const text: string = parts[0].text;
      if (text.includes('SELECTED_TEMPLATES')) {
        prompts.plan.push(text);
        const ids = JSON.parse(text.split('SELECTED_TEMPLATES: ')[1]!.split('\n')[0]!).map((x: any) => x.template_id);
        const memes = ids.map((id: string, i: number) => meme(id, i, prompts.plan.length));
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ memes, self_review: {}, approved_for_render: true }) }] } }] });
      }
      prompts.copy.push(text);
      copies++;
      const copy = {
        ...liveCopy,
        spotlight_post: `Spotlight body number ${copies} about the Moon Frog community, its pond lore and the frog who wants the moon.`,
        spotlight_alt: `Reworded spotlight number ${copies} about Moon Frog, its pond and everything its community is building.`,
      };
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(copy) }] } }] });
    })
    .on('api.telegram.org/botSTK/', async (u, init) => {
      const method = u.pathname.split('/').pop()!;
      if (method === 'getMe') return json({ ok: true, result: { id: 9, username: 'peakstickersbot' } });
      if (method === 'uploadStickerFile') return json({ ok: true, result: { file_id: 'f' } });
      const b = JSON.parse(String(init.body));
      calls.push({ method, name: b.name, stickers: b.stickers?.length });
      if (method === 'createNewStickerSet') {
        sets.set(b.name, b.stickers.length);
        return json({ ok: true, result: true });
      }
      if (method === 'addStickerToSet') {
        sets.set(b.name, sets.get(b.name)! + 1);
        return json({ ok: true, result: true });
      }
      if (method === 'getStickerSet')
        return sets.has(b.name) ? json({ ok: true, result: { stickers: Array.from({ length: sets.get(b.name)! }, (_, i) => i) } }) : json({ ok: false }, 400);
      return json({ ok: false }, 404);
    });
  return { t, prompts, sets, calls };
}

async function drain(t: ReturnType<typeof makeApp>) {
  for (let i = 0; i < 40; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) return;
}

/** The worker's sticker render: five mascot stickers plus the memes as a second set. */
async function renderStickers(t: ReturnType<typeof makeApp>) {
  const png = pngBytes(512, 512).toString('base64');
  const c = (await t.api('POST', '/v1/render/claim')).body;
  expect(c.job.kind).toBe('stickers');
  const files = [
    ...Array.from({ length: 5 }, (_, i) => ({ kind: `sticker_png_${i}`, mime: 'image/png', base64: png })),
    ...Array.from({ length: 5 }, (_, i) => ({ kind: `sticker_meme_png_${i}`, mime: 'image/png', base64: png })),
  ];
  expect((await t.api('POST', `/v1/render/${c.job.id}/complete`, { lease: c.job.lease, files })).status).toBe(200);
  await drain(t);
}

describe('repeat purchases of the same token', () => {
  it('get new posts, the social boost and ten new stickers in the existing pack, with nothing repeated', async () => {
    const { t, prompts, sets, calls } = setup();
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAM_BOT_TOKEN', 'STK');
    await t.setSetting('STICKER_OWNER_ID', '777');

    const first = (await t.api('POST', '/v1/trending', purchase)).body;
    expect(first.project.purchase_number).toBe(1);
    await drain(t);
    await renderStickers(t);
    const one = (await t.api('GET', `/v1/orders/${first.id}`)).body;
    expect(one.jobs.find((j: any) => j.kind === 'sticker_publish').result).toMatchObject({ name: 'MFROG_by_peakstickersbot', count: 10 });
    const firstTemplates: string[] = one.jobs.find((j: any) => j.kind === 'meme_plan').result.templates;

    // Same token, new purchase: only the repeat package.
    const second = (await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'rep-2', channels: ['telegraph'] })).body;
    expect(second.project.purchase_number).toBe(2);
    expect(second.project.channels).toEqual(['binance', 'cmc_community', 'meme_pack', 'social_boost']);
    for (const k of ['telegraph', 'call_channel', 'bitcointalk', 'top100token', 'coinscope']) expect(second.jobs.find((j: any) => j.kind === k).status).toBe('skipped');
    await drain(t);

    // The copy is about the team that keeps marketing, and is told the earlier posts so it repeats none of them.
    const copyPrompt = prompts.copy[1]!;
    expect(copyPrompt).toContain('trending purchase #2');
    expect(copyPrompt).toContain('keeps paying for exposure');
    expect(copyPrompt).toContain('Spotlight body number 1');
    expect(copyPrompt).toContain('chose Peak to manage its community and grow with the Peak ecosystem');
    // New meme templates and no reused captions.
    const secondTemplates: string[] = JSON.parse(prompts.plan[1]!.split('SELECTED_TEMPLATES: ')[1]!.split('\n')[0]!).map((x: any) => x.template_id);
    expect(secondTemplates.filter((id) => firstTemplates.includes(id))).toEqual([]);
    expect(prompts.plan[1]).toContain('PREVIOUS_CAPTIONS');
    expect(prompts.plan[1]).toContain('round 1 joke 0');
    // New sticker captions (the first purchase used SEND IT … LETS GO).
    const stickerPrompts = prompts.images.filter((p) => p.includes('Telegram sticker'));
    expect(stickerPrompts.slice(0, 5).some((p) => p.includes('SEND IT'))).toBe(true);
    expect(stickerPrompts.slice(5).some((p) => p.includes('Bold highly legible text: GM.'))).toBe(true);
    expect(stickerPrompts.slice(5).some((p) => p.includes('SEND IT'))).toBe(false);

    await renderStickers(t);
    const two = (await t.api('GET', `/v1/orders/${second.id}`)).body;
    // Added to the token's pack: same link, ten more stickers, no second pack.
    expect(two.jobs.find((j: any) => j.kind === 'sticker_publish').result).toMatchObject({
      url: 'https://t.me/addstickers/MFROG_by_peakstickersbot',
      count: 20,
      added: 10,
    });
    expect(calls.filter((c) => c.method === 'createNewStickerSet')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'addStickerToSet' && c.name === 'MFROG_by_peakstickersbot')).toHaveLength(10);
    expect(sets.get('MFROG_by_peakstickersbot')).toBe(20);

    // New CMC and Binance posts under a returning-project title.
    const cmc = (await t.api('POST', '/v1/publish/claim', { kinds: ['cmc_community'] })).body;
    expect(cmc.order.id).toBe(second.id);
    expect(cmc.target.text).toBe('Back in the Spotlight: Moon Frog ($MFROG)\n\nSpotlight body number 2 about the Moon Frog community, its pond lore and the frog who wants the moon.\n\nTelegram: https://t.me/moonfrog');
    const binance = (await t.api('POST', '/v1/publish/claim', { kinds: ['binance'] })).body;
    expect(binance.target.title).toBe('Back in the Spotlight: Moon Frog ($MFROG)');

    // A third purchase gets its own title and keeps adding to the same pack.
    const third = (await t.api('POST', '/v1/trending', { ...purchase, purchase_id: 'rep-3' })).body;
    expect(third.project.purchase_number).toBe(3);
  });
});
