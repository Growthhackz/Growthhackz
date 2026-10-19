import { randomBytes } from 'node:crypto';
import { get, run } from '../db/database.js';
import { DIRECTORY_HOSTS, MEME_KINDS, REDDIT_SUBREDDITS, REQUEST_LISTINGS, STICKER_KINDS, WEB3_LISTINGS, PARTNER_LISTINGS } from '../domain/schemas.js';
import { nowMs, type ServiceContext } from './context.js';

/**
 * The core bot (docs/core-bot-prompt.md) validates each callback's `data` with a closed schema and
 * refuses anything outside it: `source` must be one of the names below, `failures[].status` is
 * `failed` or `unconfirmed`, labels are at most 100 characters, and a URL is dropped unless its host
 * is on its allowlist. We ship the bot a prompt, not code, so this side keeps every event inside
 * that contract: the real destination name stays in `label` (which is what the bot shows), and a
 * link on another host goes out as a short link on our own host (`/go/:id`), which is allowlisted.
 */

/** `source` values the bot accepts. The list in the prompt is the contract; keep the two together. */
export const RECEIVER_SOURCES = [
  'telegraph',
  'binance',
  'call_channel',
  'coinsniper',
  'coinvote',
  'cmc_community',
  'press_1888',
  'bitcointalk',
  'social_boost',
  'reddit_moonshots',
  'reddit_solanamemecoins',
  'meme_pack',
  'sticker_publish',
];

/** Hosts the bot shows links from (its allowlist, minus our own host, which comes from PUBLIC_BASE_URL). */
export const RECEIVER_HOSTS = [
  'telegra.ph',
  'binance.com',
  't.me',
  'coinsniper.net',
  'coinvote.cc',
  'coinmarketcap.com',
  '1888pressrelease.com',
  'bitcointalk.org',
  'x.com',
  'twitter.com',
  'reddit.com',
  'wurk.fun',
];

export const RECEIVER_LABEL_MAX = 100;

/** The bot's `source` for one of our job kinds: the kind itself when it knows it, else the closest name it does. */
export function receiverSource(kind: string): string {
  if (RECEIVER_SOURCES.includes(kind)) return kind;
  if (DIRECTORY_HOSTS[kind] || REQUEST_LISTINGS.includes(kind) || kind === WEB3_LISTINGS || kind === PARTNER_LISTINGS) return 'coinsniper';
  if (REDDIT_SUBREDDITS[kind]) return 'reddit_moonshots';
  if (STICKER_KINDS.includes(kind)) return 'sticker_publish';
  if (MEME_KINDS.includes(kind)) return 'meme_pack';
  // Internal steps (metadata, copy, campaign image…) and the hub: only ever reported as a labelled failure.
  return 'telegraph';
}

export function receiverStatus(status: string): 'failed' | 'unconfirmed' {
  return status === 'unconfirmed' || status === 'needs checking' ? 'unconfirmed' : 'failed';
}

export function receiverLabel(label: unknown): string {
  const s = String(label ?? '').replace(/[\u0000-\u001f<>"`]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > RECEIVER_LABEL_MAX ? s.slice(0, RECEIVER_LABEL_MAX - 1).trimEnd() + '…' : s;
}

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((h) => host === h || host.endsWith('.' + h));
}

/** The URL as the bot will show it: unchanged on an allowlisted host, otherwise a short link on our host; null when nothing can be shown. */
export function receiverUrl(ctx: ServiceContext, url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 500 || /[\s<>"`\u0000-\u001f]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const own = new URL(ctx.config.PUBLIC_BASE_URL);
  const host = u.hostname.toLowerCase();
  if (hostAllowed(host, RECEIVER_HOSTS) || host === own.hostname.toLowerCase()) return url;
  return shortLink(ctx, url);
}

/** A stable short link for a URL on our own host; the same URL always gets the same id. */
export function shortLink(ctx: ServiceContext, url: string): string {
  let id = get<{ id: string }>(ctx.db, 'SELECT id FROM redirects WHERE url = :u', { u: url })?.id;
  if (!id) {
    id = randomBytes(9).toString('base64url');
    run(ctx.db, 'INSERT INTO redirects (id, url, created_at) VALUES (:id, :u, :t)', { id, u: url, t: nowMs(ctx) });
  }
  return `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/go/${id}`;
}

export function resolveShortLink(ctx: ServiceContext, id: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,16}$/.test(id)) return null;
  return get<{ url: string }>(ctx.db, 'SELECT url FROM redirects WHERE id = :id', { id })?.url ?? null;
}

type Link = { source: string; label: string; url: string | null; links?: unknown };

function shapeLink(ctx: ServiceContext, x: { source?: unknown; label?: unknown; url?: unknown; links?: unknown }): Link {
  // `links` (every checked page of a Web3 Listing Update) is extra today: the bot drops keys it doesn't know.
  // Once it takes them, each one must pass its allowlist too, so they get the same treatment as `url`.
  const links = Array.isArray(x.links)
    ? x.links
        .map((l: any) => ({ name: receiverLabel(l?.name), url: receiverUrl(ctx, l?.url) }))
        .filter((l: { name: string; url: string | null }): l is { name: string; url: string } => !!l.url)
    : null;
  return {
    source: receiverSource(String(x.source ?? '')),
    label: receiverLabel(x.label),
    url: receiverUrl(ctx, x.url),
    ...(links ? { links } : {}),
  };
}

/** Only the fields a receiver needs, in the shape it accepts: names, labels and public URLs. Error text stays in the report API. */
export function shapeCallbackData(ctx: ServiceContext, type: string, d: any): unknown {
  const project = d?.project ? { name: receiverLabel(d.project.name ?? null) || null, symbol: String(d.project.symbol ?? '').slice(0, 20) || null } : undefined;
  switch (type) {
    case 'order.accepted':
      return {};
    case 'link.published':
      // Web3 Listing Updates carries every checked page in `links` (url = the first).
      return { ...shapeLink(ctx, d ?? {}), project };
    case 'sticker_pack.ready':
      return { url: receiverUrl(ctx, d?.url), name: receiverLabel(d?.name), project };
    case 'order.completed':
      return {
        complete: !!d?.complete,
        project,
        successes: (d?.successes ?? []).map((x: any) => shapeLink(ctx, x)),
        failures: (d?.failures ?? []).map((x: any) => ({ source: receiverSource(String(x.source ?? '')), label: receiverLabel(x.label), status: receiverStatus(String(x.status ?? '')) })),
        // The bot shows successes and failures only; the prompt documents `pending` as empty, so it stays empty
        // (an outside listing still in progress follows as its own link.published).
        pending: [],
      };
    default:
      return d;
  }
}
