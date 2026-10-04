import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { FRESH_MS, makeLookup } from '../src/lib/dns.js';

const ask = (lookup: any, host: string, opts: object = {}) =>
  new Promise<{ err: any; address: any; family?: number }>((r) => lookup(host, opts, (err: any, address: any, family?: number) => r({ err, address, family })));

describe('resilient DNS', () => {
  it('resolves without the thread pool, caches, and serves the last answer when the resolver stops answering', async () => {
    let t = 0;
    let up = true;
    let calls = 0;
    const lookup = makeLookup({
      resolve4: async () => { calls++; if (!up) throw new Error('ETIMEOUT'); return ['1.2.3.4']; },
      resolve6: async () => { if (!up) throw new Error('ETIMEOUT'); return ['2001:db8::1']; },
      fallback: ((_h: string, _o: unknown, cb: any) => cb(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }))) as any,
      now: () => t,
    });
    expect(await ask(lookup, 'api.telegram.org')).toMatchObject({ err: null, address: '1.2.3.4', family: 4 });
    expect((await ask(lookup, 'api.telegram.org', { all: true })).address as LookupAddress[]).toEqual([
      { address: '1.2.3.4', family: 4 },
      { address: '2001:db8::1', family: 6 },
    ]);
    expect(calls).toBe(1); // cached
    expect(await ask(lookup, 'api.telegram.org', { family: 6 })).toMatchObject({ address: '2001:db8::1', family: 6 });
    // The resolver stops answering (seen live): the last known address keeps connections working.
    up = false;
    t += FRESH_MS + 1;
    expect(await ask(lookup, 'api.telegram.org')).toMatchObject({ err: null, address: '1.2.3.4' });
    // A host never seen before fails fast with the real reason instead of hanging.
    expect((await ask(lookup, 'new.example.com')).err.code).toBe('EAI_AGAIN');
  });

  it('leaves IP addresses and localhost to the system', async () => {
    const lookup = makeLookup({
      resolve4: async () => { throw new Error('not used'); },
      resolve6: async () => { throw new Error('not used'); },
      fallback: ((h: string, _o: unknown, cb: any) => cb(null, h === 'localhost' ? '127.0.0.1' : h, 4)) as any,
    });
    expect(await ask(lookup, '10.0.0.1')).toMatchObject({ address: '10.0.0.1' });
    expect(await ask(lookup, 'localhost')).toMatchObject({ address: '127.0.0.1' });
  });
});
