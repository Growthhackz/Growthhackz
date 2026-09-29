import { describe, expect, it } from 'vitest';
import { get } from '../src/db/database.js';
import { cancelPosition, sellNow, sweep, tick, type PositionRow, type TriggerRow } from '../src/services/engine.js';
import { updateSettings } from '../src/services/settings.js';
import { createWallet, updateWallet } from '../src/services/wallets.js';
import { SOL_MINT } from '../src/solana/keys.js';
import { transferFee } from '../src/solana/tx.js';
import { MINT, newKey, OTHER, setup, TRIGGER_TOKEN } from './helpers.js';

const SOL = 1_000_000_000n;
const MIN = 60_000;
const HOUR = 3_600_000;

async function fixture() {
  const s = setup();
  const funding = await newKey();
  const w1 = await newKey();
  const w2 = await newKey();
  await createWallet(s.ctx, { role: 'funding', secretKey: funding.secret });
  const t1 = await createWallet(s.ctx, { role: 'trading', label: 'A', secretKey: w1.secret, buyPct: 50, sellPct: 25, sellIntervalHours: 2 });
  const t2 = await createWallet(s.ctx, { role: 'trading', label: 'B', secretKey: w2.secret, buyPct: 100, sellPct: 0, sellIntervalHours: 1 });
  s.chain.balances.set(funding.address, 10n * SOL);
  s.chain.balances.set(w1.address, 2n * SOL);
  s.chain.balances.set(w2.address, 1n * SOL);
  updateSettings(s.ctx, { initialReceiver: OTHER, initialAmountSol: 0.5 });
  const fire = (body: object = { contractAddress: MINT }) =>
    s.app.inject({ method: 'POST', url: '/v1/trigger', headers: { authorization: `Bearer ${TRIGGER_TOKEN}` }, payload: body });
  const positions = () => s.db.prepare('SELECT * FROM positions ORDER BY rowid').all() as unknown as PositionRow[];
  const setDelay = (minutes: number) => {
    for (const w of [t1.wallet, t2.wallet]) updateWallet(s.ctx, w.id, { buyDelayMinutes: minutes });
  };
  return { ...s, funding, w1, w2, t1: t1.wallet, t2: t2.wallet, fire, positions, setDelay };
}

describe('trigger endpoint', () => {
  it('requires the trigger token', async () => {
    const s = await fixture();
    expect((await s.app.inject({ method: 'POST', url: '/v1/trigger', payload: { contractAddress: MINT } })).statusCode).toBe(401);
    expect(
      (await s.app.inject({ method: 'POST', url: '/v1/trigger', headers: { authorization: 'Bearer nope' }, payload: { ca: MINT } }))
        .statusCode,
    ).toBe(401);
  });

  it('validates the address and dedupes on eventId', async () => {
    const s = await fixture();
    expect((await s.fire({ contractAddress: 'not-an-address' })).statusCode).toBe(400);
    expect((await s.fire({ contractAddress: SOL_MINT })).statusCode).toBe(400);
    const a = await s.fire({ ca: MINT, eventId: 'evt-1' });
    expect(a.statusCode).toBe(202);
    expect(a.json()).toMatchObject({ funding: 'pending', scheduledBuys: 2, duplicate: false });
    const b = await s.fire({ ca: MINT, eventId: 'evt-1' });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ triggerId: a.json().triggerId, duplicate: true });
    expect(s.positions()).toHaveLength(2);
  });

  it('ignores triggers while paused', async () => {
    const s = await fixture();
    updateSettings(s.ctx, { triggersEnabled: false });
    const r = await s.fire();
    expect(r.json()).toMatchObject({ status: 'ignored', scheduledBuys: 0 });
    await tick(s.ctx);
    expect(s.txs()).toHaveLength(0);
  });

  it('skips a wallet that already holds the token', async () => {
    const s = await fixture();
    await s.fire();
    const r = await s.fire();
    expect(r.json().scheduledBuys).toBe(0);
    expect(r.json().note).toContain('already holds');
  });
});

describe('full flow', () => {
  it('funds, waits, buys, sells on the interval and closes', async () => {
    const s = await fixture();
    await s.fire();

    // Funding goes out immediately; buys wait for the delay.
    await tick(s.ctx);
    let txs = s.txs();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ kind: 'funding', to_address: OTHER, amount_in: String(SOL / 2n), status: 'pending' });
    s.confirmAll();
    await tick(s.ctx);
    expect(get<TriggerRow>(s.db, 'SELECT * FROM triggers')!.funding_status).toBe('confirmed');
    expect(s.positions().every((p) => p.status === 'waiting')).toBe(true);

    s.advance(9 * MIN);
    await tick(s.ctx);
    expect(s.txs()).toHaveLength(1);

    s.advance(1 * MIN);
    await tick(s.ctx);
    txs = s.txs().filter((t) => t.kind === 'buy');
    expect(txs).toHaveLength(2);
    // A: 50% of 2 SOL. B: 100% of 1 SOL, capped by the 0.01 SOL reserve.
    expect(txs.map((t) => t.amount_in)).toEqual([String(SOL), String(SOL - SOL / 100n)]);
    expect(s.swapper.quotes.map((q) => [q.inputMint, q.outputMint])).toEqual([
      [SOL_MINT, MINT],
      [SOL_MINT, MINT],
    ]);

    s.confirmAll();
    await tick(s.ctx);
    let [a, b] = s.positions();
    expect(a).toMatchObject({ status: 'holding', sol_spent: String(SOL), tokens_bought: String(SOL * 1000n) });
    expect(a!.next_action_at).toBe(Date.parse('2026-09-29T12:10:00Z') + 2 * HOUR);

    // A sells 25% every 2h; B has sell 0% and just holds.
    s.chain.tokens.set(`${s.w1.address}:${MINT}`, 1_000_000n);
    s.chain.tokens.set(`${s.w2.address}:${MINT}`, 5_000n);
    s.advance(2 * HOUR);
    await tick(s.ctx);
    const sells = s.txs().filter((t) => t.kind === 'sell');
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ amount_in: '250000', wallet_id: s.t1.id });

    s.chain.tokens.set(`${s.w1.address}:${MINT}`, 750_000n);
    s.confirmAll();
    await tick(s.ctx);
    [a, b] = s.positions();
    expect(a).toMatchObject({ status: 'holding', sells: 1, tokens_sold: '250000' });
    expect(b!.status).toBe('holding');

    // Manual "sell all now" sells the whole remaining balance and closes once it reads zero.
    sellNow(s.ctx, a!.id);
    await tick(s.ctx);
    expect(s.txs().filter((t) => t.kind === 'sell').at(-1)!.amount_in).toBe('750000');
    s.chain.tokens.set(`${s.w1.address}:${MINT}`, 0n);
    s.confirmAll();
    await tick(s.ctx);
    expect(s.positions()[0]).toMatchObject({ status: 'closed', sells: 2, sell_override_pct: null });
  });

  it('uses each wallet\'s own delay and swap settings, and applies a changed delay to buys still waiting', async () => {
    const s = await fixture();
    updateWallet(s.ctx, s.t2.id, { buyDelayMinutes: 30, slippageBps: 300 });
    await s.fire();
    s.advance(10 * MIN);
    await tick(s.ctx);
    let buys = s.txs().filter((t) => t.kind === 'buy');
    expect(buys.map((t) => t.wallet_id)).toEqual([s.t1.id]);
    expect(s.swapper.quotes[0]!.slippageBps).toBe(1000);

    updateWallet(s.ctx, s.t2.id, { buyDelayMinutes: 12 });
    s.advance(2 * MIN);
    await tick(s.ctx);
    buys = s.txs().filter((t) => t.kind === 'buy');
    expect(buys.map((t) => t.wallet_id)).toEqual([s.t1.id, s.t2.id]);
    expect(s.swapper.quotes[1]!.slippageBps).toBe(300);
  });

  it('keeps back each wallet\'s own reserve', async () => {
    const s = await fixture();
    s.setDelay(0);
    updateWallet(s.ctx, s.t2.id, { feeReserveSol: 0.2 });
    updateSettings(s.ctx, { initialReceiver: '' });
    await s.fire();
    await tick(s.ctx);
    expect(s.txs().find((t) => t.wallet_id === s.t2.id)!.amount_in).toBe(String(SOL - SOL / 5n));
  });

  it('retries a buy whose blockhash expired, and fails after repeated quote errors', async () => {
    const s = await fixture();
    s.setDelay(0);
    updateSettings(s.ctx, { initialReceiver: '' });
    await s.fire();
    await tick(s.ctx);
    expect(s.txs().filter((t) => t.kind === 'buy')).toHaveLength(2);

    s.chain.height += 1000n;
    await tick(s.ctx);
    expect(s.txs().every((t) => t.status === 'expired')).toBe(true);
    expect(s.positions().map((p) => p.status)).toEqual(['waiting', 'waiting']);

    s.swapper.failQuote = 'TOKEN_NOT_TRADABLE';
    for (let i = 0; i < 10; i++) {
      s.advance(30_000);
      await tick(s.ctx);
    }
    const [p] = s.positions();
    expect(p).toMatchObject({ status: 'failed', buy_attempts: 5 });
    expect(p!.last_error).toContain('TOKEN_NOT_TRADABLE');
  });

  it('marks a preflight rejection failed without leaving it pending', async () => {
    const s = await fixture();
    s.setDelay(0);
    updateSettings(s.ctx, { initialReceiver: '' });
    await s.fire();
    s.chain.rejectNext = 'slippage exceeded';
    await tick(s.ctx);
    const [first] = s.txs();
    expect(first).toMatchObject({ status: 'failed', kind: 'buy' });
    expect(first!.error).toContain('slippage');
    expect(s.positions()[0]).toMatchObject({ status: 'waiting', buy_attempts: 1 });
  });

  it('recovers a position stuck in flight after a crash', async () => {
    const s = await fixture();
    await s.fire();
    s.db.exec("UPDATE positions SET status = 'buying'");
    const r = await tick(s.ctx);
    expect(r.recovered).toBe(2);
    expect(s.positions().every((p) => p.status === 'waiting')).toBe(true);
  });

  it('stops a position on cancel', async () => {
    const s = await fixture();
    s.setDelay(0);
    await s.fire();
    cancelPosition(s.ctx, s.positions()[0]!.id);
    await tick(s.ctx);
    expect(s.txs().filter((t) => t.kind === 'buy')).toHaveLength(1);
  });

  it('refuses funding that would leave the payer below rent', async () => {
    const s = await fixture();
    s.chain.balances.set(s.funding.address, SOL / 2n + 100_000n);
    await s.fire();
    await tick(s.ctx);
    const trg = get<TriggerRow>(s.db, 'SELECT * FROM triggers')!;
    expect(trg.funding_status).toBe('failed');
    expect(trg.note).toContain('balance too low');
  });
});

describe('sweep', () => {
  it('sends each wallet balance minus the fee to the final receiver', async () => {
    const s = await fixture();
    await expect(sweep(s.ctx, [s.t1.id])).rejects.toThrow(/final receiving wallet/);
    updateSettings(s.ctx, { finalReceiver: OTHER });
    s.chain.balances.set(s.w2.address, 0n);
    const r = await sweep(s.ctx, [s.t1.id, s.t2.id]);
    const fee = transferFee(200_000);
    expect(r).toEqual([
      expect.objectContaining({ label: 'A', status: 'sent', lamports: String(2n * SOL - fee) }),
      expect.objectContaining({ label: 'B', status: 'skipped', reason: 'Empty' }),
    ]);
    expect(s.txs()[0]).toMatchObject({ kind: 'sweep', to_address: OTHER });
    // Second sweep while the first is in flight is skipped rather than double-spent.
    expect((await sweep(s.ctx, [s.t1.id]))[0]!.status).toBe('skipped');
  });
});
