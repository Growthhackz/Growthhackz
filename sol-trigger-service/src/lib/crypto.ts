import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/** AES-256-GCM for private keys at rest. */
export class Vault {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update('vault:' + secret).digest();
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

/** Stateless signed session token: `<expiresAtMs>.<nonce>.<hmac>`. */
export class Sessions {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update('session:' + secret).digest();
  }
  issue(expiresAt: number): string {
    const body = `${expiresAt}.${randomBytes(12).toString('base64url')}`;
    return `${body}.${this.sign(body)}`;
  }
  verify(token: string, now: number): boolean {
    const i = token.lastIndexOf('.');
    if (i < 0) return false;
    const body = token.slice(0, i);
    if (!safeEqual(token.slice(i + 1), this.sign(body))) return false;
    const exp = Number(body.split('.')[0]);
    return Number.isFinite(exp) && exp > now;
  }
  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
