export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE campaigns (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        notes             TEXT,
        budget_micros     INTEGER,
        auto_refill       INTEGER NOT NULL DEFAULT 0,
        metadata          TEXT NOT NULL DEFAULT '{}',
        idempotency_key   TEXT UNIQUE,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE orders (
        id                      TEXT PRIMARY KEY,
        campaign_id             TEXT NOT NULL REFERENCES campaigns(id),
        product                 TEXT NOT NULL,
        order_type              TEXT NOT NULL,
        provider                TEXT NOT NULL,
        service_id              TEXT NOT NULL,
        geo                     TEXT NOT NULL,
        premium                 INTEGER NOT NULL DEFAULT 0,
        link                    TEXT,
        link_key                TEXT,
        quantity                INTEGER NOT NULL,
        params                  TEXT NOT NULL DEFAULT '{}',
        rate_per_1000_micros    INTEGER NOT NULL,
        estimated_cost_micros   INTEGER NOT NULL,
        status                  TEXT NOT NULL,
        provider_order_id       TEXT,
        provider_status_raw     TEXT,
        start_count             INTEGER,
        remains                 INTEGER,
        charge_micros           INTEGER,
        currency                TEXT,
        last_error              TEXT,
        submit_attempted_at     TEXT,
        submitted_at            TEXT,
        completed_at            TEXT,
        next_poll_at            TEXT,
        poll_backoff_ms         INTEGER,
        stuck_flagged           INTEGER NOT NULL DEFAULT 0,
        refill_days             INTEGER,
        refill_until            TEXT,
        auto_refill             INTEGER NOT NULL DEFAULT 0,
        last_refill_at          TEXT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        UNIQUE (provider, provider_order_id)
      );
      CREATE INDEX idx_orders_campaign ON orders(campaign_id);
      CREATE INDEX idx_orders_status_poll ON orders(status, next_poll_at);
      CREATE INDEX idx_orders_link_key ON orders(link_key, product);

      CREATE TABLE order_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        type        TEXT NOT NULL,
        message     TEXT,
        data        TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_order_events_order ON order_events(order_id, id);

      CREATE TABLE refills (
        id                  TEXT PRIMARY KEY,
        order_id            TEXT NOT NULL REFERENCES orders(id),
        provider_refill_id  TEXT,
        status              TEXT NOT NULL,
        error               TEXT,
        requested_at        TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX idx_refills_order ON refills(order_id);

      CREATE TABLE catalog_services (
        provider              TEXT NOT NULL,
        service_id            TEXT NOT NULL,
        name                  TEXT NOT NULL,
        category              TEXT NOT NULL,
        raw_type              TEXT NOT NULL,
        order_type            TEXT NOT NULL,
        rate_per_1000_micros  INTEGER NOT NULL,
        min_qty               INTEGER NOT NULL,
        max_qty               INTEGER NOT NULL,
        refill                INTEGER NOT NULL,
        cancel                INTEGER NOT NULL,
        dripfeed              INTEGER NOT NULL,
        refill_days           INTEGER,
        active                INTEGER NOT NULL DEFAULT 1,
        synced_at             TEXT NOT NULL,
        PRIMARY KEY (provider, service_id)
      );

      CREATE TABLE product_mappings (
        product     TEXT NOT NULL,
        geo         TEXT NOT NULL,
        premium     INTEGER NOT NULL,
        provider    TEXT NOT NULL,
        service_id  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (product, geo, premium, provider)
      );

      CREATE TABLE ledger_entries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT NOT NULL,
        amount_micros INTEGER NOT NULL,
        order_id      TEXT REFERENCES orders(id),
        campaign_id   TEXT REFERENCES campaigns(id),
        note          TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_campaign ON ledger_entries(campaign_id);
      CREATE INDEX idx_ledger_order ON ledger_entries(order_id);

      CREATE TABLE provider_calls (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        provider       TEXT NOT NULL,
        action         TEXT NOT NULL,
        request        TEXT NOT NULL,
        http_status    INTEGER,
        response_body  TEXT,
        duration_ms    INTEGER NOT NULL,
        error          TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX idx_provider_calls_created ON provider_calls(created_at);
    `,
  },
];
