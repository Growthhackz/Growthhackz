import express from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LABEL_RE, createWallet, readRecord, updateSettings, deleteWallet
} from './custody.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.WALLET_DIR ?? path.join(__dirname, '..', 'wallets');
const PASS = process.env.WALLET_PASSPHRASE;
const RPC = process.env.RPC_URL;
const PORT = Number(process.env.PORT ?? 3000);
// Loopback only by default. There is no auth, so never expose this on a public interface.
const HOST = process.env.HOST ?? '127.0.0.1';

if (!PASS) throw new Error('set WALLET_PASSPHRASE');
if (!RPC) throw new Error('set RPC_URL');

const connection = new Connection(RPC, 'confirmed');
const app = express();

// Reject requests whose Host isn't loopback, which blocks DNS-rebinding
// attacks from a web page open in the same browser.
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`
]);
app.use((req, res, next) => {
  if (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1') {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
      return res.status(403).json({ error: 'forbidden host' });
    }
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Validates the label on every /:label route before any path is built from it.
app.param('label', (req, res, next, label) => {
  if (!LABEL_RE.test(label)) {
    return res.status(400).json({ error: 'label must be 1-32 chars of [a-zA-Z0-9_-]' });
  }
  next();
});

await fs.mkdir(STORE, { recursive: true, mode: 0o700 });

const notFound = (e) => e?.code === 'ENOENT';

app.get('/api/wallets', async (_req, res) => {
  try {
    const files = (await fs.readdir(STORE)).filter((f) => f.endsWith('.json'));
    const wallets = [];
    for (const f of files) {
      const rec = JSON.parse(await fs.readFile(path.join(STORE, f), 'utf8'));
      wallets.push({ label: rec.label, pubkey: rec.pubkey, settings: rec.settings });
    }
    res.json(wallets);
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
    const settings = await updateSettings({
      label: req.params.label, storeDir: STORE, patch: req.body ?? {}
    });
    res.json(settings);
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/wallets/:label', async (req, res) => {
  try {
    await deleteWallet({ label: req.params.label, storeDir: STORE, connection });
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

    const [lamports, legacy, t22] = await Promise.all([
      connection.getBalance(pubkey, 'confirmed'),
      connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
      connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID })
    ]);

    res.json({
      lamports,
      sol: lamports / 1e9,
      tokenAccounts: legacy.value.length + t22.value.length
    });
  } catch (e) {
    if (notFound(e)) return res.status(404).json({ error: 'no such wallet' });
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}`));
