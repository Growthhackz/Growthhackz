// Finds the best direct single-pool route across Pump.fun, PumpSwap, Raydium and Meteora,
// then builds one wallet-signable transaction that includes Peak's fee.
//
// Quotes are measured, not modelled: each candidate swap is simulated against current
// chain state and the exact amount credited to the taker is read back. This keeps every
// venue's own fee rules (Pump fee tiers, DLMM dynamic fees, Token-2022 transfer fees)
// authoritative instead of re-implementing them here.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { FEE_BPS } from './swap-shared';
import { SOL_MINT, isTokenProgram, tokenAmount, transferSol } from './solana';
import type { SolanaRpc } from './rpc';
import { type DiscoveryContext, type Route, type Side, VENUE_LABELS } from './venues/types';
import { discoverPump } from './venues/pump';
import { discoverRaydium } from './venues/raydium';
import { discoverMeteora } from './venues/meteora';

export class RouteError extends Error { constructor(public code: string, message: string, public status = 422) { super(message); } }

const BPS = BigInt(10000), BASE_FEE = BigInt(5000), SIM_UNITS = 1_400_000;
export const MAX_PRIORITY_LAMPORTS = BigInt(1_000_000); // 0.001 SOL
const MAX_CANDIDATES = 6, PER_VENUE = 2;
export const DISCOVERERS = [discoverPump, discoverRaydium, discoverMeteora];

export type QuoteRequest = { inputMint: string; outputMint: string; amount: bigint; taker: string; slippageBps: number; treasury: string };

function compile(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[]) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
}
function encode(tx: VersionedTransaction) {
  try { return Buffer.from(tx.serialize()).toString('base64'); }
  catch { throw new RouteError('ROUTE_TOO_LARGE', 'This pool needs more accounts than fit in one transaction.'); }
}
const simulationUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: SIM_UNITS });

/** Picks the most liquid pools per venue so only a handful are simulated. */
export function shortlist(routes: Route[]) {
  const ranked = routes.filter(r => r.liquidity > BigInt(0)).sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  const perVenue = new Map<string, number>();
  return ranked.filter(r => { const n = perVenue.get(r.venue) || 0; perVenue.set(r.venue, n + 1); return n < PER_VENUE; }).slice(0, MAX_CANDIDATES);
}

function failureReason(logs: string[]) {
  const text = logs.join('\n').toLowerCase();
  if (/insufficient (lamports|funds)|custom program error: 0x1\b/.test(text)) return new RouteError('INSUFFICIENT_FUNDS', 'Insufficient balance for this amount plus fees and account setup.');
  return new RouteError('NO_EXECUTABLE_ROUTE', 'No executable route. Check your balance and try again; liquidity may be migrating.');
}

export async function buildQuote(rpc: SolanaRpc, req: QuoteRequest, options: { pick?: (n: number) => number } = {}) {
  const user = new PublicKey(req.taker), inputMint = new PublicKey(req.inputMint), outputMint = new PublicKey(req.outputMint), treasury = new PublicKey(req.treasury);
  const side: Side | null = inputMint.equals(SOL_MINT) ? 'buy' : outputMint.equals(SOL_MINT) ? 'sell' : null;
  if (!side) throw new RouteError('UNSUPPORTED_PAIR', 'Peak routes directly through a single pool, so one side of the swap must be SOL.', 400);
  const mint = side === 'buy' ? outputMint : inputMint;

  const [[mintAccount], latest] = await Promise.all([rpc.getAccounts([mint]), rpc.latestBlockhash()]);
  if (!mintAccount || !isTokenProgram(mintAccount.owner)) throw new RouteError('UNKNOWN_TOKEN', 'That address is not a token mint.', 400);
  const ctx: DiscoveryContext = { rpc, side, mint, mintProgram: new PublicKey(mintAccount.owner), user, pick: options.pick };

  const discovered = await Promise.allSettled(DISCOVERERS.map(d => d(ctx)));
  if (discovered.every(d => d.status === 'rejected')) throw (discovered[0] as PromiseRejectedResult).reason;
  const candidates = shortlist(discovered.flatMap(d => d.status === 'fulfilled' ? d.value : []));
  if (!candidates.length) throw new RouteError('NO_EXECUTABLE_ROUTE', 'No Pump.fun, Raydium or Meteora pool pairs this token with SOL.');

  /** Exact output credited to the taker for `amountIn`, from a simulation with no minimum. */
  async function measure(route: Route, amountIn: bigint): Promise<bigint | null> {
    const target = route.output.kind === 'token' ? route.output.account : user;
    const tx = encode(compile(user, latest.blockhash, [simulationUnits, ...route.instructions({ amountIn, minOut: BigInt(0), measure: true })]));
    const [[before], sim] = await Promise.all([rpc.getAccounts([target]), rpc.simulate(tx, [target])]);
    const after = sim.accounts[0];
    if (sim.err || !after) return null;
    const out = route.output.kind === 'token'
      ? tokenAmount(after.data) - (before ? tokenAmount(before.data) : BigInt(0))
      : BigInt(after.lamports) - BigInt(before?.lamports || 0) + BASE_FEE; // simulation charges the signature fee
    return out > BigInt(0) ? out : null;
  }

  const measured = await Promise.all(candidates.map(async route => ({ route, out: await measure(route, req.amount).catch(() => null) })));
  const best = measured.filter((m): m is { route: Route; out: bigint } => m.out !== null).sort((a, b) => (b.out > a.out ? 1 : -1))[0];
  if (!best) throw new RouteError('NO_EXECUTABLE_ROUTE', 'No executable route. Check your balance and try again; liquidity may be migrating.');
  const { route, out: expectedOut } = best;

  // Price impact: compare the full-size rate with a 1% probe on the same pool (pool fees cancel out).
  const probe = req.amount / BigInt(100);
  const probeOut = probe > BigInt(0) ? await measure(route, probe).catch(() => null) : null;
  const priceImpactPct = probeOut ? Math.max(0, 1 - (Number(expectedOut) / Number(req.amount)) / (Number(probeOut) / Number(probe))) : NaN;

  const minOut = expectedOut * (BPS - BigInt(req.slippageBps)) / BPS;
  const feeLamports = side === 'buy' ? (req.amount * BigInt(FEE_BPS) + BPS - BigInt(1)) / BPS : expectedOut * BigInt(FEE_BPS) / BPS;
  if (feeLamports <= BigInt(0) || (side === 'sell' && minOut <= feeLamports)) throw new RouteError('AMOUNT_TOO_SMALL', 'Amount is too small to swap.', 400);
  const fee = transferSol(user, treasury, feeLamports);
  const swap = route.instructions({ amountIn: req.amount, minOut });
  const body = side === 'buy' ? [fee, ...swap] : [...swap, fee];

  const gate = await rpc.simulate(encode(compile(user, latest.blockhash, [simulationUnits, ...body])));
  if (gate.err) throw failureReason(gate.logs);
  const units = Math.min(SIM_UNITS, Math.ceil(gate.unitsConsumed * 1.2) + 10_000);
  const recent = (await rpc.priorityFees([new PublicKey(route.pool)]).catch(() => [])).map(f => f.prioritizationFee).sort((a, b) => a - b);
  const wanted = BigInt(Math.max(1000, recent[Math.floor(recent.length * 0.75)] || 0));
  const microLamports = [wanted, MAX_PRIORITY_LAMPORTS * BigInt(1_000_000) / BigInt(units)].reduce((a, b) => (a < b ? a : b));
  const prioritizationFeeLamports = Number((BigInt(units) * microLamports + BigInt(999_999)) / BigInt(1_000_000));

  const transaction = encode(compile(user, latest.blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...body]));
  const net = side === 'sell' ? (v: bigint) => v - feeLamports : (v: bigint) => v;
  return {
    transaction, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
    quote: {
      inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount.toString(),
      outAmount: net(expectedOut).toString(), minimumReceived: net(minOut).toString(), slippageBps: req.slippageBps, priceImpactPct,
      venue: route.venue, venueLabel: VENUE_LABELS[route.venue], pool: route.pool,
      feeBps: FEE_BPS, feeLamports: feeLamports.toString(), feeMint: SOL_MINT.toBase58(), feeCharged: side === 'buy' ? 'on top of input' : 'from SOL proceeds',
      totalInputAmount: (side === 'buy' ? req.amount + feeLamports : req.amount).toString(),
      signatureFeeLamports: Number(BASE_FEE), prioritizationFeeLamports, computeUnits: units,
    },
  };
}
