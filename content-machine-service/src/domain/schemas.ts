import { z } from 'zod';

export const CHAINS = ['solana', 'ethereum', 'base', 'bsc', 'polygon', 'arbitrum'] as const;
/** `call_channel` is our own Telegram call channel (e.g. @fullsendtrenches), posted by our bot. */
export const CHANNELS = ['telegraph', 'binance', 'call_channel', 'reddit', 'coinsniper', 'coinvote', 'cmc_community', 'press_1888', 'social_boost', 'bitcointalk', 'meme_pack', 'media', 'top100token', 'gemfinder', 'freshcoins', 'coinscope'] as const;

/**
 * Submitted by the worker, reviewed by the site, delivered once the public page is live: directory listings and
 * press releases.
 */
export const DIRECTORY_HOSTS: Record<string, string[]> = {
  coinsniper: ['coinsniper.net', 'www.coinsniper.net'],
  coinvote: ['coinvote.cc', 'www.coinvote.cc'],
  top100token: ['top100token.com', 'www.top100token.com'],
  gemfinder: ['gemfinder.cc', 'www.gemfinder.cc'],
  freshcoins: ['www.freshcoins.io', 'freshcoins.io'],
  coinscope: ['www.coinscope.co', 'coinscope.co'],
  press_1888: ['www.1888pressrelease.com', '1888pressrelease.com'],
};
/** What the live page's path looks like on each of those sites. */
export const LISTING_PATHS: Record<string, RegExp> = {
  coinsniper: /\/coins?\//i,
  coinvote: /\/coins?\//i,
  top100token: /^\/[a-z]+\/[A-Za-z0-9]{20,}\/?$/,
  gemfinder: /^\/gem\/\d+\/?$/,
  freshcoins: /^\/coins\/[a-z0-9-]+\/?$/,
  coinscope: /^\/coin\/[a-z0-9-]+\/?$/,
  press_1888: /-pr-\d+\.html$/i,
};
/** Press releases: the worker needs the release text, not a coin listing. */
export const PRESS_KINDS = ['press_1888'];
/** Give up waiting for a site's review after this long. */
export const LISTING_REVIEW_MAX_MS = 7 * 24 * 60 * 60_000;

/** Subreddits the Reddit account has joined, as Reddit spells them. REDDIT_TARGETS picks the ones each order gets. */
export const SUBREDDITS = [
  'moonshots',
  'SolanaMemeCoins',
  'MemecoinSeason',
  'Solana_Memes',
  'SolCoins',
  'memecoinmoonshots',
  'pumpfun',
  'Memecoinhub',
  'CryptoMoon',
  'shitcoinmoonshots',
  'memecoins',
  'CryptoMarkets',
  'CryptoMoonShots',
];
/** Pipeline kind (reddit_<lowercase name>) → subreddit. The `reddit` channel turns on the REDDIT_TARGETS entries. */
export const REDDIT_SUBREDDITS: Record<string, string> = Object.fromEntries(SUBREDDITS.map((s) => [`reddit_${s.toLowerCase()}`, s]));
const REDDIT_KINDS = Object.keys(REDDIT_SUBREDDITS);

/** The channel that switches a pipeline kind on (kinds not listed are always on). */
/** The five-meme pack (plan, renders, gallery page) is one switchable channel, so it costs nothing when off. */
export const MEME_KINDS = ['meme_plan', 'meme_0', 'meme_1', 'meme_2', 'meme_3', 'meme_4', 'meme_pack'];
export const channelOf = (kind: string): string | null =>
  REDDIT_SUBREDDITS[kind] ? 'reddit' : MEME_KINDS.includes(kind) ? 'meme_pack' : (CHANNELS as readonly string[]).includes(kind) ? kind : null;

/** One X post (the raid target for social_boost). */
const xPostUrl = z
  .string()
  .url()
  .max(300)
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === 'https:' && /^(www\.|mobile\.)?(x|twitter)\.com$/.test(u.hostname) && /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(u.pathname);
  }, 'Use an X post URL like https://x.com/user/status/123');

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
    telegram_url: httpsUrl.refine((v) => new URL(v).hostname === 't.me', 'Use a t.me link').optional(),
    website_url: httpsUrl.optional(),
    x_url: httpsUrl.optional(),
    /** The X post the social boost raids. */
    x_post_url: xPostUrl.optional(),
    logo_url: httpsUrl.optional(),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#fc6b35'),
    /** Token launch date for directory listings; defaults to the DEX pair's creation date. */
    launch_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    approved_facts: z.array(approvedFactSchema).max(12).default([]),
    telegram_owner_id: z.number().int().positive().optional(),
    channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).default([]),
    /** Which trending purchase of this token this is (1 = first). Set by the trending intake. */
    purchase_number: z.number().int().min(1).max(10_000).default(1),
    budget_cents: z.number().int().min(10).max(500).default(100),
    demo: z.boolean().default(false),
    /**
     * Admin test order: runs only the requested channels plus the content they need (metadata, copy, campaign
     * image), and never calls back. Publications are real.
     */
    test: z.boolean().default(false),
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
  telegram_url: httpsUrl.refine((v) => new URL(v).hostname === 't.me', 'Use a t.me link').optional(),
  name: z.string().min(1).max(80).optional(),
  symbol: z.string().min(1).max(20).optional(),
  description: z.string().max(2500).optional(),
  website_url: httpsUrl.optional(),
  x_url: httpsUrl.optional(),
  /** The X post the social boost raids (the $1 WURK small raid by default). */
  x_post_url: xPostUrl.optional(),
  logo_url: httpsUrl.optional(),
  /** Token launch date for directory listings; defaults to the DEX pair's creation date. */
  launch_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Numeric Telegram user ID that will own the sticker pack; they must have started the sticker bot. */
  telegram_owner_id: z.number().int().positive().optional(),
  /** Extra destinations on top of the call channel. */
  channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).optional(),
  budget_cents: z.number().int().min(10).max(500).optional(),
});
export type TrendingPurchase = z.infer<typeof trendingPurchaseSchema>;

/**
 * Three pieces of content, published with the same campaign image:
 * - article (+ headline): Telegraph, Reddit
 * - social_post: a Telegram-sized post; the Full Send Trenches channel caption
 * - short_post: one X-sized post; the hub summary
 * - spotlight_post / spotlight_alt: Peak's Community Spotlight on CoinMarketCap / Binance Square
 * meme_captions and trailer_lines are renderer inputs, not posts.
 */
export const SHORT_POST_MAX = 280;
/** Leaves room in Telegram's 1024-char photo caption for the TRENDING line and the Telegram link. */
export const SOCIAL_POST_MAX = 800;
export const copySchema = z.object({
  headline: z.string().min(5).max(150),
  article: z.string().min(100).max(6500),
  // Over-long channel posts are trimmed at a paragraph break rather than failing the whole draft.
  social_post: z
    .string()
    .min(40)
    .transform((v) => {
      const t = v.trim();
      if (t.length <= SOCIAL_POST_MAX) return t;
      const cut = t.lastIndexOf('\n\n', SOCIAL_POST_MAX);
      return (cut > 200 ? t.slice(0, cut) : t.slice(0, SOCIAL_POST_MAX)).trim();
    }),
  short_post: z.string().min(10).max(SHORT_POST_MAX),
  meme_captions: z.array(z.string().max(100)).length(8),
  trailer_lines: z.array(z.string().max(70)).min(3).max(5),
  /**
   * Peak's "Community Spotlight" (CoinMarketCap) and its reworded twin (Binance Square). Optional so older/demo copy
   * still validates; those fall back to social_post and the article.
   */
  spotlight_post: z.string().min(80).max(1200).optional(),
  spotlight_alt: z.string().min(80).max(1200).optional(),
  /** Bitcointalk thread (optional so older/demo copy still validates; falls back to headline/article). */
  forum_title: z.string().min(5).max(80).optional(),
  forum_post: z.string().min(100).max(3000).optional(),
});

export type Copy = z.infer<typeof copySchema>;

/** Project record: the intake plus enrichment. */
export type Project = OrderInput & {
  enriched_at: number | null;
  source?: string;
  market?: Record<string, unknown>;
  /** What the project's website, X and Telegram say about it (untrusted page text; see providers/research.ts). */
  research?: import('../providers/research.js').Research;
  /** How x_post_url was chosen when the order didn't supply one. */
  x_post_source?: 'pinned' | 'latest';
};

/** Delivery pipeline, in rank order. Rank >= 100 (stickers) waits until every primary item settles. */
export const STAGES: ReadonlyArray<readonly [string, number]> = [
  // Independent of the content: starts as soon as the order arrives.
  ['social_boost', 5],
  ['metadata', 10],
  ['copy', 20],
  ['hub', 30],
  ['campaign_image', 40],
  ['media', 50],
  ['telegraph', 60],
  ['binance', 65],
  ['call_channel', 75],
  ...REDDIT_KINDS.map((k) => [k, 80] as const),
  ['coinsniper', 85],
  ['coinvote', 86],
  ['top100token', 86],
  ['gemfinder', 86],
  ['freshcoins', 86],
  ['coinscope', 86],
  ['bitcointalk', 84],
  ['cmc_community', 87],
  ['press_1888', 88],
  // Peak Meme Creation Kit: plan all five jokes together and render each; they go out in the sticker pack.
  ['meme_plan', 90],
  ['meme_0', 91],
  ['meme_1', 92],
  ['meme_2', 93],
  ['meme_3', 94],
  ['meme_4', 95],
  ['meme_pack', 96],
  ['sticker_art_0', 100],
  ['sticker_art_1', 101],
  ['sticker_art_2', 102],
  ['sticker_art_3', 103],
  ['sticker_art_4', 104],
  ['stickers', 110],
  ['sticker_publish', 120],
];

/** External publications: a failure mid-flight may still have published, so these never auto-retry. */
export const IRREVERSIBLE = ['telegraph', 'binance', 'call_channel', ...REDDIT_KINDS, 'coinsniper', 'coinvote', 'top100token', 'gemfinder', 'freshcoins', 'coinscope', 'cmc_community', 'press_1888', 'bitcointalk', 'sticker_publish'];
/** Rendered by the companion worker (ffmpeg/sharp), not in-process. */
export const RENDER_KINDS = ['media', 'stickers'];
export const MAX_ATTEMPTS = 3;

/** `submitted`: a directory listing is waiting for the site's review. */
export type JobStatus = 'queued' | 'running' | 'submitted' | 'delivered' | 'skipped' | 'blocked' | 'failed' | 'uncertain';

export const EXPECTED_RENDER_FILES: Record<string, string[]> = {
  media: ['meme_0', 'meme_1', 'meme_2', 'meme_3', 'meme_4', 'meme_5', 'meme_6', 'meme_7', 'trailer_square', 'trailer_vertical'],
  stickers: ['sticker_png_0', 'sticker_png_1', 'sticker_png_2', 'sticker_png_3', 'sticker_png_4'],
};
/** Sent when they exist: the meme pack's rendered memes, as a second set of stickers in the same pack. */
export const OPTIONAL_RENDER_FILES: Record<string, string[]> = {
  stickers: ['sticker_meme_png_0', 'sticker_meme_png_1', 'sticker_meme_png_2', 'sticker_meme_png_3', 'sticker_meme_png_4'],
};

const HOUR = 60 * 60_000;
/**
 * How long each item may take from the order (or an admin retry) before it is failed automatically. Directory and
 * press items include the site's review time.
 */
export const DEADLINE_MS: Record<string, number> = {
  social_boost: 24 * HOUR,
  metadata: 1 * HOUR,
  copy: 2 * HOUR,
  hub: 2 * HOUR,
  campaign_image: 3 * HOUR,
  media: 6 * HOUR,
  telegraph: 6 * HOUR,
  call_channel: 6 * HOUR,
  binance: 12 * HOUR,
  cmc_community: 12 * HOUR,
  bitcointalk: 12 * HOUR,
  ...Object.fromEntries(REDDIT_KINDS.map((k) => [k, 12 * HOUR])),
  coinsniper: 8 * 24 * HOUR,
  coinvote: 8 * 24 * HOUR,
  top100token: 8 * 24 * HOUR,
  gemfinder: 8 * 24 * HOUR,
  freshcoins: 8 * 24 * HOUR,
  coinscope: 8 * 24 * HOUR,
  press_1888: 8 * 24 * HOUR,
  sticker_art_0: 6 * HOUR,
  sticker_art_1: 6 * HOUR,
  sticker_art_2: 6 * HOUR,
  sticker_art_3: 6 * HOUR,
  sticker_art_4: 6 * HOUR,
  stickers: 8 * HOUR,
  sticker_publish: 10 * HOUR,
  meme_plan: 3 * HOUR,
  meme_0: 6 * HOUR,
  meme_1: 6 * HOUR,
  meme_2: 6 * HOUR,
  meme_3: 6 * HOUR,
  meme_4: 6 * HOUR,
  meme_pack: 8 * HOUR,
};
export const deadlineMs = (kind: string) => DEADLINE_MS[kind] ?? 24 * HOUR;

/** What each item needs delivered first. A failed dependency fails its dependents at once. */
export function dependenciesOf(kind: string): string[] {
  if (kind === 'social_boost' || kind === 'metadata') return [];
  if (kind === 'copy') return ['metadata'];
  if (kind === 'hub' || kind === 'campaign_image' || kind.startsWith('sticker_art_')) return ['copy'];
  if (kind === 'stickers') return ['sticker_art_0', 'sticker_art_1', 'sticker_art_2', 'sticker_art_3', 'sticker_art_4'];
  if (kind === 'sticker_publish') return ['stickers'];
  if (kind === 'meme_plan') return ['copy'];
  // The gallery waits for the renders to finish (see ready()); it only needs the plan to exist.
  if (kind.startsWith('meme_')) return ['meme_plan'];
  // media and every publication go out with the campaign image.
  return ['campaign_image'];
}

/** Names used in the order report. Items not listed are internal steps, reported only when they fail. */
export const SOURCE_LABELS: Record<string, string> = {
  social_boost: 'X raid, followers and Telegram members (WURK)',
  hub: 'Project hub',
  telegraph: 'Telegraph article',
  binance: 'Binance Square article',
  call_channel: 'Call channel post',
  ...Object.fromEntries(Object.entries(REDDIT_SUBREDDITS).map(([k, s]) => [k, `Reddit r/${s}`])),
  coinsniper: 'CoinSniper listing',
  coinvote: 'Coinvote listing',
  top100token: 'Top100Token listing',
  gemfinder: 'GemFinder listing',
  freshcoins: 'FreshCoins listing',
  coinscope: 'Coinscope listing',
  cmc_community: 'CoinMarketCap community post',
  bitcointalk: 'Bitcointalk thread',
  press_1888: '1888PressRelease',
  sticker_publish: 'Telegram sticker pack',
};

/** Internal steps, named when they fail in the report. */
export const STEP_LABELS: Record<string, string> = {
  metadata: 'Token metadata',
  copy: 'Content (article and posts)',
  campaign_image: 'Campaign image',
  media: 'Memes and trailers',
  sticker_art_0: 'Sticker artwork',
  sticker_art_1: 'Sticker artwork',
  sticker_art_2: 'Sticker artwork',
  sticker_art_3: 'Sticker artwork',
  sticker_art_4: 'Sticker artwork',
  stickers: 'Sticker rendering',
  meme_plan: 'Meme pack plan',
  meme_0: 'Meme artwork',
  meme_1: 'Meme artwork',
  meme_2: 'Meme artwork',
  meme_3: 'Meme artwork',
  meme_4: 'Meme artwork',
  meme_pack: 'Meme stickers',
};
