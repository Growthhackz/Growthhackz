import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { x402Client } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';
import type { Config } from '../config.js';
import { fromMicros } from '../lib/money.js';
import { APPROVED_ROUTES, SOLANA_MAINNET, SOLANA_USDC_MINT } from './package.js';

export type { PaymentRequired, PaymentRequirements };

/** Signs x402 payments from the dedicated Peak wallet. The key never leaves this object. */
export interface WurkPayer {
  address: string;
  /** PAYMENT-SIGNATURE header for exactly `accepted`; nothing else in the challenge is signed. */
  sign(challenge: PaymentRequired, accepted: PaymentRequirements): Promise<string>;
  /** USDC held by the wallet in base units, or null when the RPC can't be reached. */
  usdcBalanceMicros(): Promise<number | null>;
}

export interface WurkRuntime {
  fetch: typeof fetch;
  /** Env vars that must be set before anything can be paid; empty when live payments are possible. */
  missingForLive(): string[];
  payer(): Promise<WurkPayer>;
}

export class WurkSetupError extends Error {}

export function decodeSecretKey(raw: string): Uint8Array {
  const s = raw.trim();
  if (s.startsWith('[')) return Uint8Array.from(JSON.parse(s) as number[]);
  if (/^[0-9a-fA-F]{128}$/.test(s)) return Uint8Array.from(Buffer.from(s, 'hex'));
  return base58.decode(s);
}

async function usdcBalance(rpcUrl: string, owner: string, http: typeof fetch): Promise<number | null> {
  try {
    const res = await http(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [owner, { mint: SOLANA_USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { result?: { value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> } };
    if (!body.result) return null;
    return body.result.value.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
  } catch {
    return null;
  }
}

export function createWurkRuntime(config: Config, http: typeof fetch = fetch): WurkRuntime {
  let cached: Promise<WurkPayer> | null = null;
  const missingForLive = () => {
    const missing: string[] = [];
    if (!config.WURK_SOLANA_PRIVATE_KEY) missing.push('WURK_SOLANA_PRIVATE_KEY');
    if (!config.WURK_LIVE_PAYMENTS_ENABLED) missing.push('WURK_LIVE_PAYMENTS_ENABLED=true');
    return missing;
  };
  return {
    fetch: http,
    missingForLive,
    payer() {
      if (!config.WURK_SOLANA_PRIVATE_KEY) return Promise.reject(new WurkSetupError('WURK_SOLANA_PRIVATE_KEY is not set'));
      cached ??= (async () => {
        let keypair;
        try {
          keypair = await createKeyPairSignerFromBytes(decodeSecretKey(config.WURK_SOLANA_PRIVATE_KEY!));
        } catch {
          // Never echo the key or the decoder's message, which can include it.
          throw new WurkSetupError('WURK_SOLANA_PRIVATE_KEY could not be decoded (expected base58, 128-char hex or a JSON byte array)');
        }
        const signer = toClientSvmSigner(keypair);
        return {
          address: keypair.address,
          async sign(challenge, accepted) {
            // A fresh client per payment, capped at exactly this amount, on top of our own checks.
            const client = x402Client.fromConfig({
              schemes: [{ network: SOLANA_MAINNET, client: new ExactSvmScheme(signer, { rpcUrl: config.SOLANA_RPC_URL }) }],
              spendControls: {
                maxAmountPerPayment: false,
                allowedAssets: [{ network: SOLANA_MAINNET, asset: SOLANA_USDC_MINT, maxAmountPerPayment: accepted.amount }],
              },
            });
            const payload = await client.createPaymentPayload({ ...challenge, accepts: [accepted] });
            return encodePaymentSignatureHeader(payload);
          },
          usdcBalanceMicros: () => usdcBalance(config.SOLANA_RPC_URL, keypair.address, http),
        } satisfies WurkPayer;
      })();
      cached.catch(() => (cached = null));
      return cached;
    },
  };
}

// ------------------------------------------------------------------ quotes

export interface Quote {
  challenge: PaymentRequired;
  accepted: PaymentRequirements;
  amountMicros: number;
}

export type QuoteCheck = { ok: true; quote: Quote } | { ok: false; reason: string };

/** Reads the x402 challenge from a 402 response (header first, body as fallback). */
export async function readChallenge(res: Response): Promise<PaymentRequired | null> {
  const header = res.headers.get('payment-required');
  if (header) {
    try {
      return decodePaymentRequiredHeader(header);
    } catch {
      // fall through to the body
    }
  }
  try {
    const body = (await res.clone().json()) as PaymentRequired;
    return Array.isArray(body?.accepts) ? body : null;
  } catch {
    return null;
  }
}

/** Refuses anything that isn't WURK's host, an approved /solana/ route, mainnet USDC to an allowlisted recipient. */
export function assertApprovedUrl(config: Config, requestUrl: string): void {
  const base = new URL(config.WURK_BASE_URL);
  const u = new URL(requestUrl);
  if (u.protocol !== 'https:' || u.host !== base.host) throw new WurkSetupError(`Refusing to pay ${u.host}: only ${base.host} over HTTPS`);
  if (!APPROVED_ROUTES.includes(u.pathname)) throw new WurkSetupError(`Refusing to pay unapproved route ${u.pathname}`);
}

export function checkQuote(config: Config, challenge: PaymentRequired | null, ceilingMicros: number): QuoteCheck {
  if (!challenge || !Array.isArray(challenge.accepts)) return { ok: false, reason: 'WURK did not return x402 payment terms' };
  if (challenge.x402Version !== 2) return { ok: false, reason: `Unexpected x402 version ${challenge.x402Version}` };
  const allow = config.WURK_PAYTO_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  const accepted = challenge.accepts.find((a) => a.scheme === 'exact' && a.network === SOLANA_MAINNET && a.asset === SOLANA_USDC_MINT);
  if (!accepted) return { ok: false, reason: 'No Solana mainnet USDC payment option in the quote (network or asset changed)' };
  if (!allow.includes(accepted.payTo)) return { ok: false, reason: `Quote pays ${accepted.payTo}, which is not on WURK_PAYTO_ALLOWLIST` };
  if (!/^\d{1,15}$/.test(accepted.amount)) return { ok: false, reason: `Unreadable quote amount ${accepted.amount}` };
  const amountMicros = Number(accepted.amount); // USDC has 6 decimals, so base units are micros.
  if (amountMicros <= 0) return { ok: false, reason: 'Quote amount is zero' };
  if (amountMicros > ceilingMicros)
    return { ok: false, reason: `Quote ${fromMicros(amountMicros)} USDC is above the ${fromMicros(ceilingMicros)} USDC ceiling` };
  const resource = challenge.resource?.url;
  if (resource && new URL(resource).host !== new URL(config.WURK_BASE_URL).host)
    return { ok: false, reason: `Quote resource is on unexpected host ${new URL(resource).host}` };
  return { ok: true, quote: { challenge, accepted, amountMicros } };
}

/** Settlement details WURK returns in PAYMENT-RESPONSE after a paid request. */
export function readSettlement(res: Response): { transaction: string | null; success: boolean | null } {
  const header = res.headers.get('payment-response');
  if (!header) return { transaction: null, success: null };
  try {
    const s = decodePaymentResponseHeader(header);
    return { transaction: s.transaction || null, success: s.success };
  } catch {
    return { transaction: null, success: null };
  }
}
