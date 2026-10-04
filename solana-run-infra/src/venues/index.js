import {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction
} from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import * as raydium from './raydium.js';
import * as pumpswap from './pumpswap.js';
import * as meteora from './meteora.js';
import * as pumpfun from './pumpfun.js';

export const VENUES = { raydium, pumpswap, meteora, pumpfun };
export const VENUE_NAMES = Object.keys(VENUES);

function venue(name) {
  const v = VENUES[name];
  if (!v) throw new Error(`unknown venue: ${name}`);
  return v;
}

// The pool a wallet trades. pump.fun curves are derived from the mint;
// PumpSwap falls back to the token's canonical graduated pool.
export function resolvePool({ venue: name, pool, mint }) {
  if (name === 'pumpfun') {
    if (!mint) throw new Error('set the token mint for a pump.fun bonding-curve wallet');
    return pumpfun.curveAddress(mint);
  }
  if (pool) return pool;
  if (name === 'pumpswap' && mint) return pumpswap.canonicalPool(mint);
  throw new Error('set a pool address for this wallet');
}

// Reads the pool and checks it pairs SOL with the wallet's token.
export async function inspectPool(connection, { venue: name, pool, mint }, owner) {
  const addr = resolvePool({ venue: name, pool, mint });
  const d = await venue(name).describePool(connection, addr, owner ?? PublicKey.default, { mint });
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

// ---- transaction cost ------------------------------------------------------

const CU_MAX = 1_400_000;
// Headroom over the simulated usage: execution can touch a little more state
// (another bin array, another tick) than the simulation did.
const cuLimitFor = (used) => Math.min(CU_MAX, Math.max(Math.ceil(used * 1.15), used + 15_000));
const AUTO_PERCENTILE = 0.6;
const AUTO_FLOOR = 1_000;

async function lookupTables(connection, message) {
  return Promise.all(message.addressTableLookups.map(async ({ accountKey }) => {
    const { value } = await connection.getAddressLookupTable(accountKey);
    if (!value) throw new Error(`lookup table not found: ${accountKey.toBase58()}`);
    return value;
  }));
}

// A venue's swap reduced to its instructions (minus any compute budget it
// set), the lookup tables it relies on and any extra signers.
async function swapCore(connection, built) {
  if (built.instructions) {
    return {
      ixs: built.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)),
      luts: [],
      signers: []
    };
  }
  const luts = await lookupTables(connection, built.transaction.message);
  const msg = TransactionMessage.decompile(built.transaction.message, { addressLookupTableAccounts: luts });
  return {
    ixs: msg.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)),
    luts,
    signers: built.signers ?? []
  };
}

function compile(owner, blockhash, ixs, luts, units, microLamports) {
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  const message = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash, instructions: [...budget, ...ixs]
  }).compileToV0Message(luts);
  return new VersionedTransaction(message);
}

async function simulate(connection, tx) {
  const { value } = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed'
  });
  return value;
}

function simulationError(value) {
  const hint = (value.logs ?? [])
    .filter((l) => /error|failed|exceed|insufficient|slippage/i.test(l))
    .slice(-2).join(' | ');
  return new Error(`swap would fail, not sent: ${JSON.stringify(value.err)}${hint ? ` (${hint})` : ''}`);
}

// µlamports per CU. Fixed mode uses the wallet's number; auto mode uses a
// recent percentile of what was paid to write the same accounts, capped at it.
async function priorityFor(connection, message, settings) {
  const cap = settings.priorityMicroLamports;
  if (settings.priorityMode !== 'auto') return cap;
  const writable = message.staticAccountKeys
    .filter((_, i) => message.isAccountWritable(i) && !message.isAccountSigner(i))
    .slice(0, 128);
  let fees = [];
  try {
    fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable });
  } catch { /* RPC without the method: fall back to the floor */ }
  const vals = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
  const pick = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * AUTO_PERCENTILE))] : 0;
  return Math.min(cap, Math.max(AUTO_FLOOR, pick));
}

// ---- build and send --------------------------------------------------------

// Builds a ready-to-sign swap on the wallet's venue and pool, sized from a
// simulation. With `closeTokenAccount` (a sell that empties the wallet's token
// account) the account is closed in the same transaction to return its rent.
export async function buildSwap({ connection, owner, settings, side, amountIn, closeTokenAccount = false }) {
  const pool = resolvePool(settings);
  const built = await venue(settings.venue).buildSwap({
    connection, owner, pool, mint: settings.mint, side, amountIn,
    slippageBps: settings.slippageBps, priorityMicroLamports: settings.priorityMicroLamports
  });
  if (settings.mint && built.tokenMint !== settings.mint) {
    throw new Error(`pool ${pool} trades ${built.tokenMint}, not ${settings.mint}`);
  }
  const { ixs, luts, signers } = await swapCore(connection, built);

  let close = [];
  if (closeTokenAccount && side === 'sell') {
    const mint = new PublicKey(built.tokenMint);
    const info = await connection.getAccountInfo(mint, 'confirmed');
    const ata = getAssociatedTokenAddressSync(mint, owner, false, info.owner);
    close = [createCloseAccountInstruction(ata, owner, owner, [], info.owner)];
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  let core = [...ixs, ...close];
  let sim = await simulate(connection, compile(owner, blockhash, core, luts, CU_MAX, 0));
  if (sim.err && close.length) {
    // Some accounts can't be closed (e.g. Token-2022 withheld fees); sell without closing.
    core = ixs;
    close = [];
    sim = await simulate(connection, compile(owner, blockhash, core, luts, CU_MAX, 0));
  }
  if (sim.err) throw simulationError(sim);

  const unitsUsed = sim.unitsConsumed ?? 200_000;
  const units = cuLimitFor(unitsUsed);
  const microLamports = await priorityFor(
    connection, compile(owner, blockhash, core, luts, units, 0).message, settings
  );
  const transaction = compile(owner, blockhash, core, luts, units, microLamports);
  const feeLamports = 5_000 * (1 + signers.length) + Math.ceil(units * microLamports / 1e6);

  return {
    transaction,
    signers,
    lastValidBlockHeight,
    expectedOut: built.expectedOut,
    tokenMint: built.tokenMint,
    pool,
    closedAccount: close.length > 0,
    cost: { units, unitsUsed, microLamports, feeLamports }
  };
}

export async function sendSwap(connection, wallet, { transaction, signers, lastValidBlockHeight }) {
  transaction.sign([wallet, ...signers]);
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
