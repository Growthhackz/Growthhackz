import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4020),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Admin bearer token: settings, API keys, connectors, reconciliation. Service keys are issued via POST /v1/keys. */
  ADMIN_API_TOKEN: z.string().min(16),
  /** Encrypts provider credentials saved through the API. Keep it stable or saved settings become unreadable. */
  CONFIG_ENCRYPTION_KEY: z.string().min(32),

  DATABASE_PATH: z.string().default('./data/content-machine.db'),
  ASSET_DIR: z.string().default('./data/assets'),

  /** Public origin of this service, used for hub links in announcements and callbacks. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4020'),
  /** Serve project hubs and their assets without authentication at /projects/:id. */
  PUBLIC_HUB_ENABLED: bool.default('false'),

  /** Provider fallbacks; values saved through PUT /v1/settings take precedence. */
  GEMINI_API_KEY: z.string().optional(),
  TEXT_MODEL: z.string().optional(),
  IMAGE_MODEL: z.string().optional(),
  TELEGRAPH_TOKEN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  CALLBACK_URL: z.string().optional(),
  CALLBACK_SECRET: z.string().optional(),
  /** Event types sent to CALLBACK_URL; the rest stay in the order's event log only. */
  CALLBACK_EVENT_TYPES: z.string().default('order.accepted,link.published,sticker_pack.ready,order.completed'),
  /** Our own call channel (separate bot from TELEGRAM_BOT_TOKEN). */
  CALL_CHANNEL_BOT_TOKEN: z.string().optional(),
  CALL_CHANNEL_ID: z.string().optional(),
  /** Team member's numeric Telegram ID that owns every sticker pack (must have started the bot). */
  STICKER_OWNER_ID: z.string().optional(),
  /** Who gets the DM for posts that need a person (ASSIST_KINDS); defaults to STICKER_OWNER_ID. Must have started the bot. */
  ASSIST_CHAT_ID: z.string().optional(),

  /** social-activity-service (private network URL) for the social_boost item. */
  SOCIAL_ACTIVITY_URL: z.string().url().optional(),
  SOCIAL_ACTIVITY_TOKEN: z.string().optional(),
  /**
   * WURK preset for trending orders: `trending` is the $1 small raid plus 50 X followers and 50 Telegram members
   * ($4.00); `small_raid` is the raid alone; `full` is the saved four-purchase package.
   */
  SOCIAL_BOOST_PRESET: z.enum(['trending', 'small_raid', 'full']).default('trending'),
  /** Logged-out x.com web client credentials, used to find the post to raid when the order has none. */
  X_WEB_BEARER: z
    .string()
    .default('AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'),
  X_GQL_USER_BY_SCREEN_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('xmU6X_CKVnQ5lSrCbAmJsg'),
  X_GQL_USER_TWEETS: z.string().regex(/^[A-Za-z0-9_-]+$/).default('E3opETHurmVJflFsUBVuUQ'),
  /**
   * Channels every trending order gets on top of what the buybot sends. Listing sites: the four the worker submits
   * automatically. Off: Reddit (on hold), CoinSniper and Coinvote (their submissions don't go through).
   */
  TRENDING_CHANNELS: z
    .string()
    .default('telegraph,binance,call_channel,top100token,gemfinder,freshcoins,coinscope,cmc_community,social_boost,bitcointalk,meme_pack'),

  /**
   * Posts handed to a person instead of the worker: the order's operator gets one Telegram DM with a page where each
   * post opens pre-filled on the site, and they pass its human check and submit. Comma list of item kinds.
   */
  ASSIST_KINDS: z.string().default(''),
  /** Channels switched off for every order, even when the buybot asks for them. The call channel is paused. */
  PAUSED_CHANNELS: z.string().default('call_channel'),
  /** Source health checks every 30 min (logins, keys, bots, WURK wallet); changes are DMed to ASSIST_CHAT_ID. */
  HEALTH_CHECKS_ENABLED: bool.default('true'),
  /** Failed content steps get one automatic retry; uncertain posts are checked on the account and re-posted if absent. */
  SELF_HEAL_ENABLED: bool.default('true'),
  /** One-time extra generation allowance (cents) for an order whose retries used up its budget. */
  HEAL_BUDGET_CENTS: z.coerce.number().int().min(0).max(1000).default(150),
  /** Alert when the WURK wallet holds less than this (USDC). */
  WURK_LOW_BALANCE_USDC: z.coerce.number().min(0).default(20),
  /**
   * A second, third… trending purchase for the same token gets only these (new posts and a new social boost), plus
   * five new stickers and five new memes added to its existing sticker pack.
   */
  REPEAT_CHANNELS: z.string().default('cmc_community,binance,social_boost,meme_pack'),
  /** Subreddits each order posts to when it has the `reddit` channel (names from SUBREDDITS, or `all`). */
  REDDIT_TARGETS: z.string().default('moonshots,SolanaMemeCoins'),

  WORKERS_ENABLED: bool.default('true'),
  /** How often the background loop advances queued jobs and sends callbacks. */
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** Upper bound on jobs processed per tick so one tick can't run unbounded. */
  JOBS_PER_TICK: z.coerce.number().int().positive().default(10),
  /** Ready in-process jobs run at once per order (independent ones, e.g. the five memes and five sticker images). */
  PARALLEL_JOBS_PER_ORDER: z.coerce.number().int().min(1).max(10).default(4),
  /** Renderer is reported offline when it hasn't claimed work for this long. */
  RENDERER_STALE_MS: z.coerce.number().int().positive().default(120_000),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
