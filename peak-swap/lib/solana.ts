// Minimal Solana primitives shared by the venue adapters. Kept dependency-free
// (only @solana/web3.js) so the Worker bundle stays small.
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';

export const pk = (value: string) => new PublicKey(value);
export const SOL_MINT = pk('So11111111111111111111111111111111111111112');
export const TOKEN_PROGRAM = pk('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = pk('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = pk('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MEMO_PROGRAM = pk('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const SYSVAR_INSTRUCTIONS = pk('Sysvar1nstructions1111111111111111111111111');
export const SYSTEM_PROGRAM = SystemProgram.programId;

export type Account = { data: Uint8Array; owner: string; lamports: number };

export const pda = (seeds: (Uint8Array | string)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : Buffer.from(s)), program)[0];
export const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) =>
  pda([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ATA_PROGRAM);
export const isTokenProgram = (owner: string) => owner === TOKEN_PROGRAM.toBase58() || owner === TOKEN_2022_PROGRAM.toBase58();

export const readU64 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).readBigUInt64LE(o);
export const readI32 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).readInt32LE(o);
export const readU16 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).readUInt16LE(o);
export const readKey = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
/** Reads a key only when the (possibly older, shorter) account is long enough. */
export const readKeyIfPresent = (d: Uint8Array, o: number) => d.length >= o + 32 ? readKey(d, o) : PublicKey.default;
export const readBool = (d: Uint8Array, o: number) => d.length > o && d[o] === 1;
export function u64(value: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; }
export function i64(value: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(value); return b; }
export const hasPrefix = (d: Uint8Array, prefix: number[]) => d.length >= prefix.length && prefix.every((v, i) => d[i] === v);
/** SPL token account amount (same offset for Token and Token-2022). */
export const tokenAmount = (d: Uint8Array) => readU64(d, 64);

export const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
export const ix = (programId: PublicKey, keys: AccountMeta[], data: Uint8Array | number[]) => new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
export const concat = (...parts: (Uint8Array | number[])[]) => Buffer.concat(parts.map(p => Buffer.from(p)));

export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return ix(ATA_PROGRAM, [meta(payer, true, true), meta(ata(mint, owner, tokenProgram), true), meta(owner), meta(mint), meta(SYSTEM_PROGRAM), meta(tokenProgram)], [1]);
}
export const syncNative = (account: PublicKey) => ix(TOKEN_PROGRAM, [meta(account, true)], [17]);
export const closeAccount = (account: PublicKey, owner: PublicKey) => ix(TOKEN_PROGRAM, [meta(account, true), meta(owner, true), meta(owner, false, true)], [9]);
export const transferSol = (from: PublicKey, to: PublicKey, lamports: bigint) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

/** Wraps `lamports` into the owner's WSOL account (created if needed). */
export function wrapSol(owner: PublicKey, lamports: bigint) {
  const account = ata(SOL_MINT, owner, TOKEN_PROGRAM);
  return [createAtaIdempotent(owner, owner, SOL_MINT, TOKEN_PROGRAM), transferSol(owner, account, lamports), syncNative(account)];
}
export const unwrapSol = (owner: PublicKey) => closeAccount(ata(SOL_MINT, owner, TOKEN_PROGRAM), owner);
