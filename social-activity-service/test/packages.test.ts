import { describe, expect, it } from 'vitest';
import { STARTER_PACKAGE } from '../src/domain/packages.js';
import { toMicros } from '../src/lib/money.js';
import type { ProviderService } from '../src/providers/types.js';
import { fitQuantity } from '../src/services/packageService.js';
import { makeApp } from './helpers.js';

const item = (key: string) => STARTER_PACKAGE.items.find((i) => i.key === key)!;

const targets = {
  twitterProfile: '@growthhackz',
  tweet: 'https://x.com/growthhackz/status/1800000000000000000',
  telegram: 'https://t.me/growthhackz',
  website: 'https://example.com/landing',
};

/** The Followiz services the starter package is pinned to, as listed on 2026-09-24. */
function fz(id: string, name: string, rate: number, min: number, max: number): ProviderService {
  return {
    serviceId: id, name, category: name, rawType: 'Default', orderType: 'default', ratePer1000Micros: toMicros(rate),
    min, max, refill: false, cancel: false, dripfeed: true, refillDays: null,
  };
}
const FOLLOWIZ_PICKS: ProviderService[] = [
  fz('4690', 'Telegram Premium Members [USA] [1 Month Premium]', 6.48, 100, 50000),
  fz('1054', 'X/Twitter Followers [1h - 1k/d - 10k]', 1.19, 10, 10000),
  fz('1501', 'X/Twitter Likes [1h - 250/d - 2.5k] [r7]', 1.8, 10, 2500),
  fz('1101', 'X/Twitter Retweets [1h - 1k/d - 2.5k] [r15]', 2.4, 10, 2500),
  fz('4955', 'X/Twitter Comments Random [1h - 100/d - 150] [Male]', 35, 5, 150),
  fz('4349', 'USA Traffic from Google.com', 0.3, 100, 1000000),
  fz('4354', 'USA Traffic from Reddit', 0.3, 100, 1000000),
  fz('4356', 'USA Traffic from X (Formerly Twitter)', 0.3, 100, 1000000),
];

/** A mock provider that answers to "followiz", so the package's pinned services apply. */
function makeFollowizApp() {
  const app = makeApp();
  Object.assign(app.provider, { name: 'followiz' });
  app.provider.services = FOLLOWIZ_PICKS;
  return app;
}

describe('fitQuantity', () => {
  it('raises to the service minimum when it is inside the item range', () => {
    const r = fitQuantity(item('telegram_members'), { min_qty: 100, max_qty: 1000, dripfeed: 0 }, 50, false);
    expect(r).toMatchObject({ quantity: 100, runs: 1 });
  });

  it('skips when the service minimum is above the item range unless allowed', () => {
    const svc = { min_qty: 500, max_qty: 1000, dripfeed: 0 };
    expect(fitQuantity(item('telegram_members'), svc, 100, false)).toHaveProperty('skip');
    expect(fitQuantity(item('telegram_members'), svc, 100, true)).toMatchObject({ quantity: 500 });
  });

  it('splits drip-feed so each run stays at or above the minimum', () => {
    expect(fitQuantity(item('twitter_followers'), { min_qty: 10, max_qty: 1000, dripfeed: 1 }, 50, false)).toMatchObject({ quantity: 50, runs: 5 });
    expect(fitQuantity(item('twitter_followers'), { min_qty: 20, max_qty: 1000, dripfeed: 1 }, 50, false)).toMatchObject({ quantity: 50, runs: 2 });
    expect(fitQuantity(item('twitter_followers'), { min_qty: 50, max_qty: 1000, dripfeed: 1 }, 50, false)).toMatchObject({ quantity: 50, runs: 1 });
    expect(fitQuantity(item('twitter_followers'), { min_qty: 10, max_qty: 1000, dripfeed: 0 }, 50, false)).toMatchObject({ quantity: 50, runs: 1 });
  });
});

describe('starter package on Followiz (pinned services)', () => {
  it('uses the pinned services with no adjustments', async () => {
    const { api } = makeFollowizApp();
    const res = await api('POST', '/v1/packages/starter/preview', { targets });
    expect(res.status).toBe(200);
    const got = res.body.lines.map((l: any) => [l.item, l.serviceId, l.quantity, l.runs, l.intervalMinutes ?? null, l.notes]);
    expect(got).toEqual([
      ['telegram_members', '4690', 100, 1, null, []],
      ['twitter_followers', '1054', 50, 5, 1440, []],
      ['twitter_likes', '1501', 50, 5, 60, []],
      ['twitter_retweets', '1101', 20, 2, 90, []],
      ['twitter_comments', '4955', 10, 1, null, []],
      ['website_traffic_google', '4349', 500, 5, 720, []],
      ['website_traffic_reddit', '4354', 250, 2, 1440, []],
      ['website_traffic_x', '4356', 350, 2, 1440, []],
    ]);
    const expected = (100 * 6.48 + 50 * 1.19 + 50 * 1.8 + 20 * 2.4 + 10 * 35 + (500 + 250 + 350) * 0.3) / 1000;
    expect(res.body.estimatedTotalUsd).toBeCloseTo(expected, 6);
  });

  it('orders the package as one campaign', async () => {
    const { api } = makeFollowizApp();
    const res = await api('POST', '/v1/packages/starter/order', { targets, name: 'Starter test' }, { 'idempotency-key': 'pkg-test-0001' });
    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(8);
    expect(res.body.orders.every((o: any) => o.status === 'pending')).toBe(true);
    const comments = res.body.orders.find((o: any) => o.product === 'twitter_comments');
    expect(comments).toMatchObject({ type: 'default', serviceId: '4955', quantity: 10 });
    const traffic = res.body.orders.filter((o: any) => o.product === 'website_traffic');
    expect(traffic.map((o: any) => [o.serviceId, o.quantity]).sort()).toEqual([['4349', 500], ['4354', 250], ['4356', 350]]);
    expect(res.body.metadata.package).toBe('starter');

    const again = await api('POST', '/v1/packages/starter/order', { targets }, { 'idempotency-key': 'pkg-test-0001' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);
  });

  it('falls back to the product mapping when a pinned service is gone', async () => {
    const { api, provider } = makeFollowizApp();
    provider.services = FOLLOWIZ_PICKS.filter((s) => s.serviceId !== '1054');
    const res = await api('POST', '/v1/packages/starter/preview', { targets });
    const line = res.body.lines.find((l: any) => l.item === 'twitter_followers');
    expect(line.included).toBe(false);
    expect(line.notes.join(' ')).toContain('Pinned service 1054 unusable');
  });
});

describe('starter package on other providers (mappings)', () => {
  it('previews against the mapped services and explains every adjustment', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    await api('PUT', '/v1/catalog/mappings', { product: 'twitter_comments', geo: 'north_america', premium: false, serviceId: '1009' });
    const res = await api('POST', '/v1/packages/starter/preview', { targets });
    expect(res.status).toBe(200);
    const lines = Object.fromEntries(res.body.lines.map((l: any) => [l.item, l]));

    // Premium Telegram maps to 1007 (min 50).
    expect(lines.telegram_members).toMatchObject({ included: true, quantity: 100, serviceId: '1007' });
    // Followers: min 50, so no room to drip.
    expect(lines.twitter_followers).toMatchObject({ included: true, quantity: 50, runs: 1, serviceId: '1001' });
    // Likes: no NA service mapped, falls back to "any"; 5 × 10 hourly.
    expect(lines.twitter_likes).toMatchObject({ included: true, geo: 'any', quantity: 50, runs: 5, intervalMinutes: 60 });
    expect(lines.twitter_likes.notes.join(' ')).toContain('"any" geo');
    expect(lines.twitter_retweets).toMatchObject({ quantity: 20, runs: 2 });
    expect(lines.twitter_comments).toMatchObject({ included: true, quantity: 10, serviceId: '1009' });
    // Traffic: all three share the one mapped service (min 100).
    expect(lines.website_traffic_google).toMatchObject({ quantity: 500, runs: 5, intervalMinutes: 720, serviceId: '1005' });
    expect(lines.website_traffic_reddit).toMatchObject({ quantity: 250, runs: 2 });
    expect(lines.website_traffic_x).toMatchObject({ quantity: 350, runs: 2 });
    expect(res.body.orders).toHaveLength(8);
  });

  it('skips items without a target, and a custom-comments mapping for provider-written comments', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const res = await api('POST', '/v1/packages/starter/preview', { targets: { website: 'example.com', tweet: targets.tweet } });
    const included = res.body.lines.filter((l: any) => l.included).map((l: any) => l.item);
    expect(included).toEqual(['twitter_likes', 'twitter_retweets', 'website_traffic_google', 'website_traffic_reddit', 'website_traffic_x']);
    expect(res.body.lines.find((l: any) => l.item === 'telegram_members').skipped).toContain('No targets.telegram');
    expect(res.body.lines.find((l: any) => l.item === 'twitter_comments').included).toBe(false);
  });

  it('rejects unknown items and empty packages', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    expect((await api('POST', '/v1/packages/starter/preview', { targets, include: ['telegram_premium'] })).status).toBe(400);
    expect((await api('POST', '/v1/packages/nope/preview', { targets })).status).toBe(404);
    const empty = await api('POST', '/v1/packages/starter/order', { targets: {} });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('every package item was skipped');
  });

  it('applies quantity overrides', async () => {
    const { api, mapAll } = makeApp();
    await mapAll();
    const res = await api('POST', '/v1/packages/starter/preview', { targets, quantities: { website_traffic_google: 1000, twitter_likes: 30 } });
    const lines = Object.fromEntries(res.body.lines.map((l: any) => [l.item, l]));
    expect(lines.website_traffic_google).toMatchObject({ quantity: 1000, runs: 5 });
    expect(lines.twitter_likes).toMatchObject({ quantity: 30, runs: 3 });
  });
});
