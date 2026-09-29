import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4030),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Dashboard login password (min 12 chars). */
  DASHBOARD_PASSWORD: z.string().min(12),
  /** Bearer token the upstream system sends with POST /v1/trigger (min 24 chars). */
  TRIGGER_API_TOKEN: z.string().min(24),
  /** Encrypts wallet private keys at rest and signs dashboard sessions (min 32 chars). Never change it once set. */
  ENCRYPTION_KEY: z.string().min(32),
  /** Dashboard session lifetime. */
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  /** Mark the session cookie Secure. Keep true behind HTTPS (Railway); set false only for plain-http localhost. */
  COOKIE_SECURE: bool.default('true'),

  DATABASE_PATH: z.string().default('./data/sol-trigger.db'),

  /** Mainnet RPC. The public endpoint is rate-limited; use a paid one (Helius, Triton, QuickNode) in production. */
  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  /** Jupiter Swap API. With JUPITER_API_KEY set, use https://api.jup.ag/swap/v1. */
  JUPITER_API_URL: z.string().url().default('https://lite-api.jup.ag/swap/v1'),
  JUPITER_API_KEY: z.string().optional(),

  WORKERS_ENABLED: bool.default('true'),
  /** How often the background loop checks for due buys, sells and pending confirmations. */
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
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
