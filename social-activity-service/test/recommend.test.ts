import { describe, expect, it } from 'vitest';
import { toMicros } from '../src/lib/money.js';
import type { ProviderService } from '../src/providers/types.js';
import { makeApp } from './helpers.js';

function svc(id: string, name: string, category: string, rate: number, min: number, opts: Partial<ProviderService> = {}): ProviderService {
  return {
    serviceId: id, name, category, rawType: 'Default', orderType: 'default',
    ratePer1000Micros: toMicros(rate), min, max: 100000, refill: false, cancel: false, dripfeed: false, refillDays: null, ...opts,
  };
}

// Names in the style SMM panels use.
const CATALOG: ProviderService[] = [
  svc('10', 'Twitter Followers | USA | 30 Days Refill', 'Twitter - Followers [USA]', 6.5, 10, { refill: true, refillDays: 30, dripfeed: true }),
  svc('11', 'Twitter Followers | Cheap Bots | No Refill', 'Twitter - Followers', 0.9, 100),
  svc('12', 'Twitter Likes + Views', 'Twitter - Likes', 0.5, 10),
  svc('13', 'Twitter Likes | USA', 'Twitter - Likes [USA]', 2.1, 10, { dripfeed: true }),
  svc('14', 'Twitter Retweets | USA', 'Twitter - Retweets [USA]', 3.2, 10, { dripfeed: true }),
  svc('15', 'Twitter Custom Comments | USA', 'Twitter - Comments', 40, 5, { rawType: 'Custom Comments', orderType: 'custom_comments' }),
  svc('17', 'Twitter Comments Random | USA', 'Twitter - Comments Random', 30, 5, { dripfeed: true }),
  svc('16', 'Twitter Auto Likes [Subscription]', 'Twitter - Auto', 1, 10, { rawType: 'Subscriptions', orderType: 'subscription' }),
  svc('20', 'Telegram Channel Members | USA | R30', 'Telegram - Members [USA]', 3.9, 10, { refill: true, refillDays: 30 }),
  svc('21', 'Telegram Members | Global | Cheap', 'Telegram - Members', 0.6, 500),
  svc('22', 'Telegram Premium Members | USA', 'Telegram - Premium Members', 25, 10),
  svc('23', 'Telegram Post Views', 'Telegram - Views', 0.02, 100),
  svc('30', 'Website Traffic from USA [Organic Google]', 'Website Traffic [USA]', 0.9, 500, { dripfeed: true }),
  svc('31', 'YouTube Views', 'YouTube', 1, 100),
];

describe('service recommendations', () => {
  it('ranks catalog services for each starter item and applies top picks', async () => {
    const { api, provider } = makeApp();
    provider.services = CATALOG;
    await api('POST', '/v1/catalog/sync');
    const recs = (await api('GET', '/v1/catalog/recommendations?package=starter')).body.items;
    const top = Object.fromEntries(recs.map((r: any) => [r.item, r.candidates.map((c: any) => c.service.serviceId)]));

    expect(top.twitter_followers[0]).toBe('10');
    expect(top.twitter_likes).toEqual(['13']); // "Likes + Views" excluded
    expect(top.twitter_retweets).toEqual(['14']);
    expect(top.twitter_comments).toEqual(['17']); // provider-written comments, not custom
    expect(top.telegram_members).toEqual(['22']); // the package's Telegram item is premium
    expect(top.website_traffic_google).toEqual(['30']);
    // Pins only apply to the provider they name.
    expect(recs.every((r: any) => r.pinnedServiceId === null)).toBe(true);

    const applied = (await api('POST', '/v1/catalog/recommendations/apply', {})).body.results;
    expect(applied.every((r: any) => r.applied)).toBe(true);

    const preview = await api('POST', '/v1/packages/starter/preview', {
      targets: { twitterProfile: '@acme', tweet: 'https://x.com/acme/status/1', telegram: 't.me/acmechannel', website: 'https://acme.com' },
    });
    const lines = Object.fromEntries(preview.body.lines.map((l: any) => [l.item, l]));
    expect(lines.telegram_members).toMatchObject({ included: true, quantity: 100 });
    expect(lines.twitter_comments).toMatchObject({ included: true, quantity: 10, serviceId: '17' });
    expect(lines.twitter_followers).toMatchObject({ quantity: 50, runs: 5 });
    expect(lines.website_traffic_google).toMatchObject({ quantity: 500, runs: 1 }); // min 500: no room to drip

    // Existing mappings are kept unless overwrite is set.
    const again = (await api('POST', '/v1/catalog/recommendations/apply', {})).body.results;
    expect(again.every((r: any) => !r.applied)).toBe(true);
  });
});
