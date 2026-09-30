import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createBurnInstruction, createCloseAccountInstruction
} from '@solana/spl-token';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadWallet, readRecord, mutateRecord, normalizeSettings } from './custody.js';
import { SOL_MINT, swap } from './jupiter.js';
import {
  getDecimals, getTokenBalance, getTokenAccounts, getPriceInSol, toBaseUnits, toUi
} from './tokens.js';
import { validateTrade, evaluateRule, afterRun } from './rules.js';
import { closeEmptyTokenAccounts, sweepAll } from './teardown.js';

const errMsg = (e) => String(e?.message ?? e);

export class TradeEngine {
  constructor({ connection, storeDir, passphrase, logDir, receiver = null, tickMs = 30_000 }) {
    Object.assign(this, { connection, storeDir, passphrase, logDir, receiver, tickMs });
    this.keypairs = new Map();
    this.locks = new Map();
    this.timer = null;
    this.ticking = false;
    this.lastPrices = new Map();
  }

  // ---- plumbing -----------------------------------------------------------

  async keypair(label) {
    if (!this.keypairs.has(label)) {
      const { keypair } = await loadWallet({
        label, passphrase: this.passphrase, storeDir: this.storeDir
      });
      this.keypairs.set(label, keypair);
    }
    return this.keypairs.get(label);
  }

  forget(label) {
    this.keypairs.delete(label);
  }

  // One on-chain operation per wallet at a time: a rule firing, a manual trade
  // and an emergency stop queue behind each other instead of racing.
  withLock(label, fn) {
    const prev = this.locks.get(label) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(label, run.catch(() => {}));
    return run;
  }

  async log(label, entry) {
    await fs.mkdir(this.logDir, { recursive: true });
    const line = JSON.stringify({ at: Date.now(), ...entry }) + '\n';
    await fs.appendFile(path.join(this.logDir, `${label}.jsonl`), line);
  }

  async readLog(label, limit = 100) {
    try {
      const text = await fs.readFile(path.join(this.logDir, `${label}.jsonl`), 'utf8');
      return text.trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async labels() {
    const files = await fs.readdir(this.storeDir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  }

  // ---- trading ------------------------------------------------------------

  async #execute(label, trade, reason) {
    const { side, amountType, amount } = validateTrade(trade);
    const rec = await readRecord({ label, storeDir: this.storeDir });
    const settings = normalizeSettings(rec.settings);
    if (!settings.mint) throw new Error('set a token mint for this wallet first');

    const wallet = await this.keypair(label);
    const { connection } = this;
    const mint = settings.mint;
    const decimals = await getDecimals(connection, mint);

    let inputMint, outputMint, raw;
    if (side === 'buy') {
      const balance = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
      const floor = BigInt(settings.solFloorLamports);
      const available = balance > floor ? balance - floor : 0n;
      raw = amountType === 'sol'
        ? BigInt(Math.floor(amount * 1e9))
        : (available * BigInt(Math.round(amount * 100))) / 10_000n;
      if (raw <= 0n) throw new Error('nothing to spend above the SOL floor');
      if (raw > available) {
        throw new Error(
          `buy of ${toUi(raw, 9)} SOL would drop below the SOL floor ` +
          `(${toUi(available, 9)} SOL available)`
        );
      }
      inputMint = SOL_MINT;
      outputMint = mint;
    } else {
      const balance = await getTokenBalance(connection, wallet.publicKey, mint);
      raw = amountType === 'token'
        ? toBaseUnits(amount, decimals)
        : (balance * BigInt(Math.round(amount * 100))) / 10_000n;
      if (raw <= 0n) throw new Error('no tokens to sell');
      if (raw > balance) {
        throw new Error(`sell of ${toUi(raw, decimals)} exceeds balance ${toUi(balance, decimals)}`);
      }
      inputMint = mint;
      outputMint = SOL_MINT;
    }

    const base = { type: 'trade', side, amountType, amount, reason, mint };
    try {
      const res = await swap({
        connection, wallet, inputMint, outputMint, amount: raw, slippageBps: settings.slippageBps
      });
      const [inDec, outDec] = side === 'buy' ? [9, decimals] : [decimals, 9];
      const entry = {
        ...base, ok: true, signature: res.signature,
        in: toUi(BigInt(res.inAmount), inDec), out: toUi(BigInt(res.outAmount), outDec)
      };
      await this.log(label, entry);
      return entry;
    } catch (e) {
      await this.log(label, { ...base, ok: false, error: errMsg(e) });
      throw e;
    }
  }

  // Manual trade from the UI or CLI. Works whether or not automation is running.
  trade(label, trade) {
    return this.withLock(label, () => this.#execute(label, trade, 'manual'));
  }

  // ---- automation ---------------------------------------------------------

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('engine tick:', errMsg(e)));
    }, this.tickMs);
    this.tick().catch((e) => console.error('engine tick:', errMsg(e)));
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async #saveRuleState(label, id, next) {
    await mutateRecord({ label, storeDir: this.storeDir }, (rec) => {
      const r = (rec.rules ?? []).find((x) => x.id === id);
      if (!r) return;
      // Only runtime fields; never re-enable a rule the user switched off meanwhile.
      r.runs = next.runs;
      r.lastRunAt = next.lastRunAt;
      r.armed = next.armed;
      r.enabled = r.enabled && next.enabled;
    });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const prices = new Map();
      for (const label of await this.labels()) {
        let rec;
        try { rec = await readRecord({ label, storeDir: this.storeDir }); }
        catch { continue; }
        const settings = normalizeSettings(rec.settings);
        const rules = (rec.rules ?? []).filter((r) => r.enabled);
        if (!settings.running || !settings.mint || rules.length === 0) continue;

        if (!prices.has(settings.mint)) {
          let p = null;
          try { p = await getPriceInSol(this.connection, settings.mint); }
          catch (e) { console.error(`price ${settings.mint}:`, errMsg(e)); }
          prices.set(settings.mint, p);
          if (p != null) this.lastPrices.set(settings.mint, { price: p, at: Date.now() });
        }
        const price = prices.get(settings.mint);

        for (const rule of rules) {
          const { fire, next } = evaluateRule(rule, { price, now: Date.now() });
          if (!fire) {
            if (next !== rule) await this.#saveRuleState(label, rule.id, next);
            continue;
          }
          await this.withLock(label, async () => {
            // Re-check: an emergency stop or a user edit may have landed while queued.
            const cur = await readRecord({ label, storeDir: this.storeDir });
            const live = (cur.rules ?? []).find((r) => r.id === rule.id);
            if (!normalizeSettings(cur.settings).running || !live?.enabled) return;

            let ok = false;
            try {
              await this.#execute(label, rule, `rule: ${describeRule(rule)}`);
              ok = true;
            } catch (e) {
              console.error(`${label} rule ${rule.id}:`, errMsg(e));
            }
            await this.#saveRuleState(label, rule.id, afterRun(next, { now: Date.now(), ok }));
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // ---- emergency stop -----------------------------------------------------

  // Cancels every rule, sells every token to SOL, closes token accounts to
  // reclaim rent, and optionally sweeps SOL to the receiver. Keeps going past
  // individual failures and reports each step.
  async emergencyStop(label, { sweep = false, burnUnsellable = false } = {}) {
    const report = { label, steps: [] };
    const step = (name, data) => report.steps.push({ name, ...data });

    // Flip the switches first so nothing new starts while we wait for the lock.
    const cancelled = await mutateRecord({ label, storeDir: this.storeDir }, (rec) => {
      rec.settings = { ...normalizeSettings(rec.settings), running: false };
      let n = 0;
      for (const r of rec.rules ?? []) { if (r.enabled) n++; r.enabled = false; }
      return n;
    });
    step('cancelRules', { ok: true, cancelled });

    await this.withLock(label, async () => {
      const { connection } = this;
      const wallet = await this.keypair(label);
      const accounts = await getTokenAccounts(connection, wallet.publicKey);

      const byMint = new Map();
      for (const a of accounts) {
        if (a.amount === 0n || a.mint === SOL_MINT) continue;
        byMint.set(a.mint, (byMint.get(a.mint) ?? 0n) + a.amount);
      }

      // Getting out matters more than price here, so allow at least 5% slippage.
      const { settings } = await readRecord({ label, storeDir: this.storeDir });
      const slippageBps = Math.max(500, normalizeSettings(settings).slippageBps);

      const unsold = new Set();
      for (const [mint, amount] of byMint) {
        try {
          const res = await swap({
            connection, wallet, inputMint: mint, outputMint: SOL_MINT, amount, slippageBps
          });
          step('sell', { ok: true, mint, signature: res.signature, solOut: toUi(BigInt(res.outAmount), 9) });
        } catch (e) {
          unsold.add(mint);
          step('sell', { ok: false, mint, error: errMsg(e) });
        }
      }

      // Wrapped SOL and (optionally) unsellable dust: empty the account so it can close.
      const fresh = await getTokenAccounts(connection, wallet.publicKey);
      for (const a of fresh) {
        if (a.amount === 0n) continue;
        const isWsol = a.mint === SOL_MINT;
        if (!isWsol && !(burnUnsellable && unsold.has(a.mint))) continue;
        try {
          const tx = new Transaction();
          if (!isWsol) {
            tx.add(createBurnInstruction(
              a.pubkey, new PublicKey(a.mint), wallet.publicKey, a.amount, [], a.programId
            ));
          }
          // Closing a native (wSOL) account returns its wrapped SOL along with the rent.
          tx.add(createCloseAccountInstruction(
            a.pubkey, wallet.publicKey, wallet.publicKey, [], a.programId
          ));
          const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
          step(isWsol ? 'unwrapSol' : 'burnAndClose', { ok: true, mint: a.mint, signature: sig });
        } catch (e) {
          step(isWsol ? 'unwrapSol' : 'burnAndClose', { ok: false, mint: a.mint, error: errMsg(e) });
        }
      }

      const failed = [];
      const closed = [
        ...await closeEmptyTokenAccounts({ connection, wallet, programId: TOKEN_PROGRAM_ID, failed }),
        ...await closeEmptyTokenAccounts({ connection, wallet, programId: TOKEN_2022_PROGRAM_ID, failed })
      ];
      const left = (await getTokenAccounts(connection, wallet.publicKey)).length;
      step('closeTokenAccounts', { ok: failed.length === 0 && left === 0, closed: closed.length, failed, stillOpen: left });

      if (sweep) {
        if (!this.receiver) {
          step('sweep', { ok: false, error: 'RECEIVER_PUBKEY not set; SOL left in wallet' });
        } else if (left > 0) {
          step('sweep', { ok: false, error: `${left} token account(s) still open; sweep skipped so rent isn't stranded` });
        } else {
          try {
            const lamports = await sweepAll({ connection, wallet, receiver: this.receiver });
            step('sweep', { ok: true, sol: toUi(lamports, 9), to: this.receiver.toBase58() });
          } catch (e) {
            step('sweep', { ok: false, error: errMsg(e) });
          }
        }
      }

      const sol = await connection.getBalance(wallet.publicKey, 'confirmed');
      report.finalSol = sol / 1e9;
    });

    report.ok = report.steps.every((s) => s.ok);
    await this.log(label, { type: 'emergencyStop', ok: report.ok, report });
    return report;
  }

  async emergencyStopAll(opts) {
    const labels = await this.labels();
    // Cancel everything up front, then unwind wallets in parallel.
    return Promise.all(labels.map((l) =>
      this.emergencyStop(l, opts).catch((e) => ({ label: l, ok: false, error: errMsg(e) }))
    ));
  }
}

export function describeRule(r) {
  const amt = {
    sol: `${r.amount} SOL`,
    pctSol: `${r.amount}% of SOL`,
    token: `${r.amount} tokens`,
    pctToken: `${r.amount}% of tokens`
  }[r.amountType];
  const t = r.trigger;
  const when = t.type === 'interval'
    ? `every ${t.minutes} min`
    : `when price ${t.type === 'priceAbove' ? '≥' : '≤'} ${t.price} SOL`;
  return `${r.side} ${amt} ${when}`;
}
