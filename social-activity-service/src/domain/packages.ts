import type { Geo, Product } from './products.js';

export type TargetKind = 'twitterProfile' | 'tweet' | 'telegram' | 'website';

export interface PackageItem {
  /** Stable name used for per-item quantity overrides and in responses. */
  key: string;
  label: string;
  product: Product;
  premium?: boolean;
  /** Preferred geo; the package falls back to "any" if no service is mapped for it. */
  geo: Geo;
  target: TargetKind;
  /** Default quantity and the range we're willing to adjust within to fit a service's min/max. */
  quantity: { default: number; min: number; max: number };
  /** Spread delivery out with drip-feed. Falls back to one delivery if the service or quantity can't support it. */
  drip?: { runs: number; intervalMinutes: number };
  /** Off unless the caller opts in. */
  optIn?: boolean;
  /** Quantity comes from the caller's comment list. */
  usesComments?: boolean;
}

export interface PackageDefinition {
  name: string;
  description: string;
  items: PackageItem[];
}

const DAY = 24 * 60;

/**
 * Small, slow, test-sized package. The quantities follow the brief
 * (5–10 TG members, 1–2 premium, 25–50 follows, 25–50 engagements, 1–2k visits).
 * Deliveries are spread out so nothing lands as one spike.
 */
export const STARTER_PACKAGE: PackageDefinition = {
  name: 'starter',
  description: 'Test-sized mix: a few Telegram joins, slow follower growth, light engagement on one post, and 1–2k site visits over 3 days.',
  items: [
    {
      key: 'telegram_members',
      label: 'Telegram members',
      product: 'telegram_members',
      geo: 'north_america',
      target: 'telegram',
      quantity: { default: 10, min: 5, max: 10 },
    },
    {
      key: 'telegram_premium',
      label: 'Telegram premium members',
      product: 'telegram_members',
      premium: true,
      geo: 'north_america',
      target: 'telegram',
      quantity: { default: 2, min: 1, max: 2 },
      optIn: true,
    },
    {
      key: 'twitter_followers',
      label: 'X followers',
      product: 'twitter_followers',
      geo: 'north_america',
      target: 'twitterProfile',
      quantity: { default: 50, min: 25, max: 50 },
      // ~10/day over 5 days.
      drip: { runs: 5, intervalMinutes: DAY },
    },
    {
      key: 'twitter_likes',
      label: 'Likes on the post',
      product: 'twitter_likes',
      geo: 'north_america',
      target: 'tweet',
      quantity: { default: 50, min: 25, max: 50 },
      // Engagement on a real post arrives in the first hours, not days.
      drip: { runs: 5, intervalMinutes: 60 },
    },
    {
      key: 'twitter_retweets',
      label: 'Retweets of the post',
      product: 'twitter_retweets',
      geo: 'north_america',
      target: 'tweet',
      quantity: { default: 25, min: 25, max: 50 },
      drip: { runs: 5, intervalMinutes: 90 },
    },
    {
      key: 'twitter_comments',
      label: 'Comments on the post',
      product: 'twitter_comments',
      geo: 'north_america',
      target: 'tweet',
      quantity: { default: 10, min: 5, max: 25 },
      usesComments: true,
    },
    {
      key: 'website_traffic',
      label: 'Website visits',
      product: 'website_traffic',
      geo: 'north_america',
      target: 'website',
      quantity: { default: 1500, min: 1000, max: 2000 },
      // ~500/day over 3 days.
      drip: { runs: 3, intervalMinutes: DAY },
    },
  ],
};

export const PACKAGES: Record<string, PackageDefinition> = {
  [STARTER_PACKAGE.name]: STARTER_PACKAGE,
};
