import express from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LABEL_RE, createWallet, readRecord, updateSettings, deleteWallet,
  mutateRecord, normalizeSettings
} from './custody.js';
import { normalizeRules, scheduleConflict, MIN_INTERVAL_MINUTES } from './rules.js';
import { inspectPool, VENUE_NAMES } from './venues/index.js';
import { TradeEngine } from './engine.js';
import { getTokenBalance, getDecimals, toUi } from './tokens.js';
import { createAuth } from './auth.js';
import { reclaimableAccounts } from './rent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.WALLET_DIR ?? path.join(__dirname, '..', 'wallets');
const PASS = process.env.WALLET_PASSPHRASE;
const RPC = process.env.RPC_URL;
const PORT = Number(process.env.PORT ?? 3000);
// Loopback only by default. For remote access keep this as is and put a
// private tunnel in front (see README-REMOTE.md), listing its hostname in
// ALLOWED_HOSTS.
const HOST = process.env.HOST ?? '127.0.0.1';
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS ?? '')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const APP_PASSWORD = process.env.APP_PASSWORD ?? '';
const LOOPBACK_BIND = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const REMOTE = !LOOPBACK_BIND || EXTRA_HOSTS.length > 0;
const LOG_DIR = process.env.LOG_DIR ?? path.join(__dirname, '..', 'logs');
const RECEIVER = process.env.RECEIVER_PUBKEY ? new PublicKey(process.env.RECEIVER_PUBKEY) : null;

if (!PASS) throw new Error('set WALLET_PASSPHRASE');
if (!RPC) throw new Error('set RPC_URL');
if (REMOTE && APP_PASSWORD.length < 12) {
  throw new Error('remote access (HOST or ALLOWED_HOSTS set) requires APP_PASSWORD of 12+ characters');
}
if (APP_PASSWORD && APP_PASSWORD.length < 12) throw new Error('APP_PASSWORD must be 12+ characters');

const connection = new Connection(RPC, 'confirmed');
const app = express();

// Only answer to known hostnames: loopback plus ALLOWED_HOSTS. This blocks
// DNS-rebinding attacks from other web pages.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
app.use((req, res, next) => {
  const host = (req.headers.host ?? '').toLowerCase();
  const bare = host.replace(/:\d+$/, '');
  const ok = (LOCAL_HOSTS.has(bare) && host === `${bare}:${PORT}`)
    || EXTRA_HOSTS.includes(host) || EXTRA_HOSTS.includes(bare);
  if (!ok) return res.status(403).json({ error: 'forbidden host' });
  next();
});

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json());

// With APP_PASSWORD set, everything but the login page requires a session.
const auth = APP_PASSWORD ? createAuth({ password: APP_PASSWORD }) : null;
if (auth) {
  app.use(auth.middleware);
  auth.install(app);
}
app.get('/api/session', (_req, res) => res.json({ auth: Boolean(auth) }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Validates the label on every /:label route before any path is built from it.
app.param('label', (req, res, next, label) => {
  if (!LABEL_RE.test(label)) {
    return res.status(400).json({ error: 'label must be 1-32 chars of [a-zA-Z0-9_-]' });
  }
  next();
});

await fs.mkdir(STORE, { recursive: true, mode: 0o700 });

const engine = new TradeEngine({
  connection, storeDir: STORE, passphrase: PASS, logDir: LOG_DIR, receiver: RECEIVER
});
engine.start();

const notFound = (e) => e?.code === 'ENOENT';

async function allWallets() {
  const out = [];
  for (const f of (await fs.readdir(STORE)).filter((x) => x.endsWith('.json'))) {
    const rec = JSON.parse(await fs.readFile(path.join(STORE, f), 'utf8'));
    out.push({ label: rec.label, mint: normalizeSettings(rec.settings).mint, rules: rec.rules ?? [] });
  }
  return out;
}

// Rejects a change if it would leave a token with both scheduled buys and
// scheduled sells. `change` replaces one wallet's mint and/or rules.
async function assertNoScheduleConflict(label, change) {
  const wallets = (await allWallets()).map((w) => (w.label === label ? { ...w, ...change } : w));
  const msg = scheduleConflict(wallets);
  if (msg) throw new Error(msg);
}

app.get('/api/wallets', async (_req, res) => {
  try {
    const files = (await fs.readdir(STORE)).filter((f) => f.endsWith('.json'));
    const wallets = [];
    for (const f of files) {
      const rec = JSON.parse(await fs.readFile(path.join(STORE, f), 'utf8'));
      const settings = normalizeSettings(rec.settings);
      wallets.push({
        label: rec.label,
        pubkey: rec.pubkey,
        settings,
        rules: rec.rules ?? [],
        lastPrice: engine.lastPrices.get(rec.label) ?? null
      });
    }
    res.json({
      wallets,
      receiver: RECEIVER?.toBase58() ?? null,
      minIntervalMinutes: MIN_INTERVAL_MINUTES,
      venues: VENUE_NAMES
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/wallets', async (req, res) => {
  try {
    const { label } = req.body ?? {};
    if (!LABEL_RE.test(label ?? '')) {
      return res.status(400).json({ error: 'label must be 1-32 chars of [a-zA-Z0-9_-]' });
    }
    const pubkey = await createWallet({ label, passphrase: PASS, storeDir: STORE });
    res.status(201).json({ label, pubkey });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(409).json({ error: 'label already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/wallets/:label', async (req, res) => {
  try {
    const patch = { ...(req.body ?? {}) };
    const cur = normalizeSettings((await readRecord({ label: req.params.label, storeDir: STORE })).settings);
    // A pool belongs to one venue; switching venue without a new pool clears it.
    if ('venue' in patch && patch.venue !== cur.venue && !('pool' in patch)) patch.pool = null;
    const next = { ...cur, ...patch };

    // Any change to where the wallet trades is checked against the chain first.
    if (['venue', 'pool', 'mint'].some((k) => k in patch) && (next.pool || next.mint)) {
      const info = await inspectPool(connection, next);
      if (!next.mint) patch.mint = info.tokenMint;
      if (!next.pool) patch.pool = info.pool;
    }
    if (next.running && !(patch.mint ?? next.mint)) {
      throw new Error('set a pool or token mint before starting automation');
    }
    if ('mint' in patch && patch.mint !== cur.mint) {
      const rec = await readRecord({ label: req.params.label, storeDir: STORE });
      await assertNoScheduleConflict(req.params.label, { mint: patch.mint, rules: rec.rules ?? [] });
    }
    const settings = await updateSettings({ label: req.params.label, storeDir: STORE, patch });
    res.json(settings);
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/wallets/:label', async (req, res) => {
  try {
    await deleteWallet({ label: req.params.label, storeDir: STORE, connection });
    engine.forget(req.params.label);
    res.json({ ok: true });
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/wallets/:label/balance', async (req, res) => {
  try {
    const rec = await readRecord({ label: req.params.label, storeDir: STORE });
    const pubkey = new PublicKey(rec.pubkey);

    const [lamports, legacy, t22, reclaimable] = await Promise.all([
      connection.getBalance(pubkey, 'confirmed'),
      connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
      connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }),
      reclaimableAccounts(connection, pubkey)
    ]);

    const { mint } = normalizeSettings(rec.settings);
    let tokens = null;
    if (mint) {
      const [raw, decimals] = await Promise.all([
        getTokenBalance(connection, pubkey, mint), getDecimals(connection, mint)
      ]);
      tokens = toUi(raw, decimals);
    }

    res.json({
      lamports,
      sol: lamports / 1e9,
      tokens,
      tokenAccounts: legacy.value.length + t22.value.length,
      emptyAccounts: reclaimable.length,
      reclaimableSol: reclaimable.reduce((n, a) => n + a.lamports, 0) / 1e9
    });
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/wallets/:label/rules', async (req, res) => {
  try {
    const rules = await mutateRecord({ label: req.params.label, storeDir: STORE }, async (rec) => {
      const next = normalizeRules(req.body?.rules, rec.rules ?? []);
      await assertNoScheduleConflict(req.params.label, {
        mint: normalizeSettings(rec.settings).mint, rules: next
      });
      rec.rules = next;
      return rec.rules;
    });
    res.json(rules);
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/wallets/:label/trade', async (req, res) => {
  try {
    res.json(await engine.trade(req.params.label, req.body ?? {}));
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/wallets/:label/reclaim', async (req, res) => {
  try {
    res.json(await engine.reclaim(req.params.label));
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wallets/:label/log', async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json(await engine.readLog(req.params.label, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const stopOpts = (body) => ({
  sweep: body?.sweep === true,
  burnUnsellable: body?.burnUnsellable === true
});

app.post('/api/wallets/:label/emergency-stop', async (req, res) => {
  try {
    res.json(await engine.emergencyStop(req.params.label, stopOpts(req.body)));
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/emergency-stop', async (req, res) => {
  try {
    res.json(await engine.emergencyStopAll(stopOpts(req.body)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}`));
