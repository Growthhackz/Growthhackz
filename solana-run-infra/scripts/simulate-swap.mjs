// Dry-runs a buy and a sell against a live pool with no keys and no funds:
// builds the real swap transactions and has the RPC simulate them as a recent
// trader in that pool.
//
//   SIM_RPC=https://api.mainnet-beta.solana.com \
//   node scripts/simulate-swap.mjs <raydium|pumpswap> <token mint> [pool]
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
const venue = await import(`../src/venues/${process.argv[2]}.js`);
const [, , , mint, poolArg] = process.argv;
const connection = new Connection(process.env.SIM_RPC ?? 'https://solana-rpc.publicnode.com', 'confirmed');
const pool = poolArg ?? venue.canonicalPool(mint);
console.log('pool', pool);

// a recent trader in this pool who still holds the token and some SOL
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sigs = await connection.getSignaturesForAddress(new PublicKey(pool), { limit: 40 });
let owner, held = 0n, buyer;
const tried = new Set();
for (const { signature, err } of sigs) {
  if (err) continue;
  await sleep(300);
  let tx; try { tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }); } catch { continue; }
  const payer = tx?.transaction.message.staticAccountKeys[0];
  if (!payer || tried.has(payer.toBase58())) continue;
  tried.add(payer.toBase58());
  const sol = await connection.getBalance(payer);
  const { value } = await connection.getParsedTokenAccountsByOwner(payer, { mint: new PublicKey(mint) });
  const amt = value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  if (!buyer && sol > 0.05e9) buyer = payer;
  if (!owner && sol > 0.003e9 && amt > 0n) { owner = payer; held = amt; }
  if (buyer && owner) break;
}
if (!owner || !buyer) throw new Error(`no suitable trader found buyer=${buyer} seller=${owner}`);
console.log('buy sim as', buyer.toBase58(), '| sell sim as', owner.toBase58());
const d = await venue.describePool(connection, pool, owner);
console.log('pool', d.kind, 'token', d.tokenMint, '| lamports per raw', d.lamportsPerRaw);

async function sim(side, amountIn, owner) {
  const { buildSwap } = await import('../src/venues/index.js');
  const { transaction, expectedOut } = await buildSwap({ connection, owner, side, amountIn,
    settings: { venue: process.argv[2], pool, mint, slippageBps: 300, priorityMicroLamports: 10_000 } });
  const r = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true });
  console.log(`${side} ${amountIn} -> expected ${expectedOut} | ${r.value.err ? 'ERR ' + JSON.stringify(r.value.err) : 'OK'} | CU ${r.value.unitsConsumed}`);
  if (r.value.err) console.log(r.value.logs?.slice(-8).join('\n'));
}
await sim('buy', 10_000_000n, buyer);
await sim('sell', held / 10n, owner);
