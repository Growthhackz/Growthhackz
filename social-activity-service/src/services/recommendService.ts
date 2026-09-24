import { catalog, mappings, type CatalogRow } from '../db/repositories.js';
import { PACKAGES, type PackageItem } from '../domain/packages.js';
import type { Geo } from '../domain/products.js';
import { NotFoundError } from '../lib/errors.js';
import { nowIso, type ServiceContext } from './context.js';
import { presentCatalog } from './presenters.js';

interface Rule {
  platform: RegExp;
  wanted: RegExp;
  unwanted: RegExp;
  orderType: string;
}

// Panel service names are free text, so matching is keyword-based. Always review the picks.
const RULES: Record<string, Rule> = {
  twitter_followers: {
    platform: /twitter|\bx\b|tweet/i,
    wanted: /follower/i,
    unwanted: /like|retweet|repost|view|impression|comment|poll|vote|bookmark|space|reply/i,
    orderType: 'default',
  },
  twitter_likes: {
    platform: /twitter|\bx\b|tweet/i,
    wanted: /like|favou?rite/i,
    unwanted: /follower|retweet|repost|view|comment|auto|subscription|reply/i,
    orderType: 'default',
  },
  twitter_retweets: {
    platform: /twitter|\bx\b|tweet/i,
    wanted: /retweet|repost|\brts?\b/i,
    unwanted: /follower|like|view|comment|auto|subscription|quote/i,
    orderType: 'default',
  },
  twitter_comments: {
    platform: /twitter|\bx\b|tweet/i,
    wanted: /comment|repl(y|ies)/i,
    unwanted: /like|follower|retweet|random|emoji/i,
    orderType: 'custom_comments',
  },
  website_traffic: {
    platform: /website|traffic|visit/i,
    wanted: /traffic|visit/i,
    unwanted: /youtube|instagram|tiktok|facebook|twitter|telegram|spotify|seo|backlink/i,
    orderType: 'default',
  },
  telegram_members: {
    platform: /telegram/i,
    wanted: /member|subscriber/i,
    unwanted: /view|reaction|vote|poll|comment|share|boost|bot start/i,
    orderType: 'default',
  },
};

/** Items without a comment list take provider-written ("random") comments, a default-type service. */
function ruleFor(item: PackageItem): Rule {
  const rule = RULES[item.product]!;
  if (item.product === 'twitter_comments' && !item.usesComments) {
    return { ...rule, unwanted: /like|follower|retweet|custom/i, orderType: 'default' };
  }
  return rule;
}

const GEO_PATTERNS: Record<Exclude<Geo, 'any'>, RegExp> = {
  north_america: /north america|\bna\b|usa|united states|\bus\b|america|canada/i,
  usa: /usa|united states|\bus\b|america/i,
  canada: /canada|canadian/i,
};

export interface Candidate {
  score: number;
  reasons: string[];
  service: ReturnType<typeof presentCatalog>;
}

function scoreService(item: PackageItem, svc: CatalogRow): Candidate | null {
  const rule = ruleFor(item);
  const text = `${svc.category} ${svc.name}`;
  if (svc.order_type !== rule.orderType) return null;
  if (!rule.platform.test(text) || !rule.wanted.test(svc.name) || rule.unwanted.test(svc.name)) return null;
  const isPremium = /premium/i.test(text);
  if (Boolean(item.premium) !== isPremium) return null;

  let score = 0;
  const reasons: string[] = [];
  if (item.geo !== 'any' && GEO_PATTERNS[item.geo].test(text)) {
    score += 30;
    reasons.push(`targets ${item.geo}`);
  }
  if (!svc.min_qty || svc.min_qty <= item.quantity.max) {
    score += 40;
    reasons.push(`min ${svc.min_qty} fits ${item.quantity.min}–${item.quantity.max}`);
  } else {
    reasons.push(`min ${svc.min_qty} is above ${item.quantity.max}`);
  }
  if (item.drip && svc.dripfeed) {
    score += 10;
    reasons.push('drip-feed');
  }
  if (svc.refill && (item.product === 'twitter_followers' || item.product === 'telegram_members')) {
    score += 10;
    reasons.push(svc.refill_days ? `${svc.refill_days}-day refill` : 'refill');
  }
  if (/non[-\s]?drop|no[-\s]?drop|real|hq|high quality|active/i.test(svc.name)) {
    score += 5;
    reasons.push('labelled high quality');
  }
  if (/bot|cheap|fake|low quality|\blq\b/i.test(svc.name)) {
    score -= 10;
    reasons.push('labelled low quality');
  }
  return { score, reasons, service: presentCatalog(svc) };
}

export function recommendForPackage(ctx: ServiceContext, packageName: string, limit = 5) {
  const pkg = PACKAGES[packageName];
  if (!pkg) throw new NotFoundError(`Package "${packageName}"`);
  const services = catalog.search(ctx.db, ctx.provider.name, undefined, false);
  return pkg.items.map((item) => {
    const candidates = services
      .map((s) => scoreService(item, s))
      .filter((c): c is Candidate => c !== null)
      // Best score first; among equals, the cheaper service.
      .sort((a, b) => b.score - a.score || a.service.ratePer1000Usd - b.service.ratePer1000Usd)
      .slice(0, limit);
    const current = mappings.find(ctx.db, ctx.provider.name, item.product, item.geo, item.premium ?? false);
    return {
      item: item.key,
      pinnedServiceId: item.serviceIds?.[ctx.provider.name] ?? null,
      product: item.product,
      geo: item.geo,
      premium: item.premium ?? false,
      currentServiceId: current?.service_id ?? null,
      candidates,
    };
  });
}

/** Map each package item to its top candidate. Items that already have a mapping are left alone unless `overwrite`. */
export function applyRecommendations(ctx: ServiceContext, packageName: string, overwrite: boolean) {
  const recs = recommendForPackage(ctx, packageName, 1);
  const now = nowIso(ctx);
  return recs.map((r) => {
    const top = r.candidates[0];
    if (r.pinnedServiceId) return { item: r.item, applied: false, reason: `pinned to ${r.pinnedServiceId} in the package` };
    if (!top) return { item: r.item, applied: false, reason: 'no matching service in the catalog' };
    if (r.currentServiceId && !overwrite) {
      return { item: r.item, applied: false, reason: `already mapped to ${r.currentServiceId}` };
    }
    mappings.upsert(ctx.db, {
      product: r.product,
      geo: r.geo,
      premium: r.premium ? 1 : 0,
      provider: ctx.provider.name,
      service_id: top.service.serviceId,
      updated_at: now,
    });
    return {
      item: r.item,
      applied: true,
      serviceId: top.service.serviceId,
      serviceName: top.service.name,
      ratePer1000Usd: top.service.ratePer1000Usd,
    };
  });
}
