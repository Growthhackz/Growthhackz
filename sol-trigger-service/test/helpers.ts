import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { all, openDatabase } from '../src/db/database.js';
import { RpcRejectedError, type Chain, type SignatureStatus } from '../src/solana/chain.js';
import type { Quote, Swapper } from '../src/solana/jupiter.js';
import { generateSecret, parseSecretKey, signerFromSecret, SOL_MINT } from '../src/solana/keys.js';
import { buildTransfer } from '../src/solana/tx.js';
import type { TxRow } from '../src/services/engine.js';

export const PASSWORD = 'correct horse battery';
export const TRIGGER_TOKEN = 'trigger-token-0123456789abcdef';
export const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export class FakeChain implements Chain {
  balances = new Map<string, bigint>();
  tokens = new Map<string, bigint>();
  statuses = new Map<string, SignatureStatus>();
  sent: string[] = [];
  height = 100n;
  rejectNext: string | null = null;

  async getBalance(a: string) {
    return this.balances.get(a) ?? 0n;
  }
  async getTokenBalance(owner: string, mint: string) {
    return this.tokens.get(`${owner}:${mint}`) ?? 0n;
  }
  async getLatestBlockhash() {
    return { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: this.height + 150n };
  }
  async getBlockHeight() {
    return this.height;
  }
  async sendTransaction(b64: string, opts: { skipPreflight?: boolean } = {}) {
    if (this.rejectNext && !opts.skipPreflight) {
      const m = this.rejectNext;
      this.rejectNext = null;
      throw new RpcRejectedError(m);
    }
    if (!opts.skipPreflight) this.sent.push(b64);
    return 'sig';
  }
  async getSignatureStatuses(sigs: string[]) {
    return sigs.map((s) => this.statuses.get(s) ?? null);
  }
}

/** Returns a real signable transaction so the signing path is exercised; the rate is 1 SOL lamport = 1000 token units. */
export class FakeSwapper implements Swapper {
  quotes: Array<{ inputMint: string; outputMint: string; amount: bigint }> = [];
  failQuote: string | null = null;
  private n = 0n;
  constructor(private readonly chain: FakeChain) {}
  async quote(args: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<Quote> {
    if (this.failQuote) throw new Error(this.failQuote);
    this.quotes.push(args);
    const out = args.inputMint === SOL_MINT ? args.amount * 1000n : args.amount / 1000n;
    return { inAmount: args.amount.toString(), outAmount: out.toString(), raw: args };
  }
  async buildSwap(args: { quote: Quote; userPublicKey: string; maxPriorityFeeLamports: number }) {
    // Stand-in for Jupiter's unsigned swap: any transaction whose fee payer is the user.
    const userSecret = walletSecrets.get(args.userPublicKey);
    if (!userSecret) throw new Error('unknown user');
    const signer = await signerFromSecret(parseSecretKey(userSecret));
    const bh = await this.chain.getLatestBlockhash();
    const tx = await buildTransfer({ from: signer, to: OTHER, amount: ++this.n, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, priorityMicroLamports: 0 });
    return { base64: tx.base64, lastValidBlockHeight: bh.lastValidBlockHeight };
  }
}

export const walletSecrets = new Map<string, string>();

export async function newKey(): Promise<{ secret: string; address: string }> {
  const k = await generateSecret();
  walletSecrets.set(k.address, k.secret);
  return k;
}

export function setup(env: Record<string, string> = {}) {
  let nowMs = Date.parse('2026-09-29T12:00:00Z');
  const clock = { now: () => new Date(nowMs) };
  const config = loadConfig({
    DASHBOARD_PASSWORD: PASSWORD,
    TRIGGER_API_TOKEN: TRIGGER_TOKEN,
    ENCRYPTION_KEY: 'x'.repeat(40),
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'silent',
    WORKERS_ENABLED: 'false',
    ...env,
  });
  const db = openDatabase(':memory:');
  const chain = new FakeChain();
  const swapper = new FakeSwapper(chain);
  const { app, ctx } = buildApp({ config, db, clock, chain, swapper });
  return {
    app,
    ctx,
    db,
    chain,
    swapper,
    advance: (ms: number) => {
      nowMs += ms;
    },
    txs: () => all<TxRow>(db, 'SELECT * FROM txs ORDER BY created_at, rowid'),
    confirmAll: () => {
      for (const t of all<TxRow>(db, "SELECT * FROM txs WHERE status = 'pending'"))
        chain.statuses.set(t.signature, { confirmationStatus: 'confirmed', err: null });
    },
  };
}

export async function login(app: ReturnType<typeof setup>['app']): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error('login failed: ' + res.body);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
