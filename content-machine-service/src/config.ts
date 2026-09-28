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
  /** Our own call channel (separate bot from TELEGRAM_BOT_TOKEN). */
  CALL_CHANNEL_BOT_TOKEN: z.string().optional(),
  CALL_CHANNEL_ID: z.string().optional(),
  CALL_CHANNEL_LABEL: z.string().optional(),
  /** Team member's numeric Telegram ID that owns every sticker pack (must have started the bot). */
  STICKER_OWNER_ID: z.string().optional(),

  WORKERS_ENABLED: bool.default('true'),
  /** How often the background loop advances queued jobs and sends callbacks. */
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** Upper bound on jobs processed per tick so one tick can't run unbounded. */
  JOBS_PER_TICK: z.coerce.number().int().positive().default(10),
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
