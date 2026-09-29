import type { Project } from '../domain/schemas.js';
import { readLimited, safeRemote } from '../lib/http.js';
import { nowMs, type ServiceContext } from '../services/context.js';
import { xSnapshot, type XSnapshot } from './xProfile.js';

/**
 * A quick, bounded look at what the project says about itself (website, X, Telegram), so the copy and memes can be
 * specific. Every source is optional and time-boxed; failures just leave that source out. Everything here is
 * untrusted page text: it is only ever passed to the writer as data.
 */
export interface Research {
  website?: { url: string; title: string | null; description: string | null; text: string | null };
  x?: XSnapshot;
  telegram?: { title: string | null; description: string | null };
  fetched_at: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
/** Pages that aren't the project's own site (video, social or link hosts) are skipped as "websites". */
const NOT_A_SITE = /(^|\.)(tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|t\.me|telegram\.me|instagram\.com|facebook\.com|dexscreener\.com|pump\.fun)$/i;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const squash = (s: string | null | undefined, max: number) => {
  const t = s ? decode(s).replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, max) : null;
};
const meta = (html: string, name: string) =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1] ??
  html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))?.[1] ??
  null;

/** GET with every redirect hop re-checked (https, public host), a size cap and a timeout. */
async function fetchPage(ctx: ServiceContext, url: string, maxBytes = 600_000): Promise<{ url: string; html: string } | null> {
  let current = safeRemote(url).href;
  for (let hop = 0; hop < 4; hop++) {
    const r = await ctx.http(current, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(8_000) });
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get('location');
      if (!next) return null;
      current = safeRemote(new URL(next, current).href).href;
      continue;
    }
    if (!r.ok || !/text\/html|application\/xhtml/i.test(r.headers.get('content-type') ?? '')) return null;
    return { url: current, html: (await readLimited(r, maxBytes)).toString('utf8') };
  }
  return null;
}

export async function websiteSnapshot(ctx: ServiceContext, url: string | undefined): Promise<Research['website'] | undefined> {
  if (!url || NOT_A_SITE.test(new URL(url).hostname.replace(/^www\./, ''))) return undefined;
  const page = await fetchPage(ctx, url);
  if (!page) return undefined;
  const body = page.html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return {
    url: page.url,
    title: squash(page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 120),
    description: squash(meta(page.html, 'og:description') ?? meta(page.html, 'description'), 300),
    text: squash(body, 1500),
  };
}

export async function telegramSnapshot(ctx: ServiceContext, url: string | undefined): Promise<Research['telegram'] | undefined> {
  const handle = url?.match(/^https:\/\/(?:www\.)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/)?.[1];
  if (!handle) return undefined;
  const page = await fetchPage(ctx, `https://t.me/${handle}`, 200_000);
  if (!page) return undefined;
  const description = page.html.match(/<div class="tgme_page_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  return {
    title: squash(meta(page.html, 'og:title'), 100),
    description: squash(description?.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ') ?? meta(page.html, 'og:description'), 400),
  };
}

export async function researchProject(ctx: ServiceContext, p: Project): Promise<Research> {
  const quiet = <T>(what: string, run: () => Promise<T>) =>
    run().catch((err) => {
      ctx.log.warn({ source: what, err: err instanceof Error ? err.message : String(err) }, 'project research source skipped');
      return undefined;
    });
  const [website, x, telegram] = await Promise.all([
    quiet('website', () => websiteSnapshot(ctx, p.website_url)),
    quiet('x', async () => (await xSnapshot(ctx, p.x_url)) ?? undefined),
    quiet('telegram', () => telegramSnapshot(ctx, p.telegram_url)),
  ]);
  return {
    ...(website ? { website } : {}),
    ...(x ? { x } : {}),
    ...(telegram && (telegram.title || telegram.description) ? { telegram } : {}),
    fetched_at: new Date(nowMs(ctx)).toISOString(),
  };
}
