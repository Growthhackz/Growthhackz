export interface Migration {
  version: number;
  sql: string;
}

// Timestamps are epoch milliseconds so lease and backoff arithmetic stays in SQL.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE orders (
        id              TEXT PRIMARY KEY,
        order_id        TEXT NOT NULL UNIQUE,
        input_hash      TEXT NOT NULL,
        input           TEXT NOT NULL,
        project         TEXT NOT NULL,
        copy            TEXT,
        reserved_cents  INTEGER NOT NULL DEFAULT 0,
        budget_cents    INTEGER NOT NULL,
        demo            INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_orders_created ON orders(created_at);

      CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL REFERENCES orders(id),
        kind          TEXT NOT NULL,
        rank          INTEGER NOT NULL,
        status        TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        available_at  INTEGER NOT NULL DEFAULT 0,
        lease         TEXT,
        lease_until   INTEGER,
        result        TEXT,
        error         TEXT,
        updated_at    INTEGER NOT NULL,
        UNIQUE (order_id, kind)
      );
      CREATE INDEX idx_jobs_order_rank ON jobs(order_id, rank);
      CREATE INDEX idx_jobs_status_available ON jobs(status, available_at);

      CREATE TABLE assets (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        kind        TEXT NOT NULL,
        path        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        name        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_assets_order ON assets(order_id);

      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL,
        type          TEXT NOT NULL,
        data          TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        sent          INTEGER NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        available_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_events_delivery ON events(sent, available_at);

      CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );

      CREATE TABLE api_keys (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        prefix        TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        revoked_at    INTEGER
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Per-item auto-fail time (NULL = none), and when every item reached a final state.
      ALTER TABLE jobs ADD COLUMN deadline_at INTEGER;
      ALTER TABLE orders ADD COLUMN completed_at INTEGER;
      -- Orders from before this change don't send a late order.completed.
      UPDATE orders SET completed_at = updated_at;
    `,
  },
  {
    version: 3,
    sql: `
      -- 'service': full order API. 'intake': trending intake and its own status/report only (the core bot).
      ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'service';
    `,
  },
];
