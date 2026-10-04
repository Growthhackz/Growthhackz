import {
  ComputeBudgetProgram, TransactionMessage, VersionedTransaction
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction
} from '@solana/spl-token';
import { SOL_MINT } from './tokens.js';

const PER_TX = 12;
const CU_PER_CLOSE = 6_000;
const PRIORITY = 1_000; // µlamports/CU: closing accounts is never urgent

// Token accounts that can be closed for their rent: empty ones, plus wrapped
// SOL accounts (closing one returns the wrapped SOL too).
export async function reclaimableAccounts(connection, owner) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed');
    for (const a of value) {
      const { mint, tokenAmount } = a.account.data.parsed.info;
      if (tokenAmount.amount !== '0' && mint !== SOL_MINT) continue;
      out.push({ pubkey: a.pubkey, mint, programId, lamports: a.account.lamports });
    }
  }
  return out;
}

async function closeBatch(connection, wallet, accounts) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000 + CU_PER_CLOSE * accounts.length }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }),
      ...accounts.map((a) => createCloseAccountInstruction(
        a.pubkey, wallet.publicKey, wallet.publicKey, [], a.programId
      ))
    ]
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const { value } = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight }, 'confirmed'
  );
  if (value.err) throw new Error(JSON.stringify(value.err));
  return signature;
}

// Closes every reclaimable token account, up to 12 per transaction. A batch
// that fails is retried one account at a time so a single account that can't
// close (e.g. Token-2022 with withheld fees) doesn't block the rest.
export async function closeEmptyAccounts(connection, wallet) {
  const accounts = await reclaimableAccounts(connection, wallet.publicKey);
  const closed = [];
  const failed = [];
  let reclaimedLamports = 0;

  for (let i = 0; i < accounts.length; i += PER_TX) {
    const batch = accounts.slice(i, i + PER_TX);
    try {
      await closeBatch(connection, wallet, batch);
      closed.push(...batch);
    } catch (e) {
      if (batch.length === 1) {
        failed.push({ account: batch[0].pubkey.toBase58(), mint: batch[0].mint, error: String(e?.message ?? e) });
        continue;
      }
      for (const a of batch) {
        try {
          await closeBatch(connection, wallet, [a]);
          closed.push(a);
        } catch (err) {
          failed.push({ account: a.pubkey.toBase58(), mint: a.mint, error: String(err?.message ?? err) });
        }
      }
    }
  }
  for (const a of closed) reclaimedLamports += a.lamports;
  return {
    closed: closed.length,
    failed,
    reclaimedSol: reclaimedLamports / 1e9
  };
}
