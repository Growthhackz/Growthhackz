import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Stable JSON: object keys sorted so equal inputs hash equally. */
export function canonical(v: unknown): string {
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Vault {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }
  decrypt(sealed: string): string {
    const [v, iv, tag, data] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognised sealed value');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  }
}

/** Hex HMAC-SHA256 of `timestamp + '.' + body`, matching the Peak callback contract. */
export function signCallback(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
}
