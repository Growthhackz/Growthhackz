import { z } from 'zod';

export const CHAINS = ['solana', 'ethereum', 'base', 'bsc', 'polygon', 'arbitrum'] as const;
export const CHANNELS = ['telegraph', 'binance', 'telegram'] as const;

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((v) => new URL(v).protocol === 'https:', 'Use an HTTPS URL');

export const approvedFactSchema = z.object({
  type: z.enum(['kol_campaign', 'product_release', 'competition', 'marketing_budget', 'other']),
  text: z.string().min(3).max(700),
  source: httpsUrl,
  confirmed: z.literal(true),
});

export const orderInputSchema = z
  .object({
    order_id: z.string().min(1).max(120),
    chain: z.enum(CHAINS),
    contract_address: z.string().min(20).max(64),
    name: z.string().min(1).max(80).optional(),
    symbol: z.string().min(1).max(20).optional(),
    description: z.string().max(2500).default(''),
    telegram_url: httpsUrl.refine((v) => new URL(v).hostname === 't.me', 'Use a t.me link'),
    website_url: httpsUrl.optional(),
    x_url: httpsUrl.optional(),
    logo_url: httpsUrl.optional(),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#fc6b35'),
    approved_facts: z.array(approvedFactSchema).max(12).default([]),
    telegram_owner_id: z.number().int().positive().optional(),
    telegram_chat_id: z.string().regex(/^-?\d+$|^@[a-zA-Z0-9_]{5,}$/).optional(),
    channels: z.array(z.enum(CHANNELS)).max(3).default([]),
    budget_cents: z.number().int().min(10).max(500).default(100),
    demo: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, c) => {
    const valid = v.chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/;
    if (!valid.test(v.contract_address))
      c.addIssue({ code: 'custom', path: ['contract_address'], message: 'Invalid address for selected chain' });
  });

export type OrderInput = z.infer<typeof orderInputSchema>;

export const copySchema = z.object({
  headline: z.string().min(5).max(150),
  article: z.string().min(100).max(6500),
  press_release: z.string().min(100).max(6500),
  telegram: z.string().min(10).max(3000),
  x_posts: z.array(z.string().max(270)).length(3),
  share_caption: z.string().max(500),
  meme_captions: z.array(z.string().max(100)).length(8),
  trailer_lines: z.array(z.string().max(70)).min(3).max(5),
});

export type Copy = z.infer<typeof copySchema>;

/** Project record: the intake plus enrichment. */
export type Project = OrderInput & {
  enriched_at: number | null;
  source?: string;
  market?: Record<string, unknown>;
};

/** Delivery pipeline, in rank order. Rank >= 100 (stickers) waits until every primary item settles. */
export const STAGES: ReadonlyArray<readonly [string, number]> = [
  ['metadata', 10],
  ['copy', 20],
  ['hub', 30],
  ['campaign_image', 40],
  ['media', 50],
  ['telegraph', 60],
  ['binance', 65],
  ['telegram', 70],
  ['sticker_art_0', 100],
  ['sticker_art_1', 101],
  ['sticker_art_2', 102],
  ['sticker_art_3', 103],
  ['sticker_art_4', 104],
  ['stickers', 110],
  ['sticker_publish', 120],
];

/** External publications: a failure mid-flight may still have published, so these never auto-retry. */
export const IRREVERSIBLE = ['telegraph', 'binance', 'telegram', 'sticker_publish'];
/** Rendered by the companion worker (ffmpeg/sharp), not in-process. */
export const RENDER_KINDS = ['media', 'stickers'];
export const MAX_ATTEMPTS = 3;

export type JobStatus = 'queued' | 'running' | 'delivered' | 'skipped' | 'blocked' | 'failed' | 'uncertain';

export const EXPECTED_RENDER_FILES: Record<string, string[]> = {
  media: ['meme_0', 'meme_1', 'meme_2', 'meme_3', 'meme_4', 'meme_5', 'meme_6', 'meme_7', 'trailer_square', 'trailer_vertical'],
  stickers: ['sticker_png_0', 'sticker_png_1', 'sticker_png_2', 'sticker_png_3', 'sticker_png_4'],
};
