import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Db = DatabaseSync;
type Params = Record<string, unknown>;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** node:sqlite rejects `undefined`; store it as NULL. */
function clean(params: Params): Record<string, string | number | bigint | null | Uint8Array> {
  const out: Record<string, string | number | bigint | null | Uint8Array> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v instanceof Uint8Array)
      out[k] = v;
    else out[k] = JSON.stringify(v);
  }
  return out;
}

export function run(db: Db, sql: string, params: Params = {}): { changes: number } {
  const res = db.prepare(sql).run(clean(params));
  return { changes: Number(res.changes) };
}

export function get<T>(db: Db, sql: string, params: Params = {}): T | undefined {
  return db.prepare(sql).get(clean(params)) as T | undefined;
}

export function all<T>(db: Db, sql: string, params: Params = {}): T[] {
  return db.prepare(sql).all(clean(params)) as T[];
}
