import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { Clock } from '../lib/clock.js';
import type { Vault } from '../lib/crypto.js';
import type { Chain } from '../solana/chain.js';
import type { Swapper } from '../solana/jupiter.js';

export interface ServiceContext {
  db: Db;
  config: Config;
  clock: Clock;
  log: FastifyBaseLogger;
  vault: Vault;
  chain: Chain;
  swapper: Swapper;
}
