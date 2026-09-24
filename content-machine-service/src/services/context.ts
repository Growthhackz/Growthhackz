import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { Clock } from '../lib/clock.js';
import type { Vault } from '../lib/crypto.js';
import type { HttpFetch } from '../lib/http.js';
import type { AssetStore } from './assetStore.js';

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface ServiceContext {
  db: Db;
  config: Config;
  clock: Clock;
  log: Logger | FastifyBaseLogger;
  /** Outbound HTTP to providers; injectable so tests never touch the network. */
  http: HttpFetch;
  assets: AssetStore;
  vault: Vault;
}

export const nowMs = (ctx: ServiceContext) => ctx.clock.now().getTime();
export const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
export const publicAssetUrl = (ctx: ServiceContext, orderId: string, assetId: string) =>
  `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/projects/${orderId}/assets/${assetId}`;
export const hubUrl = (ctx: ServiceContext, id: string) => `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/projects/${id}`;
