import {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction
} from '@solana/web3.js';
import * as pumpswap from './pumpswap.js';
import * as raydium from './raydium.js';

export const VENUES = { pumpswap, raydium };
export const VENUE_NAMES = Object.keys(VENUES);

function venue(name) {
  const v = VENUES[name];
  if (!v) throw new Error(`unknown venue: ${name}`);
  return v;
}

// The pool a wallet trades: its configured pool, or for PumpSwap the token's
// canonical graduated pool when none is set.
export function resolvePool({ venue: name, pool, mint }) {
  if (pool) return pool;
  if (name === 'pumpswap' && mint) return pumpswap.canonicalPool(mint);
  throw new Error('set a pool address for this wallet');
}

// Reads the pool and checks it pairs SOL with the wallet's token.
export async function inspectPool(connection, { venue: name, pool, mint }, owner) {
  const addr = resolvePool({ venue: name, pool, mint });
  const d = await venue(name).describePool(connection, addr, owner ?? PublicKey.default);
  if (mint && d.tokenMint !== mint) {
    throw new Error(`pool ${addr} trades ${d.tokenMint}, not ${mint}`);
  }
  return { pool: addr, ...d };
}

// SOL per 1 whole token.
export async function getPrice(connection, settings, decimals) {
  const d = await inspectPool(connection, settings);
  return d.lamportsPerRaw * 10 ** decimals / 1e9;
}

// Builds an unsigned swap transaction on the wallet's venue and pool.
export async function buildSwap({ connection, owner, settings, side, amountIn }) {
  const { venue: name, slippageBps, priorityMicroLamports } = settings;
  const pool = resolvePool(settings);
  const built = await venue(name).buildSwap({
    connection, owner, pool, side, amountIn, slippageBps, priorityMicroLamports
  });
  if (settings.mint && built.tokenMint !== settings.mint) {
    throw new Error(`pool ${pool} trades ${built.tokenMint}, not ${settings.mint}`);
  }
  if (built.transaction) return { ...built, pool };

  // Venues that return bare instructions (PumpSwap) get wrapped here.
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
      ...built.instructions
    ]
  }).compileToV0Message();
  return {
    transaction: new VersionedTransaction(message),
    signers: [],
    expectedOut: built.expectedOut,
    tokenMint: built.tokenMint,
    pool
  };
}

export async function sendSwap(connection, wallet, { transaction, signers }) {
  transaction.sign([wallet, ...signers]);
  const { lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false, maxRetries: 3
  });
  const { value } = await connection.confirmTransaction({
    signature,
    blockhash: transaction.message.recentBlockhash,
    lastValidBlockHeight
  }, 'confirmed');
  if (value.err) throw new Error(`swap failed on-chain: ${JSON.stringify(value.err)}`);
  return signature;
}
