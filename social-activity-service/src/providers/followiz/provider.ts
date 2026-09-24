import { toMicros } from '../../lib/money.js';
import {
  ProviderAmbiguousError,
  type AddOrderRequest,
  type ProviderBalance,
  type ProviderOrderState,
  type ProviderService,
  type RefillState,
  type SocialProvider,
} from '../types.js';
import type { FollowizClient } from './client.js';
import { mapService, mapStatus, type RawFollowizService, type RawFollowizStatus } from './mapper.js';

/** Followiz caps multi-order status/cancel lookups at 100 ids per request. */
export const FOLLOWIZ_BATCH_LIMIT = 100;

export class FollowizProvider implements SocialProvider {
  readonly name = 'followiz';

  constructor(private readonly client: FollowizClient) {}

  async listServices(): Promise<ProviderService[]> {
    const raw = await this.client.call<RawFollowizService[]>('services');
    if (!Array.isArray(raw)) throw new ProviderAmbiguousError('Unexpected services response', 'services');
    return raw.map(mapService);
  }

  async addOrder(req: AddOrderRequest): Promise<{ providerOrderId: string }> {
    let params: Record<string, string | number | undefined>;
    switch (req.type) {
      case 'default':
        params = { service: req.serviceId, link: req.link, quantity: req.quantity };
        break;
      case 'drip_feed':
        params = {
          service: req.serviceId,
          link: req.link,
          quantity: req.quantity,
          runs: req.runs,
          interval: req.intervalMinutes,
        };
        break;
      case 'custom_comments':
        params = { service: req.serviceId, link: req.link, comments: req.comments.join('\n') };
        break;
      case 'subscription':
        params = {
          service: req.serviceId,
          username: req.username,
          min: req.min,
          max: req.max,
          posts: req.posts,
          delay: req.delayMinutes,
          expiry: req.expiry,
        };
        break;
    }
    const res = await this.client.call<{ order?: number | string }>('add', params);
    if (res?.order === undefined || res.order === null || res.order === '') {
      // A 200 without an order id: the panel may or may not have created it.
      throw new ProviderAmbiguousError('Followiz add returned no order id', 'add');
    }
    return { providerOrderId: String(res.order) };
  }

  async getStatuses(providerOrderIds: string[]): Promise<Map<string, ProviderOrderState>> {
    const out = new Map<string, ProviderOrderState>();
    for (const chunk of chunks(providerOrderIds, FOLLOWIZ_BATCH_LIMIT)) {
      // Always use the multi-order form: it reports per-id errors instead of failing the whole call.
      const res = await this.client.call<Record<string, RawFollowizStatus>>('status', { orders: chunk.join(',') });
      for (const id of chunk) {
        const raw = res?.[id];
        if (raw) out.set(id, mapStatus(id, raw));
      }
    }
    return out;
  }

  async refill(providerOrderId: string): Promise<{ providerRefillId: string }> {
    const res = await this.client.call<{ refill?: number | string }>('refill', { order: providerOrderId });
    if (res?.refill === undefined || res.refill === null || res.refill === '') {
      throw new ProviderAmbiguousError('Followiz refill returned no refill id', 'refill');
    }
    return { providerRefillId: String(res.refill) };
  }

  async getRefillStatus(providerRefillId: string): Promise<RefillState> {
    const res = await this.client.call<{ status?: string }>('refill_status', { refill: providerRefillId });
    return { providerRefillId, status: res?.status ?? 'unknown' };
  }

  async cancel(providerOrderIds: string[]): Promise<Map<string, { ok: boolean; error?: string }>> {
    const out = new Map<string, { ok: boolean; error?: string }>();
    for (const chunk of chunks(providerOrderIds, FOLLOWIZ_BATCH_LIMIT)) {
      const res = await this.client.call<Array<{ order: number | string; cancel: unknown }>>('cancel', {
        orders: chunk.join(','),
      });
      for (const row of Array.isArray(res) ? res : []) {
        const cancel = row.cancel as { error?: string } | number | string;
        if (typeof cancel === 'object' && cancel !== null && cancel.error) {
          out.set(String(row.order), { ok: false, error: cancel.error });
        } else {
          out.set(String(row.order), { ok: true });
        }
      }
    }
    return out;
  }

  async getBalance(): Promise<ProviderBalance> {
    const res = await this.client.call<{ balance: string | number; currency?: string }>('balance');
    return { balanceMicros: toMicros(res.balance), currency: res.currency ?? 'USD' };
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
