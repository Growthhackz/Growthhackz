import { describe, expect, it } from 'vitest';
import { claim, expireLeases } from '../src/services/engine.js';
import { reserve } from '../src/providers/budget.js';
import { ADMIN, demoInput, makeApp } from './helpers.js';

describe('auth and keys', () => {
  it('requires a token, scopes service keys away from admin routes, and revokes', async () => {
    const t = makeApp();
    expect((await t.call(null, 'GET', '/v1/orders')).status).toBe(401);
    expect((await t.call('wrong-token', 'GET', '/v1/orders')).status).toBe(401);
    expect((await t.call(null, 'GET', '/health')).status).toBe(200);

    const issued = await t.api('POST', '/v1/keys', { name: 'buybot' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body.key).toMatch(/^pk_[0-9a-f]{64}$/);
    const key = issued.body.key as string;

    expect((await t.call(key, 'GET', '/v1/orders')).status).toBe(200);
    expect((await t.call(key, 'GET', '/v1/settings')).status).toBe(403);
    expect((await t.call(key, 'POST', '/v1/keys', { name: 'x' })).status).toBe(403);

    const listed = await t.api('GET', '/v1/keys');
    expect(JSON.stringify(listed.body)).not.toContain(key);
    expect(listed.body.keys[0].last_used_at).not.toBeNull();

    expect((await t.api('DELETE', `/v1/keys/${issued.body.id}`)).status).toBe(200);
    expect((await t.call(key, 'GET', '/v1/orders')).status).toBe(401);
  });
});

describe('order intake', () => {
  it('validates, is idempotent on order_id, and rejects conflicting payloads', async () => {
    const t = makeApp();
    const bad = await t.api('POST', '/v1/orders', { ...demoInput, order_id: 'bad', contract_address: 'invalid-address' });
    expect(bad.status).toBe(400);
    expect((await t.api('POST', '/v1/orders', { ...demoInput, extra: 1 })).status).toBe(400);
    expect((await t.api('POST', '/v1/orders', { ...demoInput, telegram_url: 'https://example.com/x' })).status).toBe(400);

    const first = await t.api('POST', '/v1/orders', demoInput);
    expect(first.status).toBe(201);
    const again = await t.api('POST', '/v1/orders', demoInput);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await t.api('POST', '/v1/orders', { ...demoInput, name: 'Changed' })).status).toBe(409);

    const byExt = await t.api('GET', '/v1/orders/by-external-id/test-order');
    expect(byExt.body.id).toBe(first.body.id);
  });

  it('lowercases EVM addresses and normalises channels before hashing', async () => {
    const t = makeApp();
    const base = { ...demoInput, chain: 'base', contract_address: '0xABCDEF0123456789abcdef0123456789ABCDEF01', channels: ['call_channel', 'telegraph', 'call_channel'] };
    const a = await t.api('POST', '/v1/orders', base);
    expect(a.body.project.contract_address).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
    const b = await t.api('POST', '/v1/orders', { ...base, contract_address: base.contract_address.toLowerCase(), channels: ['telegraph', 'call_channel'] });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });
});

describe('demo pipeline', () => {
  it('delivers metadata, copy and hub without spending or publishing', async () => {
    const t = makeApp();
    const order = (await t.api('POST', '/v1/orders', demoInput)).body;
    const r = await t.api('POST', '/v1/tick');
    expect(r.body.processed).toBe(3);
    const done = (await t.api('GET', `/v1/orders/${order.id}`)).body;
    expect(done.status).toBe('delivered');
    expect(done.copy.article).toBeTruthy();
    expect(done.reserved_cents).toBe(0);
    expect(done.jobs.filter((j: any) => j.status === 'delivered')).toHaveLength(3);
    expect(done.jobs.find((j: any) => j.kind === 'hub').result.url).toBe(`https://content.example.test/projects/${order.id}`);
    expect(t.http.calls).toHaveLength(0);
    expect((await t.api('POST', '/v1/render/claim')).body).toBeNull();
    expect((await t.api('POST', '/v1/publish/claim')).body).toBeNull();
    const events = (await t.api('GET', `/v1/orders/${order.id}/events`)).body.events;
    expect(events.map((e: any) => e.type)).toEqual(['order.accepted', 'delivery.updated', 'delivery.updated', 'delivery.updated']);
  });
});

describe('budget, secrets and leases', () => {
  it('caps reservations at the order budget', async () => {
    const t = makeApp();
    const order = (await t.api('POST', '/v1/orders', demoInput)).body;
    reserve(t.ctx, order.id, 80);
    expect(() => reserve(t.ctx, order.id, 21)).toThrow(/allowance/);
    expect((await t.api('GET', `/v1/orders/${order.id}`)).body.reserved_cents).toBe(80);
  });

  it('encrypts saved credentials and never echoes them', async () => {
    const t = makeApp();
    await t.setSetting('GEMINI_API_KEY', 'test-secret-value');
    const stored = t.db.prepare("SELECT value FROM settings WHERE key = 'secret:GEMINI_API_KEY'").get() as { value: string };
    expect(stored.value).not.toContain('test-secret-value');
    const summary = await t.api('GET', '/v1/settings');
    expect(summary.body.connected.GEMINI_API_KEY).toBe(true);
    expect(JSON.stringify(summary.body)).not.toContain('test-secret-value');
    expect((await t.api('PUT', '/v1/settings', { key: 'NOT_A_KEY', value: 'x' })).status).toBe(400);
    expect((await t.api('PUT', '/v1/settings', { key: 'TEXT_MODEL', value: 'gpt-4' })).status).toBe(400);
    expect((await t.api('PUT', '/v1/settings', { key: 'CALLBACK_URL', value: 'http://localhost/x' })).status).toBe(400);
  });

  it('gives a job to exactly one claimant and protects expired publications', async () => {
    const t = makeApp();
    const order = (await t.api('POST', '/v1/orders', { ...demoInput, order_id: 'leases' })).body;
    const [a, b] = [claim(t.ctx, order.id), claim(t.ctx, order.id)];
    expect([a, b].filter(Boolean)).toHaveLength(1);

    t.db.prepare("DELETE FROM jobs WHERE order_id = ? AND kind = 'telegraph'").run(order.id);
    t.db.prepare("UPDATE jobs SET kind = 'telegraph', lease_until = 0 WHERE order_id = ? AND status = 'running'").run(order.id);
    expireLeases(t.ctx);
    const job = t.db.prepare("SELECT * FROM jobs WHERE order_id = ? AND kind = 'telegraph'").get(order.id) as { id: string; status: string };
    expect(job.status).toBe('uncertain');
    expect((await t.api('POST', `/v1/jobs/${job.id}/retry`)).status).toBe(409);
  });
});

describe('public hub', () => {
  it('is off by default and exposes only public fields when enabled', async () => {
    const off = makeApp();
    const o1 = (await off.api('POST', '/v1/orders', demoInput)).body;
    expect((await off.call(null, 'GET', `/projects/${o1.id}`)).status).toBe(404);

    const t = makeApp({ PUBLIC_HUB_ENABLED: 'true' });
    const order = (await t.api('POST', '/v1/orders', { ...demoInput, telegram_owner_id: 987654321, description: '<script>x</script>' })).body;
    await t.api('POST', '/v1/tick');
    const html = await t.call(null, 'GET', `/projects/${order.id}`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(String(html.body)).toContain('Demo');
    const hub = await t.call(null, 'GET', `/projects/${order.id}`, undefined, { accept: 'application/json' });
    expect(hub.body.project.name).toBe('Demo');
    expect(JSON.stringify(hub.body)).not.toContain('987654321');
    expect(JSON.stringify(hub.body)).not.toContain('budget');
    // Public hub doesn't open the rest of the API.
    expect((await t.call(null, 'GET', `/v1/orders/${order.id}`)).status).toBe(401);
    expect(ADMIN).toBeTruthy();
  });
});
