import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { SOL_MINT, getQuote } from './jupiter.js';

const decimalsCache = new Map();

export async function getDecimals(connection, mint) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  const { value } = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const decimals = value?.data?.parsed?.info?.decimals;
  if (!Number.isInteger(decimals)) throw new Error(`not a token mint: ${mint}`);
  decimalsCache.set(mint, decimals);
  return decimals;
}

// Raw (base-unit) balance of `mint` held by `owner`, summed across its accounts.
export async function getTokenBalance(connection, owner, mint) {
  const { value } = await connection.getParsedTokenAccountsByOwner(
    owner, { mint: new PublicKey(mint) }, 'confirmed'
  );
  return value.reduce(
    (sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n
  );
}

// Every token account the wallet owns, across both token programs.
export async function getTokenAccounts(connection, owner) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await connection.getParsedTokenAccountsByOwner(
      owner, { programId }, 'confirmed'
    );
    for (const a of value) {
      const { mint, tokenAmount } = a.account.data.parsed.info;
      out.push({ pubkey: a.pubkey, mint, amount: BigInt(tokenAmount.amount), programId });
    }
  }
  return out;
}

// SOL per 1 whole token, from a Jupiter quote for selling exactly one token.
export async function getPriceInSol(connection, mint) {
  const decimals = await getDecimals(connection, mint);
  const quote = await getQuote({
    inputMint: mint, outputMint: SOL_MINT, amount: 10n ** BigInt(decimals), slippageBps: 50
  });
  return Number(quote.outAmount) / 1e9;
}

export const toBaseUnits = (uiAmount, decimals) =>
  BigInt(Math.floor(uiAmount * 10 ** decimals));

export const toUi = (raw, decimals) => Number(raw) / 10 ** decimals;
