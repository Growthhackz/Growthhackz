import { z } from 'zod';
import { get, run } from '../db/database.js';
import { ValidationError } from '../lib/errors.js';
import { isValidAddress } from '../solana/keys.js';
import type { ServiceContext } from './context.js';

const addressOrNull = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .refine((v) => v === null || isValidAddress(v), 'Not a valid Solana address');

export const SettingsSchema = z.object({
  /** Master switch: when off, incoming triggers are logged and ignored. */
  triggersEnabled: z.boolean(),
  /** Receives initialAmountSol from the funding wallet on each trigger. Null = skip this step. */
  initialReceiver: addressOrNull,
  initialAmountSol: z.number().min(0).max(100_000),
  /** Destination for sweeps. */
  finalReceiver: addressOrNull,
  /** Compute-unit price for plain SOL transfers (funding, sweep), in micro-lamports. */
  transferPriorityMicroLamports: z.number().int().min(0).max(50_000_000),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  triggersEnabled: true,
  initialReceiver: null,
  initialAmountSol: 0,
  finalReceiver: null,
  transferPriorityMicroLamports: 200_000,
};

export function getSettings(ctx: ServiceContext): Settings {
  const row = get<{ data: string }>(ctx.db, 'SELECT data FROM settings WHERE id = 1');
  const stored = row ? (JSON.parse(row.data) as Partial<Settings>) : {};
  // Strips keys that moved onto wallets in migration 2.
  return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...stored });
}

export function updateSettings(ctx: ServiceContext, patch: unknown): Settings {
  const parsed = SettingsSchema.partial().safeParse(patch);
  if (!parsed.success) throw new ValidationError('Invalid settings', parsed.error.flatten().fieldErrors);
  const next = SettingsSchema.parse({ ...getSettings(ctx), ...parsed.data });
  run(ctx.db, 'INSERT INTO settings (id, data) VALUES (1, :data) ON CONFLICT(id) DO UPDATE SET data = :data', {
    data: JSON.stringify(next),
  });
  return next;
}
