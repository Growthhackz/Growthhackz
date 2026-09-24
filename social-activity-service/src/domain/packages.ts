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
  /** Service to use per provider name, bypassing the product mapping. */
  serviceIds?: Record<string, string>;
}

export interface PackageDefinition {
  name: string;
  description: string;
  items: PackageItem[];
}

const DAY = 24 * 60;
const HOUR = 60;

/**
 * The default package. Each item is pinned to a hand-picked Followiz service;
 * other providers (and Followiz, if a pinned service disappears from its
 * catalog) fall back to the product mappings. Deliveries are spread out so
 * nothing lands as one spike.
 */
export const STARTER_PACKAGE: PackageDefinition = {
  name: 'starter',
  description:
    'Default mix: 100 Telegram joins, 50 X followers over 5 days, likes/retweets/comments on one post, and 1,100 US site visits from Google, Reddit and X.',
  items: [
    {
      key: 'telegram_members',
      label: 'Telegram members (USA, premium accounts)',
      product: 'telegram_members',
      premium: true,
      geo: 'north_america',
      target: 'telegram',
      quantity: { default: 100, min: 50, max: 100 },
      serviceIds: { followiz: '4690' },
    },
    {
      key: 'twitter_followers',
      label: 'X followers',
      product: 'twitter_followers',
      geo: 'north_america',
      target: 'twitterProfile',
      quantity: { default: 50, min: 25, max: 50 },
      // 10/day over 5 days.
      drip: { runs: 5, intervalMinutes: DAY },
      serviceIds: { followiz: '1054' },
    },
    {
      key: 'twitter_likes',
      label: 'Likes on the post',
      product: 'twitter_likes',
      geo: 'north_america',
      target: 'tweet',
      quantity: { default: 50, min: 25, max: 50 },
      // Engagement on a real post arrives in the first hours, not days.
      drip: { runs: 5, intervalMinutes: HOUR },
      serviceIds: { followiz: '1501' },
    },
    {
      key: 'twitter_retweets',
      label: 'Retweets of the post',
      product: 'twitter_retweets',
      geo: 'north_america',
      target: 'tweet',
      quantity: { default: 20, min: 10, max: 25 },
      drip: { runs: 2, intervalMinutes: 90 },
      serviceIds: { followiz: '1101' },
    },
    {
      key: 'twitter_comments',
      label: 'Comments on the post (provider-written)',
      product: 'twitter_comments',
      geo: 'north_america',
      target: 'tweet',
      quantity: { default: 10, min: 5, max: 25 },
      serviceIds: { followiz: '4955' },
    },
    {
      key: 'website_traffic_google',
      label: 'Website visits from Google (USA)',
      product: 'website_traffic',
      geo: 'north_america',
      target: 'website',
      quantity: { default: 500, min: 250, max: 1000 },
      // 100 every 12 h over 2.5 days.
      drip: { runs: 5, intervalMinutes: 12 * HOUR },
      serviceIds: { followiz: '4349' },
    },
    {
      key: 'website_traffic_reddit',
      label: 'Website visits from Reddit (USA)',
      product: 'website_traffic',
      geo: 'north_america',
      target: 'website',
      quantity: { default: 250, min: 100, max: 500 },
      drip: { runs: 2, intervalMinutes: DAY },
      serviceIds: { followiz: '4354' },
    },
    {
      key: 'website_traffic_x',
      label: 'Website visits from X (USA)',
      product: 'website_traffic',
      geo: 'north_america',
      target: 'website',
      quantity: { default: 350, min: 100, max: 700 },
      drip: { runs: 2, intervalMinutes: DAY },
      serviceIds: { followiz: '4356' },
    },
  ],
};

export const PACKAGES: Record<string, PackageDefinition> = {
  [STARTER_PACKAGE.name]: STARTER_PACKAGE,
};
