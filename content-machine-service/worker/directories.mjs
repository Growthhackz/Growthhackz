import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {browserContext, installCookieSession, NotPostedError, redditProxy} from './reddit.mjs';
import {firecrawlSite, openBrowser, sessionContext} from './firecrawl.mjs';

/** Directory sites. Paths are relative to each site's origin so tests can point at a local fake. */
export const SITES = {
  coinsniper: {origin: 'https://coinsniper.net', login: '/login', submit: '/submit', browse: ['/new', '/'], user: 'COINSNIPER_EMAIL', pass: 'COINSNIPER_PASSWORD'},
  coinvote: {origin: 'https://coinvote.cc', login: '/en/login', submit: '/en/add-coin/released', browse: ['/en/new', '/en/'], user: 'COINVOTE_EMAIL', pass: 'COINVOTE_PASSWORD'},
};

export const siteConfig = (site, env = process.env) => {
  const s = SITES[site]; if (!s) throw new Error(`Unknown site ${site}`);
  const origin = env[`${site.toUpperCase()}_BASE_URL`] || s.origin;
  // <SITE>_COOKIES: a cookie export from a browser logged in to the site; skips a login that needs a human check.
  const cookies = env[`${site.toUpperCase()}_COOKIES`];
  const domain = new RegExp(`(^|\\.)${new URL(origin).hostname.replace(/^www\./, '').replace(/\./g, '\\.')}$`);
  return {...s, site, origin, username: env[s.user], password: env[s.pass], cookies, cookieSite: {domain, isLogin: () => true, label: `${site} login cookies`}, statePath: resolve(env.DIRECTORY_STATE_DIR || '.', `${site}-session.json`), debugDir: env.DIRECTORY_DEBUG_DIR || null};
};

const CHAINS = {
  solana: /solana|\bsol\b/i, ethereum: /ethereum|\beth\b|erc-?20/i, bsc: /binance smart chain|bnb|\bbsc\b|bep-?20/i,
  base: /^\s*base\s*$|base chain|base network|\bbase\b/i, polygon: /polygon|matic/i, arbitrum: /arbitrum/i,
};

/** Maps one form control (described by its label/name/id/placeholder) to a listing value. Order matters. */
export function planField(f, listing) {
  const d = f.desc;
  if (['hidden', 'submit', 'button', 'password', 'search', 'reset', 'image'].includes(f.type)) return null;
  // Contact email: the account's own login email (never a made-up address).
  if (f.type === 'email' || /\be-?mail\b/.test(d)) return listing.contact_email ? {action: 'fill', value: listing.contact_email} : null;
  if (f.type === 'file') return {action: 'file'};
  if (f.type === 'checkbox') return /agree|terms|confirm|accept|rules/.test(d) ? {action: 'check'} : null;
  const rules = [
    [/discord|reddit|medium|github|youtube|instagram|tiktok|facebook|linkedin|coingecko|coinmarketcap|audit|kyc|whitepaper/, null],
    [/telegram|\btg\b/, listing.telegram_url],
    [/twitter|\bx\b|x\.com|x link|x url/, listing.x_url],
    [/contract|address|\bca\b|token id|mint/, listing.contract_address],
    [/symbol|ticker/, listing.symbol],
    [/chain|network|blockchain|platform/, {chain: listing.chain}],
    [/launch|release|listing date|\bdate\b/, {date: listing.launch_date}],
    [/description|about|details|summary|info/, f.tag === 'textarea' || f.maxLength === -1 || f.maxLength > 300 ? listing.description : listing.short_description],
    [/website|web ?site|homepage|\bweb\b|\burl\b|link/, listing.website_url],
    [/categor|\btags?\b|\btype\b/, {option: /meme/i}],
    [/presale|launched|\bstatus\b|stage/, {option: /launched|released|live|\bno\b/i}],
    [/decimals|supply|price|market ?cap|liquidity|hard ?cap|soft ?cap|username/, null],
    [/name|title/, listing.name],
  ];
  for (const [re, value] of rules) if (re.test(d)) return value == null ? null : {action: 'fill', value};
  return null;
}

/**
 * The coin submission form: the one asking for token details (contract, symbol, chain…), never a footer newsletter
 * or search form. Runs in the page.
 */
const PICK_LISTING_FORM = `window.pickListingForm = () => {
  const token = /contract|address|symbol|ticker|chain|network|blockchain|launch|coin ?name|token ?name|project ?name|logo/;
  const score = f => [...f.querySelectorAll('input,textarea,select')].filter(el => token.test([el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.closest('label')?.textContent, el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent].filter(Boolean).join(' ').toLowerCase())).length;
  return [...document.forms].map(f => [f, score(f)]).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};`;

export async function hasListingForm(page) {
  await page.evaluate(PICK_LISTING_FORM);
  return page.evaluate(() => !!window.pickListingForm());
}

/** Tags every control in the submit form with data-cm-idx and returns what it knows about each. */
async function describeForm(page) {
  await page.evaluate(PICK_LISTING_FORM);
  return page.evaluate(() => {
    const form = pickListingForm();
    if (!form) return [];
    document.querySelectorAll('[data-cm-form]').forEach(f => f.removeAttribute('data-cm-form'));
    form.setAttribute('data-cm-form', '1');
    return [...form.querySelectorAll('input,textarea,select')].map((el, i) => {
      el.setAttribute('data-cm-idx', String(i));
      const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || el.closest('label')?.textContent || el.getAttribute('aria-label') || el.parentElement?.querySelector('label,span,p')?.textContent || '';
      const r = el.getBoundingClientRect();
      return {
        idx: i, tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || el.tagName).toLowerCase(), name: el.name || '', required: el.required,
        visible: el.type === 'file' || (r.width > 0 && r.height > 0), maxLength: el.maxLength ?? -1, label: label.trim().replace(/\s+/g, ' ').slice(0, 80),
        desc: [label, el.name, el.id, el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase().replace(/[_-]/g, ' '),
        options: el.tagName === 'SELECT' ? [...el.options].map(o => ({value: o.value, text: o.textContent.trim()})) : undefined,
      };
    });
  });
}

async function applyField(page, f, plan, logoPath) {
  const el = page.locator(`[data-cm-idx="${f.idx}"]`);
  if (plan.action === 'file') { if (logoPath) await el.setInputFiles(logoPath); return !!logoPath; }
  if (plan.action === 'check') { await el.check(); return true; }
  const v = plan.value;
  if (f.tag === 'select') {
    const re = v?.chain ? CHAINS[v.chain] : v?.option ?? (typeof v === 'string' ? new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null);
    const opt = re && f.options.find(o => o.value && re.test(o.text));
    if (!opt) return false;
    await el.selectOption(opt.value); return true;
  }
  let text = v?.chain ?? v?.date ?? v;
  if (typeof text !== 'string' || !text) return false;
  if (v?.date && f.type === 'datetime-local') text = `${v.date}T12:00`;
  await el.fill(text); return true;
}

/**
 * DIRECTORY_PROXY (http://user:pass@host:port): listing sites block datacenter networks, so their traffic goes through it.
 * With Firecrawl the site's profile browser is used instead, opened on `path`; `save: false` for logged-out checks.
 */
async function launch(cfg, save = true, path = cfg.submit) {
  try { return await openBrowser(cfg.site, cfg.origin + path, {proxy: redditProxy(process.env.DIRECTORY_PROXY), save}); }
  catch (e) { throw new NotPostedError(`${cfg.site}: could not start the browser (${String(e?.message || e).split('\n')[0].slice(0, 160)}); nothing was sent.`); }
}

/** Cloudflare's full-page "Just a moment…" / "Performing security verification" interstitial. */
const cloudflareChallenge = async page => (await page.locator('#challenge-form').count().catch(() => 0)) > 0 || /performing security verification|just a moment/i.test(await page.title().catch(() => ''));

/** Waits for the interstitial to finish on its own (it usually does on a residential IP); true if it cleared. */
async function waitOutInterstitial(page, ms = 60000) {
  for (let t = 0; t < ms && (await cloudflareChallenge(page)); t += 2500) await page.waitForTimeout(2500);
  return !(await cloudflareChallenge(page));
}

/**
 * An in-form human check (Turnstile, hCaptcha, reCAPTCHA). Managed/invisible ones pass by themselves and fill their
 * response field; we wait for that. Returns true when one is still unanswered, which needs a person: never clicked for them.
 */
async function humanCheckPending(page, ms = 30000) {
  const widgets = 'iframe[src*="hcaptcha.com"]:visible, iframe[src*="challenges.cloudflare.com"]:visible, iframe[src*="recaptcha"]:visible, .cf-turnstile, .h-captcha, .g-recaptcha';
  const answered = () => page.evaluate(() => [...document.querySelectorAll('[name="cf-turnstile-response"],[name="h-captcha-response"],[name="g-recaptcha-response"]')].some(e => e.value));
  if (!(await page.locator(widgets).count().catch(() => 0))) return false;
  for (let t = 0; t < ms; t += 2000) { if (await answered().catch(() => false)) return false; await page.waitForTimeout(2000); }
  return !(await answered().catch(() => false));
}

/** Cookie banners, notices and modals: their accept/close buttons only (never anything inside a check's frame). */
async function dismissPopups(page) {
  const buttons = page.locator([
    '#onetrust-accept-btn-handler', '.cc-window .cc-btn', '.cc-banner .cc-btn', '[id*="cookie" i] button', '[class*="cookie" i] button',
    '.modal.show button', '[role="dialog"]:visible button', '[aria-modal="true"] button',
  ].join(', '));
  const n = Math.min(await buttons.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const text = ((await b.innerText().catch(() => '')) || (await b.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (/^(accept( all)?( cookies)?|allow( all)?|i agree|agree|got it|ok(ay)?|close|dismiss|continue|×|x)$/i.test(text) && (await b.isVisible().catch(() => false)))
      await b.click({timeout: 3000}).catch(() => {});
  }
}

/** Everything up to the filled form sends nothing, so any failure here is NotPostedError (safe to retry). */
async function openSubmitForm(browser, cfg) {
  try {
    return await openSubmitFormUnsafe(browser, cfg);
  } catch (e) {
    if (e instanceof NotPostedError) throw e;
    throw new NotPostedError(`${cfg.site}: could not open the submit form (${String(e?.message || e).split('\n')[0].slice(0, 160)}); nothing was sent.`);
  }
}

async function openSubmitFormUnsafe(browser, cfg) {
  if (cfg.cookies) {
    try { installCookieSession(cfg.statePath, cfg.cookies, cfg.cookieSite); } catch (e) { throw new NotPostedError(`${cfg.site.toUpperCase()}_COOKIES: ${e.message}`); }
  }
  if (!existsSync(cfg.statePath) && (!cfg.username || !cfg.password) && !browser.firecrawl) throw new NotPostedError(`Set ${cfg.site.toUpperCase()}_COOKIES (or ${cfg.user} and ${cfg.pass}) on the worker.`);
  const context = await sessionContext(browser, cfg.statePath, browserContext());
  const submitUrl = cfg.origin + cfg.submit;
  // A Firecrawl session starts on the submit page: use that tab rather than loading it again.
  const opened = browser.firecrawl?.page?.url().startsWith(submitUrl) ? browser.firecrawl.page : null;
  const page = opened ?? await context.newPage();
  // Only the real coin form counts: a footer newsletter form on a login or error page must not look like success.
  const onForm = async () => !page.url().includes(cfg.login) && !(await page.locator('input[type="password"]').count()) && (await hasListingForm(page));
  const clearChallenge = async where => {
    if (!(await waitOutInterstitial(page))) { await debugSnapshot(page, cfg, 'cloudflare'); throw new NotPostedError(`${cfg.site}: Cloudflare's security check did not clear on the ${where} page; nothing was sent.`); }
    await dismissPopups(page);
  };
  const where = async () => `${page.url().split('?')[0]} "${(await page.title().catch(() => '')).slice(0, 60)}"`;
  if (!opened) await page.goto(submitUrl, {waitUntil: 'domcontentloaded'});
  await clearChallenge('submit');
  if (!(await onForm())) {
    if (browser.firecrawl && (!cfg.username || !cfg.password)) throw new NotPostedError(`${cfg.site}: not logged in; run \`node login.mjs ${cfg.site}\` to log in to the Firecrawl profile.`);
    await page.goto(cfg.origin + cfg.login, {waitUntil: 'domcontentloaded'});
    await clearChallenge('login');
    if (!(await page.locator('input[type="password"]').count())) throw new NotPostedError(`${cfg.site}: neither the submit form nor a login form loaded (${await where()}); nothing was sent.`);
    if (!cfg.username || !cfg.password) throw new NotPostedError(browser.firecrawl ? `${cfg.site}: not logged in; run \`node login.mjs ${cfg.site}\` to log in to the Firecrawl profile.` : `${cfg.site}: the saved session has expired; refresh ${cfg.site.toUpperCase()}_COOKIES.`);
    await page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[name*="login" i]').first().fill(cfg.username);
    await page.locator('input[type="password"]').first().fill(cfg.password);
    const loginButton = page.locator('form:has(input[type="password"]) [type="submit"], form:has(input[type="password"]) button').first();
    await page.waitForTimeout(1500);
    // A login button that stays disabled is waiting on a human check (captcha), which is never bypassed.
    if (await loginButton.isDisabled().catch(() => false))
      throw new NotPostedError(`${cfg.site}: the login needs a human check (captcha); ${browser.firecrawl ? `log in by hand with \`node login.mjs ${cfg.site}\`` : `set ${cfg.site.toUpperCase()}_COOKIES from a logged-in browser`}.`);
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), loginButton.click({timeout: 15000})]);
    await page.waitForTimeout(1500);
    await page.goto(submitUrl, {waitUntil: 'domcontentloaded'});
    await clearChallenge('submit');
    if (!(await onForm())) throw new NotPostedError(`${cfg.site}: login failed or the submit form is not reachable (${await where()}).`);
    await context.storageState({path: cfg.statePath});
  }
  return {context, page};
}

async function debugSnapshot(page, cfg, tag) {
  if (!cfg.debugDir) return;
  await mkdir(cfg.debugDir, {recursive: true});
  const base = join(cfg.debugDir, `${cfg.site}-${tag}-${Date.now()}`);
  await page.screenshot({path: base + '.png', fullPage: true}).catch(() => {});
  await writeFile(base + '.html', await page.content()).catch(() => {});
}

/**
 * Logs in, fills the submit form from `listing`, and submits.
 * Returns {submitted: true, url} (url when the site redirects to the coin page) or {submitted: false} when the outcome is unclear.
 * Throws NotPostedError when nothing was sent (login, unmapped required fields, validation errors).
 */
export async function submitListing(site, listing, logoPath, cfg = siteConfig(site)) {
  const browser = await launch(cfg);
  try {
    const {page} = await openSubmitForm(browser, cfg);
    const visibleNames = async () => (await describeForm(page)).filter(f => f.visible).map(f => f.name || f.idx).join('|');
    // Multi-step forms: fill what each step shows, go on with its Next/Submit, until the site answers.
    for (let step = 1; step <= 6; step++) {
      await dismissPopups(page);
      const fields = await describeForm(page);
      const missing = [];
      for (const f of fields.filter(f => f.visible)) {
        const plan = planField(f, {...listing, contact_email: cfg.username});
        const ok = plan ? await applyField(page, f, plan, logoPath) : false;
        if (!ok && f.required) missing.push(f.label || f.name || `#${f.idx}`);
      }
      if (missing.length) { await debugSnapshot(page, cfg, 'unfilled'); throw new NotPostedError(`${site}: step ${step}: could not fill required fields: ${missing.join(', ')}`); }
      if (await humanCheckPending(page)) { await debugSnapshot(page, cfg, 'check'); throw new NotPostedError(`${site}: step ${step} has a human check that needs a click; the listing was not sent.`); }
      const before = page.url();
      const shape = await visibleNames();
      const button = page.locator('form[data-cm-form] [type="submit"]:visible, form[data-cm-form] button:not([type="button"]):visible, form[data-cm-form] button:visible:has-text("Next"), form[data-cm-form] button:visible:has-text("Continue")').last();
      if (!(await button.count())) { await debugSnapshot(page, cfg, 'nosubmit'); throw new NotPostedError(`${site}: step ${step} has no submit or next button; nothing was sent.`); }
      // A click that never happens (timeout) sent nothing; from a completed click on, the listing may have been sent.
      await button.click({trial: true, timeout: 15000}).catch(async e => { await debugSnapshot(page, cfg, 'unclickable'); throw new NotPostedError(`${site}: step ${step} button not clickable (${String(e.message).split('\n')[0].slice(0, 120)}); nothing was sent.`); });
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), button.click()]);
      await page.waitForTimeout(2500);
      // Cloudflare may hold the step behind its check. On a residential IP it usually clears by itself; it's never
      // solved for it. While the check stands, the request hasn't reached the site.
      if (!(await waitOutInterstitial(page))) { await debugSnapshot(page, cfg, 'cloudflare'); throw new NotPostedError(`${site}: Cloudflare's security check did not clear after step ${step}, so the listing was not sent.`); }
      await dismissPopups(page);
      const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      const errors = (await page.locator('.error:visible, .alert-danger:visible, .invalid-feedback:visible, [role="alert"]:visible, .text-danger:visible').allInnerTexts().catch(() => [])).join(' ').trim();
      if (/already (been )?(listed|exists|submitted|added)/.test(text + ' ' + errors.toLowerCase())) return {submitted: true, url: null, note: 'already listed'};
      const url = page.url();
      if (/\/coins?\//i.test(new URL(url).pathname)) return {submitted: true, url};
      const moreForm = await hasListingForm(page);
      if (moreForm && !errors && (url !== before || (await visibleNames()) !== shape)) continue;
      if (!moreForm && /success|submitted|thank|pending|review|received|has been added/.test(text) && !errors) return {submitted: true, url: null};
      if (errors) { await debugSnapshot(page, cfg, 'rejected'); throw new NotPostedError(`${site} rejected step ${step}: ${errors.slice(0, 200)}`); }
      break;
    }
    await debugSnapshot(page, cfg, 'unclear');
    return {submitted: false};
  } finally { await browser.close(); }
}

/** Logged-out look for the live coin page: the known URL first, else the site's new-coins pages. */
export async function checkListing(site, listing, submission = {}, cfg = siteConfig(site)) {
  const browser = await launch(cfg, false, '/');
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const isOurs = async () => (await page.content()).toLowerCase().includes(listing.contract_address.toLowerCase());
    if (submission.url) { const r = await page.goto(submission.url, {waitUntil: 'domcontentloaded'}).catch(() => null); if (r?.ok() && await isOurs()) return {live: true, url: page.url()}; }
    for (const path of cfg.browse) {
      await page.goto(cfg.origin + path, {waitUntil: 'domcontentloaded'}).catch(() => {});
      const hrefs = await page.locator('a[href*="/coin"]').evaluateAll((as, n) => as.filter(a => a.textContent.toLowerCase().includes(n)).map(a => a.href), listing.name.toLowerCase());
      for (const href of [...new Set(hrefs)].slice(0, 5)) {
        const r = await page.goto(href, {waitUntil: 'domcontentloaded'}).catch(() => null);
        if (r?.ok() && await isOurs()) return {live: true, url: page.url()};
      }
    }
    return {live: false};
  } finally { await browser.close(); }
}

/** Dry run: opens the form, prints each field and what would go in it. Never submits. */
export async function inspect(site, cfg = siteConfig(site)) {
  const sample = {name: 'Sample Token', symbol: 'SMPL', chain: 'solana', contract_address: 'So11111111111111111111111111111111111111112', description: 'Sample description', short_description: 'Sample', website_url: 'https://example.com', telegram_url: 'https://t.me/example', x_url: 'https://x.com/example', launch_date: '2026-01-01'};
  const browser = await launch(cfg, false);
  try {
    const {page} = await openSubmitForm(browser, cfg);
    const fields = await describeForm(page);
    await debugSnapshot(page, {...cfg, debugDir: cfg.debugDir || '.'}, 'inspect');
    return fields.map(f => ({label: f.label, name: f.name, type: f.type, required: f.required, visible: f.visible, options: f.options?.map(o => o.text).slice(0, 12), plan: planField(f, sample)}));
  } finally { await browser.close(); }
}

async function logoFile(client, listing) {
  const dir = await mkdtemp(join(tmpdir(), 'cm-logo-'));
  let bytes = null;
  if (listing.logo_url) { const r = await fetch(listing.logo_url, {signal: AbortSignal.timeout(15000)}).catch(() => null); if (r?.ok) bytes = Buffer.from(await r.arrayBuffer()); }
  if (!bytes && listing.image_asset_url) bytes = await client.asset(listing.image_asset_url);
  if (!bytes) return {dir, path: null};
  const path = join(dir, 'logo.png'); await writeFile(path, bytes); return {dir, path};
}

/** One cycle: submit one due listing, then check one listing that is waiting for review. */
export async function directoryCycle(client, {submit = submitListing, check = checkListing, env = process.env} = {}) {
  const sites = Object.keys(SITES).filter(s => env[`${s.toUpperCase()}_COOKIES`] || (env[SITES[s].user] && env[SITES[s].pass]) || firecrawlSite(s, env));
  if (!sites.length) return;
  const c = await client.request('publish/claim', {kinds: sites});
  if (c) {
    const logo = await logoFile(client, c.target.listing);
    try {
      const r = await submit(c.job.kind, c.target.listing, logo.path);
      await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, submitted: r.submitted, url: r.url ?? null});
    } catch (e) {
      if (e instanceof NotPostedError) { console.error(`${c.job.kind} (${c.job.order_id}) not posted: ${e.message}`); await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message}); }
      else {
        console.error(`${c.job.kind} (${c.job.order_id}): ${e?.message || e}`);
        await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null, note: String(e?.message || e).slice(0, 300)});
      }
    } finally { await rm(logo.dir, {recursive: true, force: true}); }
  }
  const due = await client.request('listings/check-claim', {kinds: sites});
  if (due && sites.includes(due.job.kind)) {
    const r = await check(due.job.kind, due.target.listing, due.submission).catch(() => ({live: false}));
    await client.request(`listings/${due.job.id}/checked`, r);
  }
}

// CLI: node directories.mjs inspect coinsniper|coinvote
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === 'inspect') {
  console.log(JSON.stringify(await inspect(process.argv[3]), null, 2));
}
