import { get, run } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { ValidationError } from '../lib/errors.js';
import { safeRemote } from '../lib/http.js';
import type { ServiceContext } from './context.js';

export const SETTING_KEYS = [
  'GEMINI_API_KEY',
  'TEXT_MODEL',
  'IMAGE_MODEL',
  'TELEGRAPH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'CALLBACK_URL',
  'CALLBACK_SECRET',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';

export function rawSetting(ctx: ServiceContext, key: string): string | null {
  return get<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE key = :key', { key })?.value ?? null;
}

export function setRawSetting(ctx: ServiceContext, key: string, value: string): void {
  run(ctx.db, 'INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', {
    key,
    value,
  });
}

/** Saved (encrypted) value first, then the environment. Empty string when neither is set. */
export function setting(ctx: ServiceContext, key: SettingKey): string {
  const sealed = rawSetting(ctx, 'secret:' + key);
  if (sealed !== null) return ctx.vault.decrypt(sealed);
  return ctx.config[key] ?? '';
}

export function saveSetting(ctx: ServiceContext, key: string, value: unknown): void {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new ValidationError(`Unsupported setting; use one of ${SETTING_KEYS.join(', ')}`);
  if (typeof value !== 'string' || value.length > 4096) throw new ValidationError('value must be a string up to 4096 characters');
  if (key === 'CALLBACK_URL' && value) safeRemote(value);
  if (key.endsWith('_MODEL') && value && !/^gemini-[a-zA-Z0-9.-]+$/.test(value)) throw new ValidationError('Invalid model ID');
  setRawSetting(ctx, 'secret:' + key, ctx.vault.encrypt(value));
}

export function settingsSummary(ctx: ServiceContext) {
  const connected: Record<string, boolean> = {};
  for (const k of SETTING_KEYS) connected[k] = !!setting(ctx, k);
  const rendererLastSeen = Number(rawSetting(ctx, 'renderer_last_seen') || 0);
  return {
    connected,
    api_keys: get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL')?.n ?? 0,
    renderer_last_seen: rendererLastSeen ? new Date(rendererLastSeen).toISOString() : null,
    public_base_url: ctx.config.PUBLIC_BASE_URL,
    public_hub_enabled: ctx.config.PUBLIC_HUB_ENABLED,
    text_model: setting(ctx, 'TEXT_MODEL') || DEFAULT_TEXT_MODEL,
    image_model: setting(ctx, 'IMAGE_MODEL') || DEFAULT_IMAGE_MODEL,
  };
}

export const hashKey = sha256;
