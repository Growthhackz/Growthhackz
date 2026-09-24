import type { CatalogRow } from '../db/repositories.js';
import { PACKAGES, type PackageDefinition, type PackageItem } from '../domain/packages.js';
import type { Geo } from '../domain/products.js';
import type { CreateCampaignInput, OrderInput, PackageRequest } from '../domain/schemas.js';
import { AppError, NotFoundError, ValidationError } from '../lib/errors.js';
import { fromMicros } from '../lib/money.js';
import { resolveService } from './catalogService.js';
import type { ServiceContext } from './context.js';
import { planOrder } from './orderService.js';

export interface PackageLine {
  item: string;
  label: string;
  included: boolean;
  /** Why the item was skipped, when it was. */
  skipped?: string;
  serviceId?: string;
  serviceName?: string;
  geo?: Geo;
  quantity?: number;
  runs?: number;
  intervalMinutes?: number;
  estimatedCostUsd?: number;
  /** Every adjustment made to fit the provider's service. */
  notes: string[];
}

export interface PackagePlan {
  package: string;
  orders: OrderInput[];
  lines: PackageLine[];
  estimatedTotalUsd: number;
}

export function getPackage(name: string): PackageDefinition {
  const pkg = PACKAGES[name];
  if (!pkg) throw new NotFoundError(`Package "${name}"`);
  return pkg;
}

/** Find a service for the item, trying the preferred geo first and then "any". */
async function findService(
  ctx: ServiceContext,
  item: PackageItem,
  geo: Geo,
  notes: string[],
): Promise<{ svc: CatalogRow; geo: Geo } | { error: string }> {
  const orderType = item.usesComments ? 'custom_comments' : 'default';
  const geos: Geo[] = geo === 'any' ? ['any'] : [geo, 'any'];
  let lastError = '';
  for (const g of geos) {
    try {
      const svc = await resolveService(ctx, { product: item.product, orderType, geo: g, premium: item.premium ?? false });
      if (g !== geo) notes.push(`No ${geo} service mapped; using the "any" geo service instead`);
      return { svc, geo: g };
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      lastError = err.message;
    }
  }
  return { error: lastError };
}

/**
 * Fit a package item to a service's limits. Quantities move inside the item's
 * range where possible; drip-feed is dropped when the service can't do it or
 * each run would fall under the service minimum.
 */
export function fitQuantity(
  item: PackageItem,
  svc: Pick<CatalogRow, 'min_qty' | 'max_qty' | 'dripfeed'>,
  requested: number,
  allowAboveRange: boolean,
): { quantity: number; runs: number; notes: string[] } | { skip: string } {
  const notes: string[] = [];
  let qty = requested;

  if (svc.min_qty && qty < svc.min_qty) {
    if (svc.min_qty <= item.quantity.max || allowAboveRange) {
      notes.push(`Raised ${qty} → ${svc.min_qty} (service minimum)`);
      qty = svc.min_qty;
    } else {
      return {
        skip: `Service minimum is ${svc.min_qty}, above this item's range (${item.quantity.min}–${item.quantity.max}). Map a smaller service or set allowAboveRange.`,
      };
    }
  }
  if (svc.max_qty && qty > svc.max_qty) {
    notes.push(`Lowered ${qty} → ${svc.max_qty} (service maximum)`);
    qty = svc.max_qty;
  }

  let runs = 1;
  if (item.drip) {
    if (!svc.dripfeed) {
      notes.push('Service has no drip-feed; delivered as a single order');
    } else {
      const perRunMin = Math.max(1, svc.min_qty);
      runs = Math.min(item.drip.runs, Math.floor(qty / perRunMin));
      if (runs < 2) {
        runs = 1;
        notes.push(`Too small to split under the service minimum of ${svc.min_qty}; delivered as a single order`);
      } else {
        if (runs < item.drip.runs) notes.push(`Split into ${runs} runs instead of ${item.drip.runs} to keep each run ≥ ${svc.min_qty}`);
        const perRun = Math.floor(qty / runs);
        if (perRun * runs !== qty) notes.push(`Rounded ${qty} → ${perRun * runs} to split evenly across ${runs} runs`);
        qty = perRun * runs;
      }
    }
  }
  return { quantity: qty, runs, notes };
}

export async function planPackage(ctx: ServiceContext, name: string, req: PackageRequest): Promise<PackagePlan> {
  const pkg = getPackage(name);
  const include = new Set(req.include ?? []);
  const exclude = new Set(req.exclude ?? []);
  const known = new Set(pkg.items.map((i) => i.key));
  for (const k of [...include, ...exclude, ...Object.keys(req.quantities ?? {})]) {
    if (!known.has(k)) throw new ValidationError(`Unknown package item "${k}". Items: ${[...known].join(', ')}`);
  }

  const orders: OrderInput[] = [];
  const lines: PackageLine[] = [];
  let totalMicros = 0;

  for (const item of pkg.items) {
    const line: PackageLine = { item: item.key, label: item.label, included: false, notes: [] };
    lines.push(line);

    if (item.optIn && !include.has(item.key)) {
      line.skipped = `Opt-in item; add "${item.key}" to include`;
      continue;
    }
    if (exclude.has(item.key)) {
      line.skipped = 'Excluded by request';
      continue;
    }
    const target = req.targets[item.target];
    if (!target) {
      line.skipped = `No targets.${item.target} given`;
      continue;
    }
    let comments: string[] | undefined;
    if (item.usesComments) {
      if (!req.comments?.length) {
        line.skipped = 'No comments given; comment text must be supplied';
        continue;
      }
      comments = req.comments.slice(0, item.quantity.max);
      if (comments.length < req.comments.length) {
        line.notes.push(`Used the first ${comments.length} of ${req.comments.length} comments (package max)`);
      }
    }

    const found = await findService(ctx, item, req.geo ?? item.geo, line.notes);
    if ('error' in found) {
      line.skipped = found.error;
      continue;
    }
    const { svc, geo } = found;

    let input: OrderInput;
    if (comments) {
      if (svc.min_qty && comments.length < svc.min_qty) {
        line.skipped = `Service needs at least ${svc.min_qty} comments; ${comments.length} given`;
        continue;
      }
      if (svc.max_qty && comments.length > svc.max_qty) {
        line.notes.push(`Trimmed to ${svc.max_qty} comments (service maximum)`);
        comments = comments.slice(0, svc.max_qty);
      }
      input = { product: item.product, type: 'custom_comments', link: target, comments, geo, serviceId: svc.service_id };
      line.quantity = comments.length;
      line.runs = 1;
    } else {
      const requested = req.quantities?.[item.key] ?? item.quantity.default;
      const fit = fitQuantity(item, svc, requested, req.allowAboveRange ?? false);
      if ('skip' in fit) {
        line.skipped = fit.skip;
        continue;
      }
      line.notes.push(...fit.notes);
      line.quantity = fit.quantity;
      line.runs = fit.runs;
      const base = {
        product: item.product,
        link: item.target === 'twitterProfile' ? profileLink(target) : target,
        geo,
        premium: item.premium,
        serviceId: svc.service_id,
      };
      if (fit.runs > 1) {
        line.intervalMinutes = item.drip!.intervalMinutes;
        input = { ...base, type: 'drip_feed', quantity: fit.quantity / fit.runs, runs: fit.runs, intervalMinutes: item.drip!.intervalMinutes };
      } else {
        input = { ...base, type: 'default', quantity: fit.quantity };
      }
    }

    // Run it through the normal order validation to catch bad links and get the estimate.
    try {
      const { row } = await planOrder(ctx, { id: 'preview', name: pkg.name, autoRefill: false }, input, orders.length);
      totalMicros += row.estimated_cost_micros;
      line.estimatedCostUsd = fromMicros(row.estimated_cost_micros);
    } catch (err) {
      if (err instanceof AppError) {
        line.skipped = err.message.replace(/^orders\[\d+\]: /, '');
        continue;
      }
      throw err;
    }

    line.included = true;
    line.serviceId = svc.service_id;
    line.serviceName = svc.name;
    line.geo = geo;
    orders.push(input);
  }

  return { package: pkg.name, orders, lines, estimatedTotalUsd: fromMicros(totalMicros) };
}

function profileLink(target: string): string {
  const t = target.trim();
  return /^@?[A-Za-z0-9_]{1,15}$/.test(t) ? `https://x.com/${t.replace(/^@/, '')}` : t;
}

export function packageToCampaign(
  plan: PackagePlan,
  opts: {
    name?: string;
    notes?: string;
    budgetUsd?: number;
    autoRefill?: boolean;
    metadata?: Record<string, unknown>;
    submit?: boolean;
  },
): CreateCampaignInput {
  if (plan.orders.length === 0) {
    throw new ValidationError('Nothing to order: every package item was skipped', { lines: plan.lines });
  }
  return {
    name: opts.name ?? `${plan.package} package`,
    notes: opts.notes,
    budgetUsd: opts.budgetUsd,
    autoRefill: opts.autoRefill,
    submit: opts.submit,
    metadata: {
      ...(opts.metadata ?? {}),
      package: plan.package,
      packageLines: plan.lines.map(({ item, included, skipped, notes }) => ({ item, included, skipped, notes })),
    },
    orders: plan.orders,
  };
}
