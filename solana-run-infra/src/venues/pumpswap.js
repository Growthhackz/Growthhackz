import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import { createRequire } from 'node:module';

// CommonJS build: the package's ESM entry has the same resolution problems as the DLMM SDK.
const require = createRequire(import.meta.url);
const pump = require('@pump-fun/pump-swap-sdk');

export const PROGRAM_ID = pump.PUMP_AMM_PROGRAM_ID.toBase58();
const offline = new pump.PumpAmmSdk();
const onlineCache = new WeakMap();
const online = (connection) => {
  if (!onlineCache.has(connection)) onlineCache.set(connection, new pump.OnlinePumpAmmSdk(connection));
  return onlineCache.get(connection);
};

// The canonical pool a pump.fun token graduates into (token / SOL, index 0).
export function canonicalPool(mint) {
  const pda = pump.canonicalPumpPoolPda(new PublicKey(mint));
  return (Array.isArray(pda) ? pda[0] : pda).toBase58();
}

async function state(connection, pool, owner) {
  let s;
  try {
    s = await online(connection).swapSolanaState(new PublicKey(pool), owner);
  } catch (e) {
    if (/not found/i.test(e?.message ?? '')) {
      throw new Error(`no PumpSwap pool at ${pool}; if the token is still on its bonding curve, use the pump.fun venue`);
    }
    throw e;
  }
  const solIsQuote = s.pool.quoteMint.equals(NATIVE_MINT);
  const solIsBase = s.pool.baseMint.equals(NATIVE_MINT);
  if (!solIsQuote && !solIsBase) throw new Error('PumpSwap pool is not paired with SOL');
  return { s, solIsQuote, tokenMint: (solIsQuote ? s.pool.baseMint : s.pool.quoteMint).toBase58() };
}

const pct = (slippageBps) => slippageBps / 100;

export async function describePool(connection, pool, owner) {
  const { s, solIsQuote, tokenMint } = await state(connection, pool, owner);
  // Pricing uses the pool's virtual quote reserves on top of the real ones.
  const quote = s.poolQuoteAmount.add(s.pool.virtualQuoteReserves ?? new BN(0));
  const [solReserve, tokenReserve] = solIsQuote
    ? [quote, s.poolBaseAmount]
    : [s.poolBaseAmount, quote];
  return {
    tokenMint,
    kind: 'pumpswap',
    lamportsPerRaw: Number(solReserve.toString()) / Number(tokenReserve.toString())
  };
}

// side 'buy': spend `amountIn` lamports on the token. side 'sell': sell `amountIn` raw tokens.
export async function buildSwap({ connection, owner, pool, side, amountIn, slippageBps }) {
  const { s, solIsQuote, tokenMint } = await state(connection, pool, owner);
  const amt = new BN(amountIn.toString());
  let instructions;
  let expectedOut;

  if (solIsQuote) {
    if (side === 'buy') {
      const r = pump.buyQuoteInput({ ...quoteArgs(s), quote: amt, slippage: pct(slippageBps) });
      expectedOut = r.base;
      instructions = await offline.buyQuoteInput(s, amt, pct(slippageBps));
    } else {
      const r = pump.sellBaseInput({ ...quoteArgs(s), base: amt, slippage: pct(slippageBps) });
      expectedOut = r.uiQuote ?? r.quote;
      instructions = await offline.sellBaseInput(s, amt, pct(slippageBps));
    }
  } else {
    // Reversed pool (SOL is the base): buying the token means selling base SOL.
    if (side === 'buy') {
      const r = pump.sellBaseInput({ ...quoteArgs(s), base: amt, slippage: pct(slippageBps) });
      expectedOut = r.uiQuote ?? r.quote;
      instructions = await offline.sellBaseInput(s, amt, pct(slippageBps));
    } else {
      const r = pump.buyQuoteInput({ ...quoteArgs(s), quote: amt, slippage: pct(slippageBps) });
      expectedOut = r.base;
      instructions = await offline.buyQuoteInput(s, amt, pct(slippageBps));
    }
  }
  return { instructions, expectedOut: BigInt(expectedOut.toString()), tokenMint };
}

function quoteArgs(s) {
  return {
    baseReserve: s.poolBaseAmount,
    quoteReserve: s.poolQuoteAmount,
    globalConfig: s.globalConfig,
    baseMintAccount: s.baseMintAccount,
    baseMint: s.baseMint,
    coinCreator: s.pool.coinCreator,
    creator: s.pool.creator,
    feeConfig: s.feeConfig,
    quoteMint: s.pool.quoteMint,
    virtualQuoteReserves: s.pool.virtualQuoteReserves,
    isMayhemMode: s.pool.isMayhemMode,
    creatorFeeBps: s.pool.creatorFeeBps
  };
}
