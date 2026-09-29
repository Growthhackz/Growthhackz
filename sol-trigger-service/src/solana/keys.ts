import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  generateKeyPair,
  getBase58Decoder,
  getBase58Encoder,
  isAddress,
  type KeyPairSigner,
} from '@solana/kit';
import { webcrypto } from 'node:crypto';
import { ValidationError } from '../lib/errors.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const isValidAddress = (v: string) => isAddress(v);

/**
 * Accepts the formats wallets export: base58 (Phantom/Solflare, 64-byte keypair or 32-byte seed)
 * or a JSON byte array (solana-keygen id.json).
 */
export function parseSecretKey(input: string): Uint8Array {
  const v = input.trim();
  let bytes: Uint8Array;
  if (v.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(v);
    } catch {
      throw new ValidationError('Private key JSON array could not be parsed');
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
      throw new ValidationError('Private key JSON must be an array of bytes');
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = new Uint8Array(getBase58Encoder().encode(v));
    } catch {
      throw new ValidationError('Private key is not valid base58');
    }
  }
  if (bytes.length !== 64 && bytes.length !== 32)
    throw new ValidationError(`Private key must be 64 bytes (or a 32-byte seed); got ${bytes.length}`);
  return bytes;
}

export async function signerFromSecret(bytes: Uint8Array): Promise<KeyPairSigner> {
  try {
    // Both helpers reject a keypair whose public half does not match its seed.
    return bytes.length === 64
      ? await createKeyPairSignerFromBytes(bytes)
      : await createKeyPairSignerFromPrivateKeyBytes(bytes);
  } catch {
    throw new ValidationError('Private key is invalid (public key does not match)');
  }
}

/** Canonical base58 64-byte secret for storage, plus its address. */
export async function normaliseSecret(input: string): Promise<{ secret: string; address: string }> {
  const bytes = parseSecretKey(input);
  const signer = await signerFromSecret(bytes);
  if (bytes.length === 64) return { secret: getBase58Decoder().decode(bytes), address: signer.address };
  const full = new Uint8Array(64);
  full.set(bytes, 0);
  full.set(getBase58Encoder().encode(signer.address), 32);
  return { secret: getBase58Decoder().decode(full), address: signer.address };
}

/** Fresh keypair, returned as a base58 64-byte secret (the Phantom import format). */
export async function generateSecret(): Promise<{ secret: string; address: string }> {
  const kp = await generateKeyPair(true);
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey as webcrypto.CryptoKey));
  const seed = pkcs8.slice(-32);
  return normaliseSecret(getBase58Decoder().decode(seed));
}
