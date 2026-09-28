import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4010),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Bearer token callers must send. Leave unset only for local development. */
  SERVICE_API_TOKEN: z.string().min(16).optional(),

  DATABASE_PATH: z.string().default('./data/social-activity.db'),

  /** Which provider adapter to use: "followiz" for real orders, "mock" for local testing. */
  PROVIDER: z.enum(['followiz', 'mock']).default('mock'),
  FOLLOWIZ_API_URL: z.string().url().default('https://followiz.com/api/v2'),
  FOLLOWIZ_API_KEY: z.string().optional(),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** Minimum spacing between provider API calls. */
  PROVIDER_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(250),

  WORKERS_ENABLED: bool.default('true'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** How long to wait before re-polling an active order; doubles while nothing changes. */
  POLL_MIN_BACKOFF_MS: z.coerce.number().int().positive().default(2 * 60_000),
  POLL_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(30 * 60_000),
  CATALOG_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  REFILL_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60_000),
  /** Days between automatic refill requests for orders with auto-refill on. */
  AUTO_REFILL_EVERY_DAYS: z.coerce.number().positive().default(7),
  /** Fallback refill guarantee when the service name doesn't state one. 0 = no refill. */
  DEFAULT_REFILL_DAYS: z.coerce.number().int().nonnegative().default(0),
  /** Orders sitting in pending longer than this are flagged as stuck. */
  STUCK_PENDING_HOURS: z.coerce.number().positive().default(12),
  /** Refuse to submit if provider balance would fall below this (USD). */
  MIN_BALANCE_BUFFER_USD: z.coerce.number().nonnegative().default(0),
  LOW_BALANCE_ALERT_USD: z.coerce.number().nonnegative().default(10),

  /** UTM params appended to website traffic links so the traffic can be segmented. */
  TRAFFIC_UTM_SOURCE: z.string().default('growthhackz'),
  TRAFFIC_UTM_MEDIUM: z.string().default('test-traffic'),

  // --- WURK (x402, USDC on Solana). Separate from PROVIDER: the WURK package never calls Followiz. ---
  WURK_BASE_URL: z.string().url().default('https://wurkapi.fun'),
  /** Dedicated Peak wallet: base58 64-byte secret, 128-char hex, or a solana-keygen JSON array. Server-side only. */
  WURK_SOLANA_PRIVATE_KEY: z.string().optional(),
  /** Nothing is signed unless this is true and the key is set; otherwise orders stop at the quote. */
  WURK_LIVE_PAYMENTS_ENABLED: bool.default('false'),
  /** Recipients we will pay. Checked against every live quote; a change puts the order in needs_attention. */
  WURK_PAYTO_ALLOWLIST: z.string().default('SAT8g2xU7AFy7eUmNJ9SNrM6yYo7LDCi13GXJ8Ez9kC'),
  /** Per-component ceilings (USDC). Baseline quotes from 2026-09-28: 1.40 / 2.25 / 0.45. */
  WURK_MAX_FOLLOWERS_USDC: z.coerce.number().positive().default(1.4),
  WURK_MAX_POST_MIX_USDC: z.coerce.number().positive().default(2.25),
  WURK_MAX_TG_BATCH_USDC: z.coerce.number().positive().default(0.45),
  WURK_PACKAGE_MAX_USDC: z.coerce.number().positive().default(4.55),
  WURK_DAILY_MAX_USDC: z.coerce.number().positive().default(25),
  WURK_SMOKE_MAX_USDC: z.coerce.number().positive().default(1),
  /** Default delay before the second 15-member Telegram batch; admins can change it at runtime. */
  WURK_TG_SECOND_BATCH_DELAY_MIN: z.coerce.number().int().min(0).max(24 * 60).default(30),
  WURK_TICK_MS: z.coerce.number().int().positive().default(15_000),
  WURK_STATUS_POLL_MS: z.coerce.number().int().positive().default(10 * 60_000),
  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  if (config.PROVIDER === 'followiz' && !config.FOLLOWIZ_API_KEY) {
    throw new Error('FOLLOWIZ_API_KEY is required when PROVIDER=followiz');
  }
  return config;
}
