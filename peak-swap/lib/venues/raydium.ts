// Raydium CPMM and AMM v4 (swap_base_in_v2, no OpenBook accounts).
// Layouts and account order follow @raydium-io/raydium-sdk-v2; see tests/venues.ts.
import { PublicKey } from '@solana/web3.js';
import { SOL_MINT, TOKEN_PROGRAM, ata, pda, pk, meta, ix, concat, u64, readKey, tokenAmount, createAtaIdempotent, wrapSol, unwrapSol } from '../solana';
import type { DiscoveryContext, Route } from './types';

export const CPMM_PROGRAM = pk('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const AMM_V4_PROGRAM = pk('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
export const AMM_V4_AUTHORITY = pk('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
export const CPMM_AUTHORITY = pda(['vault_and_lp_mint_auth_seed'], CPMM_PROGRAM);
const CPMM_POOL_SIZE = 637, AMM_V4_SIZE = 752;
const SWAP_BASE_INPUT = [143, 190, 90, 218, 196, 30, 51, 222];

export type CpmmPool = { pool: PublicKey; config: PublicKey; vaultA: PublicKey; vaultB: PublicKey; mintA: PublicKey; mintB: PublicKey; programA: PublicKey; programB: PublicKey; observation: PublicKey };
export const decodeCpmm = (pool: PublicKey, d: Uint8Array): CpmmPool => ({
  pool, config: readKey(d, 8), vaultA: readKey(d, 72), vaultB: readKey(d, 104), mintA: readKey(d, 168), mintB: readKey(d, 200),
  programA: readKey(d, 232), programB: readKey(d, 264), observation: readKey(d, 296),
});

export function cpmmSwap(p: CpmmPool & { user: PublicKey; inputMint: PublicKey; amountIn: bigint; minOut: bigint }) {
  const aIn = p.inputMint.equals(p.mintA);
  const [inMint, outMint, inVault, outVault, inProgram, outProgram] = aIn
    ? [p.mintA, p.mintB, p.vaultA, p.vaultB, p.programA, p.programB]
    : [p.mintB, p.mintA, p.vaultB, p.vaultA, p.programB, p.programA];
  return ix(CPMM_PROGRAM, [
    meta(p.user, false, true), meta(CPMM_AUTHORITY), meta(p.config), meta(p.pool, true),
    meta(ata(inMint, p.user, inProgram), true), meta(ata(outMint, p.user, outProgram), true),
    meta(inVault, true), meta(outVault, true), meta(inProgram), meta(outProgram), meta(inMint), meta(outMint), meta(p.observation, true),
  ], concat(SWAP_BASE_INPUT, u64(p.amountIn), u64(p.minOut)));
}

export type AmmV4Pool = { pool: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; baseMint: PublicKey; quoteMint: PublicKey };
export const decodeAmmV4 = (pool: PublicKey, d: Uint8Array): AmmV4Pool => ({ pool, baseVault: readKey(d, 336), quoteVault: readKey(d, 368), baseMint: readKey(d, 400), quoteMint: readKey(d, 432) });

/** AMM v4 only supports classic SPL Token mints. */
export function ammV4Swap(p: AmmV4Pool & { user: PublicKey; inputMint: PublicKey; amountIn: bigint; minOut: bigint }) {
  const outMint = p.inputMint.equals(p.baseMint) ? p.quoteMint : p.baseMint;
  return ix(AMM_V4_PROGRAM, [
    meta(TOKEN_PROGRAM), meta(p.pool, true), meta(AMM_V4_AUTHORITY), meta(p.baseVault, true), meta(p.quoteVault, true),
    meta(ata(p.inputMint, p.user, TOKEN_PROGRAM), true), meta(ata(outMint, p.user, TOKEN_PROGRAM), true), meta(p.user, false, true),
  ], concat([16], u64(p.amountIn), u64(p.minOut)));
}

/** Pools holding both mints, in either orientation. */
export async function poolsByMints(c: DiscoveryContext, program: PublicKey, dataSize: number, offsetA: number, offsetB: number) {
  const [a, b] = [c.mint.toBase58(), SOL_MINT.toBase58()];
  const lists = await Promise.all([[a, b], [b, a]].map(([x, y]) => c.rpc.getProgramAccounts(program, [{ dataSize }, { memcmp: { offset: offsetA, bytes: x } }, { memcmp: { offset: offsetB, bytes: y } }])));
  return lists.flat();
}

/** Standard SOL-wrapping envelope around a single token-to-token swap instruction. */
export function wrapped(c: DiscoveryContext, swap: (amountIn: bigint, minOut: bigint) => ReturnType<typeof ix>) {
  const { side, user, mint, mintProgram } = c;
  return ({ amountIn, minOut, measure }: { amountIn: bigint; minOut: bigint; measure?: boolean }) => side === 'buy'
    ? [...wrapSol(user, amountIn), createAtaIdempotent(user, user, mint, mintProgram), swap(amountIn, minOut), unwrapSol(user)]
    : [createAtaIdempotent(user, user, SOL_MINT, TOKEN_PROGRAM), swap(amountIn, minOut), ...(measure ? [] : [unwrapSol(user)])];
}
export const wrappedOutput = (c: DiscoveryContext) => ({ kind: 'token' as const, account: c.side === 'buy' ? ata(c.mint, c.user, c.mintProgram) : ata(SOL_MINT, c.user, TOKEN_PROGRAM) });

async function solVaultBalances(c: DiscoveryContext, vaults: PublicKey[]) {
  const accounts = vaults.length ? await c.rpc.getAccounts(vaults) : [];
  return accounts.map(a => a ? tokenAmount(a.data) : BigInt(0));
}

export async function discoverRaydium(c: DiscoveryContext): Promise<Route[]> {
  const inputMint = c.side === 'buy' ? SOL_MINT : c.mint;
  const [cpmm, v4] = await Promise.all([
    poolsByMints(c, CPMM_PROGRAM, CPMM_POOL_SIZE, 168, 200),
    c.mintProgram.equals(TOKEN_PROGRAM) ? poolsByMints(c, AMM_V4_PROGRAM, AMM_V4_SIZE, 400, 432) : Promise.resolve([]),
  ]);
  const cp = cpmm.map(p => decodeCpmm(p.pubkey, p.account.data)), am = v4.map(p => decodeAmmV4(p.pubkey, p.account.data));
  const balances = await solVaultBalances(c, [...cp.map(p => p.mintA.equals(SOL_MINT) ? p.vaultA : p.vaultB), ...am.map(p => p.baseMint.equals(SOL_MINT) ? p.baseVault : p.quoteVault)]);
  return [
    ...cp.map((p, i): Route => ({ venue: 'raydium-cpmm', pool: p.pool.toBase58(), liquidity: balances[i], output: wrappedOutput(c), instructions: wrapped(c, (amountIn, minOut) => cpmmSwap({ ...p, user: c.user, inputMint, amountIn, minOut })) })),
    ...am.map((p, i): Route => ({ venue: 'raydium-amm-v4', pool: p.pool.toBase58(), liquidity: balances[cp.length + i], output: wrappedOutput(c), instructions: wrapped(c, (amountIn, minOut) => ammV4Swap({ ...p, user: c.user, inputMint, amountIn, minOut })) })),
  ];
}
