import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import type { Clock } from '../src/lib/clock.js';
import { MemoryAssetStore } from '../src/services/assetStore.js';

export class FakeClock implements Clock {
  constructor(public current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const ADMIN = 'admin-token-0123456789';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Routes outbound requests by host+path prefix; anything unmatched fails loudly. */
export class FakeHttp {
  readonly calls: Array<{ url: string; init: RequestInit }> = [];
  private routes: Array<[string, Handler]> = [];
  on(prefix: string, h: Handler): this {
    this.routes.unshift([prefix, h]);
    return this;
  }
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.calls.push({ url: url.href, init });
    const match = this.routes.find(([p]) => (url.host + url.pathname).startsWith(p));
    if (!match) throw new Error(`Unexpected outbound request ${url.href}`);
    return match[1](url, init);
  };
  count(prefix: string): number {
    return this.calls.filter((c) => c.url.replace(/^https?:\/\//, '').startsWith(prefix)).length;
  }
}

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

export function pngBytes(width = 64, height = 64): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export function mp4Bytes(): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4);
  return b;
}

export const liveCopy = {
  headline: 'Moon Frog squad launches community kit',
  short_post: 'The $MFROG squad is cooking. Community kit is live.',
  social_post: '🔥 The $MFROG squad is cooking.\n\nMoon Frog community kit is live and the crew keeps growing.',
  article: 'Moon Frog brings its community together.\n'.repeat(5),
  meme_captions: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  trailer_lines: ['MOON FROG', 'COOKING', '$MFROG', 'JOIN'],
};

export const SOL = 'So11111111111111111111111111111111111111112';

export function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    LOG_LEVEL: process.env.TEST_LOG ?? 'silent',
    ADMIN_API_TOKEN: ADMIN,
    CONFIG_ENCRYPTION_KEY: 'test-only-vault-key-32-characters!',
    PUBLIC_BASE_URL: 'https://content.example.test',
    WORKERS_ENABLED: 'false',
    ...env,
  });
  const db = openDatabase(':memory:');
  const clock = new FakeClock();
  const http = new FakeHttp();
  const assets = new MemoryAssetStore();
  const { app, ctx } = buildApp({ config, db, clock, http: http.fetch as typeof fetch, assets });

  const call = async (token: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method,
      url,
      payload: body as object,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    let parsed: any = null;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.rawPayload };
  };
  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => call(ADMIN, method, url, body);

  const setSetting = async (key: string, value: string) => {
    const r = await api('PUT', '/v1/settings', { key, value });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  };

  return { app, ctx, clock, http, assets, db, api, call, setSetting };
}

export const demoInput = {
  order_id: 'test-order',
  chain: 'solana',
  contract_address: SOL,
  telegram_url: 'https://t.me/DemoProject',
  name: 'Demo',
  symbol: 'DEMO',
  demo: true,
};
