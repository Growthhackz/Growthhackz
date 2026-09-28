import { SetupRequiredError, UpstreamError } from '../lib/errors.js';
import { jsonFetch } from '../lib/http.js';
import type { ServiceContext } from '../services/context.js';
import { setting } from '../services/settingsService.js';

export function telegraphToken(ctx: ServiceContext): string {
  const token = setting(ctx, 'TELEGRAPH_TOKEN');
  if (!token) throw new SetupRequiredError('Connect a Telegraph access token.');
  return token;
}

export async function createPage(
  ctx: ServiceContext,
  page: { title: string; author: string; paragraphs: string[]; telegramUrl: string; imageUrl: string },
) {
  const content = [
    { tag: 'figure', children: [{ tag: 'img', attrs: { src: page.imageUrl } }] },
    { tag: 'p', children: ['Project announcement supplied by the project.'] },
    ...page.paragraphs.map((s) => ({ tag: 'p', children: [s] })),
    { tag: 'p', children: [{ tag: 'a', attrs: { href: page.telegramUrl }, children: ['Official Telegram'] }] },
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
