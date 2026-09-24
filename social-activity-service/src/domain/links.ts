import { isIP } from 'node:net';
import type { LinkKind } from './products.js';

export interface NormalizedLink {
  /** The link that will be sent to the provider. */
  link: string;
  /** Canonical identity of the target, used to detect overlapping active orders. */
  key: string;
}

export class LinkError extends Error {}

const TWITTER_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'x.com', 'www.x.com', 'mobile.x.com']);
const TELEGRAM_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);
const RESERVED_TWITTER_PATHS = new Set(['home', 'i', 'search', 'explore', 'settings', 'notifications', 'messages', 'intent', 'share']);
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

function parseUrl(input: string): URL {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new LinkError(`Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LinkError('Link must be http(s)');
  return url;
}

export function normalizeTwitterHandle(input: string): string {
  const handle = input.trim().replace(/^@/, '');
  if (!HANDLE.test(handle) || RESERVED_TWITTER_PATHS.has(handle.toLowerCase())) {
    throw new LinkError(`Not a valid Twitter/X username: ${input}`);
  }
  return handle;
}

export interface UtmOptions {
  source: string;
  medium: string;
  campaign?: string;
}

export function normalizeLink(kind: LinkKind, input: string, utm?: UtmOptions): NormalizedLink {
  const url = parseUrl(input);
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  switch (kind) {
    case 'twitter_profile': {
      if (!TWITTER_HOSTS.has(host)) throw new LinkError('Expected a twitter.com or x.com profile link');
      if (segments.length !== 1) throw new LinkError('Expected a profile link like https://x.com/username');
      const handle = normalizeTwitterHandle(segments[0]!);
      return { link: `https://x.com/${handle}`, key: `twitter:@${handle.toLowerCase()}` };
    }
    case 'twitter_post': {
      if (!TWITTER_HOSTS.has(host)) throw new LinkError('Expected a twitter.com or x.com post link');
      const [user, statusWord, id] = segments;
      if (!user || !statusWord || !/^status(es)?$/.test(statusWord) || !id || !/^\d{1,25}$/.test(id)) {
        throw new LinkError('Expected a post link like https://x.com/username/status/123');
      }
      const handle = normalizeTwitterHandle(user);
      return { link: `https://x.com/${handle}/status/${id}`, key: `twitter:status:${id}` };
    }
    case 'telegram_channel': {
      if (!TELEGRAM_HOSTS.has(host)) throw new LinkError('Expected a t.me link');
      const [first, second] = segments;
      if (!first) throw new LinkError('Expected a channel link like https://t.me/channelname');
      if (first.startsWith('+') || first === 'joinchat') {
        const code = first === 'joinchat' ? second : first.slice(1);
        if (!code || !/^[\w-]{5,}$/.test(code)) throw new LinkError('Invalid Telegram invite link');
        const path = first === 'joinchat' ? `joinchat/${code}` : `+${code}`;
        return { link: `https://t.me/${path}`, key: `telegram:invite:${code}` };
      }
      if (first === 'c') throw new LinkError('Private /c/ links cannot be used; provide a public or invite link');
      const name = first === 's' ? second : first;
      if (!name || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) throw new LinkError('Invalid Telegram channel name');
      return { link: `https://t.me/${name}`, key: `telegram:${name.toLowerCase()}` };
    }
    case 'website': {
      if (isPrivateHost(host)) throw new LinkError('Website traffic must target a public host');
      if (!host.includes('.')) throw new LinkError('Website link needs a full domain');
      url.hash = '';
      if (utm) {
        if (!url.searchParams.has('utm_source')) url.searchParams.set('utm_source', utm.source);
        if (!url.searchParams.has('utm_medium')) url.searchParams.set('utm_medium', utm.medium);
        if (utm.campaign && !url.searchParams.has('utm_campaign')) url.searchParams.set('utm_campaign', utm.campaign);
      }
      const keyPath = url.pathname.replace(/\/+$/, '') || '/';
      return { link: url.toString(), key: `web:${host.replace(/^www\./, '')}${keyPath.toLowerCase()}` };
    }
  }
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const bare = host.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(bare);
  if (ipVersion === 4) {
    const [a, b] = bare.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (ipVersion === 6) return true;
  return false;
}
