import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
  type Blockhash,
  type KeyPairSigner,
} from '@solana/kit';

export const BASE_FEE_LAMPORTS = 5_000n;
/** Rent-exempt minimum for a plain system account; a payer may end at 0 or at least this. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
// Transfer (150 CU) + two compute-budget instructions (150 CU each), with headroom.
const TRANSFER_CU_LIMIT = 1_000;

export interface SignedTx {
  base64: string;
  signature: string;
}

/** Total fee a transfer built by buildTransfer pays. */
export function transferFee(priorityMicroLamports: number): bigint {
  const priority = (BigInt(TRANSFER_CU_LIMIT) * BigInt(Math.max(0, Math.floor(priorityMicroLamports))) + 999_999n) / 1_000_000n;
  return BASE_FEE_LAMPORTS + priority;
}

export async function buildTransfer(args: {
  from: KeyPairSigner;
  to: string;
  amount: bigint;
  blockhash: string;
  lastValidBlockHeight: bigint;
  priorityMicroLamports: number;
}): Promise<SignedTx> {
  const ixs = [
    getSetComputeUnitLimitInstruction({ units: TRANSFER_CU_LIMIT }),
    ...(args.priorityMicroLamports > 0
      ? [getSetComputeUnitPriceInstruction({ microLamports: BigInt(Math.floor(args.priorityMicroLamports)) })]
      : []),
    getTransferSolInstruction({ source: args.from, destination: address(args.to), amount: lamports(args.amount) }),
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(args.from, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: args.blockhash as Blockhash, lastValidBlockHeight: args.lastValidBlockHeight },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return { base64: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
}

/** Signs a serialized transaction built elsewhere (Jupiter) with the wallet's key. */
export async function signSerialized(signer: KeyPairSigner, base64: string): Promise<SignedTx> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const signed = await signTransaction([signer.keyPair], tx);
  return { base64: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
}
