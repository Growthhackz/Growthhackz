import { all, get, run } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { newApiKey, uid } from '../lib/ids.js';
import { iso, nowMs, type ServiceContext } from './context.js';

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const present = (r: KeyRow) => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  created_at: iso(r.created_at),
  last_used_at: iso(r.last_used_at),
  revoked_at: iso(r.revoked_at),
});

/** Issues a service key. The plaintext is returned once; only its hash is stored. */
export function issueKey(ctx: ServiceContext, name: unknown) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new ValidationError('name is required (max 80 chars)');
  const key = newApiKey();
  const row: KeyRow = { id: uid(), name: name.trim(), prefix: key.slice(0, 10), created_at: nowMs(ctx), last_used_at: null, revoked_at: null };
  run(ctx.db, 'INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES (:id, :name, :hash, :prefix, :created_at)', {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.created_at,
    hash: sha256(key),
  });
  return { ...present(row), key, shown_once: true };
}

export function listKeys(ctx: ServiceContext) {
  return all<KeyRow>(ctx.db, 'SELECT * FROM api_keys ORDER BY created_at DESC').map(present);
}

export function revokeKey(ctx: ServiceContext, id: string) {
  const r = run(ctx.db, 'UPDATE api_keys SET revoked_at = :t WHERE id = :id AND revoked_at IS NULL', { id, t: nowMs(ctx) });
  if (!r.changes && !get(ctx.db, 'SELECT id FROM api_keys WHERE id = :id', { id })) throw new NotFoundError('API key');
  return present(get<KeyRow>(ctx.db, 'SELECT * FROM api_keys WHERE id = :id', { id })!);
}

/** Returns true for a live service key and records its use. */
export function authenticateKey(ctx: ServiceContext, key: string): boolean {
  const row = get<{ id: string }>(ctx.db, 'SELECT id FROM api_keys WHERE key_hash = :h AND revoked_at IS NULL', { h: sha256(key) });
  if (!row) return false;
  run(ctx.db, 'UPDATE api_keys SET last_used_at = :t WHERE id = :id', { id: row.id, t: nowMs(ctx) });
  return true;
}
