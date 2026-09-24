// Pump.fun bonding curve (pre-migration) and PumpSwap (canonical post-migration pool).
// Account lists follow the official IDLs (@pump-fun/pump-sdk 2.0.0, @pump-fun/pump-swap-sdk 1.20.0);
// tests/venues.ts checks them byte-for-byte against those SDKs' own builders.
import { PublicKey } from '@solana/web3.js';
import { SOL_MINT, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM, ata, pda, pk, meta, ix, concat, u64, readU64, readKey, readKeyIfPresent, readBool, hasPrefix, tokenAmount, createAtaIdempotent, wrapSol, unwrapSol } from '../solana';
import { type DiscoveryContext, type Route, randomPick } from './types';

export const PUMP_PROGRAM = pk('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM_PROGRAM = pk('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_FEE_PROGRAM = pk('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

const DISC = {
  global: [167, 232, 232, 177, 200, 108, 114, 127],
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  ammGlobalConfig: [149, 8, 156, 202, 160, 252, 176, 217],
  ammPool: [241, 154, 109, 4, 17, 177, 109, 188],
  buyExactSolIn: [56, 252, 116, 8, 158, 223, 205, 95],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  buyExactQuoteIn: [198, 46, 21, 82, 180, 217, 232, 112],
  extendAccount: [234, 102, 194, 203, 150, 72, 62, 229],
};
const TRACK_VOLUME = [1]; // OptionBool(true), as the official SDK sends it

const pumpPda = (...seeds: (Uint8Array | string)[]) => pda(seeds, PUMP_PROGRAM);
const ammPda = (...seeds: (Uint8Array | string)[]) => pda(seeds, PUMP_AMM_PROGRAM);
export const PUMP = {
  global: pumpPda('global'),
  eventAuthority: pumpPda('__event_authority'),
  globalVolumeAccumulator: pumpPda('global_volume_accumulator'),
  feeConfig: pda(['fee_config', PUMP_PROGRAM.toBytes()], PUMP_FEE_PROGRAM),
  bondingCurve: (mint: PublicKey) => pumpPda('bonding-curve', mint.toBytes()),
  bondingCurveV2: (mint: PublicKey) => pumpPda('bonding-curve-v2', mint.toBytes()),
  creatorVault: (creator: PublicKey) => pumpPda('creator-vault', creator.toBytes()),
  userVolumeAccumulator: (user: PublicKey) => pumpPda('user_volume_accumulator', user.toBytes()),
  poolAuthority: (mint: PublicKey) => pumpPda('pool-authority', mint.toBytes()),
};
export const AMM = {
  globalConfig: ammPda('global_config'),
  eventAuthority: ammPda('__event_authority'),
  globalVolumeAccumulator: ammPda('global_volume_accumulator'),
  feeConfig: pda(['fee_config', PUMP_AMM_PROGRAM.toBytes()], PUMP_FEE_PROGRAM),
  canonicalPool: (mint: PublicKey) => ammPda('pool', new Uint8Array(2), PUMP.poolAuthority(mint).toBytes(), mint.toBytes(), SOL_MINT.toBytes()),
  poolV2: (mint: PublicKey) => ammPda('pool-v2', mint.toBytes()),
  creatorVaultAuthority: (coinCreator: PublicKey) => ammPda('creator_vault', coinCreator.toBytes()),
  userVolumeAccumulator: (user: PublicKey) => ammPda('user_volume_accumulator', user.toBytes()),
};

const keys = (d: Uint8Array, offset: number, count: number) => Array.from({ length: count }, (_, i) => readKeyIfPresent(d, offset + 32 * i)).filter(k => !k.equals(PublicKey.default));

// ---- Pump.fun bonding curve --------------------------------------------------

export type PumpCurve = { creator: PublicKey; isMayhemMode: boolean; isCashbackCoin: boolean };
export type PumpRecipients = { feeRecipient: PublicKey; buybackFeeRecipient: PublicKey };

export function decodePumpGlobalRecipients(d: Uint8Array, mayhem: boolean, pick = randomPick): PumpRecipients {
  if (!hasPrefix(d, DISC.global)) throw Error('Unexpected pump global account.');
  const fee = mayhem ? [readKeyIfPresent(d, 483), ...keys(d, 516, 7)] : [readKey(d, 41), ...keys(d, 162, 7)];
  const feeRecipients = fee.filter(k => !k.equals(PublicKey.default)), buyback = keys(d, 741, 8);
  if (!feeRecipients.length || !buyback.length) throw Error('Pump fee recipients are not configured.');
  return { feeRecipient: feeRecipients[pick(feeRecipients.length)], buybackFeeRecipient: buyback[pick(buyback.length)] };
}

export function pumpCurveBuy(a: PumpCurve & PumpRecipients & { user: PublicKey; mint: PublicKey; tokenProgram: PublicKey; spendableSolIn: bigint; minTokensOut: bigint }) {
  const curve = PUMP.bondingCurve(a.mint);
  return ix(PUMP_PROGRAM, [
    meta(PUMP.global), meta(a.feeRecipient, true), meta(a.mint), meta(curve, true), meta(ata(a.mint, curve, a.tokenProgram), true),
    meta(ata(a.mint, a.user, a.tokenProgram), true), meta(a.user, true, true), meta(SYSTEM_PROGRAM), meta(a.tokenProgram),
    meta(PUMP.creatorVault(a.creator), true), meta(PUMP.eventAuthority), meta(PUMP_PROGRAM), meta(PUMP.globalVolumeAccumulator),
    meta(PUMP.userVolumeAccumulator(a.user), true), meta(PUMP.feeConfig), meta(PUMP_FEE_PROGRAM),
    meta(PUMP.bondingCurveV2(a.mint)), meta(a.buybackFeeRecipient, true),
  ], concat(DISC.buyExactSolIn, u64(a.spendableSolIn), u64(a.minTokensOut), TRACK_VOLUME));
}

export function pumpCurveSell(a: PumpCurve & PumpRecipients & { user: PublicKey; mint: PublicKey; tokenProgram: PublicKey; amount: bigint; minSolOutput: bigint }) {
  const curve = PUMP.bondingCurve(a.mint);
  return ix(PUMP_PROGRAM, [
    meta(PUMP.global), meta(a.feeRecipient, true), meta(a.mint), meta(curve, true), meta(ata(a.mint, curve, a.tokenProgram), true),
    meta(ata(a.mint, a.user, a.tokenProgram), true), meta(a.user, true, true), meta(SYSTEM_PROGRAM), meta(PUMP.creatorVault(a.creator), true),
    meta(a.tokenProgram), meta(PUMP.eventAuthority), meta(PUMP_PROGRAM), meta(PUMP.feeConfig), meta(PUMP_FEE_PROGRAM),
    ...(a.isCashbackCoin ? [meta(PUMP.userVolumeAccumulator(a.user), true)] : []),
    meta(PUMP.bondingCurveV2(a.mint)), meta(a.buybackFeeRecipient, true),
  ], concat(DISC.sell, u64(a.amount), u64(a.minSolOutput)));
}

// ---- PumpSwap ------------------------------------------------------------------

export type PumpPool = { pool: PublicKey; baseMint: PublicKey; poolBaseTokenAccount: PublicKey; poolQuoteTokenAccount: PublicKey; coinCreator: PublicKey; isMayhemMode: boolean; isCashbackCoin: boolean; needsExtend: boolean };
export type PumpAmmRecipients = { protocolFeeRecipient: PublicKey; buybackFeeRecipient: PublicKey };

export function decodePumpPool(pool: PublicKey, d: Uint8Array): PumpPool {
  if (!hasPrefix(d, DISC.ammPool)) throw Error('Unexpected PumpSwap pool account.');
  return { pool, baseMint: readKey(d, 43), poolBaseTokenAccount: readKey(d, 139), poolQuoteTokenAccount: readKey(d, 171), coinCreator: readKey(d, 211), isMayhemMode: readBool(d, 243), isCashbackCoin: readBool(d, 244), needsExtend: d.length < 300 };
}
export const pumpPoolQuoteMint = (d: Uint8Array) => readKey(d, 75);

export function decodePumpAmmRecipients(d: Uint8Array, mayhem: boolean, pick = randomPick): PumpAmmRecipients {
  if (!hasPrefix(d, DISC.ammGlobalConfig)) throw Error('Unexpected PumpSwap global config.');
  const fee = mayhem ? [readKeyIfPresent(d, 385), ...keys(d, 418, 7)] : keys(d, 57, 8), buyback = keys(d, 643, 8);
  const feeRecipients = fee.filter(k => !k.equals(PublicKey.default));
  if (!feeRecipients.length || !buyback.length) throw Error('PumpSwap fee recipients are not configured.');
  return { protocolFeeRecipient: feeRecipients[pick(feeRecipients.length)], buybackFeeRecipient: buyback[pick(buyback.length)] };
}

function ammSwapKeys(p: PumpPool & PumpAmmRecipients & { user: PublicKey; baseTokenProgram: PublicKey }) {
  const quoteProgram = TOKEN_PROGRAM, vaultAuthority = AMM.creatorVaultAuthority(p.coinCreator);
  return [
    meta(p.pool, true), meta(p.user, true, true), meta(AMM.globalConfig), meta(p.baseMint), meta(SOL_MINT),
    meta(ata(p.baseMint, p.user, p.baseTokenProgram), true), meta(ata(SOL_MINT, p.user, quoteProgram), true),
    meta(p.poolBaseTokenAccount, true), meta(p.poolQuoteTokenAccount, true),
    meta(p.protocolFeeRecipient), meta(ata(SOL_MINT, p.protocolFeeRecipient, quoteProgram), true),
    meta(p.baseTokenProgram), meta(quoteProgram), meta(SYSTEM_PROGRAM), meta(ATA_PROGRAM), meta(AMM.eventAuthority), meta(PUMP_AMM_PROGRAM),
    meta(ata(SOL_MINT, vaultAuthority, quoteProgram), true), meta(vaultAuthority),
  ];
}
const ammTail = (p: PumpPool & PumpAmmRecipients) => [
  ...(p.coinCreator.equals(PublicKey.default) ? [] : [meta(AMM.poolV2(p.baseMint))]),
  meta(p.buybackFeeRecipient), meta(ata(SOL_MINT, p.buybackFeeRecipient, TOKEN_PROGRAM), true),
];

export function pumpAmmBuy(p: PumpPool & PumpAmmRecipients & { user: PublicKey; baseTokenProgram: PublicKey; spendableQuoteIn: bigint; minBaseAmountOut: bigint }) {
  return ix(PUMP_AMM_PROGRAM, [
    ...ammSwapKeys(p), meta(AMM.globalVolumeAccumulator), meta(AMM.userVolumeAccumulator(p.user), true), meta(AMM.feeConfig), meta(PUMP_FEE_PROGRAM),
    ...(p.isCashbackCoin ? [meta(ata(SOL_MINT, AMM.userVolumeAccumulator(p.user), TOKEN_PROGRAM), true)] : []),
    ...ammTail(p),
  ], concat(DISC.buyExactQuoteIn, u64(p.spendableQuoteIn), u64(p.minBaseAmountOut), TRACK_VOLUME));
}

export function pumpAmmSell(p: PumpPool & PumpAmmRecipients & { user: PublicKey; baseTokenProgram: PublicKey; baseAmountIn: bigint; minQuoteAmountOut: bigint }) {
  const uva = AMM.userVolumeAccumulator(p.user);
  return ix(PUMP_AMM_PROGRAM, [
    ...ammSwapKeys(p), meta(AMM.feeConfig), meta(PUMP_FEE_PROGRAM),
    ...(p.isCashbackCoin ? [meta(ata(SOL_MINT, uva, TOKEN_PROGRAM), true), meta(uva, true)] : []),
    ...ammTail(p),
  ], concat(DISC.sell, u64(p.baseAmountIn), u64(p.minQuoteAmountOut)));
}

export const pumpAmmExtendPool = (pool: PublicKey, user: PublicKey) =>
  ix(PUMP_AMM_PROGRAM, [meta(pool, true), meta(user, true, true), meta(SYSTEM_PROGRAM), meta(AMM.eventAuthority), meta(PUMP_AMM_PROGRAM)], DISC.extendAccount);

// ---- Discovery -----------------------------------------------------------------

export async function discoverPump(c: DiscoveryContext): Promise<Route[]> {
  const { rpc, side, mint, mintProgram, user } = c, pick = c.pick || randomPick;
  const poolKey = AMM.canonicalPool(mint);
  const [global, curveAccount, ammConfig, poolAccount] = await rpc.getAccounts([PUMP.global, PUMP.bondingCurve(mint), AMM.globalConfig, poolKey]);
  const routes: Route[] = [];
  const userToken = ata(mint, user, mintProgram), userWsol = ata(SOL_MINT, user, TOKEN_PROGRAM);

  if (global && curveAccount && curveAccount.owner === PUMP_PROGRAM.toBase58() && hasPrefix(curveAccount.data, DISC.bondingCurve)) {
    const d = curveAccount.data, quoteMint = readKeyIfPresent(d, 83);
    const open = readU64(d, 8) > BigInt(0) && !readBool(d, 48) && (quoteMint.equals(PublicKey.default) || quoteMint.equals(SOL_MINT));
    if (open) {
      const curve: PumpCurve = { creator: readKey(d, 49), isMayhemMode: readBool(d, 81), isCashbackCoin: readBool(d, 82) };
      const recipients = decodePumpGlobalRecipients(global.data, curve.isMayhemMode, pick);
      routes.push({
        venue: 'pump-curve', pool: PUMP.bondingCurve(mint).toBase58(), liquidity: readU64(d, 32),
        output: side === 'buy' ? { kind: 'token', account: userToken } : { kind: 'lamports' },
        instructions: ({ amountIn, minOut }) => side === 'buy'
          ? [createAtaIdempotent(user, user, mint, mintProgram), pumpCurveBuy({ ...curve, ...recipients, user, mint, tokenProgram: mintProgram, spendableSolIn: amountIn, minTokensOut: minOut })]
          : [pumpCurveSell({ ...curve, ...recipients, user, mint, tokenProgram: mintProgram, amount: amountIn, minSolOutput: minOut })],
      });
    }
  }

  if (ammConfig && poolAccount && poolAccount.owner === PUMP_AMM_PROGRAM.toBase58() && pumpPoolQuoteMint(poolAccount.data).equals(SOL_MINT)) {
    const pool = decodePumpPool(poolKey, poolAccount.data);
    if (pool.baseMint.equals(mint)) {
      const recipients = decodePumpAmmRecipients(ammConfig.data, pool.isMayhemMode, pick);
      const [quoteVault] = await rpc.getAccounts([pool.poolQuoteTokenAccount]);
      const args = { ...pool, ...recipients, user, baseTokenProgram: mintProgram };
      const extend = pool.needsExtend ? [pumpAmmExtendPool(poolKey, user)] : [];
      routes.push({
        venue: 'pumpswap', pool: poolKey.toBase58(), liquidity: quoteVault ? tokenAmount(quoteVault.data) : BigInt(0),
        output: { kind: 'token', account: side === 'buy' ? userToken : userWsol },
        instructions: ({ amountIn, minOut, measure }) => side === 'buy'
          ? [...extend, ...wrapSol(user, amountIn), createAtaIdempotent(user, user, mint, mintProgram), pumpAmmBuy({ ...args, spendableQuoteIn: amountIn, minBaseAmountOut: minOut }), unwrapSol(user)]
          : [...extend, createAtaIdempotent(user, user, SOL_MINT, TOKEN_PROGRAM), pumpAmmSell({ ...args, baseAmountIn: amountIn, minQuoteAmountOut: minOut }), ...(measure ? [] : [unwrapSol(user)])],
      });
    }
  }
  return routes;
}
