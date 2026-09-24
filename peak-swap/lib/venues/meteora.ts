// Meteora DAMM v2 (cp-amm) and DLMM (lb_clmm, swap2).
// Layouts and account order follow @meteora-ag/cp-amm-sdk 1.4.10 and @meteora-ag/dlmm 1.9.14; see tests/venues.ts.
import { PublicKey } from '@solana/web3.js';
import { SOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, MEMO_PROGRAM, SYSVAR_INSTRUCTIONS, ata, pda, pk, meta, ix, concat, u64, i64, readKey, readI32, readU64, tokenAmount } from '../solana';
import { poolsByMints, wrapped, wrappedOutput } from './raydium';
import type { DiscoveryContext, Route } from './types';

export const DAMM_V2_PROGRAM = pk('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const DAMM_V2_AUTHORITY = pk('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');
export const DLMM_PROGRAM = pk('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const DAMM_EVENT_AUTHORITY = pda(['__event_authority'], DAMM_V2_PROGRAM), DLMM_EVENT_AUTHORITY = pda(['__event_authority'], DLMM_PROGRAM);
const DAMM_POOL_SIZE = 1112, LB_PAIR_SIZE = 904;
const flagProgram = (flag: number) => flag === 1 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;

export type DammPool = { pool: PublicKey; mintA: PublicKey; mintB: PublicKey; vaultA: PublicKey; vaultB: PublicKey; programA: PublicKey; programB: PublicKey };
export const decodeDamm = (pool: PublicKey, d: Uint8Array): DammPool => ({
  pool, mintA: readKey(d, 168), mintB: readKey(d, 200), vaultA: readKey(d, 232), vaultB: readKey(d, 264), programA: flagProgram(d[482]), programB: flagProgram(d[483]),
});

/**
 * The instructions sysvar is only read by pools with an active rate-limiter fee;
 * it is always passed so every pool mode is covered (extra remaining accounts are ignored).
 */
export function dammSwap(p: DammPool & { user: PublicKey; inputMint: PublicKey; amountIn: bigint; minOut: bigint; rateLimiterAccount?: boolean }) {
  const aIn = p.inputMint.equals(p.mintA);
  const inAccount = aIn ? ata(p.mintA, p.user, p.programA) : ata(p.mintB, p.user, p.programB), outAccount = aIn ? ata(p.mintB, p.user, p.programB) : ata(p.mintA, p.user, p.programA);
  return ix(DAMM_V2_PROGRAM, [
    meta(DAMM_V2_AUTHORITY), meta(p.pool, true), meta(inAccount, true), meta(outAccount, true), meta(p.vaultA, true), meta(p.vaultB, true),
    meta(p.mintA), meta(p.mintB), meta(p.user, false, true), meta(p.programA), meta(p.programB),
    meta(DAMM_V2_PROGRAM), meta(DAMM_EVENT_AUTHORITY), meta(DAMM_V2_PROGRAM),
    ...(p.rateLimiterAccount === false ? [] : [meta(SYSVAR_INSTRUCTIONS)]),
  ], concat([248, 198, 158, 145, 225, 117, 135, 200], u64(p.amountIn), u64(p.minOut)));
}

export type LbPair = { pair: PublicKey; activeId: number; mintX: PublicKey; mintY: PublicKey; reserveX: PublicKey; reserveY: PublicKey; oracle: PublicKey; programX: PublicKey; programY: PublicKey; bitmap: bigint[] };
export function decodeLbPair(pair: PublicKey, d: Uint8Array): LbPair {
  return {
    pair, activeId: readI32(d, 76), mintX: readKey(d, 88), mintY: readKey(d, 120), reserveX: readKey(d, 152), reserveY: readKey(d, 184), oracle: readKey(d, 552),
    programX: flagProgram(d[880]), programY: flagProgram(d[881]), bitmap: Array.from({ length: 16 }, (_, i) => readU64(d, 584 + 8 * i)),
  };
}

const BINS_PER_ARRAY = 70, BITMAP_HALF = 512;
export const binArrayIndex = (binId: number) => Math.floor(binId / BINS_PER_ARRAY);
export const binArrayKey = (pair: PublicKey, index: number) => pda(['bin_array', pair.toBytes(), i64(BigInt(index))], DLMM_PROGRAM);
export const bitmapExtensionKey = (pair: PublicKey) => pda(['bitmap', pair.toBytes()], DLMM_PROGRAM);
const bitSet = (bitmap: bigint[], index: number) => { const bit = index + BITMAP_HALF; return ((bitmap[bit >> 6] >> BigInt(bit & 63)) & BigInt(1)) === BigInt(1); };

/**
 * Initialized bin arrays the swap will walk, in order, starting at the active bin.
 * Mirrors the SDK's getBinArrayForSwap for the pair's internal bitmap (indexes -512..511);
 * pairs trading outside that range need the bitmap extension and are left to simulation to reject.
 */
export function binArraysForSwap(p: LbPair, swapForY: boolean, count = 3) {
  const out: number[] = [];
  for (let i = binArrayIndex(p.activeId); out.length < count && i >= -BITMAP_HALF && i < BITMAP_HALF; i += swapForY ? -1 : 1) if (bitSet(p.bitmap, i)) out.push(i);
  return out.map(i => binArrayKey(p.pair, i));
}

export function dlmmSwap(p: LbPair & { user: PublicKey; inputMint: PublicKey; amountIn: bigint; minOut: bigint; binArrays: PublicKey[]; bitmapExtension?: PublicKey | null }) {
  const xIn = p.inputMint.equals(p.mintX);
  const inAccount = xIn ? ata(p.mintX, p.user, p.programX) : ata(p.mintY, p.user, p.programY), outAccount = xIn ? ata(p.mintY, p.user, p.programY) : ata(p.mintX, p.user, p.programX);
  return ix(DLMM_PROGRAM, [
    meta(p.pair, true), p.bitmapExtension ? meta(p.bitmapExtension, true) : meta(DLMM_PROGRAM), meta(p.reserveX, true), meta(p.reserveY, true),
    meta(inAccount, true), meta(outAccount, true), meta(p.mintX), meta(p.mintY), meta(p.oracle, true), meta(DLMM_PROGRAM),
    meta(p.user, false, true), meta(p.programX), meta(p.programY), meta(MEMO_PROGRAM), meta(DLMM_EVENT_AUTHORITY), meta(DLMM_PROGRAM),
    ...p.binArrays.map(k => meta(k, true)),
  ], concat([65, 75, 63, 76, 235, 91, 91, 136], u64(p.amountIn), u64(p.minOut), [0, 0, 0, 0]));
}

export async function discoverMeteora(c: DiscoveryContext): Promise<Route[]> {
  const inputMint = c.side === 'buy' ? SOL_MINT : c.mint;
  const [damm, dlmm] = await Promise.all([poolsByMints(c, DAMM_V2_PROGRAM, DAMM_POOL_SIZE, 168, 200), poolsByMints(c, DLMM_PROGRAM, LB_PAIR_SIZE, 88, 120)]);
  const dp = damm.filter(p => p.account.data[481] === 0).map(p => decodeDamm(p.pubkey, p.account.data)); // pool_status 0 = enabled
  const lp = dlmm.map(p => decodeLbPair(p.pubkey, p.account.data));
  const extensions = lp.map(p => bitmapExtensionKey(p.pair));
  const accounts = await c.rpc.getAccounts([...dp.map(p => p.mintA.equals(SOL_MINT) ? p.vaultA : p.vaultB), ...lp.map(p => p.mintX.equals(SOL_MINT) ? p.reserveX : p.reserveY), ...extensions]);
  const balance = (i: number) => accounts[i] ? tokenAmount(accounts[i]!.data) : BigInt(0);
  return [
    ...dp.map((p, i): Route => ({ venue: 'meteora-damm-v2', pool: p.pool.toBase58(), liquidity: balance(i), output: wrappedOutput(c), instructions: wrapped(c, (amountIn, minOut) => dammSwap({ ...p, user: c.user, inputMint, amountIn, minOut })) })),
    ...lp.map((p, i): Route => {
      const binArrays = binArraysForSwap(p, inputMint.equals(p.mintX)), bitmapExtension = accounts[dp.length + lp.length + i] ? extensions[i] : null;
      return { venue: 'meteora-dlmm', pool: p.pair.toBase58(), liquidity: binArrays.length ? balance(dp.length + i) : BigInt(0), output: wrappedOutput(c), instructions: wrapped(c, (amountIn, minOut) => dlmmSwap({ ...p, user: c.user, inputMint, amountIn, minOut, binArrays, bitmapExtension })) };
    }),
  ];
}
