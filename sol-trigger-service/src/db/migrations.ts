export interface Migration {
  version: number;
  sql: string;
}

// Timestamps are epoch milliseconds. Lamport and raw token amounts are TEXT (u64 overflows REAL).
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        data  TEXT NOT NULL
      );

      CREATE TABLE wallets (
        id                   TEXT PRIMARY KEY,
        role                 TEXT NOT NULL CHECK (role IN ('funding', 'trading')),
        label                TEXT NOT NULL,
        address              TEXT NOT NULL,
        secret_sealed        TEXT NOT NULL,
        buy_pct              REAL NOT NULL DEFAULT 0,
        sell_pct             REAL NOT NULL DEFAULT 0,
        sell_interval_hours  REAL NOT NULL DEFAULT 1,
        enabled              INTEGER NOT NULL DEFAULT 1,
        archived             INTEGER NOT NULL DEFAULT 0,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_wallets_address ON wallets(address) WHERE archived = 0;
      CREATE UNIQUE INDEX idx_wallets_one_funding ON wallets(role) WHERE role = 'funding' AND archived = 0;

      CREATE TABLE triggers (
        id                TEXT PRIMARY KEY,
        mint              TEXT NOT NULL,
        event_id          TEXT UNIQUE,
        source            TEXT NOT NULL,
        status            TEXT NOT NULL,
        note              TEXT,
        funding_status    TEXT NOT NULL,
        funding_attempts  INTEGER NOT NULL DEFAULT 0,
        funding_to        TEXT,
        funding_lamports  TEXT,
        received_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_triggers_received ON triggers(received_at);

      CREATE TABLE positions (
        id                 TEXT PRIMARY KEY,
        trigger_id         TEXT NOT NULL REFERENCES triggers(id),
        wallet_id          TEXT NOT NULL REFERENCES wallets(id),
        mint               TEXT NOT NULL,
        status             TEXT NOT NULL,
        buy_attempts       INTEGER NOT NULL DEFAULT 0,
        sol_spent          TEXT NOT NULL DEFAULT '0',
        tokens_bought      TEXT NOT NULL DEFAULT '0',
        tokens_sold        TEXT NOT NULL DEFAULT '0',
        sol_received       TEXT NOT NULL DEFAULT '0',
        sells              INTEGER NOT NULL DEFAULT 0,
        next_action_at     INTEGER,
        sell_override_pct  REAL,
        sell_failures      INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX idx_positions_status ON positions(status);
      CREATE INDEX idx_positions_wallet ON positions(wallet_id);

      CREATE TABLE txs (
        id                       TEXT PRIMARY KEY,
        kind                     TEXT NOT NULL CHECK (kind IN ('funding', 'buy', 'sell', 'sweep')),
        wallet_id                TEXT NOT NULL REFERENCES wallets(id),
        trigger_id               TEXT,
        position_id              TEXT,
        to_address               TEXT,
        amount_in                TEXT NOT NULL,
        expected_out             TEXT,
        signature                TEXT NOT NULL UNIQUE,
        raw                      TEXT,
        last_valid_block_height  TEXT NOT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'expired')),
        error                    TEXT,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );
      CREATE INDEX idx_txs_status ON txs(status);
      CREATE INDEX idx_txs_wallet ON txs(wallet_id, status);
      CREATE INDEX idx_txs_created ON txs(created_at);
    `,
  },
  {
    // Buy delay and swap settings move from global settings onto each trading wallet.
    version: 2,
    sql: `
      ALTER TABLE wallets ADD COLUMN buy_delay_minutes REAL NOT NULL DEFAULT 10;
      ALTER TABLE wallets ADD COLUMN slippage_bps INTEGER NOT NULL DEFAULT 1000;
      ALTER TABLE wallets ADD COLUMN fee_reserve_sol REAL NOT NULL DEFAULT 0.01;
      ALTER TABLE wallets ADD COLUMN swap_max_priority_fee_lamports INTEGER NOT NULL DEFAULT 2000000;
      UPDATE wallets SET
        buy_delay_minutes = coalesce((SELECT json_extract(data, '$.buyDelayMinutes') FROM settings WHERE id = 1), buy_delay_minutes),
        slippage_bps = coalesce((SELECT json_extract(data, '$.slippageBps') FROM settings WHERE id = 1), slippage_bps),
        fee_reserve_sol = coalesce((SELECT json_extract(data, '$.feeReserveSol') FROM settings WHERE id = 1), fee_reserve_sol),
        swap_max_priority_fee_lamports = coalesce((SELECT json_extract(data, '$.swapMaxPriorityFeeLamports') FROM settings WHERE id = 1), swap_max_priority_fee_lamports);
    `,
  },
];
