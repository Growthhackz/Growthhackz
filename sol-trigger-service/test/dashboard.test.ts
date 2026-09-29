import { describe, expect, it } from 'vitest';
import { get } from '../src/db/database.js';
import { lamportsToSol, percentOf, solToLamports } from '../src/lib/money.js';
import { normaliseSecret } from '../src/solana/keys.js';
import { login, MINT, newKey, OTHER, PASSWORD, setup } from './helpers.js';

describe('dashboard auth', () => {
  it('serves the page but guards the API', async () => {
    const { app } = setup();
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: { cookie: 'sts_session=1.x.y' } })).statusCode).toBe(401);
  });

  it('logs in with the password and throttles guessing', async () => {
    const { app } = setup();
    const cookie = await login(app);
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: { cookie } })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++)
      expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } })).statusCode).toBe(429);
  });

  it('expires sessions', async () => {
    const s = setup({ SESSION_TTL_HOURS: '1' });
    const cookie = await login(s.app);
    s.advance(61 * 60_000);
    expect((await s.app.inject({ method: 'GET', url: '/api/state', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects cross-site style requests', async () => {
    const { app } = setup();
    const cookie = await login(app);
    const plain = await app.inject({
      method: 'PUT', url: '/api/settings', headers: { cookie, 'content-type': 'text/plain' }, payload: '{"buyDelayMinutes":1}',
    });
    expect(plain.statusCode).toBe(415);
    const foreign = await app.inject({
      method: 'PUT', url: '/api/settings', headers: { cookie, origin: 'https://evil.example' }, payload: { buyDelayMinutes: 1 },
    });
    expect(foreign.statusCode).toBe(403);
  });
});

describe('dashboard actions', () => {
  it('manages settings, wallets and never returns private keys', async () => {
    const s = setup();
    const cookie = await login(s.app);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
      s.app.inject({ method, url, headers: { cookie }, payload });

    expect((await call('PUT', '/api/settings', { initialReceiver: 'bad' })).statusCode).toBe(400);
    const saved = await call('PUT', '/api/settings', { initialReceiver: OTHER, initialAmountSol: 0.25, buyDelayMinutes: 15 });
    expect(saved.json().settings).toMatchObject({ initialReceiver: OTHER, initialAmountSol: 0.25, buyDelayMinutes: 15, slippageBps: 1000 });
    expect((await call('PUT', '/api/settings', { initialReceiver: '' })).json().settings.initialReceiver).toBeNull();

    const key = await newKey();
    const imported = await call('POST', '/api/wallets', { role: 'trading', label: 'W1', secretKey: key.secret, buyPct: 40, sellPct: 10, sellIntervalHours: 6 });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().wallet.address).toBe(key.address);
    expect(imported.json().generatedSecret).toBeUndefined();
    expect((await call('POST', '/api/wallets', { role: 'trading', label: 'dup', secretKey: key.secret, buyPct: 1, sellPct: 1, sellIntervalHours: 1 })).statusCode).toBe(409);
    expect((await call('POST', '/api/wallets', { role: 'trading', label: 'x', secretKey: 'abc', buyPct: 1, sellPct: 1, sellIntervalHours: 1 })).statusCode).toBe(400);

    const generated = await call('POST', '/api/wallets', { role: 'trading', label: 'W2', generate: true, buyPct: 20, sellPct: 50, sellIntervalHours: 0.5 });
    const g = generated.json();
    expect((await normaliseSecret(g.generatedSecret)).address).toBe(g.wallet.address);

    const id = imported.json().wallet.id;
    const edited = await call('PATCH', `/api/wallets/${id}`, { sellPct: 33, enabled: false });
    expect(edited.json().wallet).toMatchObject({ buyPct: 40, sellPct: 33, enabled: false });

    s.chain.balances.set(key.address, 1_500_000_000n);
    const state = await call('GET', '/api/state');
    expect(state.body).not.toContain(key.secret);
    expect(state.body).not.toContain(g.generatedSecret);
    expect(state.body).not.toContain('secret');
    expect(state.json().wallets.find((w: { id: string }) => w.id === id).balanceSol).toBe('1.5');

    expect((await call('POST', `/api/wallets/${id}/remove`, {})).statusCode).toBe(200);
    expect((await call('GET', '/api/state')).json().wallets).toHaveLength(1);
    const sealed = get<{ secret_sealed: string }>(s.db, 'SELECT secret_sealed FROM wallets WHERE id = :id', { id })!.secret_sealed;
    expect(sealed).not.toContain(key.secret);
  });

  it('fires a manual trigger and sweeps', async () => {
    const s = setup();
    const cookie = await login(s.app);
    const call = (url: string, payload: object) => s.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    const key = await newKey();
    const w = (await call('/api/wallets', { role: 'trading', label: 'W', secretKey: key.secret, buyPct: 10, sellPct: 10, sellIntervalHours: 1 })).json().wallet;
    expect((await call('/api/trigger', { contractAddress: MINT })).json()).toMatchObject({ status: 'active', scheduledBuys: 1 });

    s.chain.balances.set(key.address, 1_000_000_000n);
    expect((await call('/api/sweep', { walletIds: [w.id] })).statusCode).toBe(400);
    await s.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { finalReceiver: OTHER } });
    const r = (await call('/api/sweep', { walletIds: [w.id] })).json();
    expect(r.results[0]).toMatchObject({ status: 'sent' });
  });
});

describe('money', () => {
  it('converts without float drift', () => {
    expect(solToLamports(0.1)).toBe(100_000_000n);
    expect(solToLamports('1.000000001')).toBe(1_000_000_001n);
    expect(lamportsToSol(1_500_000_000n)).toBe('1.5');
    expect(percentOf(1_000n, 33.33)).toBe(333n);
    expect(percentOf(10n ** 18n, 100)).toBe(10n ** 18n);
  });
});
