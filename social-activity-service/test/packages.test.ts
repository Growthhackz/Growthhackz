import { describe, expect, it } from 'vitest';
import { STARTER_PACKAGE } from '../src/domain/packages.js';
import { fitQuantity } from '../src/services/packageService.js';
import { makeApp } from './helpers.js';

const item = (key: string) => STARTER_PACKAGE.items.find((i) => i.key === key)!;

const targets = {
  twitterProfile: '@growthhackz',
  tweet: 'https://x.com/growthhackz/status/1800000000000000000',
  telegram: 'https://t.me/growthhackz',
  website: 'https://example.com/landing',
};
const comments = ['Great thread', 'Saving this', 'Agree with point 2', 'Useful breakdown', 'Following for more', 'Nice'];

describe('fitQuantity', () => {
  it('raises to the service minimum when it is inside the item range', () => {
    const r = fitQuantity(item('telegram_members'), { min_qty: 10, max_qty: 1000, dripfeed: 0 }, 5, false);
    expect(r).toMatchObject({ quantity: 10, runs: 1 });
  });

  it('skips when the service minimum is above the item range unless allowed', () => {
    const svc = { min_qty: 100, max_qty: 1000, dripfeed: 0 };
    expect(fitQuantity(item('telegram_members'), svc, 10, false)).toHaveProperty('skip');
    expect(fitQuantity(item('telegram_members'), svc, 10, true)).toMatchObject({ quantity: 100 });
  });

  it('splits drip-feed so each run stays at or above the minimum', () => {
    expect(fitQuantity(item('twitter_followers'), { min_qty: 10, max_qty: 1000, dripfeed: 1 }, 50, false)).toMatchObject({ quantity: 50, runs: 5 });
    expect(fitQuantity(item('twitter_followers'), { min_qty: 20, max_qty: 1000, dripfeed: 1 }, 50, false)).toMatchObject({ quantity: 50, runs: 2 });
    expect(fitQuantity(item('twitter_followers'), { min_qty: 50, max_qty: 1000, dripfeed: 1 }, 50, false)).toMatchObject({ quantity: 50, runs: 1 });
    expect(fitQuantity(item('twitter_followers'), { min_qty: 10, max_qty: 1000, dripfeed: 0 }, 50, false)).toMatchObject({ quantity: 50, runs: 1 });
  });
});

describe('starter package', () => {
  it('previews against the catalog and explains every adjustment', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const res = await api('POST', '/v1/packages/starter/preview', { targets, comments, include: ['telegram_premium'] });
    expect(res.status).toBe(200);
    const lines = Object.fromEntries(res.body.lines.map((l: any) => [l.item, l]));

    // Mock Telegram services have minimums of 100 and 50: too big for a 5–10 / 1–2 test.
    expect(lines.telegram_members.included).toBe(false);
    expect(lines.telegram_members.skipped).toContain('minimum is 100');
    expect(lines.telegram_premium.included).toBe(false);

    // Followers: min 50, so no room to drip.
    expect(lines.twitter_followers).toMatchObject({ included: true, quantity: 50, runs: 1, serviceId: '1001' });
    // Likes: no NA service mapped, falls back to "any"; 5 × 10 hourly.
    expect(lines.twitter_likes).toMatchObject({ included: true, geo: 'any', quantity: 50, runs: 5, intervalMinutes: 60 });
    expect(lines.twitter_likes.notes.join(' ')).toContain('"any" geo');
    // Retweets: 25 with min 10 → 2 runs of 12.
    expect(lines.twitter_retweets).toMatchObject({ quantity: 24, runs: 2 });
    expect(lines.twitter_comments).toMatchObject({ included: true, quantity: 6 });
    // Traffic: 3 × 500 daily.
    expect(lines.website_traffic).toMatchObject({ quantity: 1500, runs: 3, intervalMinutes: 1440 });

    const expected = 50 * 2.5 / 1000 + 50 * 0.8 / 1000 + 24 * 1.2 / 1000 + 6 * 12 / 1000 + 1500 * 0.3 / 1000;
    expect(res.body.estimatedTotalUsd).toBeCloseTo(expected, 6);
    expect(res.body.orders).toHaveLength(5);
  });

  it('skips items without a target or comments', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const res = await api('POST', '/v1/packages/starter/preview', { targets: { website: 'example.com' } });
    const included = res.body.lines.filter((l: any) => l.included).map((l: any) => l.item);
    expect(included).toEqual(['website_traffic']);
    expect(res.body.lines.find((l: any) => l.item === 'twitter_comments').skipped).toContain('No targets.tweet');
  });

  it('orders a package as a campaign, including standard + premium on the same channel', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const res = await api(
      'POST',
      '/v1/packages/starter/order',
      { targets, comments, include: ['telegram_premium'], allowAboveRange: true, name: 'Starter test' },
      { 'idempotency-key': 'pkg-test-0001' },
    );
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Starter test');
    expect(res.body.orders).toHaveLength(7);
    expect(res.body.orders.every((o: any) => o.status === 'pending')).toBe(true);
    const tg = res.body.orders.filter((o: any) => o.product === 'telegram_members');
    expect(tg.map((o: any) => [o.serviceId, o.quantity]).sort()).toEqual([['1006', 100], ['1007', 50]]);
    const likes = res.body.orders.find((o: any) => o.product === 'twitter_likes');
    expect(likes).toMatchObject({ type: 'drip_feed', quantity: 50, params: { runs: 5, quantityPerRun: 10, intervalMinutes: 60 } });
    expect(res.body.metadata.package).toBe('starter');

    const again = await api('POST', '/v1/packages/starter/order', { targets, comments, include: ['telegram_premium'], allowAboveRange: true }, { 'idempotency-key': 'pkg-test-0001' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);
  });

  it('rejects unknown items and empty packages', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    expect((await api('POST', '/v1/packages/starter/preview', { targets, include: ['nope'] })).status).toBe(400);
    expect((await api('POST', '/v1/packages/nope/preview', { targets })).status).toBe(404);
    const empty = await api('POST', '/v1/packages/starter/order', { targets: {} });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('every package item was skipped');
  });

  it('applies quantity overrides', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const res = await api('POST', '/v1/packages/starter/preview', { targets, quantities: { website_traffic: 2000, twitter_likes: 30 } });
    const lines = Object.fromEntries(res.body.lines.map((l: any) => [l.item, l]));
    expect(lines.website_traffic).toMatchObject({ quantity: 1998, runs: 3 });
    expect(lines.twitter_likes).toMatchObject({ quantity: 30, runs: 3 });
  });
});
