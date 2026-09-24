import { describe, expect, it } from 'vitest';
import { LinkError, normalizeLink } from '../src/domain/links.js';
import { OrderInputSchema } from '../src/domain/schemas.js';

describe('normalizeLink', () => {
  it('normalizes twitter profiles and posts', () => {
    expect(normalizeLink('twitter_profile', 'twitter.com/Growth_Hackz/')).toEqual({ link: 'https://x.com/Growth_Hackz', key: 'twitter:@growth_hackz' });
    expect(normalizeLink('twitter_post', 'https://mobile.x.com/foo/status/1234567890?s=20')).toEqual({ link: 'https://x.com/foo/status/1234567890', key: 'twitter:status:1234567890' });
  });

  it('rejects wrong link shapes', () => {
    expect(() => normalizeLink('twitter_profile', 'https://x.com/foo/status/1')).toThrow(LinkError);
    expect(() => normalizeLink('twitter_post', 'https://x.com/foo')).toThrow(LinkError);
    expect(() => normalizeLink('twitter_profile', 'https://facebook.com/foo')).toThrow(LinkError);
    expect(() => normalizeLink('twitter_profile', 'https://x.com/home')).toThrow(LinkError);
  });

  it('handles telegram public channels and invites', () => {
    expect(normalizeLink('telegram_channel', 't.me/MyChannel')).toEqual({ link: 'https://t.me/MyChannel', key: 'telegram:mychannel' });
    expect(normalizeLink('telegram_channel', 'https://t.me/+AbCdEf123').key).toBe('telegram:invite:AbCdEf123');
    expect(normalizeLink('telegram_channel', 'https://t.me/joinchat/AbCdEf123').link).toBe('https://t.me/joinchat/AbCdEf123');
    expect(() => normalizeLink('telegram_channel', 'https://t.me/c/12345/6')).toThrow(LinkError);
  });

  it('adds UTM params to website links without overwriting existing ones', () => {
    const r = normalizeLink('website', 'https://www.example.com/landing?utm_source=mine#top', { source: 'gh', medium: 'test', campaign: 'c1' });
    const url = new URL(r.link);
    expect(url.searchParams.get('utm_source')).toBe('mine');
    expect(url.searchParams.get('utm_medium')).toBe('test');
    expect(url.searchParams.get('utm_campaign')).toBe('c1');
    expect(url.hash).toBe('');
    expect(r.key).toBe('web:example.com/landing');
  });

  it('refuses private website targets', () => {
    for (const bad of ['http://localhost:3000', 'http://192.168.1.10', 'http://10.0.0.1/x', 'http://[::1]/']) {
      expect(() => normalizeLink('website', bad)).toThrow(LinkError);
    }
  });
});

describe('OrderInputSchema', () => {
  const ok = (v: unknown) => OrderInputSchema.safeParse(v).success;

  it('accepts each product in its basic form', () => {
    expect(ok({ product: 'twitter_followers', link: 'x.com/a', quantity: 100 })).toBe(true);
    expect(ok({ product: 'twitter_comments', link: 'x.com/a/status/1', comments: ['hi'] })).toBe(true);
    expect(ok({ product: 'telegram_members', link: 't.me/abcd', quantity: 100, premium: true })).toBe(true);
    expect(ok({ product: 'twitter_likes', type: 'subscription', username: 'a', min: 10, max: 20, posts: 5 })).toBe(true);
    expect(ok({ product: 'website_traffic', type: 'drip_feed', link: 'example.com', quantity: 100, runs: 3, intervalMinutes: 60 })).toBe(true);
  });

  it('rejects mismatched fields', () => {
    expect(ok({ product: 'twitter_followers', link: 'x.com/a' })).toBe(false); // no quantity
    expect(ok({ product: 'twitter_followers', type: 'custom_comments', link: 'x.com/a', comments: ['x'] })).toBe(false);
    expect(ok({ product: 'twitter_comments', link: 'x.com/a/status/1', comments: ['hi'], quantity: 5 })).toBe(false);
    expect(ok({ product: 'twitter_likes', link: 'x.com/a/status/1', quantity: 10, premium: true })).toBe(false);
    expect(ok({ product: 'twitter_likes', type: 'subscription', username: 'a', min: 30, max: 20, posts: 5 })).toBe(false);
    expect(ok({ product: 'twitter_followers', link: 'x.com/a', quantity: 10, runs: 2 })).toBe(false);
    expect(ok({ product: 'twitter_followers', link: 'x.com/a', quantity: 10, bogus: 1 })).toBe(false);
  });
});
