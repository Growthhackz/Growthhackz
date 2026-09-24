import { describe, expect, it } from 'vitest';
import { FollowizClient, type ProviderCallRecord } from '../src/providers/followiz/client.js';
import { parseRefillDays } from '../src/providers/followiz/mapper.js';
import { FollowizProvider } from '../src/providers/followiz/provider.js';
import { ProviderAmbiguousError, ProviderRejectedError } from '../src/providers/types.js';

type Handler = (params: URLSearchParams) => { status?: number; body: string } | Error;

function setup(handler: Handler) {
  const calls: URLSearchParams[] = [];
  const records: ProviderCallRecord[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const params = new URLSearchParams(String(init.body));
    calls.push(params);
    const out = handler(params);
    if (out instanceof Error) throw out;
    return new Response(out.body, { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  const client = new FollowizClient({
    apiUrl: 'https://followiz.test/api/v2',
    apiKey: 'secret-key',
    timeoutMs: 1000,
    minIntervalMs: 0,
    fetchImpl,
    recorder: (r) => records.push(r),
  });
  return { provider: new FollowizProvider(client), calls, records };
}

describe('FollowizProvider', () => {
  it('maps the services list', async () => {
    const { provider } = setup(() => ({
      body: JSON.stringify([
        { service: 1, name: 'Twitter Followers [R30]', type: 'Default', category: 'Twitter', rate: '2.50', min: '50', max: '10000', refill: true, cancel: false, dripfeed: true },
        { service: '2', name: 'Custom Comments', type: 'Custom Comments', category: 'Twitter', rate: 12, min: 5, max: 500 },
      ]),
    }));
    const services = await provider.listServices();
    expect(services[0]).toMatchObject({ serviceId: '1', orderType: 'default', ratePer1000Micros: 2_500_000, min: 50, max: 10000, refill: true, dripfeed: true, refillDays: 30 });
    expect(services[1]).toMatchObject({ serviceId: '2', orderType: 'custom_comments', refill: false });
  });

  it('sends custom comments newline-separated and never logs the key', async () => {
    const { provider, calls, records } = setup(() => ({ body: '{"order": 23501}' }));
    const res = await provider.addOrder({ type: 'custom_comments', serviceId: '2', link: 'https://x.com/a/status/1', comments: ['one', 'two'] });
    expect(res.providerOrderId).toBe('23501');
    expect(calls[0]!.get('key')).toBe('secret-key');
    expect(calls[0]!.get('action')).toBe('add');
    expect(calls[0]!.get('comments')).toBe('one\ntwo');
    expect(records[0]!.request).not.toHaveProperty('key');
  });

  it('sends drip-feed and subscription params', async () => {
    const { provider, calls } = setup(() => ({ body: '{"order": 1}' }));
    await provider.addOrder({ type: 'drip_feed', serviceId: '1', link: 'l', quantity: 100, runs: 5, intervalMinutes: 30 });
    await provider.addOrder({ type: 'subscription', serviceId: '3', username: 'bob', min: 10, max: 20, posts: 5, delayMinutes: 0 });
    expect(Object.fromEntries(calls[0]!)).toMatchObject({ quantity: '100', runs: '5', interval: '30' });
    expect(Object.fromEntries(calls[1]!)).toMatchObject({ username: 'bob', min: '10', max: '20', posts: '5', delay: '0' });
    expect(calls[1]!.has('link')).toBe(false);
  });

  it('uses multi-order status and keeps per-order errors', async () => {
    const { provider, calls } = setup(() => ({
      body: JSON.stringify({
        '10': { charge: '0.27819', start_count: '3572', status: 'Partial', remains: '157', currency: 'USD' },
        '11': { error: 'Incorrect order ID' },
        '12': { charge: '1', start_count: '0', status: 'In progress', remains: '10', currency: 'USD' },
      }),
    }));
    const states = await provider.getStatuses(['10', '11', '12']);
    expect(calls[0]!.get('orders')).toBe('10,11,12');
    expect(states.get('10')).toMatchObject({ status: 'partial', chargeMicros: 278_190, startCount: 3572, remains: 157 });
    expect(states.get('11')).toMatchObject({ status: 'unknown', error: 'Incorrect order ID' });
    expect(states.get('12')?.status).toBe('in_progress');
  });

  it('chunks status lookups at 100 ids', async () => {
    const { provider, calls } = setup(() => ({ body: '{}' }));
    await provider.getStatuses(Array.from({ length: 250 }, (_, i) => String(i)));
    expect(calls.map((c) => c.get('orders')!.split(',').length)).toEqual([100, 100, 50]);
  });

  it('treats {"error"} as a definite rejection', async () => {
    const { provider } = setup(() => ({ body: '{"error": "Not enough funds on balance"}' }));
    await expect(provider.addOrder({ type: 'default', serviceId: '1', link: 'l', quantity: 1 })).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it.each([
    ['network failure', () => new Error('ECONNRESET')],
    ['HTTP 502', () => ({ status: 502, body: 'bad gateway' })],
    ['non-JSON 200', () => ({ body: '<html>cloudflare</html>' })],
    ['200 without order id', () => ({ body: '{}' })],
  ] as Array<[string, Handler]>)('treats %s on add as ambiguous', async (_label, handler) => {
    const { provider } = setup(handler);
    await expect(provider.addOrder({ type: 'default', serviceId: '1', link: 'l', quantity: 1 })).rejects.toBeInstanceOf(ProviderAmbiguousError);
  });

  it('parses cancel results', async () => {
    const { provider } = setup(() => ({ body: JSON.stringify([{ order: 9, cancel: { error: 'Incorrect order ID' } }, { order: 2, cancel: 1 }]) }));
    const res = await provider.cancel(['9', '2']);
    expect(res.get('9')).toEqual({ ok: false, error: 'Incorrect order ID' });
    expect(res.get('2')).toEqual({ ok: true });
  });

  it('reads balance', async () => {
    const { provider } = setup(() => ({ body: '{"balance": "100.84292", "currency": "USD"}' }));
    expect(await provider.getBalance()).toEqual({ balanceMicros: 100_842_920, currency: 'USD' });
  });
});

describe('parseRefillDays', () => {
  it.each([
    ['Followers [R30]', 30],
    ['Followers | 30 Days Refill', 30],
    ['Members - Refill: 60 days', 60],
    ['Lifetime Refill Followers', 3650],
    ['Followers [No Refill]', 0],
    ['Followers HQ', null],
  ])('%s → %s', (name, days) => {
    expect(parseRefillDays(name)).toBe(days);
  });
});
