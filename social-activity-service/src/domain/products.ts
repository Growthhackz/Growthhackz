export const PRODUCTS = [
  'twitter_followers',
  'twitter_likes',
  'twitter_retweets',
  'twitter_comments',
  'website_traffic',
  'telegram_members',
] as const;
export type Product = (typeof PRODUCTS)[number];

export const ORDER_TYPES = ['default', 'drip_feed', 'custom_comments', 'subscription'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const GEOS = ['any', 'north_america', 'usa', 'canada'] as const;
export type Geo = (typeof GEOS)[number];

export type LinkKind = 'twitter_profile' | 'twitter_post' | 'telegram_channel' | 'website';

export interface ProductSpec {
  label: string;
  linkKind: LinkKind;
  allowedTypes: readonly OrderType[];
  defaultType: OrderType;
  /** Whether the "premium" variant (e.g. Telegram Premium members) exists. */
  supportsPremium: boolean;
}

export const PRODUCT_SPECS: Record<Product, ProductSpec> = {
  twitter_followers: {
    label: 'Twitter/X followers',
    linkKind: 'twitter_profile',
    allowedTypes: ['default', 'drip_feed'],
    defaultType: 'default',
    supportsPremium: false,
  },
  twitter_likes: {
    label: 'Twitter/X likes',
    linkKind: 'twitter_post',
    allowedTypes: ['default', 'drip_feed', 'subscription'],
    defaultType: 'default',
    supportsPremium: false,
  },
  twitter_retweets: {
    label: 'Twitter/X retweets',
    linkKind: 'twitter_post',
    allowedTypes: ['default', 'drip_feed', 'subscription'],
    defaultType: 'default',
    supportsPremium: false,
  },
  twitter_comments: {
    label: 'Twitter/X comments',
    linkKind: 'twitter_post',
    // default = provider-written ("random") comments by quantity.
    allowedTypes: ['custom_comments', 'default'],
    defaultType: 'custom_comments',
    supportsPremium: false,
  },
  website_traffic: {
    label: 'Website traffic',
    linkKind: 'website',
    allowedTypes: ['default', 'drip_feed'],
    defaultType: 'default',
    supportsPremium: false,
  },
  telegram_members: {
    label: 'Telegram members',
    linkKind: 'telegram_channel',
    allowedTypes: ['default', 'drip_feed'],
    defaultType: 'default',
    supportsPremium: true,
  },
};

/** Internal order lifecycle. */
export const ORDER_STATUSES = [
  'draft', // created locally, not yet sent
  'submitting', // `add` call in flight (or crashed mid-flight)
  'pending',
  'in_progress',
  'processing',
  'completed',
  'partial',
  'canceled',
  'failed', // provider rejected the order; nothing was created
  'needs_review', // unclear whether the provider created the order; a human must reconcile
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses the poller keeps checking. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ['pending', 'in_progress', 'processing'];
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['completed', 'partial', 'canceled', 'failed'];
