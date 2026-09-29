import { UpstreamError } from '../lib/errors.js';

export interface Quote {
  inAmount: string;
  outAmount: string;
  /** Opaque: passed back to /swap untouched. */
  raw: unknown;
}

export interface SwapTx {
  base64: string;
  lastValidBlockHeight: bigint;
}

export interface Swapper {
  quote(args: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<Quote>;
  buildSwap(args: { quote: Quote; userPublicKey: string; maxPriorityFeeLamports: number }): Promise<SwapTx>;
}

/** Jupiter Swap API v1: routes across Raydium, Orca, Meteora, pump.fun and others. */
export class JupiterSwapper implements Swapper {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) };
  }

  async quote(args: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<Quote> {
    const q = new URLSearchParams({
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amount.toString(),
      slippageBps: String(args.slippageBps),
      restrictIntermediateTokens: 'true',
    });
    const res = await this.http(`${this.baseUrl.replace(/\/$/, '')}/quote?${q}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { inAmount?: string; outAmount?: string; error?: string };
    if (!res.ok || !body.outAmount) throw new UpstreamError(`Jupiter quote failed: ${body.error ?? `HTTP ${res.status}`}`);
    return { inAmount: body.inAmount ?? args.amount.toString(), outAmount: body.outAmount, raw: body };
  }

  async buildSwap(args: { quote: Quote; userPublicKey: string; maxPriorityFeeLamports: number }): Promise<SwapTx> {
    const res = await this.http(`${this.baseUrl.replace(/\/$/, '')}/swap`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        quoteResponse: args.quote.raw,
        userPublicKey: args.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: { maxLamports: args.maxPriorityFeeLamports, priorityLevel: 'veryHigh' },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      swapTransaction?: string;
      lastValidBlockHeight?: number;
      error?: string;
    };
    if (!res.ok || !body.swapTransaction || body.lastValidBlockHeight === undefined)
      throw new UpstreamError(`Jupiter swap failed: ${body.error ?? `HTTP ${res.status}`}`);
    return { base64: body.swapTransaction, lastValidBlockHeight: BigInt(body.lastValidBlockHeight) };
  }
}
