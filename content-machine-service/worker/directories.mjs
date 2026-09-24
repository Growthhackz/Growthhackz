import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {NotPostedError} from './reddit.mjs';

/** Directory sites. Paths are relative to each site's origin so tests can point at a local fake. */
export const SITES = {
  coinsniper: {origin: 'https://coinsniper.net', login: '/login', submit: '/submit', browse: ['/new', '/'], user: 'COINSNIPER_EMAIL', pass: 'COINSNIPER_PASSWORD'},
  coinvote: {origin: 'https://coinvote.cc', login: '/en/login', submit: '/en/add-coin/released', browse: ['/en/new', '/en/'], user: 'COINVOTE_EMAIL', pass: 'COINVOTE_PASSWORD'},
};

export const siteConfig = (site, env = process.env) => {
  const s = SITES[site]; if (!s) throw new Error(`Unknown site ${site}`);
  const origin = env[`${site.toUpperCase()}_BASE_URL`] || s.origin;
  return {...s, site, origin, username: env[s.user], password: env[s.pass], statePath: resolve(env.DIRECTORY_STATE_DIR || '.', `${site}-session.json`), debugDir: env.DIRECTORY_DEBUG_DIR || null};
};

const CHAINS = {
  solana: /solana|\bsol\b/i, ethereum: /ethereum|\beth\b|erc-?20/i, bsc: /binance smart chain|bnb|\bbsc\b|bep-?20/i,
  base: /^\s*base\s*$|base chain|base network|\bbase\b/i, polygon: /polygon|matic/i, arbitrum: /arbitrum/i,
};

/** Maps one form control (described by its label/name/id/placeholder) to a listing value. Order matters. */
export function planField(f, listing) {
  const d = f.desc;
  if (['hidden', 'submit', 'button', 'password', 'email', 'search', 'reset', 'image'].includes(f.type)) return null;
  if (f.type === 'file') return {action: 'file'};
  if (f.type === 'checkbox') return /agree|terms|confirm|accept|rules/.test(d) ? {action: 'check'} : null;
  const rules = [
    [/discord|reddit|medium|github|youtube|instagram|tiktok|facebook|linkedin|coingecko|coinmarketcap|audit|kyc|whitepaper|email|e-mail/, null],
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

/** Tags every control in the submit form with data-cm-idx and returns what it knows about each. */
async function describeForm(page) {
  return page.evaluate(() => {
    const forms = [...document.forms].filter(f => f.querySelector('input,textarea,select'));
    const form = forms.sort((a, b) => b.querySelectorAll('input,textarea,select').length - a.querySelectorAll('input,textarea,select').length)[0];
    if (!form) return [];
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

async function launch() { return chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined}); }

async function openSubmitForm(browser, cfg) {
  if (!cfg.username || !cfg.password) throw new NotPostedError(`Set ${cfg.user} and ${cfg.pass} on the worker.`);
  const context = await browser.newContext(existsSync(cfg.statePath) ? {storageState: cfg.statePath} : {});
  const page = await context.newPage();
  const submitUrl = cfg.origin + cfg.submit;
  const onForm = async () => !page.url().includes(cfg.login) && !(await page.locator('input[type="password"]').count()) && (await page.locator('form textarea, form input[type="text"], form select').count()) > 0;
  await page.goto(submitUrl, {waitUntil: 'domcontentloaded'});
  if (!(await onForm())) {
    await page.goto(cfg.origin + cfg.login, {waitUntil: 'domcontentloaded'});
    await page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[name*="login" i]').first().fill(cfg.username);
    await page.locator('input[type="password"]').first().fill(cfg.password);
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.locator('form:has(input[type="password"]) [type="submit"], form:has(input[type="password"]) button').first().click()]);
    await page.waitForTimeout(1500);
    await page.goto(submitUrl, {waitUntil: 'domcontentloaded'});
    if (!(await onForm())) throw new NotPostedError(`${cfg.site}: login failed or the submit form is not reachable.`);
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
  const browser = await launch();
  try {
    const {page} = await openSubmitForm(browser, cfg);
    const fields = await describeForm(page);
    const missing = [];
    for (const f of fields.filter(f => f.visible)) {
      const plan = planField(f, listing);
      const ok = plan ? await applyField(page, f, plan, logoPath) : false;
      if (!ok && f.required) missing.push(f.label || f.name || `#${f.idx}`);
    }
    if (missing.length) { await debugSnapshot(page, cfg, 'unfilled'); throw new NotPostedError(`${site}: could not fill required fields: ${missing.join(', ')}`); }
    const before = page.url();
    const button = page.locator('form [type="submit"], form button:not([type="button"])').last();
    // From the click on, the listing may have been sent.
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), button.click()]);
    await page.waitForTimeout(2500);
    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const errors = (await page.locator('.error:visible, .alert-danger:visible, .invalid-feedback:visible, [role="alert"]:visible, .text-danger:visible').allInnerTexts().catch(() => [])).join(' ').trim();
    if (/already (been )?(listed|exists|submitted|added)/.test(text + ' ' + errors.toLowerCase())) return {submitted: true, url: null, note: 'already listed'};
    const url = page.url();
    if (/\/coins?\//i.test(new URL(url).pathname)) return {submitted: true, url};
    if (/success|submitted|thank|pending|review|received|has been added/.test(text) && !errors) return {submitted: true, url: null};
    if (errors && url === before) { await debugSnapshot(page, cfg, 'rejected'); throw new NotPostedError(`${site} rejected the listing: ${errors.slice(0, 200)}`); }
    await debugSnapshot(page, cfg, 'unclear');
    return {submitted: false};
  } finally { await browser.close(); }
}

/** Logged-out look for the live coin page: the known URL first, else the site's new-coins pages. */
export async function checkListing(site, listing, submission = {}, cfg = siteConfig(site)) {
  const browser = await launch();
  try {
    const page = await (await browser.newContext()).newPage();
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
  const browser = await launch();
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
  const sites = Object.keys(SITES).filter(s => env[SITES[s].user] && env[SITES[s].pass]);
  if (!sites.length) return;
  const c = await client.request('publish/claim', {kinds: sites});
  if (c) {
    const logo = await logoFile(client, c.target.listing);
    try {
      const r = await submit(c.job.kind, c.target.listing, logo.path);
      await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, submitted: r.submitted, url: r.url ?? null});
    } catch (e) {
      if (e instanceof NotPostedError) await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message});
      else await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null});
    } finally { await rm(logo.dir, {recursive: true, force: true}); }
  }
  const due = await client.request('listings/check-claim', {});
  if (due && sites.includes(due.job.kind)) {
    const r = await check(due.job.kind, due.target.listing, due.submission).catch(() => ({live: false}));
    await client.request(`listings/${due.job.id}/checked`, r);
  }
}

// CLI: node directories.mjs inspect coinsniper|coinvote
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === 'inspect') {
  console.log(JSON.stringify(await inspect(process.argv[3]), null, 2));
}
