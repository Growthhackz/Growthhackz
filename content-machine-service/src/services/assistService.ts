import { randomBytes } from 'node:crypto';
import { all, get, run } from '../db/database.js';
import { DIRECTORY_HOSTS, REDDIT_SUBREDDITS, SOURCE_LABELS } from '../domain/schemas.js';
import { ConflictError, NotFoundError, SetupRequiredError, ValidationError } from '../lib/errors.js';
import { telegram } from '../providers/telegram.js';
import { nowMs, publicAssetUrl, type ServiceContext } from './context.js';
import { publishTarget, reconcile } from './engine.js';
import { loadOrder, recordEvent, type JobRow, type Order } from './orderService.js';
import { setting } from './settingsService.js';

/**
 * Posts handed to a person (ASSIST_KINDS): sites whose human check we never pass for them. The operator gets one
 * Telegram DM per order linking to a private page where each post opens on the site already filled in; they pass
 * the check, submit, and paste the link back, which delivers it like any other publication.
 */

const HANDABLE = [...Object.keys(REDDIT_SUBREDDITS), 'coinsniper', 'coinvote'];
const SUBMIT_PAGES: Record<string, string> = {
  coinsniper: 'https://coinsniper.net/submit',
  coinvote: 'https://coinvote.cc/en/add-coin/released',
};
/** What each subreddit asks of a post, shown on its card. */
const SUBREDDIT_NOTES: Record<string, string> = {
  Solana_Memes: 'Pick a flair before posting. One launch post per coin per week.',
  SolCoins: 'One post per project per day.',
  memecoins: 'At most two posts per coin per day.',
};
const TOKEN_TTL_MS = 7 * 24 * 3_600_000;
const RESEND_MS = 5 * 60_000;
const WAITING = 'Waiting on you: open the posting link in your Telegram DM, submit, and paste the link back.';

interface AssistRow {
  order_id: string;
  token: string;
  created_at: number;
  sent_at: number | null;
}

/** ASSIST_KINDS as item kinds; `reddit` stands for every subreddit. */
export function assistKinds(ctx: ServiceContext): string[] {
  const listed = ctx.config.ASSIST_KINDS.split(',').map((s) => s.trim()).filter(Boolean);
  return HANDABLE.filter((k) => listed.includes(k) || (REDDIT_SUBREDDITS[k] && listed.includes('reddit')));
}

const label = (kind: string) => SOURCE_LABELS[kind] ?? kind;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pageUrl = (ctx: ServiceContext, token: string) => `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/assist/${token}`;
const ready = (o: Order) => !o.demo && !!o.copy && o.assets.some((a) => a.kind === 'campaign_image');
const inList = (kinds: string[]) => kinds.map((k) => `'${k}'`).join(', ');

/** Each tick: hands newly ready posts over (blocked, waiting on the person) and sends any DM not yet delivered. */
export async function sendAssists(ctx: ServiceContext): Promise<number> {
  const kinds = assistKinds(ctx);
  if (!kinds.length) return 0;
  const t = nowMs(ctx);
  const handed = new Set<string>();
  for (const j of all<JobRow>(ctx.db, `SELECT * FROM jobs WHERE status = 'queued' AND kind IN (${inList(kinds)})`)) {
    if (!ready(loadOrder(ctx, j.order_id))) continue;
    const r = run(ctx.db, "UPDATE jobs SET status = 'blocked', error = :e, updated_at = :t WHERE id = :id AND status = 'queued'", { e: WAITING, t, id: j.id });
    if (!r.changes) continue;
    recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'blocked', error: WAITING });
    handed.add(j.order_id);
  }
  for (const id of handed)
    run(ctx.db, 'INSERT OR IGNORE INTO assists (order_id, token, created_at) VALUES (:id, :token, :t)', { id, token: randomBytes(24).toString('base64url'), t });

  let sent = 0;
  const due = all<AssistRow>(ctx.db, 'SELECT * FROM assists WHERE sent_at IS NULL AND (attempted_at IS NULL OR attempted_at <= :a) LIMIT 5', { a: t - RESEND_MS });
  for (const a of due) {
    run(ctx.db, 'UPDATE assists SET attempted_at = :t WHERE order_id = :id', { t, id: a.order_id });
    try {
      await sendDm(ctx, a);
      run(ctx.db, 'UPDATE assists SET sent_at = :t, error = NULL WHERE order_id = :id', { t: nowMs(ctx), id: a.order_id });
      sent++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      run(ctx.db, 'UPDATE assists SET error = :e WHERE order_id = :id', { e: error.slice(0, 300), id: a.order_id });
      ctx.log.warn({ order_id: a.order_id, err: error }, 'posting link DM not sent; retrying in 5 minutes');
    }
  }
  return sent;
}

async function sendDm(ctx: ServiceContext, a: AssistRow) {
  const chat = setting(ctx, 'ASSIST_CHAT_ID') || setting(ctx, 'STICKER_OWNER_ID');
  if (!chat) throw new SetupRequiredError('Set ASSIST_CHAT_ID (the Telegram user ID that gets posting links; they must start the bot).');
  const o = loadOrder(ctx, a.order_id);
  const items = o.jobs.filter((j) => assistKinds(ctx).includes(j.kind) && j.status !== 'skipped');
  const p = o.project;
  const text = [
    `🛠 <b>${esc(p.name)}${p.symbol ? ` ($${esc(p.symbol)})` : ''}</b> is ready to post`,
    items.map((j) => `• ${esc(label(j.kind))}`).join('\n'),
    'Open the page and tap each one: it opens on the site already filled in. Pass the check, submit, then paste the link back on the page.',
    ...((p as { test?: boolean }).test ? ['<i>Test order: nothing goes to the buyer.</i>'] : []),
  ].join('\n\n');
  await telegram(ctx, 'sendMessage', {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: 'Open posting page', url: pageUrl(ctx, a.token) }]] },
  });
}

function loadAssist(ctx: ServiceContext, token: string): AssistRow {
  const a = get<AssistRow>(ctx.db, 'SELECT * FROM assists WHERE token = :token', { token });
  if (!a || nowMs(ctx) - a.created_at > TOKEN_TTL_MS) throw new NotFoundError('Posting page');
  return a;
}

const jobResult = (j: JobRow) => (j.result ? (JSON.parse(j.result) as { url?: string | null }) : {});

/** Reddit's own pre-filled submit links (new and old Reddit); the image goes as a link, not inline markdown. */
function redditLinks(sub: string, title: string, text: string) {
  const body = text.replace(/^!\[[^\]]*\]\([^)]*\)\s*/, '');
  const q = (extra: string) => `${extra}title=${encodeURIComponent(title)}&text=${encodeURIComponent(body)}`;
  return { body, open: `https://www.reddit.com/r/${sub}/submit?${q('type=TEXT&')}`, old: `https://old.reddit.com/r/${sub}/submit?${q('selftext=true&')}` };
}

/** Fills a listing form in the visitor's own browser: fields matched by their label, name or placeholder. */
function autofillBookmarklet(data: Record<string, unknown>): string {
  const code = `(d=>{const lab=e=>{const t=[e.name,e.id,e.placeholder,e.getAttribute('aria-label')];if(e.id){const l=document.querySelector('label[for="'+CSS.escape(e.id)+'"]');if(l)t.push(l.textContent)}let p=e.parentElement;for(let i=0;i<3&&p;i++,p=p.parentElement){const l=p.querySelector('label');if(l){t.push(l.textContent);break}}return t.filter(Boolean).join(' ').toLowerCase()};const set=(e,v)=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};const R=[[/contract|token address|\\bca\\b/,'contract_address'],[/symbol|ticker/,'symbol'],[/telegram/,'telegram_url'],[/twitter|\\bx\\b/,'x_url'],[/website|homepage/,'website_url'],[/launch|date/,'launch_date'],[/short|tagline|summary|slogan/,'short_description'],[/descr|about/,'description'],[/name/,'name']];let n=0;document.querySelectorAll('input,textarea,select').forEach(e=>{if(e.offsetParent===null||e.disabled||e.readOnly||['hidden','password','file','checkbox','radio','submit','button','email'].includes(e.type))return;const l=lab(e);if(e.tagName==='SELECT'){if(/chain|network|blockchain|platform/.test(l)){const o=[...e.options].find(o=>o.text.toLowerCase().includes(d.chain));if(o){e.value=o.value;e.dispatchEvent(new Event('change',{bubbles:true}));n++}}return}for(const[r,k]of R){if(r.test(l)&&d[k]){if(!e.value){set(e,k==='launch_date'&&e.type==='datetime-local'?d[k]+'T12:00':d[k]);n++}break}}});alert('Filled '+n+' fields. Check them, add the logo, pass the check and submit.')})(${JSON.stringify(data)})`;
  return 'javascript:' + encodeURIComponent(code);
}

export function assistView(ctx: ServiceContext, token: string) {
  const a = loadAssist(ctx, token);
  const o = loadOrder(ctx, a.order_id);
  const kinds = assistKinds(ctx);
  const image = o.assets.find((x) => x.kind === 'campaign_image');
  const items = o.copy
    ? o.jobs
        .filter((j) => kinds.includes(j.kind) && j.status !== 'skipped')
        .map((j) => ({ id: j.id, kind: j.kind, label: label(j.kind), status: j.status, url: jobResult(j).url ?? null, target: publishTarget(ctx, j.kind, o) as any }))
    : [];
  return { order: o, items, image_url: image ? publicAssetUrl(ctx, o.id, image.id) : null };
}

/** The person pasted the post or listing link (or says the listing went in without one). */
export async function assistDone(ctx: ServiceContext, token: string, body: unknown) {
  const a = loadAssist(ctx, token);
  const { kind, url, submitted } = (body ?? {}) as { kind?: unknown; url?: unknown; submitted?: unknown };
  const j = typeof kind === 'string' && assistKinds(ctx).includes(kind)
    ? get<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE order_id = :o AND kind = :k', { o: a.order_id, k: kind })
    : undefined;
  if (!j || j.status === 'skipped') throw new NotFoundError('Post');
  if (j.status === 'delivered') return { status: 'delivered', url: jobResult(j).url ?? null };
  if (typeof url === 'string' && url.trim()) {
    const order = await reconcile(ctx, j.id, url.trim());
    return { status: 'delivered', url: (order.jobs.find((x: { kind: string }) => x.kind === j.kind) as any)?.result?.url ?? null };
  }
  if (submitted === true && DIRECTORY_HOSTS[j.kind]) {
    if (!['blocked', 'uncertain', 'failed'].includes(j.status)) throw new ConflictError('This listing is already waiting for review');
    // The worker's listing check finds the coin page once the site approves it.
    const result = { submitted_at: new Date(nowMs(ctx)).toISOString(), url: null, via: 'assist' };
    run(ctx.db, "UPDATE jobs SET status = 'submitted', result = :r, error = NULL, available_at = :a, updated_at = :t WHERE id = :id", {
      r: result,
      a: nowMs(ctx) + 30 * 60_000,
      t: nowMs(ctx),
      id: j.id,
    });
    recordEvent(ctx, j.order_id, 'delivery.updated', { job_id: j.id, kind: j.kind, status: 'submitted', result });
    return { status: 'submitted', url: null };
  }
  throw new ValidationError('Paste the link to the post or listing');
}

export function renderAssist(view: ReturnType<typeof assistView>): string {
  const p = view.order.project;
  const copyRow = (name: string, value: unknown, long = false) =>
    value
      ? `<div class="f"><div class="fl">${esc(name)}</div><${long ? 'textarea rows="5"' : 'input'} readonly ${long ? '' : `value="${esc(value)}"`}>${long ? esc(value) + '</textarea>' : ''}<button type="button" class="cp">Copy</button></div>`
      : '';
  const doneForm = (kind: string, directory: boolean) => `
    <form class="done" data-kind="${esc(kind)}">
      <input name="url" type="url" placeholder="${directory ? 'Paste the coin page link' : 'Paste the post link'}" autocomplete="off">
      <button type="submit">Save link</button>
      ${directory ? '<button type="button" class="nolink">Submitted, no link yet</button>' : ''}
      <div class="msg"></div>
    </form>`;
  const cards = view.items
    .map((it) => {
      const state =
        it.status === 'delivered'
          ? `<div class="ok">✅ Done: <a href="${esc(it.url)}" target="_blank" rel="noreferrer">${esc(it.url)}</a></div>`
          : it.status === 'submitted'
            ? '<div class="ok">⏳ Submitted; the link arrives once the site approves it.</div>'
            : '';
      if (REDDIT_SUBREDDITS[it.kind]) {
        const t = it.target as { subreddit: string; title: string; text: string };
        const r = redditLinks(t.subreddit, t.title, t.text);
        const note = SUBREDDIT_NOTES[t.subreddit];
        return `<section><h2>${esc(it.label)}</h2>${state}${note ? `<p class="hint">${esc(note)}</p>` : ''}
          <a class="go" href="${esc(r.open)}" target="_blank" rel="noreferrer">Open r/${esc(t.subreddit)} with the post filled in</a>
          <a class="alt" href="${esc(r.old)}" target="_blank" rel="noreferrer">Or open it on old Reddit</a>
          <details><summary>Title and text to copy</summary>${copyRow('Title', t.title)}${copyRow('Text', r.body, true)}</details>
          ${it.status === 'delivered' ? '' : doneForm(it.kind, false)}</section>`;
      }
      const l = (it.target as { listing: Record<string, string | null> }).listing;
      const logo = l.logo_url || view.image_url;
      const fill = { ...l, chain: String(l.chain ?? '').toLowerCase() };
      return `<section><h2>${esc(it.label)}</h2>${state}
        <a class="go" href="${esc(SUBMIT_PAGES[it.kind])}" target="_blank" rel="noreferrer">Open the ${esc(it.label.replace(/ listing$/, ''))} submit page</a>
        <p class="hint">On a computer: drag <a class="bm" href="${esc(autofillBookmarklet(fill))}">⚡ Fill ${esc(p.symbol || p.name)}</a> to your bookmarks bar once, open the submit page, click it and the form fills in. On a phone: use the copy buttons.</p>
        <details><summary>Fields to copy</summary>
          ${copyRow('Name', l.name)}${copyRow('Symbol', l.symbol)}${copyRow('Chain', l.chain)}${copyRow('Contract address', l.contract_address)}
          ${copyRow('Short description', l.short_description, true)}${copyRow('Description', l.description, true)}
          ${copyRow('Website', l.website_url)}${copyRow('Telegram', l.telegram_url)}${copyRow('X', l.x_url)}${copyRow('Launch date', l.launch_date)}
          ${logo ? `<div class="f"><div class="fl">Logo</div><a href="${esc(logo)}" target="_blank" rel="noreferrer">Open the logo image</a> (save it, then upload)</div>` : ''}
        </details>
        ${it.status === 'delivered' || it.status === 'submitted' ? '' : doneForm(it.kind, true)}</section>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Post ${esc(p.symbol || p.name)}</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#1b1b1b;--mute:#666;--line:#e3e3df;--acc:#fc6b35}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--ink:#eee;--mute:#9a9a9a;--line:#333}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0 4px}h2{font-size:18px;margin:0 0 10px}
.sub{color:var(--mute);margin:0 0 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 14px}
a{color:var(--acc)}a.go{display:block;text-align:center;background:var(--acc);color:#fff;text-decoration:none;font-weight:600;padding:12px;border-radius:10px}
a.alt{display:block;text-align:center;font-size:14px;margin:8px 0}
.hint{font-size:14px;color:var(--mute)}a.bm{background:var(--bg);border:1px dashed var(--acc);padding:2px 8px;border-radius:6px;text-decoration:none}
details{margin:10px 0}summary{cursor:pointer;font-weight:600}
.f{margin:10px 0}.fl{font-size:13px;color:var(--mute)}
.f input,.f textarea,.done input{box-sizing:border-box;width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);margin-top:6px;cursor:pointer}
.done{border-top:1px solid var(--line);margin-top:12px;padding-top:12px}.done button[type=submit]{background:var(--ink);color:var(--bg)}
.ok{margin:0 0 10px;word-break:break-all}.msg{font-size:14px;margin-top:6px}
</style></head><body><main>
<h1>${esc(p.name)}${p.symbol ? ` ($${esc(p.symbol)})` : ''}</h1>
<p class="sub">Tap a site, pass its check, submit, then paste the link back here.</p>
${cards || '<section>Nothing to post right now.</section>'}
</main><script>
document.querySelectorAll('.cp').forEach(b=>b.onclick=()=>{const f=b.previousElementSibling;navigator.clipboard.writeText(f.value).then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200)},()=>{f.select();document.execCommand('copy')})});
async function send(form,payload){const m=form.querySelector('.msg');m.textContent='Saving…';try{const r=await fetch(location.pathname+'/done',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok)throw new Error(j.error&&j.error.message||'Could not save');m.textContent=j.status==='delivered'?'✅ Saved and delivered.':'✅ Saved. The link arrives once the site approves the listing.';form.querySelectorAll('button,input').forEach(e=>e.disabled=true)}catch(e){m.textContent='⚠️ '+e.message}}
document.querySelectorAll('form.done').forEach(f=>{f.onsubmit=e=>{e.preventDefault();send(f,{kind:f.dataset.kind,url:f.url.value.trim()})};const n=f.querySelector('.nolink');if(n)n.onclick=()=>send(f,{kind:f.dataset.kind,submitted:true})});
</script></body></html>`;
}
