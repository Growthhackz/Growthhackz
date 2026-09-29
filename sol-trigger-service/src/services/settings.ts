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
  /** Wait between the trigger and the trading wallets' buys. Applies to triggers still waiting too. */
  buyDelayMinutes: z.number().min(0).max(10_080),
  /** Destination for sweeps. */
  finalReceiver: addressOrNull,
  /** Max slippage for buys and sells, in basis points (100 = 1%). */
  slippageBps: z.number().int().min(10).max(5_000),
  /** SOL each trading wallet keeps back from a buy for fees and token-account rent. */
  feeReserveSol: z.number().min(0.003).max(10),
  /** Cap on the priority fee Jupiter may attach to a swap, in lamports. */
  swapMaxPriorityFeeLamports: z.number().int().min(0).max(50_000_000),
  /** Compute-unit price for plain SOL transfers (funding, sweep), in micro-lamports. */
  transferPriorityMicroLamports: z.number().int().min(0).max(50_000_000),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  triggersEnabled: true,
  initialReceiver: null,
  initialAmountSol: 0,
  buyDelayMinutes: 10,
  finalReceiver: null,
  slippageBps: 1_000,
  feeReserveSol: 0.01,
  swapMaxPriorityFeeLamports: 2_000_000,
  transferPriorityMicroLamports: 200_000,
};

export function getSettings(ctx: ServiceContext): Settings {
  const row = get<{ data: string }>(ctx.db, 'SELECT data FROM settings WHERE id = 1');
  const stored = row ? (JSON.parse(row.data) as Partial<Settings>) : {};
  return { ...DEFAULT_SETTINGS, ...stored };
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
