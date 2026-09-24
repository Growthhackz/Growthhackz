import { toMicros } from '../../lib/money.js';
import type { ProviderOrderState, ProviderOrderStatus, ProviderOrderType, ProviderService } from '../types.js';

export interface RawFollowizService {
  service: number | string;
  name: string;
  type?: string;
  category?: string;
  rate: string | number;
  min: string | number;
  max: string | number;
  refill?: boolean | number | string;
  cancel?: boolean | number | string;
  dripfeed?: boolean | number | string;
}

export interface RawFollowizStatus {
  charge?: string | number | null;
  start_count?: string | number | null;
  status?: string;
  remains?: string | number | null;
  currency?: string;
  error?: string;
}

const STATUS_MAP: Record<string, ProviderOrderStatus> = {
  pending: 'pending',
  'in progress': 'in_progress',
  inprogress: 'in_progress',
  processing: 'processing',
  completed: 'completed',
  partial: 'partial',
  canceled: 'canceled',
  cancelled: 'canceled',
  refunded: 'canceled',
};

export function normalizeStatus(raw: string | undefined): ProviderOrderStatus {
  if (!raw) return 'unknown';
  return STATUS_MAP[raw.trim().toLowerCase()] ?? 'unknown';
}

export function normalizeOrderType(raw: string | undefined): ProviderOrderType {
  const t = (raw ?? 'default').trim().toLowerCase();
  if (t === 'default' || t === 'package') return 'default';
  if (t === 'custom comments' || t === 'custom comments package') return 'custom_comments';
  if (t === 'subscriptions' || t === 'subscription') return 'subscription';
  return 'other';
}

/** Pull a refill guarantee (in days) out of a service name like "Followers [R30]" or "30 Days Refill". */
export function parseRefillDays(name: string): number | null {
  if (/\bno\s*refill\b/i.test(name)) return 0;
  if (/\blifetime\b/i.test(name) && /refill|guarantee/i.test(name)) return 3650;
  const patterns = [
    /(\d{1,4})\s*(?:days?|d)\s*(?:auto[-\s]?)?(?:refill|guarantee)/i,
    /(?:refill|guarantee)\s*[:\-]?\s*(\d{1,4})\s*(?:days?|d)\b/i,
    /\bR(\d{1,4})\b/,
  ];
  for (const p of patterns) {
    const m = p.exec(name);
    if (m?.[1]) return Number.parseInt(m[1], 10);
  }
  return null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

export function mapService(raw: RawFollowizService): ProviderService {
  return {
    serviceId: String(raw.service),
    name: raw.name,
    category: raw.category ?? '',
    rawType: raw.type ?? 'Default',
    orderType: normalizeOrderType(raw.type),
    ratePer1000Micros: toMicros(raw.rate),
    min: intOrNull(raw.min) ?? 0,
    max: intOrNull(raw.max) ?? 0,
    refill: truthy(raw.refill),
    cancel: truthy(raw.cancel),
    dripfeed: truthy(raw.dripfeed),
    refillDays: parseRefillDays(raw.name),
  };
}

export function mapStatus(providerOrderId: string, raw: RawFollowizStatus): ProviderOrderState {
  if (raw.error) {
    return {
      providerOrderId,
      status: 'unknown',
      rawStatus: '',
      chargeMicros: null,
      startCount: null,
      remains: null,
      currency: null,
      error: raw.error,
    };
  }
  return {
    providerOrderId,
    status: normalizeStatus(raw.status),
    rawStatus: raw.status ?? '',
    chargeMicros: raw.charge === null || raw.charge === undefined || raw.charge === '' ? null : toMicros(raw.charge),
    startCount: intOrNull(raw.start_count),
    remains: intOrNull(raw.remains),
    currency: raw.currency ?? null,
  };
}
