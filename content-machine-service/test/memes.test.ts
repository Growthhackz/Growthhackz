import { describe, expect, it } from 'vitest';
import { memeKit, selectTemplates, storyboardProblems } from '../src/providers/memes.js';
import { json, liveCopy, makeApp, pngBytes, SOL } from './helpers.js';

const purchase = {
  purchase_id: 'memes-1',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/moonfrog',
  name: 'Moon Frog',
  symbol: 'MFROG',
  x_url: 'https://x.com/moonfrog',
  logo_url: 'https://cdn.example.com/logo.png',
};

const meme = (id: string, i: number, caption = `joke ${i} about the frog`) => ({
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
  selected_caption: { top: caption },
  uses_claims: [],
});

describe('meme kit', () => {
  it('draws five distinct templates from the 25-template bank and checks storyboards', () => {
    expect(memeKit().templates).toHaveLength(25);
    const five = selectTemplates();
    expect(new Set(five.map((t) => t.id)).size).toBe(5);
    // Retired templates (the image model never renders them) are never drawn, even when they are all that's left.
    const others = memeKit().templates.map((t) => t.id).filter((id) => id !== 'grus_plan');
    expect(selectTemplates(5, others.slice(0, 21)).map((t) => t.id)).not.toContain('grus_plan');
    expect(selectTemplates(5, others.slice(0, 21))).toHaveLength(3);
    const memes = five.map((t, i) => meme(t.id, i)) as any;
    expect(storyboardProblems(memes, five)).toEqual([]);
    expect(storyboardProblems([...memes.slice(0, 4), meme(five[0]!.id, 9)] as any, five)).toContain('template ids repeat');
    expect(storyboardProblems(memes.map((m: any) => ({ ...m, selected_caption: { top: 'same' } })), five)).toContain('duplicate captions');
  });
});

describe('meme pack', () => {
  it('plans, reviews a duplicate, renders five memes from template + logo, and hands them to the sticker pack (no Telegraph gallery)', async () => {
    const t = makeApp({ TRENDING_CHANNELS: 'meme_pack', PUBLIC_BASE_URL: 'https://content.example.test' });
    const renders: any[] = [];
    let planCalls = 0;
    t.http
      .on('cdn.example.com/logo.png', () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }))
      .on('api.dexscreener.com/', () => json([{ chainId: 'solana', baseToken: { address: SOL, name: 'Moon Frog', symbol: 'MFROG' }, liquidity: { usd: 1 } }]))
      .on('generativelanguage.googleapis.com/', (_u, init) => {
        const body = JSON.parse(String(init.body));
        if (body.generationConfig?.responseModalities) {
          renders.push(body.contents[0].parts);
          return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes(1024, 1024).toString('base64') } }] } }] });
        }
        const prompt: string = body.contents[0].parts[0].text;
        if (!prompt.includes('SELECTED_TEMPLATES')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] });
        planCalls++;
        const ids = JSON.parse(prompt.split('SELECTED_TEMPLATES: ')[1]!.split('\n')[0]!).map((x: any) => x.template_id);
        // First plan repeats a caption; the targeted review returns a fixed storyboard.
        const memes = ids.map((id: string, i: number) => meme(id, i, planCalls === 1 && i === 4 ? 'joke 0 about the frog' : undefined));
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ memes, self_review: {}, approved_for_render: true }) }] } }] });
      })
      .on('telegra.ph', () => {
        throw new Error('The meme pack must not publish a Telegraph page');
      });
    await t.setSetting('GEMINI_API_KEY', 'G');
    await t.setSetting('TELEGRAPH_TOKEN', 'TP');
    const o = (await t.api('POST', '/v1/trending', purchase)).body;
    for (let i = 0; i < 40; i++) if (!(await t.api('POST', '/v1/tick')).body.processed) break;
    const done = (await t.api('GET', `/v1/orders/${o.id}`)).body;
    const job = (k: string) => done.jobs.find((j: any) => j.kind === k);

    expect(planCalls).toBe(2); // plan + one targeted review
    const plan = job('meme_plan').result;
    expect(new Set(plan.templates).size).toBe(5);
    expect(new Set(plan.memes.map((m: any) => m.selected_caption.top)).size).toBe(5);
    for (const k of ['meme_0', 'meme_1', 'meme_2', 'meme_3', 'meme_4']) expect(job(k).status).toBe('delivered');
    // Each render gets only its own template reference, the logo and the prompt with the exact caption.
    const memeRenders = renders.filter((p) => p.length === 3); // campaign image and stickers send logo + prompt only
    expect(memeRenders).toHaveLength(5);
    expect(memeRenders.every((p) => p[0].inlineData && p[1].inlineData && p[2].text.includes('joke ') && !/composited/.test(p[2].text))).toBe(true);
    expect(job('meme_pack')).toMatchObject({ status: 'delivered', result: { count: 5, delivered_in: 'sticker_pack' } });
    // Not a link of its own: the memes reach the buyer inside the sticker pack.
    const links = (await t.api('GET', `/v1/orders/${o.id}/events`)).body.events.filter((e: any) => e.type === 'link.published');
    expect(links.map((e: any) => e.data.source)).not.toContain('meme_pack');
  });
});
