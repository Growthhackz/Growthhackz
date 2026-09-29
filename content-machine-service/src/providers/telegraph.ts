import { SetupRequiredError, UpstreamError } from '../lib/errors.js';
import { jsonFetch } from '../lib/http.js';
import type { ServiceContext } from '../services/context.js';
import { setting } from '../services/settingsService.js';

export function telegraphToken(ctx: ServiceContext): string {
  const token = setting(ctx, 'TELEGRAPH_TOKEN');
  if (!token) throw new SetupRequiredError('Connect a Telegraph access token.');
  return token;
}

export const PEAK_BUYBOT_URL = 'https://t.me/peakbuybot';

type Node = string | { tag: string; attrs?: Record<string, string>; children?: Node[] };

/** A paragraph with every "Peak BuyBot" mention linked to @peakbuybot (never to the project's own links). */
export function paragraphNodes(text: string): Node[] {
  return text
    .split(/(Peak Buy ?Bot)/i)
    .filter(Boolean)
    .map((part) => (/^Peak Buy ?Bot$/i.test(part) ? { tag: 'a', attrs: { href: PEAK_BUYBOT_URL }, children: [part] } : part));
}

export interface PageLink {
  label: string;
  href: string;
}

export async function createPage(
  ctx: ServiceContext,
  page: { title: string; author: string; paragraphs: string[]; links: PageLink[]; imageUrl: string },
) {
  const links: Node[] = page.links.flatMap((l, i) => [...(i ? [' · '] : []), { tag: 'a', attrs: { href: l.href }, children: [l.label] }]);
  const content: Node[] = [
    { tag: 'figure', children: [{ tag: 'img', attrs: { src: page.imageUrl } }] },
    ...page.paragraphs.map((s) => ({ tag: 'p', children: paragraphNodes(s) })),
    ...(links.length ? [{ tag: 'h4', children: ['Links'] }, { tag: 'p', children: links }] : []),
  ];
  const r = await jsonFetch(ctx.http, 'https://api.telegra.ph/createPage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: telegraphToken(ctx), title: page.title, author_name: page.author, content, return_content: false }),
  });
  if (!r.ok || !r.result?.url) throw new UpstreamError('Telegraph did not return a page URL.');
  return { url: r.result.url as string, path: r.result.path as string };
}

export async function accountInfo(ctx: ServiceContext) {
  const token = setting(ctx, 'TELEGRAPH_TOKEN');
  if (!token) throw new SetupRequiredError('Save a Telegraph access token first.');
  const data = await jsonFetch(
    ctx.http,
    'https://api.telegra.ph/getAccountInfo?fields=%5B%22short_name%22%2C%22author_name%22%2C%22page_count%22%5D',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: token }) },
    12_000,
  );
  if (!data.ok) throw new SetupRequiredError('Telegraph did not accept that access token.');
  return data.result;
}

/**
 * The meme pack gallery: a Telegraph page (opens inside Telegram as Instant View, no download or outside site)
 * with the memes one under another, then the project's links.
 */
export async function createGalleryPage(ctx: ServiceContext, page: { title: string; author: string; intro: string; images: string[]; links: PageLink[] }) {
  const links: Node[] = page.links.flatMap((l, i) => [...(i ? [' · '] : []), { tag: 'a', attrs: { href: l.href }, children: [l.label] }]);
  const content: Node[] = [
    { tag: 'p', children: [page.intro] },
    ...page.images.map((src) => ({ tag: 'figure', children: [{ tag: 'img', attrs: { src } }] })),
    ...(links.length ? [{ tag: 'h4', children: ['Links'] }, { tag: 'p', children: links }] : []),
  ];
  const r = await jsonFetch(ctx.http, 'https://api.telegra.ph/createPage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: telegraphToken(ctx), title: page.title, author_name: page.author, content, return_content: false }),
  });
  if (!r.ok || !r.result?.url) throw new UpstreamError('Telegraph did not return a page URL.');
  return { url: r.result.url as string, path: r.result.path as string };
}
