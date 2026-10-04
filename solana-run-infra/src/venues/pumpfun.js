import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, getMint } from '@solana/spl-token';
import BN from 'bn.js';
import { createRequire } from 'node:module';

// pump.fun bonding curve: tokens that have not graduated to PumpSwap yet.
const require = createRequire(import.meta.url);
const pump = require('@pump-fun/pump-sdk');

export const PROGRAM_ID = pump.PUMP_PROGRAM_ID.toBase58();
const offline = pump.PUMP_SDK;
const onlineCache = new WeakMap();
const online = (connection) => {
  if (!onlineCache.has(connection)) onlineCache.set(connection, new pump.OnlinePumpSdk(connection));
  return onlineCache.get(connection);
};

// The curve account is derived from the mint, so the "pool" is always this PDA.
export function curveAddress(mint) {
  return pump.bondingCurvePda(new PublicKey(mint)).toBase58();
}

const pct = (slippageBps) => slippageBps / 100;

async function mintInfo(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`mint not found: ${mint.toBase58()}`);
  const parsed = await getMint(connection, mint, 'confirmed', info.owner);
  return { tokenProgram: info.owner, supply: new BN(parsed.supply.toString()) };
}

function checkCurve(curve, mint) {
  if (curve.complete) {
    throw new Error(`${mint} has graduated from its bonding curve; trade it on the PumpSwap venue`);
  }
  const quote = curve.quoteMint;
  if (quote && !quote.equals(PublicKey.default) && !quote.equals(NATIVE_MINT)) {
    throw new Error('this bonding curve is not priced in SOL');
  }
}

export async function describePool(connection, _pool, _owner, { mint }) {
  if (!mint) throw new Error('set the token mint for a pump.fun bonding-curve wallet');
  const curve = await online(connection).fetchBondingCurve(new PublicKey(mint));
  checkCurve(curve, mint);
  return {
    tokenMint: mint,
    kind: 'bonding curve',
    lamportsPerRaw: Number(curve.virtualQuoteReserves.toString()) /
      Number(curve.virtualTokenReserves.toString())
  };
}

// side 'buy': spend `amountIn` lamports. side 'sell': sell `amountIn` raw tokens.
export async function buildSwap({ connection, owner, mint: mintStr, side, amountIn, slippageBps }) {
  if (!mintStr) throw new Error('set the token mint for a pump.fun bonding-curve wallet');
  const sdk = online(connection);
  const mint = new PublicKey(mintStr);
  const amt = new BN(amountIn.toString());
  const [{ tokenProgram, supply }, global, feeConfig] = await Promise.all([
    mintInfo(connection, mint), sdk.fetchGlobal(), sdk.fetchFeeConfig()
  ]);

  if (side === 'buy') {
    const state = await sdk.fetchBuyState(mint, owner, tokenProgram);
    checkCurve(state.bondingCurve, mintStr);
    const tokens = pump.getBuyTokenAmountFromSolAmount({
      global, feeConfig, mintSupply: supply, bondingCurve: state.bondingCurve,
      amount: amt, quoteMint: state.quoteMint
    });
    const instructions = await offline.buyV2Instructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint, user: owner, amount: tokens, quoteAmount: amt,
      slippage: pct(slippageBps), tokenProgram, quoteTokenProgram: state.quoteTokenProgram
    });
    return { instructions, expectedOut: BigInt(tokens.toString()), tokenMint: mintStr };
  }

  const state = await sdk.fetchSellState(mint, owner, tokenProgram);
  checkCurve(state.bondingCurve, mintStr);
  const sol = pump.getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply: supply, bondingCurve: state.bondingCurve, amount: amt
  });
  const instructions = await offline.sellV2Instructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    mint, user: owner, amount: amt, quoteAmount: sol,
    slippage: pct(slippageBps), tokenProgram, quoteTokenProgram: state.quoteTokenProgram
  });
  return { instructions, expectedOut: BigInt(sol.toString()), tokenMint: mintStr };
}
