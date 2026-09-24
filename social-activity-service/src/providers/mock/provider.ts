import { costForUnits, toMicros } from '../../lib/money.js';
import {
  ProviderAmbiguousError,
  ProviderRejectedError,
  type AddOrderRequest,
  type ProviderBalance,
  type ProviderOrderState,
  type ProviderService,
  type RefillState,
  type SocialProvider,
} from '../types.js';

interface MockOrder {
  id: string;
  serviceId: string;
  quantity: number;
  delivered: number;
  statusIndex: number;
  canceled: boolean;
  chargeMicros: number;
}

const PROGRESSION = ['Pending', 'In progress', 'Completed'] as const;

export const MOCK_SERVICES: ProviderService[] = [
  svc('1001', 'Twitter Followers [North America] [R30]', 'Twitter', 'Default', 2.5, 50, 20000, true, true),
  svc('1002', 'Twitter Likes [R30]', 'Twitter', 'Default', 0.8, 10, 50000, true, true),
  svc('1003', 'Twitter Retweets [R30]', 'Twitter', 'Default', 1.2, 10, 20000, true, true),
  svc('1004', 'Twitter Custom Comments [North America]', 'Twitter', 'Custom Comments', 12, 5, 1000, false, false),
  svc('1005', 'Website Traffic [USA + Canada]', 'Website Traffic', 'Default', 0.3, 100, 1000000, false, true),
  svc('1006', 'Telegram Channel Members [North America] [R30]', 'Telegram', 'Default', 1.8, 100, 50000, true, true),
  svc('1007', 'Telegram Premium Members [North America] [30 Days Refill]', 'Telegram', 'Default', 9, 50, 10000, true, false),
  svc('1008', 'Twitter Auto Likes [Subscription]', 'Twitter', 'Subscriptions', 0.9, 10, 5000, false, false),
];

function svc(
  serviceId: string,
  name: string,
  category: string,
  rawType: string,
  rate: number,
  min: number,
  max: number,
  refill: boolean,
  dripfeed: boolean,
): ProviderService {
  const orderType =
    rawType === 'Custom Comments' ? 'custom_comments' : rawType === 'Subscriptions' ? 'subscription' : 'default';
  return {
    serviceId,
    name,
    category,
    rawType,
    orderType,
    ratePer1000Micros: toMicros(rate),
    min,
    max,
    refill,
    cancel: true,
    dripfeed,
    refillDays: refill ? 30 : null,
  };
}

/**
 * In-memory stand-in for an SMM panel. Each status poll advances an order one
 * step (Pending → In progress → Completed), so the full lifecycle can be
 * exercised locally without an API key or spending money.
 */
export class MockProvider implements SocialProvider {
  readonly name = 'mock';
  private orders = new Map<string, MockOrder>();
  private seq = 5000;
  balanceMicros: number;
  /** Test hook: make the next addOrder call fail in a specific way. */
  failNextAdd: 'reject' | 'ambiguous' | null = null;

  constructor(opts: { balanceUsd?: number; services?: ProviderService[] } = {}) {
    this.balanceMicros = toMicros(opts.balanceUsd ?? 100);
    if (opts.services) this.services = opts.services;
  }

  services: ProviderService[] = MOCK_SERVICES;

  async listServices(): Promise<ProviderService[]> {
    return this.services.map((s) => ({ ...s }));
  }

  async addOrder(req: AddOrderRequest): Promise<{ providerOrderId: string }> {
    if (this.failNextAdd) {
      const mode = this.failNextAdd;
      this.failNextAdd = null;
      if (mode === 'reject') throw new ProviderRejectedError('Mock rejection', 'add');
      throw new ProviderAmbiguousError('Mock timeout', 'add');
    }
    const service = this.services.find((s) => s.serviceId === req.serviceId);
    if (!service) throw new ProviderRejectedError('Incorrect service ID', 'add');

    const quantity =
      req.type === 'custom_comments'
        ? req.comments.length
        : req.type === 'subscription'
          ? req.max * req.posts
          : req.type === 'drip_feed'
            ? req.quantity * req.runs
            : req.quantity;
    const charge = costForUnits(service.ratePer1000Micros, quantity);
    if (charge > this.balanceMicros) throw new ProviderRejectedError('Not enough funds on balance', 'add');
    this.balanceMicros -= charge;

    const id = String(++this.seq);
    this.orders.set(id, {
      id,
      serviceId: req.serviceId,
      quantity,
      delivered: 0,
      statusIndex: 0,
      canceled: false,
      chargeMicros: charge,
    });
    return { providerOrderId: id };
  }

  async getStatuses(ids: string[]): Promise<Map<string, ProviderOrderState>> {
    const out = new Map<string, ProviderOrderState>();
    for (const id of ids) {
      const o = this.orders.get(id);
      if (!o) {
        out.set(id, {
          providerOrderId: id,
          status: 'unknown',
          rawStatus: '',
          chargeMicros: null,
          startCount: null,
          remains: null,
          currency: null,
          error: 'Incorrect order ID',
        });
        continue;
      }
      if (!o.canceled && o.statusIndex < PROGRESSION.length - 1) o.statusIndex += 1;
      const raw = o.canceled ? 'Canceled' : PROGRESSION[o.statusIndex]!;
      if (raw === 'Completed') o.delivered = o.quantity;
      else if (raw === 'In progress') o.delivered = Math.floor(o.quantity / 2);
      out.set(id, {
        providerOrderId: id,
        status: raw === 'Canceled' ? 'canceled' : raw === 'Completed' ? 'completed' : raw === 'In progress' ? 'in_progress' : 'pending',
        rawStatus: raw,
        chargeMicros: o.canceled ? 0 : o.chargeMicros,
        startCount: 1000,
        remains: o.quantity - o.delivered,
        currency: 'USD',
      });
    }
    return out;
  }

  async refill(providerOrderId: string): Promise<{ providerRefillId: string }> {
    if (!this.orders.has(providerOrderId)) throw new ProviderRejectedError('Incorrect order ID', 'refill');
    return { providerRefillId: `r${providerOrderId}` };
  }

  async getRefillStatus(providerRefillId: string): Promise<RefillState> {
    return { providerRefillId, status: 'Completed' };
  }

  async cancel(ids: string[]): Promise<Map<string, { ok: boolean; error?: string }>> {
    const out = new Map<string, { ok: boolean; error?: string }>();
    for (const id of ids) {
      const o = this.orders.get(id);
      if (!o || o.statusIndex >= PROGRESSION.length - 1) {
        out.set(id, { ok: false, error: 'Order cannot be canceled' });
        continue;
      }
      o.canceled = true;
      this.balanceMicros += o.chargeMicros;
      out.set(id, { ok: true });
    }
    return out;
  }

  async getBalance(): Promise<ProviderBalance> {
    return { balanceMicros: this.balanceMicros, currency: 'USD' };
  }
}
