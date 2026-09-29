import { UpstreamError } from '../lib/errors.js';

export interface SignatureStatus {
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  err: unknown;
}

/** The RPC calls this service needs; swapped for a fake in tests. */
export interface Chain {
  getBalance(address: string): Promise<bigint>;
  /** Sum of the owner's accounts for this mint (SPL Token and Token-2022). */
  getTokenBalance(owner: string, mint: string): Promise<bigint>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  getBlockHeight(): Promise<bigint>;
  /** Throws RpcRejectedError when the node refuses the transaction (preflight), so it never landed. */
  sendTransaction(base64: string, opts?: { skipPreflight?: boolean }): Promise<string>;
  getSignatureStatuses(signatures: string[]): Promise<Array<SignatureStatus | null>>;
}

/** The node answered with a JSON-RPC error: the transaction was not forwarded. */
export class RpcRejectedError extends Error {}

export class RpcChain implements Chain {
  private seq = 0;
  constructor(
    private readonly url: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.http(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new UpstreamError(`RPC ${method} HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) {
      const logs = (body.error.data as { logs?: string[] } | undefined)?.logs;
      const msg = `RPC ${method}: ${body.error.message}${logs?.length ? ' | ' + logs.slice(-3).join(' | ') : ''}`;
      if (method === 'sendTransaction') throw new RpcRejectedError(msg);
      throw new UpstreamError(msg);
    }
    return body.result as T;
  }

  async getBalance(address: string): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }

  async getTokenBalance(owner: string, mint: string): Promise<bigint> {
    const r = await this.call<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>(
      'getTokenAccountsByOwner',
      [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    );
    return r.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [
      { commitment: 'confirmed' },
    ]);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
  }

  async getBlockHeight(): Promise<bigint> {
    return BigInt(await this.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]));
  }

  async sendTransaction(base64: string, opts: { skipPreflight?: boolean } = {}): Promise<string> {
    return this.call<string>('sendTransaction', [
      base64,
      { encoding: 'base64', skipPreflight: opts.skipPreflight ?? false, preflightCommitment: 'confirmed', maxRetries: 0 },
    ]);
  }

  async getSignatureStatuses(signatures: string[]): Promise<Array<SignatureStatus | null>> {
    const r = await this.call<{ value: Array<SignatureStatus | null> }>('getSignatureStatuses', [
      signatures,
      { searchTransactionHistory: false },
    ]);
    return r.value;
  }
}
