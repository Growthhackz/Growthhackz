import {
  PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createCloseAccountInstruction, getAccount
} from '@solana/spl-token';
import BN from 'bn.js';
import { createRequire } from 'node:module';
import { saveState, loadState } from './state.js';

export const TEARDOWN_STEPS = [
  'removeLiquidity',
  'claimFees',
  'closePosition',
  'sellInventory',
  'closeTokenAccounts',
  'sweep',
  'done'
];

// Loaded through require(): the package's ESM build fails to resolve under Node
// (ERR_UNSUPPORTED_DIR_IMPORT), while the CommonJS build exports the class itself.
const require = createRequire(import.meta.url);

function loadDlmm(connection, poolAddress) {
  const mod = require('@meteora-ag/dlmm');
  const DLMM = typeof mod.create === 'function' ? mod : (mod.default ?? mod.DLMM);
  return DLMM.create(connection, new PublicKey(poolAddress));
}

async function findPosition(dlmm, owner, positionPubKey) {
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
  return userPositions.find((p) => p.publicKey.equals(positionPubKey)) ?? null;
}

async function sendAll(connection, wallet, txs) {
  for (const tx of [txs].flat()) {
    await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
  }
}

export async function closeEmptyTokenAccounts({ connection, wallet, programId, failed }) {
  const { value: accounts } = await connection.getTokenAccountsByOwner(
    wallet.publicKey, { programId }
  );

  const closed = [];
  for (const { pubkey } of accounts) {
    let amount = 0n;
    try {
      const acct = await getAccount(connection, pubkey, 'confirmed', programId);
      amount = acct.amount;
    } catch {
      continue;
    }
    if (amount > 0n) continue;

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      createCloseAccountInstruction(pubkey, wallet.publicKey, wallet.publicKey, [], programId)
    );
    try {
      await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
      closed.push(pubkey.toBase58());
    } catch (e) {
      // With a `failed` list the caller wants best effort; otherwise abort so
      // teardown records the error and can resume from this step.
      if (!failed) throw e;
      failed.push({ account: pubkey.toBase58(), error: String(e?.message ?? e) });
    }
  }
  return closed;
}

// Sends the entire balance minus the exact network fee, leaving the wallet at 0.
// No priority fee here: it would be charged on top of the quoted fee and make the
// transfer fail for insufficient funds.
export async function sweepAll({ connection, wallet, receiver }) {
  const balance = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
  if (balance === 0n) return 0n;

  const build = (lamports) => new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: receiver,
      lamports
    })
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const probe = build(balance);
  probe.feePayer = wallet.publicKey;
  probe.recentBlockhash = blockhash;
  const { value } = await connection.getFeeForMessage(probe.compileMessage(), 'confirmed');
  const fee = BigInt(value ?? 5_000);
  if (balance <= fee) return 0n;

  const amount = balance - fee;
  const tx = build(amount);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
  return amount;
}

async function runStep(step, ctx) {
  const { connection, wallet, state, receiver } = ctx;

  switch (step) {
    case 'removeLiquidity': {
      if (!state.positionPubKey || state.liquidityRemoved) return {};
      const dlmm = await loadDlmm(connection, state.poolAddress);
      const positionPubKey = new PublicKey(state.positionPubKey);
      const position = await findPosition(dlmm, wallet.publicKey, positionPubKey);
      const bins = position?.positionData.positionBinData.map((b) => b.binId) ?? [];
      if (bins.length > 0) {
        await sendAll(connection, wallet, await dlmm.removeLiquidity({
          user: wallet.publicKey,
          position: positionPubKey,
          fromBinId: Math.min(...bins),
          toBinId: Math.max(...bins),
          bps: new BN(10_000),
          shouldClaimAndClose: false
        }));
      }
      return { liquidityRemoved: true };
    }

    case 'claimFees': {
      if (!state.positionPubKey || state.feesClaimed) return {};
      const dlmm = await loadDlmm(connection, state.poolAddress);
      const position = await findPosition(dlmm, wallet.publicKey, new PublicKey(state.positionPubKey));
      if (position) {
        try {
          await sendAll(connection, wallet, await dlmm.claimSwapFee({
            owner: wallet.publicKey, position
          }));
        } catch (e) {
          if (!/no fee to claim/i.test(e?.message ?? '')) throw e;
        }
      }
      return { feesClaimed: true };
    }

    case 'closePosition': {
      if (!state.positionPubKey || state.positionClosed) return {};
      const dlmm = await loadDlmm(connection, state.poolAddress);
      const position = await findPosition(dlmm, wallet.publicKey, new PublicKey(state.positionPubKey));
      if (position) {
        await sendAll(connection, wallet, await dlmm.closePosition({
          owner: wallet.publicKey, position
        }));
      }
      return { positionClosed: true };
    }

    case 'sellInventory':
      // Wire your unwind swap here. Signature: (connection, wallet, state) => {}
      return { inventorySold: true };

    case 'closeTokenAccounts': {
      if (state.tokenAccountsClosed) return {};
      const closed = [
        ...await closeEmptyTokenAccounts({ connection, wallet, programId: TOKEN_PROGRAM_ID }),
        ...await closeEmptyTokenAccounts({ connection, wallet, programId: TOKEN_2022_PROGRAM_ID })
      ];
      return { tokenAccountsClosed: true, closedAccounts: closed };
    }

    case 'sweep': {
      if (state.swept) return {};
      const swept = await sweepAll({ connection, wallet, receiver });
      return { swept: true, sweptLamports: swept.toString() };
    }

    default:
      return {};
  }
}

export async function teardown(ctx, { statePath, fromPhase } = {}) {
  let state = await loadState(statePath);
  if (!state) throw new Error(`no run state at ${statePath}`);

  const startIdx = fromPhase
    ? TEARDOWN_STEPS.indexOf(fromPhase)
    : Math.max(0, TEARDOWN_STEPS.indexOf(state.phase));

  if (startIdx < 0) throw new Error(`unknown phase: ${fromPhase ?? state.phase}`);

  for (let i = startIdx; i < TEARDOWN_STEPS.length; i++) {
    const step = TEARDOWN_STEPS[i];
    try {
      const patch = await runStep(step, { ...ctx, state });
      state = { ...state, ...patch, phase: TEARDOWN_STEPS[i + 1] ?? 'done' };
      await saveState(statePath, state);
    } catch (err) {
      state = { ...state, phase: step, lastError: String(err?.message ?? err) };
      await saveState(statePath, state);
      throw err;
    }
  }
  return state;
}

export async function recover(ctx, { statePath }) {
  const state = await loadState(statePath);
  if (!state) throw new Error(`nothing to recover at ${statePath}`);
  if (state.phase === 'done') return state;
  // Pre-teardown phases (e.g. 'funded') aren't teardown steps; start from the top.
  const fromPhase = TEARDOWN_STEPS.includes(state.phase) ? state.phase : TEARDOWN_STEPS[0];
  return teardown(ctx, { statePath, fromPhase });
}
