import { z } from 'zod';
import { GEOS, ORDER_TYPES, PRODUCTS, PRODUCT_SPECS } from './products.js';

const positiveInt = z.number().int().positive();

export const OrderInputSchema = z
  .object({
    product: z.enum(PRODUCTS),
    type: z.enum(ORDER_TYPES).optional(),
    /** Target destination (profile, post, channel or page URL). Not used for subscriptions. */
    link: z.string().min(1).max(2048).optional(),
    quantity: positiveInt.optional(),
    /** Custom comments: one entry per comment, posted verbatim. */
    comments: z.array(z.string().trim().min(1).max(280)).min(1).max(10_000).optional(),
    /** Drip-feed: number of deliveries and minutes between them. */
    runs: positiveInt.optional(),
    intervalMinutes: positiveInt.optional(),
    /** Subscription (auto engagement on future posts). */
    username: z.string().min(1).max(64).optional(),
    min: positiveInt.optional(),
    max: positiveInt.optional(),
    posts: positiveInt.optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    expiry: z
      .string()
      .regex(/^\d{2}\/\d{2}\/\d{4}$/, 'expiry must be dd/mm/yyyy')
      .optional(),
    geo: z.enum(GEOS).optional(),
    premium: z.boolean().optional(),
    /** Bypass the product mapping and use this provider service id directly. */
    serviceId: z.string().min(1).optional(),
    autoRefill: z.boolean().optional(),
    /** Website traffic only: append UTM params (default true). */
    utm: z.boolean().optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const spec = PRODUCT_SPECS[o.product];
    const type = o.type ?? spec.defaultType;
    const need = (field: keyof typeof o, why: string) => {
      if (o[field] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: why });
    };
    const forbid = (field: keyof typeof o, why: string) => {
      if (o[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: why });
    };

    if (!spec.allowedTypes.includes(type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: `${o.product} supports: ${spec.allowedTypes.join(', ')}`,
      });
      return;
    }
    if (o.premium && !spec.supportsPremium) forbid('premium', `${o.product} has no premium variant`);
    if (o.utm !== undefined && o.product !== 'website_traffic') forbid('utm', 'utm only applies to website_traffic');

    switch (type) {
      case 'default':
        need('link', 'link is required');
        need('quantity', 'quantity is required');
        break;
      case 'drip_feed':
        need('link', 'link is required');
        need('quantity', 'quantity (per run) is required');
        need('runs', 'runs is required for drip_feed');
        need('intervalMinutes', 'intervalMinutes is required for drip_feed');
        break;
      case 'custom_comments':
        need('link', 'link is required');
        need('comments', 'comments are required for custom_comments');
        forbid('quantity', 'quantity is derived from the number of comments');
        break;
      case 'subscription':
        need('username', 'username is required for subscription');
        need('min', 'min is required for subscription');
        need('max', 'max is required for subscription');
        need('posts', 'posts is required for subscription');
        forbid('link', 'subscriptions target a username, not a link');
        if (o.min !== undefined && o.max !== undefined && o.min > o.max) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['min'], message: 'min must be <= max' });
        }
        break;
    }
    if (type !== 'drip_feed') {
      forbid('runs', 'runs only applies to drip_feed');
      forbid('intervalMinutes', 'intervalMinutes only applies to drip_feed');
    }
    if (type !== 'custom_comments') forbid('comments', 'comments only applies to custom_comments');
  });

export type OrderInput = z.infer<typeof OrderInputSchema>;

export const CreateCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    notes: z.string().max(5000).optional(),
    /** Optional spend cap in USD; creation fails if the estimate exceeds it. */
    budgetUsd: z.number().positive().optional(),
    /** Defaults applied to every order that doesn't set its own. */
    targeting: z
      .object({
        geo: z.enum(GEOS).optional(),
        premium: z.boolean().optional(),
      })
      .strict()
      .optional(),
    autoRefill: z.boolean().optional(),
    /** Free-form metadata stored with the campaign (source, experiment id, etc). */
    metadata: z.record(z.unknown()).optional(),
    /** Submit to the provider immediately (default true). */
    submit: z.boolean().optional(),
    orders: z.array(OrderInputSchema).min(1).max(100),
  })
  .strict();

export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

export const UpsertMappingSchema = z
  .object({
    product: z.enum(PRODUCTS),
    geo: z.enum(GEOS).default('any'),
    premium: z.boolean().default(false),
    serviceId: z.string().min(1),
  })
  .strict();

export const FundingSchema = z
  .object({
    amountUsd: z.number().positive(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const ResolveReviewSchema = z.discriminatedUnion('resolution', [
  z.object({ resolution: z.literal('exists'), providerOrderId: z.string().min(1) }).strict(),
  z.object({ resolution: z.literal('not_created'), note: z.string().max(500).optional() }).strict(),
]);

export const PackageRequestSchema = z
  .object({
    /** Where each part of the package is delivered. Items without a target are skipped. */
    targets: z
      .object({
        /** X handle ("@name") or profile URL, for followers. */
        twitterProfile: z.string().min(1).max(2048).optional(),
        /** The post to boost (usually the pinned or best-performing tweet). */
        tweet: z.string().min(1).max(2048).optional(),
        telegram: z.string().min(1).max(2048).optional(),
        website: z.string().min(1).max(2048).optional(),
      })
      .strict(),
    /** Comment texts for the post. Comments are only ordered when these are provided. */
    comments: z.array(z.string().trim().min(1).max(280)).max(100).optional(),
    /** Include opt-in items such as Telegram premium members. */
    include: z.array(z.string()).optional(),
    /** Leave out items by key. */
    exclude: z.array(z.string()).optional(),
    /** Per-item quantity overrides, e.g. {"twitter_likes": 30}. */
    quantities: z.record(z.number().int().positive()).optional(),
    /** Override the preferred geo for every item. */
    geo: z.enum(GEOS).optional(),
    /** Allow raising a quantity above the package range when the service minimum requires it. */
    allowAboveRange: z.boolean().optional(),
  })
  .strict();

export type PackageRequest = z.infer<typeof PackageRequestSchema>;

export const PackageOrderSchema = PackageRequestSchema.extend({
  name: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(5000).optional(),
  budgetUsd: z.number().positive().optional(),
  autoRefill: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
  submit: z.boolean().optional(),
}).strict();
