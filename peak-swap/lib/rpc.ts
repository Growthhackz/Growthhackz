// Small JSON-RPC client for the configured Solana endpoint (fetch only; Worker-friendly).
import { PublicKey } from '@solana/web3.js';
import type { Account } from './solana';
import type { Rpc } from './venues/types';

export class RpcError extends Error { constructor(message: string, public code?: number, public data?: any, public timeout = false) { super(message); } }

export type Simulation = { err: unknown; logs: string[]; unitsConsumed: number; accounts: (Account | null)[] };

const decode = (a: any): Account | null => a ? { data: new Uint8Array(Buffer.from(a.data[0], 'base64')), owner: a.owner, lamports: a.lamports } : null;

export function solanaRpc(url: string) {
  let id = 0;
  async function call<T>(method: string, params: unknown[], timeoutMs = 10000): Promise<T> {
    let response: Response;
    try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new RpcError(`Solana RPC ${method} did not respond.`, undefined, undefined, true); }
    if (!response.ok) throw new RpcError(`Solana RPC ${method} failed (${response.status}).`, response.status);
    const body: any = await response.json();
    if (body.error) throw new RpcError(body.error.message || `Solana RPC ${method} failed.`, body.error.code, body.error.data);
    return body.result as T;
  }
  const client = {
    call,
    async getAccounts(keys: PublicKey[]) {
      const out: (Account | null)[] = [];
      for (let i = 0; i < keys.length; i += 100) {
        const r = await call<{ value: any[] }>('getMultipleAccounts', [keys.slice(i, i + 100).map(String), { encoding: 'base64', commitment: 'confirmed' }]);
        out.push(...r.value.map(decode));
      }
      return out;
    },
    async getProgramAccounts(program: PublicKey, filters: object[]) {
      const r = await call<any[]>('getProgramAccounts', [program.toBase58(), { encoding: 'base64', commitment: 'confirmed', filters }], 15000);
      return r.slice(0, 200).map(x => ({ pubkey: new PublicKey(x.pubkey), account: decode(x.account)! }));
    },
    async simulate(transaction: string, accounts: PublicKey[] = []): Promise<Simulation> {
      const r = await call<{ value: any }>('simulateTransaction', [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', ...(accounts.length ? { accounts: { encoding: 'base64', addresses: accounts.map(String) } } : {}) }], 15000);
      return { err: r.value.err, logs: r.value.logs || [], unitsConsumed: r.value.unitsConsumed || 0, accounts: (r.value.accounts || []).map(decode) };
    },
    latestBlockhash: () => call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]).then(r => r.value),
    blockHeight: () => call<number>('getBlockHeight', [{ commitment: 'confirmed' }]),
    priorityFees: (accounts: PublicKey[]) => call<{ prioritizationFee: number }[]>('getRecentPrioritizationFees', [accounts.slice(0, 128).map(String)]),
    send: (transaction: string) => call<string>('sendTransaction', [transaction, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 10 }], 20000),
    signatureStatus: (signature: string, searchTransactionHistory = true) => call<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory }]).then(r => r.value[0]),
  } satisfies Rpc & Record<string, unknown>;
  return client;
}
export type SolanaRpc = ReturnType<typeof solanaRpc>;
