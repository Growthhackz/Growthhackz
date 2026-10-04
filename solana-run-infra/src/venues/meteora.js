import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import { createRequire } from 'node:module';

// Meteora DLMM pools. Loaded through require() for the same reason as in
// teardown.js: the package's ESM build fails to resolve under Node.
const require = createRequire(import.meta.url);
const mod = require('@meteora-ag/dlmm');
const DLMM = typeof mod.create === 'function' ? mod : (mod.default ?? mod.DLMM);

export const PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const SOL = NATIVE_MINT.toBase58();

async function load(connection, pool) {
  const info = await connection.getAccountInfo(new PublicKey(pool), 'confirmed');
  if (!info) throw new Error(`pool not found: ${pool}`);
  if (info.owner.toBase58() !== PROGRAM_ID) throw new Error('not a Meteora DLMM pool');
  const dlmm = await DLMM.create(connection, new PublicKey(pool));
  const x = dlmm.tokenX.publicKey.toBase58();
  const y = dlmm.tokenY.publicKey.toBase58();
  if (x !== SOL && y !== SOL) throw new Error('Meteora pool is not paired with SOL');
  return { dlmm, x, y, solIsX: x === SOL, tokenMint: x === SOL ? y : x };
}

export async function describePool(connection, pool) {
  const { dlmm, solIsX, tokenMint } = await load(connection, pool);
  // Active-bin price is raw Y per raw X.
  const yPerX = Number((await dlmm.getActiveBin()).price);
  return { tokenMint, kind: 'DLMM', lamportsPerRaw: solIsX ? 1 / yPerX : yPerX };
}

// side 'buy': spend `amountIn` lamports. side 'sell': sell `amountIn` raw tokens.
export async function buildSwap({ connection, owner, pool, side, amountIn, slippageBps }) {
  const { dlmm, x, tokenMint } = await load(connection, pool);
  const inToken = side === 'buy' ? SOL : tokenMint;
  const outToken = side === 'buy' ? tokenMint : SOL;
  const swapForY = inToken === x;
  const amt = new BN(amountIn.toString());

  const binArrays = await dlmm.getBinArrayForSwap(swapForY);
  const quote = dlmm.swapQuote(amt, swapForY, new BN(slippageBps), binArrays);
  const tx = await dlmm.swap({
    inToken: new PublicKey(inToken),
    outToken: new PublicKey(outToken),
    inAmount: amt,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmm.pubkey,
    user: owner,
    binArraysPubkey: quote.binArraysPubkey
  });
  // The SDK returns a legacy transaction with its own compute budget; keep only
  // the swap instructions so the shared builder can size the budget itself.
  const instructions = tx.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId)
  );
  return { instructions, expectedOut: BigInt(quote.outAmount.toString()), tokenMint };
}
