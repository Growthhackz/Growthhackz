import { z } from 'zod';

export const CHAINS = ['solana', 'ethereum', 'base', 'bsc', 'polygon', 'arbitrum'] as const;
/** `call_channel` is our own Telegram call channel (e.g. @fullsendtrenches), posted by our bot. */
export const CHANNELS = ['telegraph', 'binance', 'call_channel', 'reddit'] as const;

/** Pipeline kind → subreddit. The `reddit` channel turns on every entry. */
export const REDDIT_SUBREDDITS: Record<string, string> = {
  reddit_moonshots: 'moonshots',
  reddit_solanamemecoins: 'solanamemecoins',
};

/** The channel that switches a pipeline kind on (kinds not listed are always on). */
export const channelOf = (kind: string): string | null =>
  REDDIT_SUBREDDITS[kind] ? 'reddit' : (CHANNELS as readonly string[]).includes(kind) ? kind : null;

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
    channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).default([]),
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

/**
 * The buybot's trending-purchase webhook. Unknown fields are ignored so the buybot can send its full
 * purchase record; only the fields below reach the order. purchase_id makes retries idempotent.
 */
export const trendingPurchaseSchema = z.object({
  purchase_id: z.string().min(1).max(100),
  chain: z.enum(CHAINS),
  contract_address: z.string().min(20).max(64),
  telegram_url: httpsUrl.refine((v) => new URL(v).hostname === 't.me', 'Use a t.me link'),
  name: z.string().min(1).max(80).optional(),
  symbol: z.string().min(1).max(20).optional(),
  description: z.string().max(2500).optional(),
  website_url: httpsUrl.optional(),
  x_url: httpsUrl.optional(),
  logo_url: httpsUrl.optional(),
  /** Numeric Telegram user ID that will own the sticker pack; they must have started the sticker bot. */
  telegram_owner_id: z.number().int().positive().optional(),
  /** Extra destinations on top of the call channel. */
  channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).optional(),
  budget_cents: z.number().int().min(10).max(500).optional(),
});
export type TrendingPurchase = z.infer<typeof trendingPurchaseSchema>;

/**
 * Three pieces of content, published with the same campaign image:
 * - article (+ headline): Binance Square, Telegraph, Reddit
 * - social_post: a Telegram-sized post; the Full Send Trenches channel caption
 * - short_post: one X-sized post; the hub summary
 * meme_captions and trailer_lines are renderer inputs, not posts.
 */
export const SHORT_POST_MAX = 280;
/** Leaves room in Telegram's 1024-char photo caption for the TRENDING line and the Telegram link. */
export const SOCIAL_POST_MAX = 800;
export const copySchema = z.object({
  headline: z.string().min(5).max(150),
  article: z.string().min(100).max(6500),
  social_post: z.string().min(40).max(SOCIAL_POST_MAX),
  short_post: z.string().min(10).max(SHORT_POST_MAX),
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
  ['call_channel', 75],
  ['reddit_moonshots', 80],
  ['reddit_solanamemecoins', 81],
  ['sticker_art_0', 100],
  ['sticker_art_1', 101],
  ['sticker_art_2', 102],
  ['sticker_art_3', 103],
  ['sticker_art_4', 104],
  ['stickers', 110],
  ['sticker_publish', 120],
];

/** External publications: a failure mid-flight may still have published, so these never auto-retry. */
export const IRREVERSIBLE = ['telegraph', 'binance', 'call_channel', 'reddit_moonshots', 'reddit_solanamemecoins', 'sticker_publish'];
/** Rendered by the companion worker (ffmpeg/sharp), not in-process. */
export const RENDER_KINDS = ['media', 'stickers'];
export const MAX_ATTEMPTS = 3;

export type JobStatus = 'queued' | 'running' | 'delivered' | 'skipped' | 'blocked' | 'failed' | 'uncertain';

export const EXPECTED_RENDER_FILES: Record<string, string[]> = {
  media: ['meme_0', 'meme_1', 'meme_2', 'meme_3', 'meme_4', 'meme_5', 'meme_6', 'meme_7', 'trailer_square', 'trailer_vertical'],
  stickers: ['sticker_png_0', 'sticker_png_1', 'sticker_png_2', 'sticker_png_3', 'sticker_png_4'],
};
