import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { Account } from '../solana';

export type VenueId = 'pump-curve' | 'pumpswap' | 'raydium-cpmm' | 'raydium-amm-v4' | 'meteora-damm-v2' | 'meteora-dlmm';
export const VENUE_LABELS: Record<VenueId, string> = {
  'pump-curve': 'Pump.fun bonding curve',
  'pumpswap': 'PumpSwap',
  'raydium-cpmm': 'Raydium CPMM',
  'raydium-amm-v4': 'Raydium AMM v4',
  'meteora-damm-v2': 'Meteora DAMM v2',
  'meteora-dlmm': 'Meteora DLMM',
};

/**
 * Every Peak route is a single pool with SOL on one side.
 * `buy`: SOL in, `mint` out. `sell`: `mint` in, SOL out.
 */
export type Side = 'buy' | 'sell';

export type SwapParams = {
  amountIn: bigint;
  minOut: bigint;
  /**
   * Quote-measurement build: leave the received SOL wrapped so a simulation can
   * read the exact amount from the WSOL account. Never used for signed orders.
   */
  measure?: boolean;
};

export type Route = {
  venue: VenueId;
  pool: string;
  /** SOL-side liquidity in lamports, used only to shortlist pools before simulation. */
  liquidity: bigint;
  /** Where the swap output lands, so a simulation can measure it. */
  output: { kind: 'token'; account: PublicKey } | { kind: 'lamports' };
  instructions(p: SwapParams): TransactionInstruction[];
};

export type Rpc = {
  getAccounts(keys: PublicKey[]): Promise<(Account | null)[]>;
  getProgramAccounts(program: PublicKey, filters: ({ dataSize: number } | { memcmp: { offset: number; bytes: string } })[]): Promise<{ pubkey: PublicKey; account: Account }[]>;
};

export type DiscoveryContext = {
  rpc: Rpc;
  side: Side;
  mint: PublicKey;
  mintProgram: PublicKey;
  user: PublicKey;
  /** Random index source; injectable so tests can pin fee-recipient choices. */
  pick?: (length: number) => number;
};

export const randomPick = (length: number) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % length; };
