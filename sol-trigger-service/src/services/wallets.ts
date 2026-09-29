import type { KeyPairSigner } from '@solana/kit';
import { z } from 'zod';
import { all, get, run, transaction } from '../db/database.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { generateSecret, normaliseSecret, parseSecretKey, signerFromSecret } from '../solana/keys.js';
import type { ServiceContext } from './context.js';

export interface WalletRow {
  id: string;
  role: 'funding' | 'trading';
  label: string;
  address: string;
  secret_sealed: string;
  buy_pct: number;
  sell_pct: number;
  sell_interval_hours: number;
  enabled: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

const TradingFields = z.object({
  label: z.string().trim().min(1).max(60),
  /** % of the wallet's SOL balance to spend on each buy. */
  buyPct: z.number().gt(0).max(100),
  /** % of the wallet's current token holding to sell each interval (0 = hold, never sell). */
  sellPct: z.number().min(0).max(100),
  sellIntervalHours: z.number().min(0.01).max(24 * 365),
  enabled: z.boolean(),
});

const CreateSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('funding'),
    label: z.string().trim().min(1).max(60).default('Funding wallet'),
    secretKey: z.string().min(1).optional(),
    generate: z.boolean().optional(),
  }),
  TradingFields.partial({ enabled: true }).extend({
    role: z.literal('trading'),
    secretKey: z.string().min(1).optional(),
    generate: z.boolean().optional(),
  }),
]);

export function listWallets(ctx: ServiceContext): WalletRow[] {
  return all<WalletRow>(ctx.db, "SELECT * FROM wallets WHERE archived = 0 ORDER BY role = 'trading', created_at");
}

export function getWallet(ctx: ServiceContext, id: string): WalletRow {
  const w = get<WalletRow>(ctx.db, 'SELECT * FROM wallets WHERE id = :id', { id });
  if (!w) throw new NotFoundError('Wallet');
  return w;
}

export function fundingWallet(ctx: ServiceContext): WalletRow | undefined {
  return get<WalletRow>(ctx.db, "SELECT * FROM wallets WHERE role = 'funding' AND archived = 0");
}

export async function signerFor(ctx: ServiceContext, w: WalletRow): Promise<KeyPairSigner> {
  return signerFromSecret(parseSecretKey(ctx.vault.decrypt(w.secret_sealed)));
}

/**
 * Imports a key or generates one. A new funding wallet replaces the old one (archived, key kept).
 * `generatedSecret` is returned once so it can be backed up; it is never readable again.
 */
export async function createWallet(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ wallet: WalletRow; generatedSecret?: string }> {
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid wallet', parsed.error.flatten().fieldErrors);
  const body = parsed.data;
  if (!body.secretKey && !body.generate) throw new ValidationError('Provide secretKey or set generate: true');
  const { secret, address } = body.secretKey ? await normaliseSecret(body.secretKey) : await generateSecret();

  const now = ctx.clock.now().getTime();
  const id = newId('wal');
  transaction(ctx.db, () => {
    if (get(ctx.db, 'SELECT 1 FROM wallets WHERE address = :address AND archived = 0', { address }))
      throw new ConflictError('That wallet is already added');
    if (body.role === 'funding')
      run(ctx.db, "UPDATE wallets SET archived = 1, updated_at = :now WHERE role = 'funding' AND archived = 0", { now });
    run(
      ctx.db,
      `INSERT INTO wallets (id, role, label, address, secret_sealed, buy_pct, sell_pct, sell_interval_hours, enabled, created_at, updated_at)
       VALUES (:id, :role, :label, :address, :sealed, :buy, :sell, :interval, :enabled, :now, :now)`,
      {
        id,
        role: body.role,
        label: body.label,
        address,
        sealed: ctx.vault.encrypt(secret),
        buy: body.role === 'trading' ? body.buyPct : 0,
        sell: body.role === 'trading' ? body.sellPct : 0,
        interval: body.role === 'trading' ? body.sellIntervalHours : 1,
        enabled: body.role === 'trading' ? (body.enabled ?? true) : true,
        now,
      },
    );
  });
  return { wallet: getWallet(ctx, id), generatedSecret: body.generate && !body.secretKey ? secret : undefined };
}

export function updateWallet(ctx: ServiceContext, id: string, patch: unknown): WalletRow {
  const w = getWallet(ctx, id);
  if (w.archived) throw new NotFoundError('Wallet');
  const parsed = TradingFields.partial().safeParse(patch);
  if (!parsed.success) throw new ValidationError('Invalid wallet settings', parsed.error.flatten().fieldErrors);
  const p = parsed.data;
  if (w.role === 'funding' && (p.buyPct !== undefined || p.sellPct !== undefined || p.sellIntervalHours !== undefined))
    throw new ValidationError('The funding wallet has no trading settings');
  run(
    ctx.db,
    `UPDATE wallets SET label = :label, buy_pct = :buy, sell_pct = :sell, sell_interval_hours = :interval,
       enabled = :enabled, updated_at = :now WHERE id = :id`,
    {
      id,
      label: p.label ?? w.label,
      buy: p.buyPct ?? w.buy_pct,
      sell: p.sellPct ?? w.sell_pct,
      interval: p.sellIntervalHours ?? w.sell_interval_hours,
      enabled: p.enabled ?? Boolean(w.enabled),
      now: ctx.clock.now().getTime(),
    },
  );
  return getWallet(ctx, id);
}

/** Removes the wallet from the dashboard and stops its positions. The encrypted key stays in the database. */
export function archiveWallet(ctx: ServiceContext, id: string): void {
  const w = getWallet(ctx, id);
  if (w.archived) return;
  if (get(ctx.db, "SELECT 1 FROM txs WHERE wallet_id = :id AND status = 'pending'", { id }))
    throw new ConflictError('This wallet has a transaction in flight; try again in a minute');
  const now = ctx.clock.now().getTime();
  transaction(ctx.db, () => {
    run(ctx.db, 'UPDATE wallets SET archived = 1, updated_at = :now WHERE id = :id', { id, now });
    run(
      ctx.db,
      `UPDATE positions SET status = 'cancelled', last_error = 'wallet removed', updated_at = :now
       WHERE wallet_id = :id AND status IN ('waiting', 'holding')`,
      { id, now },
    );
  });
}
