import { describe, expect, it } from 'vitest';
import { orders } from '../src/db/repositories.js';
import { recoverInterruptedSubmissions } from '../src/services/orderService.js';
import { applyProviderState, pollDueOrders } from '../src/services/pollingService.js';
import { runAutoRefills } from '../src/services/refillService.js';
import { makeApp } from './helpers.js';

const campaignBody = {
  name: 'Launch test',
  targeting: { geo: 'north_america' },
  orders: [
    { product: 'twitter_followers', link: 'https://x.com/growthhackz', quantity: 1000 },
    { product: 'twitter_likes', geo: 'any', link: 'https://x.com/growthhackz/status/111', quantity: 200 },
    { product: 'twitter_comments', link: 'https://x.com/growthhackz/status/111', comments: ['Great thread', 'Useful', 'Agree', 'Nice', 'Saved'] },
    { product: 'website_traffic', link: 'https://example.com/landing', quantity: 5000 },
    { product: 'telegram_members', link: 'https://t.me/growthhackz', quantity: 500, premium: true },
  ],
};

describe('auth', () => {
  it('requires the bearer token except on /health', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/campaigns' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/campaigns', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });
});

describe('campaign lifecycle', () => {
  it('submits, polls to completion and reconciles spend', async () => {
    const { api, mapAll, ctx, clock } = makeApp();
    await mapAll();

    const created = await api('POST', '/v1/campaigns', campaignBody);
    expect(created.status).toBe(201);
    const c = created.body;
    expect(c.orders).toHaveLength(5);
    expect(c.orders.every((o: any) => o.status === 'pending' && o.providerOrderId)).toBe(true);
    expect(c.status).toBe('active');

    const byProduct = Object.fromEntries(c.orders.map((o: any) => [o.product, o]));
    expect(byProduct.twitter_followers.serviceId).toBe('1001');
    expect(byProduct.telegram_members.serviceId).toBe('1007'); // premium mapping
    expect(byProduct.twitter_comments.quantity).toBe(5);
    expect(byProduct.website_traffic.link).toContain('utm_source=growthhackz');
    // 1000 followers at $2.50/1000
    expect(byProduct.twitter_followers.estimatedCostUsd).toBe(2.5);
    expect(c.spentUsd).toBeCloseTo(c.estimatedCostUsd, 6);

    // Nothing is due until the backoff passes.
    expect((await pollDueOrders(ctx)).polled).toBe(0);
    clock.advance(ctx.config.POLL_MIN_BACKOFF_MS);
    expect(await pollDueOrders(ctx)).toEqual({ polled: 5, changed: 5 });
    let now = (await api('GET', `/v1/campaigns/${c.id}`)).body;
    expect(now.orders.every((o: any) => o.status === 'in_progress')).toBe(true);

    clock.advance(ctx.config.POLL_MIN_BACKOFF_MS);
    await pollDueOrders(ctx);
    now = (await api('GET', `/v1/campaigns/${c.id}`)).body;
    expect(now.status).toBe('finished');
    const followers = now.orders.find((o: any) => o.product === 'twitter_followers');
    expect(followers).toMatchObject({ status: 'completed', remains: 0, delivered: 1000, refillDays: 30 });
    expect(followers.refillUntil).toBe(new Date(clock.now().getTime() + 30 * 86_400_000).toISOString());
    expect(followers.nextPollAt).toBeNull();

    const detail = (await api('GET', `/v1/orders/${followers.id}`)).body;
    expect(detail.events.map((e: any) => e.type)).toEqual(['created', 'submitted', 'status_changed', 'status_changed']);
  });

  it('adjusts the ledger when the provider charges less (partial)', async () => {
    const { api, mapAll, ctx } = makeApp();
    await mapAll();
    const c = (await api('POST', '/v1/campaigns', { name: 'p', orders: [{ product: 'twitter_likes', link: 'x.com/a/status/9', quantity: 1000 }] })).body;
    const row = orders.get(ctx.db, c.orders[0].id)!;
    expect(row.estimated_cost_micros).toBe(800_000);
    applyProviderState(ctx, row, {
      providerOrderId: row.provider_order_id!,
      status: 'partial',
      rawStatus: 'Partial',
      chargeMicros: 500_000,
      startCount: 10,
      remains: 375,
      currency: 'USD',
    });
    const after = (await api('GET', `/v1/campaigns/${c.id}`)).body;
    expect(after.spentUsd).toBe(0.5);
    expect(after.orders[0]).toMatchObject({ status: 'partial', chargeUsd: 0.5, delivered: 625 });
    const ledger = (await api('GET', '/v1/ledger')).body.entries;
    expect(ledger.map((e: any) => [e.kind, e.amountUsd])).toEqual([
      ['adjustment', -0.3],
      ['estimate', 0.8],
    ]);
  });

  it('replays a campaign for the same Idempotency-Key instead of ordering twice', async () => {
    const { api, mapAll, provider } = makeApp();
    await mapAll();
    const body = { name: 'idem', orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 100 }] };
    const first = await api('POST', '/v1/campaigns', body, { 'idempotency-key': 'abc-12345' });
    const balanceAfterFirst = provider.balanceMicros;
    const second = await api('POST', '/v1/campaigns', body, { 'idempotency-key': 'abc-12345' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(provider.balanceMicros).toBe(balanceAfterFirst);
  });

  it('blocks a second active order on the same target', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const order = { product: 'twitter_likes', link: 'https://twitter.com/a/status/5', quantity: 100 };
    expect((await api('POST', '/v1/campaigns', { name: 'a', orders: [order] })).status).toBe(201);
    const dup = await api('POST', '/v1/campaigns', { name: 'b', orders: [{ ...order, link: 'x.com/a/status/5' }] });
    expect(dup.status).toBe(409);
    const inBatch = await api('POST', '/v1/campaigns', { name: 'c', orders: [{ ...order, link: 'x.com/a/status/6' }, { ...order, link: 'x.com/a/status/6' }] });
    expect(inBatch.status).toBe(409);
  });

  it('validates against the service catalog', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const tooFew = await api('POST', '/v1/campaigns', { name: 'x', orders: [{ product: 'twitter_followers', geo: 'north_america', link: 'x.com/a', quantity: 10 }] });
    expect(tooFew.status).toBe(400);
    expect(tooFew.body.error.message).toContain('outside the service range');
    const unmapped = await api('POST', '/v1/campaigns', { name: 'x', orders: [{ product: 'twitter_followers', geo: 'canada', link: 'x.com/a', quantity: 100 }] });
    expect(unmapped.status).toBe(400);
    expect(unmapped.body.error.message).toContain('No service mapped');
    const wrongType = await api('POST', '/v1/campaigns', { name: 'x', orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 100, serviceId: '1004' }] });
    expect(wrongType.status).toBe(400);
    const overBudget = await api('POST', '/v1/campaigns', { name: 'x', budgetUsd: 1, orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 5000 }] });
    expect(overBudget.status).toBe(400);
    expect(overBudget.body.error.message).toContain('exceeds budget');
  });

  it('refuses to submit when the provider balance is too low and leaves drafts', async () => {
    const { api, mapAll, provider } = makeApp({}, { balanceUsd: 1 });
    await mapAll();
    const res = await api('POST', '/v1/campaigns', { name: 'poor', orders: [{ product: 'twitter_followers', geo: 'north_america', link: 'x.com/a', quantity: 1000 }] });
    expect(res.status).toBe(402);
    const list = (await api('GET', '/v1/campaigns')).body.campaigns;
    expect(list[0].orders[0].status).toBe('draft');

    provider.balanceMicros = 50_000_000;
    const submitted = await api('POST', `/v1/campaigns/${list[0].id}/submit`);
    expect(submitted.body.orders[0].status).toBe('pending');
  });

  it('can create drafts without submitting', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const res = await api('POST', '/v1/campaigns', { name: 'd', submit: false, orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 100 }] });
    expect(res.body.status).toBe('draft');
    const canceled = await api('POST', `/v1/orders/${res.body.orders[0].id}/cancel`);
    expect(canceled.body.status).toBe('canceled');
  });
});

describe('submission failures', () => {
  it('marks a rejected order failed and records no spend', async () => {
    const { api, mapAll, provider } = makeApp();
    await mapAll();
    provider.failNextAdd = 'reject';
    const c = (await api('POST', '/v1/campaigns', { name: 'r', orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 100 }] })).body;
    expect(c.orders[0]).toMatchObject({ status: 'failed', lastError: 'Mock rejection' });
    expect(c.status).toBe('attention');
    expect(c.spentUsd).toBe(0);
  });

  it('never retries an ambiguous submission and supports manual reconcile', async () => {
    const { api, mapAll, provider } = makeApp();
    await mapAll();
    provider.failNextAdd = 'ambiguous';
    const c = (await api('POST', '/v1/campaigns', { name: 'a', orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 100 }] })).body;
    const id = c.orders[0].id;
    expect(c.orders[0].status).toBe('needs_review');

    // Resubmitting is refused until someone reconciles.
    expect((await api('POST', `/v1/orders/${id}/submit`)).status).toBe(409);
    const review = (await api('GET', '/v1/orders?status=needs_review')).body.orders;
    expect(review.map((o: any) => o.id)).toEqual([id]);

    // Operator confirms on the dashboard that the panel never created it.
    const back = await api('POST', `/v1/orders/${id}/resolve`, { resolution: 'not_created' });
    expect(back.body.status).toBe('draft');
    const resubmitted = await api('POST', `/v1/orders/${id}/submit`);
    expect(resubmitted.body.status).toBe('pending');
  });

  it('links a needs_review order to an existing provider order', async () => {
    const { api, mapAll, provider } = makeApp();
    await mapAll();
    provider.failNextAdd = 'ambiguous';
    const c = (await api('POST', '/v1/campaigns', { name: 'a', orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 100 }] })).body;
    const res = await api('POST', `/v1/orders/${c.orders[0].id}/resolve`, { resolution: 'exists', providerOrderId: '99999' });
    expect(res.body).toMatchObject({ status: 'pending', providerOrderId: '99999' });
    expect((await api('GET', `/v1/campaigns/${c.id}`)).body.spentUsd).toBe(0.08);
  });

  it('moves orders interrupted mid-submit to needs_review on startup', async () => {
    const { api, mapAll, ctx } = makeApp();
    await mapAll();
    const c = (await api('POST', '/v1/campaigns', { name: 's', submit: false, orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 100 }] })).body;
    orders.update(ctx.db, c.orders[0].id, { status: 'submitting' }, new Date().toISOString());
    expect(recoverInterruptedSubmissions(ctx)).toBe(1);
    expect(orders.get(ctx.db, c.orders[0].id)!.status).toBe('needs_review');
  });
});

describe('cancel and refill', () => {
  it('cancels an active order and picks up the refund on the next poll', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const c = (await api('POST', '/v1/campaigns', { name: 'c', orders: [{ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 1000 }] })).body;
    const id = c.orders[0].id;
    await api('POST', `/v1/orders/${id}/cancel`);
    const refreshed = await api('POST', `/v1/orders/${id}/refresh`);
    expect(refreshed.body).toMatchObject({ status: 'canceled', chargeUsd: 0 });
    expect((await api('GET', `/v1/campaigns/${c.id}`)).body.spentUsd).toBe(0);
  });

  it('refills manually and automatically inside the guarantee window only', async () => {
    const { api, mapAll, ctx, clock } = makeApp();
    await mapAll();
    const c = (
      await api('POST', '/v1/campaigns', {
        name: 'r',
        autoRefill: true,
        orders: [{ product: 'twitter_followers', geo: 'north_america', link: 'x.com/a', quantity: 100 }],
      })
    ).body;
    const id = c.orders[0].id;
    expect(c.orders[0].autoRefill).toBe(true);

    // Not delivered yet.
    expect((await api('POST', `/v1/orders/${id}/refill`)).status).toBe(409);
    await api('POST', `/v1/orders/${id}/refresh`);
    await api('POST', `/v1/orders/${id}/refresh`);

    const manual = await api('POST', `/v1/orders/${id}/refill`);
    expect(manual.body.refills).toHaveLength(1);
    expect(manual.body.refills[0].status).toBe('pending');

    // Auto-refill waits AUTO_REFILL_EVERY_DAYS after the last refill.
    expect(await runAutoRefills(ctx)).toBe(0);
    clock.advance(8 * 86_400_000);
    expect(await runAutoRefills(ctx)).toBe(1);

    // After the 30-day window closes, nothing more.
    clock.advance(30 * 86_400_000);
    expect(await runAutoRefills(ctx)).toBe(0);
    expect((await api('POST', `/v1/orders/${id}/refill`)).status).toBe(409);
  });
});

describe('catalog and balance', () => {
  it('lists services, mappings and balance', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const services = (await api('GET', '/v1/catalog/services?q=Telegram')).body.services;
    expect(services.map((s: any) => s.serviceId).sort()).toEqual(['1006', '1007']);
    const mappings = (await api('GET', '/v1/catalog/mappings')).body.mappings;
    expect(mappings).toHaveLength(7);
    expect(mappings.find((m: any) => m.premium).serviceName).toContain('Premium');

    await api('POST', '/v1/ledger/funding', { amountUsd: 100, note: 'initial top-up' });
    const balance = (await api('GET', '/v1/balance')).body;
    expect(balance).toMatchObject({ provider: 'mock', balanceUsd: 100, lowBalance: false, ledger: { fundedUsd: 100, spentUsd: 0 } });
  });

  it('rejects mapping to an unknown service', async () => {
    const { api } = makeApp();
    await api('POST', '/v1/catalog/sync');
    const r = await api('PUT', '/v1/catalog/mappings', { product: 'twitter_likes', serviceId: 'nope' });
    expect(r.status).toBe(400);
  });
});

describe('re-polling a finished order', () => {
  it('does not extend the refill window', async () => {
    const { api, mapAll, clock } = makeApp();
    await mapAll();
    const c = (await api('POST', '/v1/campaigns', { name: 'w', orders: [{ product: 'twitter_followers', geo: 'north_america', link: 'x.com/w', quantity: 100 }] })).body;
    const id = c.orders[0].id;
    await api('POST', `/v1/orders/${id}/refresh`);
    const done = (await api('POST', `/v1/orders/${id}/refresh`)).body;
    expect(done.status).toBe('completed');
    clock.advance(5 * 86_400_000);
    const again = (await api('POST', `/v1/orders/${id}/refresh`)).body;
    expect(again.refillUntil).toBe(done.refillUntil);
    expect(again.completedAt).toBe(done.completedAt);
  });
});
