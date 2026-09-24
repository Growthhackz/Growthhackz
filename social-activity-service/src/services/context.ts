import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { Clock } from '../lib/clock.js';
import type { SocialProvider } from '../providers/types.js';

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface ServiceContext {
  db: Db;
  provider: SocialProvider;
  config: Config;
  clock: Clock;
  log: Logger | FastifyBaseLogger;
}

export function nowIso(ctx: ServiceContext): string {
  return ctx.clock.now().toISOString();
}

export function isoPlus(ctx: ServiceContext, ms: number): string {
  return new Date(ctx.clock.now().getTime() + ms).toISOString();
}
