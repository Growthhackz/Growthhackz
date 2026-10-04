import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const KDF = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEY_LEN = 32;

export const LABEL_RE = /^[a-zA-Z0-9_-]{1,32}$/;

const deriveKey = (passphrase, salt, params) =>
  scryptSync(passphrase, salt, KEY_LEN, params);

// Every file path is built from a validated label, so no caller can escape storeDir.
function walletFile(storeDir, label) {
  if (!LABEL_RE.test(label ?? '')) {
    throw new Error('label must be 1-32 chars of [a-zA-Z0-9_-]');
  }
  return path.join(storeDir, `${label}.json`);
}

const intIn = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const isMint = (v) => {
  if (v === null) return true;
  try { return typeof v === 'string' && new PublicKey(v).toBase58() === v; }
  catch { return false; }
};
const SETTINGS_SCHEMA = {
  venue: (v) => ['raydium', 'pumpswap', 'meteora', 'pumpfun'].includes(v),
  pool: isMint, // any base58 address, or null
  mint: isMint,
  slippageBps: intIn(1, 5000),
  priorityMode: (v) => v === 'auto' || v === 'fixed',
  priorityMicroLamports: intIn(0, 50_000_000), // fixed price, or the cap in auto mode
  closeEmptyAccounts: (v) => typeof v === 'boolean',
  solFloorLamports: intIn(0, Number.MAX_SAFE_INTEGER),
  running: (v) => typeof v === 'boolean'
};

export const DEFAULT_SETTINGS = {
  venue: 'raydium',
  pool: null,
  mint: null,
  slippageBps: 100,
  priorityMode: 'auto',
  priorityMicroLamports: 100_000,
  closeEmptyAccounts: true,
  solFloorLamports: 10_000_000,
  running: false
};

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings patch must be an object');
  }
  for (const [k, v] of Object.entries(patch)) {
    const check = SETTINGS_SCHEMA[k];
    if (!check) throw new Error(`unknown setting: ${k}`);
    if (!check(v)) throw new Error(`invalid value for ${k}: ${JSON.stringify(v)}`);
  }
  return patch;
}

// Fills defaults and drops keys this version no longer uses.
export function normalizeSettings(settings = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(SETTINGS_SCHEMA)) {
    if (k in settings && SETTINGS_SCHEMA[k](settings[k])) out[k] = settings[k];
  }
  return out;
}

export async function createWallet({ label, passphrase, storeDir }) {
  const file = walletFile(storeDir, label);
  const kp = Keypair.generate();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, KDF);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(kp.secretKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  const record = {
    label,
    pubkey: kp.publicKey.toBase58(),
    kdf: { salt: salt.toString('base64'), ...KDF },
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
    settings: { ...DEFAULT_SETTINGS },
    rules: []
  };

  // 'wx' refuses to overwrite an existing wallet (and its key) with the same label.
  await fs.writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  return kp.publicKey.toBase58();
}

export async function readRecord({ label, storeDir }) {
  return JSON.parse(await fs.readFile(walletFile(storeDir, label), 'utf8'));
}

export async function loadWallet({ label, passphrase, storeDir }) {
  const rec = await readRecord({ label, storeDir });
  const { salt, ...params } = rec.kdf;
  const key = deriveKey(passphrase, Buffer.from(salt, 'base64'), params);

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));

  let sk;
  try {
    sk = Buffer.concat([decipher.update(Buffer.from(rec.ct, 'base64')), decipher.final()]);
  } catch {
    throw new Error(`bad passphrase or tampered record: ${label}`);
  }
  return { keypair: Keypair.fromSecretKey(sk), settings: normalizeSettings(rec.settings) };
}

// Serializes read-modify-write on each wallet file, so the trade engine and the
// API can't clobber each other's changes.
const fileLocks = new Map();
function withFileLock(file, fn) {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(file, run.catch(() => {}));
  return run;
}

export async function mutateRecord({ label, storeDir }, fn) {
  const file = walletFile(storeDir, label);
  return withFileLock(file, async () => {
    const rec = JSON.parse(await fs.readFile(file, 'utf8'));
    const result = await fn(rec);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
    return result;
  });
}

export async function updateSettings({ label, storeDir, patch }) {
  validatePatch(patch);
  return mutateRecord({ label, storeDir }, (rec) => {
    rec.settings = { ...normalizeSettings(rec.settings), ...patch };
    return rec.settings;
  });
}

export async function deleteWallet({ label, storeDir, connection }) {
  const file = walletFile(storeDir, label);
  const rec = JSON.parse(await fs.readFile(file, 'utf8'));
  const pubkey = new PublicKey(rec.pubkey);

  const lamports = await connection.getBalance(pubkey, 'confirmed');
  if (lamports > 0) throw new Error(`${label} still holds ${lamports} lamports`);

  const [legacy, t22] = await Promise.all([
    connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID })
  ]);
  const open = legacy.value.length + t22.value.length;
  if (open > 0) {
    throw new Error(`${label} has ${open} open token accounts (stranded rent)`);
  }
  await fs.unlink(file);
}
