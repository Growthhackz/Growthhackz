import { SetupRequiredError, UpstreamError, ValidationError } from '../lib/errors.js';
import type { ServiceContext } from '../services/context.js';

/** Calls social-activity-service (a trusted, configured URL; usually Railway's private network). */
export async function socialActivity<T = any>(
  ctx: ServiceContext,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const base = ctx.config.SOCIAL_ACTIVITY_URL;
  const token = ctx.config.SOCIAL_ACTIVITY_TOKEN;
  if (!base || !token) throw new SetupRequiredError('Set SOCIAL_ACTIVITY_URL and SOCIAL_ACTIVITY_TOKEN to run the social boost.');
  let r: Response;
  try {
    r = await ctx.http(base.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UpstreamError('Social activity service is unreachable');
  }
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  if (r.ok) return json as T;
  const message = json?.error?.message ?? `HTTP ${r.status}`;
  if (r.status >= 500 || r.status === 429) throw new UpstreamError(`Social activity service: ${message}`);
  throw new ValidationError(`Social activity service refused the request: ${message}`, json?.error?.details);
}
