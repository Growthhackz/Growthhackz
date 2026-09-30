import { VersionedTransaction } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// lite-api is keyless; set JUP_API_URL=https://api.jup.ag/swap/v1 plus
// JUP_API_KEY to use a paid plan.
const BASE = process.env.JUP_API_URL ?? 'https://lite-api.jup.ag/swap/v1';
const HEADERS = {
  'content-type': 'application/json',
  ...(process.env.JUP_API_KEY ? { 'x-api-key': process.env.JUP_API_KEY } : {})
};

async function jupFetch(url, init) {
  const res = await fetch(url, { ...init, headers: HEADERS });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`jupiter: ${body.error ?? body.message ?? res.statusText}`);
  }
  return body;
}

export function getQuote({ inputMint, outputMint, amount, slippageBps }) {
  const qs = new URLSearchParams({
    inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps)
  });
  return jupFetch(`${BASE}/quote?${qs}`);
}

// Quotes, builds, signs and confirms one ExactIn swap. `amount` is in base units.
export async function swap({ connection, wallet, inputMint, outputMint, amount, slippageBps }) {
  const quote = await getQuote({ inputMint, outputMint, amount, slippageBps });
  const built = await jupFetch(`${BASE}/swap`, {
    method: 'POST',
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  if (built.simulationError) {
    throw new Error(`swap simulation failed: ${JSON.stringify(built.simulationError)}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
  tx.sign([wallet]);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, maxRetries: 3
  });
  const { value } = await connection.confirmTransaction({
    signature,
    blockhash: tx.message.recentBlockhash,
    lastValidBlockHeight: built.lastValidBlockHeight
  }, 'confirmed');
  if (value.err) throw new Error(`swap failed on-chain: ${JSON.stringify(value.err)}`);

  return { signature, inAmount: quote.inAmount, outAmount: quote.outAmount };
}
