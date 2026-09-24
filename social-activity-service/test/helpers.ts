import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import type { Clock } from '../src/lib/clock.js';
import { MockProvider } from '../src/providers/mock/provider.js';

export class FakeClock implements Clock {
  constructor(public current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const TOKEN = 'test-token-0123456789';

export function makeApp(env: Record<string, string> = {}, providerOpts: { balanceUsd?: number } = {}) {
  const config = loadConfig({ LOG_LEVEL: 'silent', SERVICE_API_TOKEN: TOKEN, PROVIDER: 'mock', ...env });
  const db = openDatabase(':memory:');
  const provider = new MockProvider(providerOpts);
  const clock = new FakeClock();
  const { app, ctx } = buildApp({ config, db, provider, clock });
  const auth = { authorization: `Bearer ${TOKEN}` };

  const api = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, payload: body as object, headers: { ...auth, ...headers } });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null, headers: res.headers };
  };

  /** Map every product to the matching mock service. */
  const mapAll = async () => {
    await api('POST', '/v1/catalog/sync');
    const maps: Array<[string, string, boolean, string]> = [
      ['twitter_followers', 'north_america', false, '1001'],
      ['twitter_likes', 'any', false, '1002'],
      ['twitter_retweets', 'any', false, '1003'],
      ['twitter_comments', 'north_america', false, '1004'],
      ['website_traffic', 'north_america', false, '1005'],
      ['telegram_members', 'north_america', false, '1006'],
      ['telegram_members', 'north_america', true, '1007'],
    ];
    for (const [product, geo, premium, serviceId] of maps) {
      const r = await api('PUT', '/v1/catalog/mappings', { product, geo, premium, serviceId });
      if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    }
  };

  return { app, ctx, provider, clock, api, mapAll, db };
}
