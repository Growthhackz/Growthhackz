import { catalog, mappings, type CatalogRow } from '../db/repositories.js';
import type { Geo, OrderType, Product } from '../domain/products.js';
import { ValidationError } from '../lib/errors.js';
import { nowIso, type ServiceContext } from './context.js';

export async function syncCatalog(ctx: ServiceContext): Promise<{ count: number; syncedAt: string }> {
  const services = await ctx.provider.listServices();
  const syncedAt = nowIso(ctx);
  catalog.replaceForProvider(ctx.db, ctx.provider.name, services, syncedAt);
  ctx.log.info({ provider: ctx.provider.name, count: services.length }, 'catalog synced');
  return { count: services.length, syncedAt };
}

async function ensureCatalog(ctx: ServiceContext): Promise<void> {
  if (catalog.count(ctx.db, ctx.provider.name) === 0) await syncCatalog(ctx);
}

/** Which panel service types can fulfil each of our order types. */
function compatible(orderType: OrderType, svc: CatalogRow): string | null {
  switch (orderType) {
    case 'default':
      return svc.order_type === 'default' ? null : `service ${svc.service_id} is "${svc.raw_type}", not a default service`;
    case 'drip_feed':
      if (svc.order_type !== 'default') return `service ${svc.service_id} is "${svc.raw_type}", not a default service`;
      return svc.dripfeed ? null : `service ${svc.service_id} does not support drip-feed`;
    case 'custom_comments':
      return svc.order_type === 'custom_comments' ? null : `service ${svc.service_id} is not a Custom Comments service`;
    case 'subscription':
      return svc.order_type === 'subscription' ? null : `service ${svc.service_id} is not a Subscriptions service`;
  }
}

export async function resolveService(
  ctx: ServiceContext,
  args: { product: Product; orderType: OrderType; geo: Geo; premium: boolean; serviceIdOverride?: string },
): Promise<CatalogRow> {
  await ensureCatalog(ctx);
  let serviceId = args.serviceIdOverride;
  if (!serviceId) {
    const mapping = mappings.find(ctx.db, ctx.provider.name, args.product, args.geo, args.premium);
    if (!mapping) {
      throw new ValidationError(
        `No service mapped for ${args.product} (geo=${args.geo}, premium=${args.premium}). ` +
          'Add one with PUT /v1/catalog/mappings or pass serviceId on the order.',
      );
    }
    serviceId = mapping.service_id;
  }
  const svc = catalog.get(ctx.db, ctx.provider.name, serviceId);
  if (!svc) throw new ValidationError(`Service ${serviceId} is not in the ${ctx.provider.name} catalog`);
  if (!svc.active) throw new ValidationError(`Service ${serviceId} is no longer offered by ${ctx.provider.name}`);
  const problem = compatible(args.orderType, svc);
  if (problem) throw new ValidationError(problem);
  return svc;
}
