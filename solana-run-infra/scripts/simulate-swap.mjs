// Dry-runs a buy and a sell against a live pool with no keys and no funds:
// builds the real swap transactions (sized and priced exactly as a live trade
// would be) and has the RPC simulate them as a recent trader in that pool.
//
//   SIM_RPC=https://api.mainnet-beta.solana.com \
//   node scripts/simulate-swap.mjs <raydium|pumpswap|meteora|pumpfun> <token mint> [pool]
import { Connection, PublicKey } from '@solana/web3.js';
import { inspectPool, buildSwap } from '../src/venues/index.js';

const [, , venue, mint, poolArg] = process.argv;
const connection = new Connection(process.env.SIM_RPC ?? 'https://api.mainnet-beta.solana.com', 'confirmed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = {
  venue, mint, pool: poolArg ?? null, slippageBps: 300,
  priorityMode: 'auto', priorityMicroLamports: 100_000
};

const info = await inspectPool(connection, settings);
console.log(`pool ${info.pool} (${info.kind}) trades ${info.tokenMint}, ${info.lamportsPerRaw} lamports per raw unit`);
settings.pool = info.pool;

// A recent trader with SOL to buy as, and one holding the token to sell as.
const sigs = await connection.getSignaturesForAddress(new PublicKey(info.pool), { limit: 40 });
let buyer, seller, held = 0n;
const tried = new Set();
for (const { signature, err } of sigs) {
  if (err || (buyer && seller)) continue;
  await sleep(300);
  let tx;
  try { tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }); } catch { continue; }
  const payer = tx?.transaction.message.staticAccountKeys[0];
  if (!payer || tried.has(payer.toBase58())) continue;
  tried.add(payer.toBase58());
  const sol = await connection.getBalance(payer);
  const { value } = await connection.getParsedTokenAccountsByOwner(payer, { mint: new PublicKey(mint) });
  const amt = value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  if (!buyer && sol > 0.05e9) buyer = payer;
  if (!seller && sol > 0.003e9 && amt > 0n) { seller = payer; held = amt; }
}
if (!buyer) throw new Error('no recent trader with SOL found to simulate a buy as');

async function sim(side, amountIn, owner, closeTokenAccount = false) {
  try {
    const b = await buildSwap({ connection, owner, settings, side, amountIn, closeTokenAccount });
    const r = await connection.simulateTransaction(b.transaction, { sigVerify: false, replaceRecentBlockhash: true });
    const c = b.cost;
    console.log(`${side} ${amountIn} -> ~${b.expectedOut} | ${r.value.err ? 'ERR ' + JSON.stringify(r.value.err) : 'OK'}` +
      ` | CU used ${c.unitsUsed}, limit ${c.units}, ${c.microLamports} µL/CU, fee ${c.feeLamports / 1e9} SOL` +
      (b.closedAccount ? ' | closes token account' : ''));
    if (r.value.err) console.log(r.value.logs?.slice(-6).join('\n'));
  } catch (e) {
    console.log(`${side} ${amountIn} -> ${e.message}`);
  }
}
await sim('buy', 10_000_000n, buyer);
if (seller) {
  await sim('sell', held / 10n, seller);
  await sim('sell', held, seller, true);
} else console.log('no recent holder found to simulate a sell as');
