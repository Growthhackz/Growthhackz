import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ray = require('@raydium-io/raydium-sdk-v2');

const SOL = NATIVE_MINT.toBase58();
export const PROGRAMS = {
  amm: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
};

// Raydium.load with every network-dependent feature off: pools are read
// straight from RPC, nothing from Raydium's HTTP API.
async function sdk(connection, owner) {
  return ray.Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'confirmed'
  });
}

export async function poolKind(connection, pool) {
  const info = await connection.getAccountInfo(new PublicKey(pool), 'confirmed');
  if (!info) throw new Error(`pool not found: ${pool}`);
  const owner = info.owner.toBase58();
  const kind = Object.keys(PROGRAMS).find((k) => PROGRAMS[k] === owner);
  if (!kind) throw new Error('not a Raydium AMM v4, CPMM or CLMM pool');
  return kind;
}

const mintsOf = (poolInfo) => [poolInfo.mintA.address, poolInfo.mintB.address];

function solPair(poolInfo) {
  const [a, b] = mintsOf(poolInfo);
  if (a !== SOL && b !== SOL) throw new Error('Raydium pool is not paired with SOL');
  return { tokenMint: a === SOL ? b : a, solIsA: a === SOL };
}

async function load(connection, pool, owner) {
  const kind = await poolKind(connection, pool);
  const r = await sdk(connection, owner);
  if (kind === 'amm') {
    const d = await r.liquidity.getPoolInfoFromRpc({ poolId: pool });
    return { kind, r, d, poolInfo: d.poolInfo };
  }
  if (kind === 'cpmm') {
    const d = await r.cpmm.getPoolInfoFromRpc(pool);
    return { kind, r, d, poolInfo: d.poolInfo };
  }
  const d = await r.clmm.getPoolInfoFromRpc(pool);
  return { kind, r, d, poolInfo: d.poolInfo };
}

export async function describePool(connection, pool, owner) {
  const { kind, d, poolInfo } = await load(connection, pool, owner);
  const { tokenMint, solIsA } = solPair(poolInfo);
  let price; // lamports per raw token unit
  if (kind === 'clmm') {
    // currentPrice is B per A in UI units.
    const ui = Number(d.computePoolInfo.currentPrice);
    const decA = poolInfo.mintA.decimals, decB = poolInfo.mintB.decimals;
    const bPerA = ui * 10 ** (decB - decA);
    price = solIsA ? 1 / bPerA : bPerA;
  } else {
    const rpc = kind === 'amm' ? d.poolRpcData : d.rpcData;
    const a = Number(rpc.baseReserve.toString()), b = Number(rpc.quoteReserve.toString());
    price = solIsA ? a / b : b / a;
  }
  return { tokenMint, kind, lamportsPerRaw: price };
}

// side 'buy': spend `amountIn` lamports on the token. side 'sell': sell `amountIn` raw tokens.
// Returns an unsigned VersionedTransaction plus any extra signers Raydium needs.
export async function buildSwap({
  connection, owner, pool, side, amountIn, slippageBps, priorityMicroLamports
}) {
  const { kind, r, d, poolInfo } = await load(connection, pool, owner);
  const { tokenMint } = solPair(poolInfo);
  const inputMint = side === 'buy' ? SOL : tokenMint;
  const outputMint = side === 'buy' ? tokenMint : SOL;
  const amount = new BN(amountIn.toString());
  const slippage = slippageBps / 10_000;
  const common = {
    txVersion: ray.TxVersion.V0,
    computeBudgetConfig: { units: 400_000, microLamports: priorityMicroLamports }
  };

  let built, expectedOut;
  if (kind === 'amm') {
    const rpc = d.poolRpcData;
    const out = r.liquidity.computeAmountOut({
      poolInfo: {
        ...poolInfo,
        baseReserve: rpc.baseReserve,
        quoteReserve: rpc.quoteReserve,
        status: rpc.status.toNumber(),
        version: 4
      },
      amountIn: amount, mintIn: inputMint, mintOut: outputMint, slippage
    });
    expectedOut = out.amountOut;
    built = await r.liquidity.swap({
      poolInfo, poolKeys: d.poolKeys,
      amountIn: amount, amountOut: out.minAmountOut,
      fixedSide: 'in', inputMint,
      config: { inputUseSolBalance: true, outputUseSolBalance: true, associatedOnly: true },
      ...common
    });
  } else if (kind === 'cpmm') {
    const rpc = d.rpcData;
    const baseIn = inputMint === poolInfo.mintA.address;
    const feeOn = rpc.feeOn;
    const creatorFeeOnInput = feeOn === 0 || (feeOn === 1 && baseIn) || (feeOn === 2 && !baseIn);
    const swapResult = ray.CurveCalculator.swapBaseInput(
      amount,
      baseIn ? rpc.baseReserve : rpc.quoteReserve,
      baseIn ? rpc.quoteReserve : rpc.baseReserve,
      rpc.configInfo.tradeFeeRate,
      rpc.configInfo.creatorFeeRate ?? new BN(0),
      rpc.configInfo.protocolFeeRate,
      rpc.configInfo.fundFeeRate,
      creatorFeeOnInput
    );
    expectedOut = swapResult.outputAmount;
    built = await r.cpmm.swap({
      poolInfo, poolKeys: d.poolKeys, inputAmount: amount, swapResult, slippage, baseIn, ...common
    });
  } else {
    const baseIn = inputMint === poolInfo.mintA.address;
    const [epochInfo, slot] = await Promise.all([
      connection.getEpochInfo('confirmed'), connection.getSlot('confirmed')
    ]);
    const blockTimestamp = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const out = await ray.PoolUtils.computeAmountOutFormat({
      poolInfo: d.computePoolInfo,
      tickarrayBitmapExtension: d.computePoolInfo.exBitmapInfo,
      tickArrayCache: d.tickData[pool],
      amountIn: amount,
      tokenOut: poolInfo[baseIn ? 'mintB' : 'mintA'],
      slippage,
      epochInfo,
      blockTimestamp
    });
    expectedOut = out.amountOut.amount.raw;
    built = await r.clmm.swap({
      poolInfo, poolKeys: d.poolKeys, inputMint,
      amountIn: amount, amountOutMin: out.minAmountOut.amount.raw,
      observationId: d.computePoolInfo.observationId,
      ownerInfo: { useSOLBalance: true },
      remainingAccounts: out.remainingAccounts,
      ...common
    });
  }

  return {
    transaction: built.transaction,
    signers: built.signers ?? [],
    expectedOut: BigInt(expectedOut.toString()),
    tokenMint
  };
}
