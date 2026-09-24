import type { ServiceContext } from './context.js';
import { loadOrder } from './orderService.js';

/** Only what the project would publish anyway: no order input, budgets, errors or private destinations. */
export function publicHub(ctx: ServiceContext, id: string) {
  const o = loadOrder(ctx, id);
  const p = o.project;
  return {
    id: o.id,
    demo: o.demo,
    project: {
      name: p.name,
      symbol: p.symbol,
      description: p.description,
      colour: p.colour,
      chain: p.chain,
      contract_address: p.contract_address,
      telegram_url: p.telegram_url,
      website_url: p.website_url,
      x_url: p.x_url,
    },
    copy: o.copy,
    assets: o.assets.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, name: a.name, url: `/projects/${o.id}/assets/${a.id}` })),
    publications: o.jobs
      .filter((j) => ['telegraph', 'binance', 'sticker_publish'].includes(j.kind) && j.status === 'delivered')
      .map((j) => ({ kind: j.kind, url: j.result ? JSON.parse(j.result).url ?? null : null })),
  };
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safeHref = (u: unknown) => (typeof u === 'string' && /^https:\/\//.test(u) ? esc(u) : null);

export function renderHub(h: ReturnType<typeof publicHub>): string {
  const p = h.project;
  const art = h.assets.find((a) => a.kind === 'campaign_image');
  const images = h.assets.filter((a) => a.mime.startsWith('image/') && a.kind !== 'campaign_image');
  const videos = h.assets.filter((a) => a.mime.startsWith('video/'));
  const links = [
    ['Telegram', p.telegram_url],
    ['Website', p.website_url],
    ['X', p.x_url],
    ...h.publications.map((x) => [x.kind === 'sticker_publish' ? 'Sticker pack' : x.kind === 'telegraph' ? 'Article' : 'Binance Square', x.url]),
  ]
    .map(([label, url]) => (safeHref(url) ? `<a href="${safeHref(url)}" rel="noopener">${esc(label)}</a>` : ''))
    .join('');
  const paragraphs = (h.copy?.article ?? '').split(/\n+/).filter(Boolean).map((s) => `<p>${esc(s)}</p>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} community kit</title>
<style>
:root{--accent:${/^#[0-9a-fA-F]{6}$/.test(p.colour) ? p.colour : '#fc6b35'};--bg:#fff;--fg:#141414;--muted:#666;--line:#e5e5e5}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--fg:#f2f2f2;--muted:#9a9a9a;--line:#2a2d31}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}.eyebrow{font-size:12px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
.cover{background:var(--accent);color:#fff;border-radius:16px;padding:28px;display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.cover h1{margin:4px 0 8px;font-size:clamp(28px,6vw,44px)}.cover img{width:120px;height:120px;border-radius:14px;object-fit:cover}
.ca{margin:20px 0;padding:14px;border:1px solid var(--line);border-radius:12px;font-family:ui-monospace,monospace;font-size:14px;overflow-wrap:anywhere}
nav{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}nav a{padding:8px 14px;border:1px solid var(--line);border-radius:999px;color:inherit;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.grid img,.grid video{width:100%;border-radius:10px;display:block}
h2{margin-top:36px}
</style></head><body><main>
<div class="eyebrow">${h.demo ? 'Demonstration' : 'Project announcement'} · community kit</div>
<section class="cover"><div><div class="eyebrow" style="color:inherit">${esc(p.chain)} / $${esc(p.symbol)}</div><h1>${esc(p.name)}</h1>
<p style="margin:0;max-width:560px">${esc(h.copy?.x_post ?? 'Content and community assets appear here as they are delivered.')}</p></div>
${art ? `<img src="${esc(art.url)}" alt="${esc(p.name)} campaign artwork">` : ''}</section>
<div class="ca"><div class="eyebrow">Contract address</div>${esc(p.contract_address)}</div>
<nav>${links}</nav>
${h.copy ? `<h2>${esc(h.copy.headline)}</h2>${paragraphs}` : ''}
${images.length ? `<h2>Memes &amp; stickers</h2><div class="grid">${images.map((a) => `<a href="${esc(a.url)}?download"><img src="${esc(a.url)}" alt="${esc(a.kind)}" loading="lazy"></a>`).join('')}</div>` : ''}
${videos.length ? `<h2>Trailers</h2><div class="grid">${videos.map((a) => `<video src="${esc(a.url)}" controls preload="metadata"></video>`).join('')}</div>` : ''}
</main></body></html>`;
}
