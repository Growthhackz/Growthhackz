import dns, { type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Name lookups that can't stall the service. Node's default lookup (getaddrinfo) runs on a small thread pool, so a
 * slow resolver on the host makes every new connection wait, internal Railway hosts included. This resolves over
 * the network with a short timeout (no thread pool), caches answers, and falls back to the last known addresses when
 * the resolver doesn't answer.
 */

type Resolve = (host: string) => Promise<string[]>;
type Lookup = typeof dns.lookup;
type Callback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export const FRESH_MS = 5 * 60_000;
export const STALE_MS = 24 * 3600_000;

export function makeLookup(deps: { resolve4: Resolve; resolve6: Resolve; fallback: Lookup; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { list: LookupAddress[]; at: number }>();

  async function addresses(host: string): Promise<LookupAddress[]> {
    const hit = cache.get(host);
    if (hit && now() - hit.at < FRESH_MS) return hit.list;
    const [v4, v6] = await Promise.allSettled([deps.resolve4(host), deps.resolve6(host)]);
    const list: LookupAddress[] = [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (list.length) {
      cache.set(host, { list, at: now() });
      return list;
    }
    // Hosts only the system resolver knows (e.g. /etc/hosts); bounded so it can't hang the caller.
    const sys = await new Promise<LookupAddress[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error(`DNS lookup timed out for ${host}`), { code: 'ETIMEOUT' })), 5000);
      deps.fallback(host, { all: true }, (err, res) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(res as LookupAddress[]);
      });
    }).catch((err) => {
      if (hit && now() - hit.at < STALE_MS) return hit.list;
      throw err;
    });
    cache.set(host, { list: sys, at: now() });
    return sys;
  }

  function lookup(host: string, options: number | LookupOptions | Callback, cb?: Callback): void {
    const callback = (typeof options === 'function' ? options : cb) as Callback;
    const opts: LookupOptions = typeof options === 'number' ? { family: options } : typeof options === 'object' ? options : {};
    if (!host || isIP(host) || host === 'localhost') {
      (deps.fallback as any)(host, opts, callback);
      return;
    }
    addresses(host).then(
      (all) => {
        const family = opts.family === 4 || opts.family === 6 ? opts.family : 0;
        let list = family ? all.filter((a) => a.family === family) : all;
        // Prefer IPv4 for public hosts (as Node's default ordering does); internal-only hosts are IPv6.
        list = [...list].sort((a, b) => a.family - b.family);
        if (!list.length) return callback(Object.assign(new Error(`No address for ${host}`), { code: 'ENOTFOUND' }), '', 0);
        if (opts.all) callback(null, list);
        else callback(null, list[0]!.address, list[0]!.family);
      },
      (err) => callback(err, '', 0),
    );
  }
  return lookup as unknown as Lookup;
}

/** Replaces dns.lookup for every outgoing connection in this process (fetch included). */
export function installResilientLookup(): void {
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  dns.lookup = makeLookup({
    resolve4: (h) => resolver.resolve4(h),
    resolve6: (h) => resolver.resolve6(h),
    fallback: dns.lookup.bind(dns),
  });
}
