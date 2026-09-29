import type { Config } from '../config.js';
import { LinkError, normalizeLink, normalizeTwitterHandle } from '../domain/links.js';
import { toMicros } from '../lib/money.js';

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const COMPONENT_KINDS = ['verified_followers', 'post_mix', 'tg_batch_1', 'tg_batch_2', 'small_raid'] as const;

/**
 * `small_raid`: WURK's $1 preset raid on one X post (25 likes, 10 reposts, 10 comments, 70 views), the current
 * default for trending orders. `full`: the four-purchase package below, kept to switch in later.
 */
export const PRESETS = ['small_raid', 'full'] as const;
export type Preset = (typeof PRESETS)[number];
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const COMPONENT_STATUSES = [
  'pending_payment',
  'queued',
  'quoting',
  'paid_job_created',
  'scheduled',
  'in_progress',
  'completed',
  'partial',
  'needs_attention',
  'reconcile_required',
] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];
export type PackageStatus = ComponentStatus;

/** What the customer buys. Only the followers are gated on X blue verification; WURK offers no geo targeting. */
export const WURK_PACKAGE = {
  followers: 20,
  likes: 30,
  reposts: 30,
  comments: 30,
  tgBatch: 15,
} as const;

/** WURK routes this service may pay for. Anything else is refused before signing. */
export const APPROVED_ROUTES = ['/solana/xfollowers/xverified', '/solana/xraid/custom', '/solana/tgmembers', '/solana/xraid/small'];

export interface WurkTargets {
  /** Empty for presets that don't use it (small_raid needs only the post). */
  xHandle: string;
  xProfileUrl: string;
  xPostUrl: string;
  tgUrl: string;
}

export class TargetError extends Error {}

/** Accepts a profile URL or @handle (optional: defaults to the post's author), one post URL and an optional public t.me link or @handle. */
export function normalizeTargets(input: { xProfile?: string; xPost: string; telegram?: string }, preset: Preset = 'full'): WurkTargets {
  if (preset === 'small_raid') {
    try {
      const xPostUrl = normalizeLink('twitter_post', input.xPost).link;
      return { xHandle: '', xProfileUrl: '', xPostUrl, tgUrl: '' };
    } catch (err) {
      if (err instanceof LinkError) throw new TargetError(err.message);
      throw err;
    }
  }
  try {
    const xPostUrl = normalizeLink('twitter_post', input.xPost).link;
    // No profile given: the followers go to the account that wrote the post.
    const raw = (input.xProfile ?? new URL(xPostUrl).pathname.split('/')[1] ?? '').trim();
    const xHandle = /^@?[A-Za-z0-9_]{1,15}$/.test(raw)
      ? normalizeTwitterHandle(raw)
      : normalizeLink('twitter_profile', raw).link.split('/').pop()!;
    // No Telegram: the package skips the Telegram members and keeps the X parts.
    const tgRaw = input.telegram?.trim();
    const tgUrl = tgRaw
      ? normalizeLink('telegram_channel', /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(tgRaw) ? `https://t.me/${tgRaw.slice(1)}` : tgRaw).link
      : '';
    return { xHandle, xProfileUrl: `https://x.com/${xHandle}`, xPostUrl, tgUrl };
  } catch (err) {
    if (err instanceof LinkError) throw new TargetError(err.message);
    throw err;
  }
}

export interface ComponentPlan {
  kind: ComponentKind;
  url: string;
  quantities: Record<string, number>;
  ceilingMicros: number;
}

export function packageCeilingMicros(config: Config, preset: Preset): number {
  return toMicros(preset === 'small_raid' ? config.WURK_MAX_SMALL_RAID_USDC : config.WURK_PACKAGE_MAX_USDC);
}

export function componentPlans(config: Config, t: WurkTargets, preset: Preset = 'full'): ComponentPlan[] {
  const base = config.WURK_BASE_URL.replace(/\/$/, '');
  if (preset === 'small_raid')
    return [
      {
        kind: 'small_raid',
        url: `${base}/solana/xraid/small?${new URLSearchParams({ url: t.xPostUrl })}`,
        quantities: { likes: 25, reposts: 10, comments: 10, views: 70 },
        ceilingMicros: toMicros(config.WURK_MAX_SMALL_RAID_USDC),
      },
    ];
  const q = (path: string, params: Record<string, string | number>) =>
    `${base}${path}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString()}`;
  // WURK documents `join` as the tgmembers invite-link parameter.
  const tg = q('/solana/tgmembers', { join: t.tgUrl, amount: WURK_PACKAGE.tgBatch });
  return [
    {
      kind: 'verified_followers',
      url: q('/solana/xfollowers/xverified', { handle: t.xHandle, amount: WURK_PACKAGE.followers }),
      quantities: { followers: WURK_PACKAGE.followers },
      ceilingMicros: toMicros(config.WURK_MAX_FOLLOWERS_USDC),
    },
    {
      kind: 'post_mix',
      url: q('/solana/xraid/custom', { url: t.xPostUrl, likes: WURK_PACKAGE.likes, reposts: WURK_PACKAGE.reposts, comments: WURK_PACKAGE.comments, bookmarks: 0 }),
      quantities: { likes: WURK_PACKAGE.likes, reposts: WURK_PACKAGE.reposts, comments: WURK_PACKAGE.comments },
      ceilingMicros: toMicros(config.WURK_MAX_POST_MIX_USDC),
    },
    ...(t.tgUrl
      ? [
          { kind: 'tg_batch_1' as const, url: tg, quantities: { members: WURK_PACKAGE.tgBatch }, ceilingMicros: toMicros(config.WURK_MAX_TG_BATCH_USDC) },
          { kind: 'tg_batch_2' as const, url: tg, quantities: { members: WURK_PACKAGE.tgBatch }, ceilingMicros: toMicros(config.WURK_MAX_TG_BATCH_USDC) },
        ]
      : []),
  ];
}

export function smokeUrl(config: Config, postUrl: string): string {
  const link = normalizeLink('twitter_post', postUrl).link;
  return `${config.WURK_BASE_URL.replace(/\/$/, '')}/solana/xraid/small?${new URLSearchParams({ url: link })}`;
}
