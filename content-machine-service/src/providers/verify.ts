import { NotVerifiedError, ValidationError } from '../lib/errors.js';
import { readLimited, safeRemote } from '../lib/http.js';
import { nowMs, type ServiceContext } from '../services/context.js';

const HOSTS: Record<string, string[]> = {
  telegraph: ['telegra.ph'],
  binance: ['www.binance.com', 'binance.com'],
};

/** Confirms a publication is publicly visible and, when a headline is given, that it is this project's article. */
export async function verifyPublication(ctx: ServiceContext, url: string, kind: string, headline?: string) {
  const u = safeRemote(url, HOSTS[kind] ?? ['t.me']);
  if (kind === 'binance' && !/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?square\/post\/[0-9]+\/?$/.test(u.pathname))
    throw new ValidationError('Use the direct Binance Square article URL');
  if (kind === 'telegraph' && (!u.pathname.includes('-') || u.pathname === '/api'))
    throw new ValidationError('Use the direct Telegraph article URL');
  let r: Response;
  try {
    r = await ctx.http(u, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new NotVerifiedError('Publication exists but its public page could not be verified yet.');
  }
  if (!r.ok) throw new NotVerifiedError('Publication exists but its public page could not be verified yet.');
  const text = (await readLimited(r, 2_000_000)).toString('utf8');
  if (text.length < 100 || /page not found|post does not exist/i.test(text))
    throw new NotVerifiedError('Publication visibility is not yet verified.');
  if (headline) {
    const normalized = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#[^;]+;|&[a-z]+;/g, ' ')
      .replace(/[^a-z0-9]+/gi, ' ')
      .toLowerCase();
    const words = headline.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    if (words.length && words.filter((w) => normalized.includes(w)).length / words.length < 0.7)
      throw new NotVerifiedError('The public article could not be matched to this project headline.');
  }
  return { url, verified_at: new Date(nowMs(ctx)).toISOString() };
}
