import { all, get, run, transaction } from '../db/database.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { percentOf, solToLamports } from '../lib/money.js';
import { RpcRejectedError } from '../solana/chain.js';
import { isValidAddress, SOL_MINT } from '../solana/keys.js';
import { buildTransfer, RENT_EXEMPT_MIN_LAMPORTS, signSerialized, transferFee, type SignedTx } from '../solana/tx.js';
import type { ServiceContext } from './context.js';
import { getSettings } from './settings.js';
import { fundingWallet, getWallet, signerFor, type WalletRow } from './wallets.js';

/** Attempts per buy before the position is marked failed (quote errors on a brand-new token count too). */
export const MAX_BUY_ATTEMPTS = 5;
export const BUY_RETRY_MS = 20_000;
export const MAX_FUNDING_ATTEMPTS = 3;
/** Consecutive sell failures retried a minute apart before waiting a full interval. */
export const SELL_FAST_RETRIES = 5;
export const SELL_RETRY_MS = 60_000;

export interface TriggerRow {
  id: string;
  mint: string;
  event_id: string | null;
  source: string;
  status: 'active' | 'ignored';
  note: string | null;
  funding_status: 'skipped' | 'pending' | 'sent' | 'confirmed' | 'failed';
  funding_attempts: number;
  funding_to: string | null;
  funding_lamports: string | null;
  received_at: number;
}

export type PositionStatus = 'waiting' | 'buying' | 'holding' | 'selling' | 'closed' | 'failed' | 'cancelled';

export interface PositionRow {
  id: string;
  trigger_id: string;
  wallet_id: string;
  mint: string;
  status: PositionStatus;
  buy_attempts: number;
  sol_spent: string;
  tokens_bought: string;
  tokens_sold: string;
  sol_received: string;
  sells: number;
  next_action_at: number | null;
  sell_override_pct: number | null;
  sell_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface TxRow {
  id: string;
  kind: 'funding' | 'buy' | 'sell' | 'sweep';
  wallet_id: string;
  trigger_id: string | null;
  position_id: string | null;
  to_address: string | null;
  amount_in: string;
  expected_out: string | null;
  signature: string;
  raw: string | null;
  last_valid_block_height: string;
  status: 'pending' | 'confirmed' | 'failed' | 'expired';
  error: string | null;
  created_at: number;
  updated_at: number;
}

const now = (ctx: ServiceContext) => ctx.clock.now().getTime();
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

// ---------------------------------------------------------------- triggers

export interface TriggerResult {
  trigger: TriggerRow;
  duplicate: boolean;
  positions: number;
}

/** Records a trigger and schedules its funding transfer and buys. Idempotent on eventId. */
export function receiveTrigger(
  ctx: ServiceContext,
  input: { mint: string; eventId?: string | null; source: string },
): TriggerResult {
  const mint = input.mint.trim();
  if (!isValidAddress(mint)) throw new ValidationError('contractAddress is not a valid Solana address');
  if (mint === SOL_MINT) throw new ValidationError('contractAddress cannot be wrapped SOL');
  const eventId = input.eventId?.trim() || null;

  return transaction(ctx.db, () => {
    if (eventId) {
      const existing = get<TriggerRow>(ctx.db, 'SELECT * FROM triggers WHERE event_id = :eventId', { eventId });
      if (existing) {
        const n = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM positions WHERE trigger_id = :id', { id: existing.id });
        return { trigger: existing, duplicate: true, positions: n?.n ?? 0 };
      }
    }
    const s = getSettings(ctx);
    const t = now(ctx);
    const id = newId('trg');
    const notes: string[] = [];

    if (!s.triggersEnabled) {
      run(
        ctx.db,
        `INSERT INTO triggers (id, mint, event_id, source, status, note, funding_status, received_at)
         VALUES (:id, :mint, :eventId, :source, 'ignored', 'Triggers are paused', 'skipped', :t)`,
        { id, mint, eventId, source: input.source, t },
      );
      return { trigger: get<TriggerRow>(ctx.db, 'SELECT * FROM triggers WHERE id = :id', { id })!, duplicate: false, positions: 0 };
    }

    const amount = solToLamports(s.initialAmountSol);
    let funding: TriggerRow['funding_status'] = 'pending';
    if (!s.initialReceiver || amount === 0n) {
      funding = 'skipped';
      notes.push('No initial receiver/amount set');
    } else if (!fundingWallet(ctx)) {
      funding = 'skipped';
      notes.push('No funding wallet set');
    }
    run(
      ctx.db,
      `INSERT INTO triggers (id, mint, event_id, source, status, note, funding_status, funding_to, funding_lamports, received_at)
       VALUES (:id, :mint, :eventId, :source, 'active', NULL, :funding, :to, :lamports, :t)`,
      {
        id,
        mint,
        eventId,
        source: input.source,
        funding,
        to: funding === 'pending' ? s.initialReceiver : null,
        lamports: funding === 'pending' ? amount.toString() : null,
        t,
      },
    );

    const traders = all<WalletRow>(
      ctx.db,
      "SELECT * FROM wallets WHERE role = 'trading' AND archived = 0 AND enabled = 1 AND buy_pct > 0 ORDER BY created_at, rowid",
    );
    let positions = 0;
    for (const w of traders) {
      const open = get(
        ctx.db,
        "SELECT 1 FROM positions WHERE wallet_id = :w AND mint = :mint AND status IN ('waiting', 'buying', 'holding', 'selling')",
        { w: w.id, mint },
      );
      if (open) {
        notes.push(`${w.label} already holds this token`);
        continue;
      }
      run(
        ctx.db,
        `INSERT INTO positions (id, trigger_id, wallet_id, mint, status, created_at, updated_at)
         VALUES (:id, :trigger, :wallet, :mint, 'waiting', :t, :t)`,
        { id: newId('pos'), trigger: id, wallet: w.id, mint, t },
      );
      positions++;
    }
    if (traders.length === 0) notes.push('No enabled trading wallets');
    if (notes.length) run(ctx.db, 'UPDATE triggers SET note = :note WHERE id = :id', { id, note: notes.join('; ') });
    return { trigger: get<TriggerRow>(ctx.db, 'SELECT * FROM triggers WHERE id = :id', { id })!, duplicate: false, positions };
  });
}

// ---------------------------------------------------------------- transaction submission and settlement

function walletBusy(ctx: ServiceContext, walletId: string): boolean {
  return Boolean(get(ctx.db, "SELECT 1 FROM txs WHERE wallet_id = :walletId AND status = 'pending'", { walletId }));
}

/**
 * Records the signed transaction before sending it, so a crash mid-send can never cause a blind resend:
 * the confirmation loop resolves it by signature, or marks it expired once its blockhash can no longer land.
 */
async function submit(
  ctx: ServiceContext,
  args: {
    kind: TxRow['kind'];
    wallet: WalletRow;
    signed: SignedTx;
    lastValidBlockHeight: bigint;
    triggerId?: string;
    positionId?: string;
    to?: string;
    amountIn: bigint;
    expectedOut?: bigint;
  },
): Promise<TxRow> {
  const id = newId('tx');
  const t = now(ctx);
  run(
    ctx.db,
    `INSERT INTO txs (id, kind, wallet_id, trigger_id, position_id, to_address, amount_in, expected_out, signature, raw,
       last_valid_block_height, status, created_at, updated_at)
     VALUES (:id, :kind, :wallet, :trigger, :position, :to, :amountIn, :expectedOut, :signature, :raw, :lvbh, 'pending', :t, :t)`,
    {
      id,
      kind: args.kind,
      wallet: args.wallet.id,
      trigger: args.triggerId,
      position: args.positionId,
      to: args.to,
      amountIn: args.amountIn.toString(),
      expectedOut: args.expectedOut?.toString(),
      signature: args.signed.signature,
      raw: args.signed.base64,
      lvbh: args.lastValidBlockHeight.toString(),
      t,
    },
  );
  try {
    await ctx.chain.sendTransaction(args.signed.base64);
  } catch (err) {
    if (err instanceof RpcRejectedError) {
      await settle(ctx, id, 'failed', errMsg(err));
    } else {
      // Unknown whether the node got it: leave pending and let confirmation decide.
      ctx.log.warn({ tx: id, err: errMsg(err) }, 'send failed; will resolve by signature');
    }
  }
  return getTx(ctx, id);
}

function getTx(ctx: ServiceContext, id: string): TxRow {
  return get<TxRow>(ctx.db, 'SELECT * FROM txs WHERE id = :id', { id })!;
}

async function settle(ctx: ServiceContext, txId: string, outcome: 'confirmed' | 'failed' | 'expired', error?: string) {
  const tx = getTx(ctx, txId);
  if (tx.status !== 'pending') return;
  const t = now(ctx);
  run(ctx.db, 'UPDATE txs SET status = :outcome, error = :error, raw = NULL, updated_at = :t WHERE id = :id', {
    id: txId,
    outcome,
    error: error ?? (outcome === 'expired' ? 'Blockhash expired before the transaction landed' : null),
    t,
  });
  const ok = outcome === 'confirmed';

  if (tx.kind === 'funding' && tx.trigger_id) {
    const trg = get<TriggerRow>(ctx.db, 'SELECT * FROM triggers WHERE id = :id', { id: tx.trigger_id })!;
    const status = ok
      ? 'confirmed'
      : outcome === 'expired' && trg.funding_attempts < MAX_FUNDING_ATTEMPTS
        ? 'pending'
        : 'failed';
    run(ctx.db, 'UPDATE triggers SET funding_status = :status WHERE id = :id', { id: trg.id, status });
    return;
  }

  if (!tx.position_id) return;
  const p = getPosition(ctx, tx.position_id);
  if (tx.kind === 'buy') {
    if (ok) {
      const w = getWallet(ctx, p.wallet_id);
      run(
        ctx.db,
        `UPDATE positions SET status = 'holding', sol_spent = :spent, tokens_bought = :bought, last_error = NULL,
           next_action_at = :next, updated_at = :t WHERE id = :id`,
        {
          id: p.id,
          spent: (BigInt(p.sol_spent) + BigInt(tx.amount_in)).toString(),
          bought: (BigInt(p.tokens_bought) + BigInt(tx.expected_out ?? '0')).toString(),
          next: t + w.sell_interval_hours * 3_600_000,
          t,
        },
      );
    } else {
      const giveUp = p.buy_attempts >= MAX_BUY_ATTEMPTS;
      run(
        ctx.db,
        `UPDATE positions SET status = :status, last_error = :error, next_action_at = :next, updated_at = :t WHERE id = :id`,
        { id: p.id, status: giveUp ? 'failed' : 'waiting', error: error ?? 'Buy did not land', next: t + BUY_RETRY_MS, t },
      );
    }
    return;
  }

  if (tx.kind === 'sell') {
    const w = getWallet(ctx, p.wallet_id);
    const interval = w.sell_interval_hours * 3_600_000;
    if (ok) {
      let remaining: bigint | null = null;
      try {
        remaining = await ctx.chain.getTokenBalance(w.address, p.mint);
      } catch {
        /* checked again at the next sell */
      }
      run(
        ctx.db,
        `UPDATE positions SET status = :status, tokens_sold = :sold, sol_received = :received, sells = sells + 1,
           sell_failures = 0, sell_override_pct = NULL, last_error = NULL, next_action_at = :next, updated_at = :t WHERE id = :id`,
        {
          id: p.id,
          status: remaining === 0n ? 'closed' : 'holding',
          sold: (BigInt(p.tokens_sold) + BigInt(tx.amount_in)).toString(),
          received: (BigInt(p.sol_received) + BigInt(tx.expected_out ?? '0')).toString(),
          next: remaining === 0n ? null : t + interval,
          t,
        },
      );
    } else {
      const failures = p.sell_failures + 1;
      const backOff = failures >= SELL_FAST_RETRIES;
      run(
        ctx.db,
        `UPDATE positions SET status = 'holding', sell_failures = :failures, last_error = :error, next_action_at = :next,
           updated_at = :t WHERE id = :id`,
        {
          id: p.id,
          failures: backOff ? 0 : failures,
          error: error ?? 'Sell did not land',
          next: t + (backOff ? interval : SELL_RETRY_MS),
          t,
        },
      );
    }
  }
}

/** Resolves pending transactions: confirmed, failed on-chain, or expired. Rebroadcasts the rest. */
export async function confirmPending(ctx: ServiceContext): Promise<number> {
  const pending = all<TxRow>(ctx.db, "SELECT * FROM txs WHERE status = 'pending' ORDER BY created_at LIMIT 200");
  if (!pending.length) return 0;
  const [statuses, height] = await Promise.all([
    ctx.chain.getSignatureStatuses(pending.map((p) => p.signature)),
    ctx.chain.getBlockHeight(),
  ]);
  let resolved = 0;
  for (const [i, tx] of pending.entries()) {
    const st = statuses[i];
    if (st?.err) {
      await settle(ctx, tx.id, 'failed', `On-chain error: ${JSON.stringify(st.err)}`);
      resolved++;
    } else if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
      await settle(ctx, tx.id, 'confirmed');
      resolved++;
    } else if (height > BigInt(tx.last_valid_block_height)) {
      await settle(ctx, tx.id, 'expired');
      resolved++;
    } else if (tx.raw) {
      await ctx.chain.sendTransaction(tx.raw, { skipPreflight: true }).catch(() => undefined);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------- funding

async function processFunding(ctx: ServiceContext): Promise<number> {
  const due = all<TriggerRow>(ctx.db, "SELECT * FROM triggers WHERE funding_status = 'pending' ORDER BY received_at LIMIT 10");
  let sent = 0;
  for (const trg of due) {
    const w = fundingWallet(ctx);
    if (!w) {
      run(ctx.db, "UPDATE triggers SET funding_status = 'failed', note = 'Funding wallet removed' WHERE id = :id", { id: trg.id });
      continue;
    }
    if (walletBusy(ctx, w.id)) continue;
    run(ctx.db, 'UPDATE triggers SET funding_attempts = funding_attempts + 1 WHERE id = :id', { id: trg.id });
    try {
      const s = getSettings(ctx);
      const amount = BigInt(trg.funding_lamports!);
      const fee = transferFee(s.transferPriorityMicroLamports);
      const balance = await ctx.chain.getBalance(w.address);
      const left = balance - amount - fee;
      if (left < 0n || (left > 0n && left < RENT_EXEMPT_MIN_LAMPORTS))
        throw new ValidationError(`Funding wallet balance too low (${balance} lamports)`);
      const signer = await signerFor(ctx, w);
      const bh = await ctx.chain.getLatestBlockhash();
      const signed = await buildTransfer({
        from: signer,
        to: trg.funding_to!,
        amount,
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
        priorityMicroLamports: s.transferPriorityMicroLamports,
      });
      run(ctx.db, "UPDATE triggers SET funding_status = 'sent' WHERE id = :id", { id: trg.id });
      await submit(ctx, {
        kind: 'funding',
        wallet: w,
        signed,
        lastValidBlockHeight: bh.lastValidBlockHeight,
        triggerId: trg.id,
        to: trg.funding_to!,
        amountIn: amount,
      });
      sent++;
    } catch (err) {
      const fresh = get<TriggerRow>(ctx.db, 'SELECT * FROM triggers WHERE id = :id', { id: trg.id })!;
      const giveUp = err instanceof ValidationError || fresh.funding_attempts >= MAX_FUNDING_ATTEMPTS;
      run(
        ctx.db,
        "UPDATE triggers SET funding_status = :status, note = trim(coalesce(note || '; ', '') || :note) WHERE id = :id",
        { id: trg.id, status: giveUp ? 'failed' : 'pending', note: `Funding: ${errMsg(err)}` },
      );
    }
  }
  return sent;
}

// ---------------------------------------------------------------- buys and sells

function getPosition(ctx: ServiceContext, id: string): PositionRow {
  const p = get<PositionRow>(ctx.db, 'SELECT * FROM positions WHERE id = :id', { id });
  if (!p) throw new NotFoundError('Position');
  return p;
}

async function processBuys(ctx: ServiceContext): Promise<number> {
  const t = now(ctx);
  // Each wallet's own delay, read live, so editing it also moves buys that are still waiting.
  const due = all<PositionRow>(
    ctx.db,
    `SELECT p.* FROM positions p JOIN triggers t ON t.id = p.trigger_id JOIN wallets w ON w.id = p.wallet_id
     WHERE p.status = 'waiting' AND t.received_at + CAST(round(w.buy_delay_minutes * 60000) AS INTEGER) <= :t
       AND coalesce(p.next_action_at, 0) <= :t
     ORDER BY p.created_at, p.rowid LIMIT 20`,
    { t },
  );
  let sent = 0;
  for (const p of due) {
    const w = getWallet(ctx, p.wallet_id);
    if (w.archived || !w.enabled) {
      run(ctx.db, "UPDATE positions SET status = 'cancelled', last_error = 'Wallet disabled', updated_at = :t WHERE id = :id", {
        id: p.id,
        t,
      });
      continue;
    }
    if (walletBusy(ctx, w.id)) continue;
    run(ctx.db, "UPDATE positions SET status = 'buying', buy_attempts = buy_attempts + 1, updated_at = :t WHERE id = :id", {
      id: p.id,
      t,
    });
    try {
      const balance = await ctx.chain.getBalance(w.address);
      const reserve = solToLamports(w.fee_reserve_sol);
      let spend = percentOf(balance, w.buy_pct);
      if (spend > balance - reserve) spend = balance - reserve;
      if (spend < 100_000n) throw new ValidationError(`Not enough SOL to buy (balance ${balance} lamports, reserve ${reserve})`);
      const quote = await ctx.swapper.quote({ inputMint: SOL_MINT, outputMint: p.mint, amount: spend, slippageBps: w.slippage_bps });
      const swap = await ctx.swapper.buildSwap({ quote, userPublicKey: w.address, maxPriorityFeeLamports: w.swap_max_priority_fee_lamports });
      const signed = await signSerialized(await signerFor(ctx, w), swap.base64);
      await submit(ctx, {
        kind: 'buy',
        wallet: w,
        signed,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        positionId: p.id,
        amountIn: spend,
        expectedOut: BigInt(quote.outAmount),
      });
      sent++;
    } catch (err) {
      const fresh = getPosition(ctx, p.id);
      const giveUp = err instanceof ValidationError || fresh.buy_attempts >= MAX_BUY_ATTEMPTS;
      run(
        ctx.db,
        'UPDATE positions SET status = :status, last_error = :error, next_action_at = :next, updated_at = :t WHERE id = :id',
        { id: p.id, status: giveUp ? 'failed' : 'waiting', error: errMsg(err), next: now(ctx) + BUY_RETRY_MS, t: now(ctx) },
      );
    }
  }
  return sent;
}

async function processSells(ctx: ServiceContext): Promise<number> {
  const t = now(ctx);
  const due = all<PositionRow>(
    ctx.db,
    `SELECT p.* FROM positions p JOIN wallets w ON w.id = p.wallet_id
     WHERE p.status = 'holding' AND p.next_action_at <= :t AND w.enabled = 1 AND w.archived = 0
     ORDER BY p.next_action_at LIMIT 20`,
    { t },
  );
  let sent = 0;
  for (const p of due) {
    const w = getWallet(ctx, p.wallet_id);
    const pct = p.sell_override_pct ?? w.sell_pct;
    const interval = w.sell_interval_hours * 3_600_000;
    if (pct <= 0) {
      run(ctx.db, 'UPDATE positions SET next_action_at = :next, updated_at = :t WHERE id = :id', { id: p.id, next: t + interval, t });
      continue;
    }
    if (walletBusy(ctx, w.id)) continue;
    try {
      const holding = await ctx.chain.getTokenBalance(w.address, p.mint);
      if (holding === 0n) {
        run(ctx.db, "UPDATE positions SET status = 'closed', next_action_at = NULL, updated_at = :t WHERE id = :id", { id: p.id, t });
        continue;
      }
      let amount = percentOf(holding, pct);
      if (amount === 0n || pct >= 100) amount = holding;
      run(ctx.db, "UPDATE positions SET status = 'selling', updated_at = :t WHERE id = :id", { id: p.id, t });
      const quote = await ctx.swapper.quote({ inputMint: p.mint, outputMint: SOL_MINT, amount, slippageBps: w.slippage_bps });
      const swap = await ctx.swapper.buildSwap({ quote, userPublicKey: w.address, maxPriorityFeeLamports: w.swap_max_priority_fee_lamports });
      const signed = await signSerialized(await signerFor(ctx, w), swap.base64);
      await submit(ctx, {
        kind: 'sell',
        wallet: w,
        signed,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        positionId: p.id,
        amountIn: amount,
        expectedOut: BigInt(quote.outAmount),
      });
      sent++;
    } catch (err) {
      const failures = p.sell_failures + 1;
      const backOff = failures >= SELL_FAST_RETRIES;
      run(
        ctx.db,
        `UPDATE positions SET status = 'holding', sell_failures = :failures, last_error = :error, next_action_at = :next,
           updated_at = :t WHERE id = :id`,
        { id: p.id, failures: backOff ? 0 : failures, error: errMsg(err), next: now(ctx) + (backOff ? interval : SELL_RETRY_MS), t: now(ctx) },
      );
    }
  }
  return sent;
}

/** Undoes a claim left behind by a crash between marking work in flight and recording its transaction. */
function recoverStuck(ctx: ServiceContext): number {
  const noTx = (col: string, ref: string) =>
    `NOT EXISTS (SELECT 1 FROM txs x WHERE x.${col} = ${ref}.id AND x.status = 'pending')`;
  const t = now(ctx);
  return (
    run(ctx.db, `UPDATE positions SET status = 'waiting', updated_at = :t WHERE status = 'buying' AND ${noTx('position_id', 'positions')}`, { t }).changes +
    run(ctx.db, `UPDATE positions SET status = 'holding', updated_at = :t WHERE status = 'selling' AND ${noTx('position_id', 'positions')}`, { t }).changes +
    run(ctx.db, `UPDATE triggers SET funding_status = 'pending' WHERE funding_status = 'sent' AND ${noTx('trigger_id', 'triggers')}`).changes
  );
}

/** One pass of the background loop. Each stage is isolated so one failing RPC call does not stall the rest. */
export async function tick(ctx: ServiceContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, fn] of [
    ['recovered', async (c: ServiceContext) => recoverStuck(c)],
    ['confirmed', confirmPending],
    ['funding', processFunding],
    ['buys', processBuys],
    ['sells', processSells],
  ] as const) {
    try {
      out[name] = await fn(ctx);
    } catch (err) {
      ctx.log.error({ stage: name, err: errMsg(err) }, 'tick stage failed');
      out[name] = 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- manual actions

export function sellNow(ctx: ServiceContext, positionId: string, pct = 100): PositionRow {
  const p = getPosition(ctx, positionId);
  if (p.status !== 'holding') throw new ConflictError(`Position is ${p.status}; only holding positions can be sold`);
  if (!(pct > 0 && pct <= 100)) throw new ValidationError('pct must be between 0 and 100');
  run(ctx.db, 'UPDATE positions SET sell_override_pct = :pct, next_action_at = :t, sell_failures = 0, updated_at = :t WHERE id = :id', {
    id: p.id,
    pct,
    t: now(ctx),
  });
  return getPosition(ctx, p.id);
}

/** Stops the bot touching this position. Tokens already bought stay in the wallet. */
export function cancelPosition(ctx: ServiceContext, positionId: string): PositionRow {
  const p = getPosition(ctx, positionId);
  if (p.status !== 'waiting' && p.status !== 'holding')
    throw new ConflictError(`Position is ${p.status}; wait for the transaction in flight to finish`);
  run(ctx.db, "UPDATE positions SET status = 'cancelled', next_action_at = NULL, updated_at = :t WHERE id = :id", {
    id: p.id,
    t: now(ctx),
  });
  return getPosition(ctx, p.id);
}

export interface SweepResult {
  walletId: string;
  label: string;
  status: 'sent' | 'skipped' | 'failed';
  lamports?: string;
  signature?: string;
  reason?: string;
}

/** Sends every lamport (minus the fee) from each selected wallet to the final receiver. */
export async function sweep(ctx: ServiceContext, walletIds: string[]): Promise<SweepResult[]> {
  const s = getSettings(ctx);
  if (!s.finalReceiver) throw new ValidationError('Set a final receiving wallet first');
  const ids = [...new Set(walletIds)];
  if (!ids.length) throw new ValidationError('Select at least one wallet');
  const fee = transferFee(s.transferPriorityMicroLamports);
  const results: SweepResult[] = [];
  let bh: { blockhash: string; lastValidBlockHeight: bigint } | null = null;

  for (const id of ids) {
    const w = getWallet(ctx, id);
    const base = { walletId: w.id, label: w.label };
    try {
      if (w.archived) throw new NotFoundError('Wallet');
      if (w.address === s.finalReceiver) {
        results.push({ ...base, status: 'skipped', reason: 'This is the final receiver' });
        continue;
      }
      if (walletBusy(ctx, w.id)) {
        results.push({ ...base, status: 'skipped', reason: 'Transaction in flight; try again shortly' });
        continue;
      }
      const balance = await ctx.chain.getBalance(w.address);
      const amount = balance - fee;
      if (amount <= 0n) {
        results.push({ ...base, status: 'skipped', reason: 'Empty' });
        continue;
      }
      bh ??= await ctx.chain.getLatestBlockhash();
      const signed = await buildTransfer({
        from: await signerFor(ctx, w),
        to: s.finalReceiver,
        amount,
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
        priorityMicroLamports: s.transferPriorityMicroLamports,
      });
      const tx = await submit(ctx, {
        kind: 'sweep',
        wallet: w,
        signed,
        lastValidBlockHeight: bh.lastValidBlockHeight,
        to: s.finalReceiver,
        amountIn: amount,
      });
      results.push(
        tx.status === 'failed'
          ? { ...base, status: 'failed', reason: tx.error ?? 'Rejected' }
          : { ...base, status: 'sent', lamports: amount.toString(), signature: tx.signature },
      );
    } catch (err) {
      results.push({ ...base, status: 'failed', reason: errMsg(err) });
    }
  }
  return results;
}
