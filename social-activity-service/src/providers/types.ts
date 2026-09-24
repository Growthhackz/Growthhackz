/**
 * Provider-neutral contract. Every SMM panel adapter (Followiz today) maps its
 * own API onto these shapes so the rest of the service never sees raw panel data.
 */

export type ProviderOrderType = 'default' | 'custom_comments' | 'subscription' | 'other';

export interface ProviderService {
  serviceId: string;
  name: string;
  category: string;
  /** Raw panel type label, e.g. "Default", "Custom Comments". */
  rawType: string;
  orderType: ProviderOrderType;
  /** USD micros per 1000 units. */
  ratePer1000Micros: number;
  min: number;
  max: number;
  refill: boolean;
  cancel: boolean;
  dripfeed: boolean;
  /** Refill guarantee in days parsed from the service name, if stated. */
  refillDays: number | null;
}

/** Normalized lifecycle status reported by a provider. */
export type ProviderOrderStatus =
  | 'pending'
  | 'in_progress'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'canceled'
  | 'unknown';

export interface ProviderOrderState {
  providerOrderId: string;
  status: ProviderOrderStatus;
  rawStatus: string;
  chargeMicros: number | null;
  startCount: number | null;
  remains: number | null;
  currency: string | null;
  /** Set when the provider returned an error for this particular order id. */
  error?: string;
}

export type AddOrderRequest =
  | { type: 'default'; serviceId: string; link: string; quantity: number }
  | {
      type: 'drip_feed';
      serviceId: string;
      link: string;
      quantity: number;
      runs: number;
      intervalMinutes: number;
    }
  | { type: 'custom_comments'; serviceId: string; link: string; comments: string[] }
  | {
      type: 'subscription';
      serviceId: string;
      username: string;
      min: number;
      max: number;
      posts: number;
      delayMinutes: number;
      expiry?: string;
    };

export interface ProviderBalance {
  balanceMicros: number;
  currency: string;
}

export interface RefillState {
  providerRefillId: string;
  status: string;
  error?: string;
}

export interface SocialProvider {
  readonly name: string;
  listServices(): Promise<ProviderService[]>;
  addOrder(req: AddOrderRequest): Promise<{ providerOrderId: string }>;
  /** Batch status lookup; implementations chunk to the provider's max batch size. */
  getStatuses(providerOrderIds: string[]): Promise<Map<string, ProviderOrderState>>;
  refill(providerOrderId: string): Promise<{ providerRefillId: string }>;
  getRefillStatus(providerRefillId: string): Promise<RefillState>;
  cancel(providerOrderIds: string[]): Promise<Map<string, { ok: boolean; error?: string }>>;
  getBalance(): Promise<ProviderBalance>;
}

/**
 * The provider explicitly rejected the request (e.g. `{"error": "Not enough funds"}`).
 * Nothing was created on the provider side, so it is safe to mark the order failed.
 */
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    readonly action: string,
  ) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

/**
 * We cannot tell whether the provider acted on the request (timeout, network
 * error, 5xx, unparseable body). For `add` this means the order MAY exist and
 * must not be retried automatically.
 */
export class ProviderAmbiguousError extends Error {
  constructor(
    message: string,
    readonly action: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderAmbiguousError';
  }
}
