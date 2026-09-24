import { SetupRequiredError, UpstreamError, ValidationError, AppError } from './errors.js';

export type HttpFetch = typeof fetch;

/** Rejects anything but a public HTTPS hostname (no credentials, ports, IPs or internal names). */
export function safeRemote(value: string, allowedHosts?: string[]): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ValidationError('Invalid URL');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/.test(u.hostname) ||
    /^\d+\./.test(u.hostname) ||
    u.hostname.includes(':') ||
    u.hostname.startsWith('[') ||
    !u.hostname.includes('.')
  )
    throw new ValidationError('A public HTTPS hostname is required');
  if (allowedHosts && !allowedHosts.includes(u.hostname)) throw new ValidationError('Unsupported provider URL');
  return u;
}

export async function readLimited(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length') || 0) > max) throw new AppError('Payload exceeds the size limit', 413, 'too_large');
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new AppError('Payload exceeds the size limit', 413, 'too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function jsonFetch(http: HttpFetch, url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<any> {
  let res: Response;
  try {
    res = await http(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new UpstreamError('Provider request failed (network or timeout)');
  }
  if (!res.ok) throw new UpstreamError(`Provider request failed (${res.status})`);
  try {
    return JSON.parse((await readLimited(res, 20_000_000)).toString('utf8'));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new UpstreamError('Provider returned invalid JSON');
  }
}

export function requireSetting(value: string, message: string): string {
  if (!value) throw new SetupRequiredError(message);
  return value;
}
