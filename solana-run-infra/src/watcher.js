import { PublicKey } from '@solana/web3.js';

const MEMO_PROGRAM = 'spl-memo';
const RENT_EXEMPT_MIN = 890_880n;

function extractMemo(tx) {
  const scan = (ixs) => {
    for (const ix of ixs ?? []) {
      if (ix.program === MEMO_PROGRAM && typeof ix.parsed === 'string') return ix.parsed;
    }
    return null;
  };
  const top = scan(tx.transaction.message.instructions);
  if (top) return top;
  for (const inner of tx.meta?.innerInstructions ?? []) {
    const hit = scan(inner.instructions);
    if (hit) return hit;
  }
  return null;
}

// Reads the balances recorded in the funding tx itself, so later activity on
// the account can't skew the snapshot.
function balancesFor(tx, pubkey) {
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.pubkey.equals(pubkey));
  if (idx < 0) return null;
  const pre = BigInt(tx.meta.preBalances[idx]);
  const post = BigInt(tx.meta.postBalances[idx]);
  return { pre, delta: post - pre };
}

export class FundingWatcher {
  constructor({ connection, botPubkey, onFunded }) {
    this.connection = connection;
    this.botPubkey = botPubkey;
    this.onFunded = onFunded;
    this.subId = null;
    this.seen = new Set();
  }

  async start() {
    this.subId = this.connection.onAccountChange(
      this.botPubkey,
      () => { this.drain().catch((e) => console.error('watcher:', e.message)); },
      'confirmed'
    );
    await this.drain();
  }

  async stop() {
    if (this.subId !== null) {
      await this.connection.removeAccountChangeListener(this.subId);
      this.subId = null;
    }
  }

  async drain() {
    const sigs = await this.connection.getSignaturesForAddress(
      this.botPubkey, { limit: 25 }, 'confirmed'
    );

    for (const { signature, err } of sigs) {
      if (err || this.seen.has(signature)) continue;
      this.seen.add(signature);

      let tx;
      try {
        tx = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed'
        });
      } catch (e) {
        // A transaction version this client can't decode: log it and keep
        // scanning rather than abort. Check skipped signatures by hand.
        console.error(`watcher: skipping ${signature}: ${e.message}`);
        continue;
      }
      if (!tx?.meta) continue;

      const bal = balancesFor(tx, this.botPubkey);
      if (!bal || bal.delta <= 0n) continue;

      const memo = extractMemo(tx);
      if (!memo) continue;

      let mint;
      try { mint = new PublicKey(memo.trim()); }
      catch { continue; }

      if (bal.delta < RENT_EXEMPT_MIN) continue;

      await this.onFunded({
        signature,
        mint: mint.toBase58(),
        depositLamports: bal.delta.toString(),
        preRunBalance: bal.pre.toString()
      });
    }
  }
}
