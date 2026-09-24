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
