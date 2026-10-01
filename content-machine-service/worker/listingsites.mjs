import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {browserContext, installCookieSession, NotPostedError, redditProxy} from './reddit.mjs';

/**
 * Listing sites with their own step-by-step flows (each mapped from the live form): Top100Token (no login, 3 steps,
 * free "Normal Listing") and GemFinder (email login, one page). Each submit returns {submitted, url}; the coin page is
 * then checked logged-out until it is public.
 */

const launch = () => chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, proxy: redditProxy(process.env.DIRECTORY_PROXY)});
const stateDir = (env = process.env) => resolve(env.DIRECTORY_STATE_DIR || '.');
const notSent = (site, what, e) => new NotPostedError(`${site}: ${what}${e ? ` (${String(e?.message || e).split('\n')[0].slice(0, 160)})` : ''}; nothing was sent.`);

async function top100Submit(listing, logoPath) {
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const ca = listing.contract_address;
    const coinUrl = `https://top100token.com/${listing.chain}/${ca}`;
    try {
      await page.goto('https://top100token.com/submit', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.waitForTimeout(4000);
      const chain = page.locator('select').first();
      const label = (await chain.locator('option').allInnerTexts()).find(t => t.toLowerCase().includes(listing.chain));
      if (!label) throw notSent('top100token', `chain ${listing.chain} is not offered`);
      await chain.selectOption({label});
      await page.getByPlaceholder('0xB8c76482f45A0F44dE1545F52C73426C621bDC52').fill(ca);
      await page.waitForTimeout(5000);
      if (await page.getByText('already submitted').count()) return {submitted: true, url: coinUrl, note: 'already listed'};
      if (logoPath) await page.locator('input[type=file]').first().setInputFiles(logoPath);
      await page.waitForTimeout(3000);
      const fillIf = async (sel, v) => { const e = page.locator(sel).first(); if (v && await e.count() && await e.isVisible() && !(await e.inputValue())) await e.fill(v); };
      await fillIf('input[placeholder="Bitcoin"]', listing.name);
      await fillIf('input[placeholder="BTC"]', listing.symbol);
      await fillIf('textarea', listing.description);
      await page.locator('input[name=presale]').nth(1).check();
      await page.getByRole('button', {name: 'Next'}).click();
      await page.waitForTimeout(3000);
      await fillIf('input[placeholder^="https://yourwebsite.com"]', listing.website_url);
      await fillIf('input[placeholder^="Telegram"]', listing.telegram_url);
      await fillIf('input[placeholder^="Twitter"]', listing.x_url);
      await page.getByRole('button', {name: 'Next'}).click();
      await page.waitForTimeout(3000);
      // Free listing (reviewed by the site); Premium is a paid upgrade.
      await page.getByText('Normal Listing', {exact: true}).click();
      await page.waitForTimeout(1000);
    } catch (e) { throw e instanceof NotPostedError ? e : notSent('top100token', 'could not fill the form', e); }
    const created = page.waitForResponse(r => /\/offer\/create/.test(r.url()) && r.request().method() === 'POST', {timeout: 30000}).catch(() => null);
    await page.locator('button:has-text("Submit")').last().click();
    const r = await created;
    if (!r) return {submitted: false};
    const body = await r.json().catch(() => ({}));
    if (r.status() >= 300 || body.status !== 'success') throw new NotPostedError(`top100token rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    return {submitted: true, url: coinUrl};
  } finally { await browser.close(); }
}

const GEMFINDER_COOKIES = {domain: /(^|\.)gemfinder\.cc$/, isLogin: n => n === 'laravel_session', label: 'GemFinder login cookies'};

async function gemfinderSubmit(listing, logoPath, env = process.env) {
  const statePath = join(stateDir(env), 'gemfinder-session.json');
  if (env.GEMFINDER_COOKIES && !existsSync(statePath)) { try { installCookieSession(statePath, env.GEMFINDER_COOKIES, GEMFINDER_COOKIES); } catch {} }
  const browser = await launch();
  try {
    const context = await browser.newContext(browserContext(existsSync(statePath) ? {storageState: statePath} : {}));
    const page = await context.newPage();
    try {
      await page.goto('https://gemfinder.cc/addcoin', {waitUntil: 'domcontentloaded', timeout: 60000});
      if (!page.url().includes('/addcoin')) {
        if (!env.GEMFINDER_EMAIL || !env.GEMFINDER_PASSWORD) throw notSent('gemfinder', 'not logged in; set GEMFINDER_EMAIL and GEMFINDER_PASSWORD');
        await page.goto('https://gemfinder.cc/login', {waitUntil: 'domcontentloaded'});
        await page.locator('input[type=email], input[name=email]').first().fill(env.GEMFINDER_EMAIL);
        await page.locator('input[type=password]').first().fill(env.GEMFINDER_PASSWORD);
        await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.locator('button[type=submit]').first().click()]);
        await page.waitForTimeout(4000);
        await page.goto('https://gemfinder.cc/addcoin', {waitUntil: 'domcontentloaded'});
        if (!page.url().includes('/addcoin')) throw notSent('gemfinder', 'login failed');
        await context.storageState({path: statePath});
      }
      await page.waitForTimeout(2000);
      await page.fill('#name', listing.name);
      await page.fill('#symbol', listing.symbol || listing.name);
      if (logoPath) await page.locator('input[name=files]').setInputFiles(logoPath);
      else if (listing.logo_url) await page.fill('#logo_link', listing.logo_url);
      await page.fill('#telegram', listing.telegram_url || listing.x_url || listing.website_url || '');
      if (listing.website_url) await page.fill('#website', listing.website_url);
      if (listing.x_url) await page.fill('#twitter', listing.x_url);
      const chain = (await page.locator('select[name=chain] option').allInnerTexts()).find(t => t.toLowerCase().includes(listing.chain));
      if (chain) await page.selectOption('select[name=chain]', {label: chain});
      await page.locator('input[name=presale]').first().check();
      await page.fill('input[name=chain_address]', listing.contract_address);
      await page.fill('input[name=poocoin_link]', `https://dexscreener.com/${listing.chain}/${listing.contract_address}`);
      await page.fill('input[name=launch_date]', `${listing.launch_date}T12:00`);
      const editor = page.locator('.note-editable').first();
      if (await editor.count()) { await editor.click(); await page.keyboard.insertText(listing.description); }
      await page.locator('input[type=checkbox][required]').first().check({force: true});
    } catch (e) { throw e instanceof NotPostedError ? e : notSent('gemfinder', 'could not fill the form', e); }
    await page.locator('button:has-text("ADD COIN")').last().click();
    // Success redirects to My coins; through the proxy that can take a while.
    await page.waitForURL(/\/mycoin/, {timeout: 45000}).catch(() => {});
    if (!page.url().includes('/mycoin')) {
      const errors = (await page.locator('.alert-danger:visible, .invalid-feedback:visible, .text-danger:visible').allInnerTexts().catch(() => [])).join(' ').trim();
      if (errors && page.url().includes('/addcoin')) throw new NotPostedError(`gemfinder rejected the listing: ${errors.slice(0, 200)}`);
      await page.goto('https://gemfinder.cc/mycoin', {waitUntil: 'domcontentloaded', timeout: 60000}).catch(() => {});
    }
    await context.storageState({path: statePath}).catch(() => {});
    // My coins lists ours newest first; the card links to /gem/<id>.
    const url = await page.evaluate(name => [...document.querySelectorAll('a[href*="/gem/"]')].find(a => a.textContent.includes(name))?.href ?? null, listing.name);
    return url ? {submitted: true, url} : {submitted: false};
  } finally { await browser.close(); }
}

/**
 * FreshCoins: Google-only account, so the session comes from FRESHCOINS_COOKIES (a browser export that includes the
 * long-lived __client cookie on clerk.freshcoins.io). 4 steps: basic info (logo crop), market details, links, verify.
 */
const FRESHCOINS_COOKIES = {domain: /(^|\.)freshcoins\.io$/, isLogin: n => n === '__client', label: 'FreshCoins login cookies (__client on clerk.freshcoins.io)'};

async function freshcoinsSubmit(listing, logoPath, env = process.env) {
  const statePath = join(stateDir(env), 'freshcoins-session.json');
  try { installCookieSession(statePath, env.FRESHCOINS_COOKIES, FRESHCOINS_COOKIES); } catch (e) { throw notSent('freshcoins', `FRESHCOINS_COOKIES: ${e.message}`); }
  const browser = await launch();
  try {
    const context = await browser.newContext(browserContext(existsSync(statePath) ? {storageState: statePath} : {}));
    const page = await context.newPage();
    const next = async () => { const b = page.locator('button[aria-label="Next step"]').last(); await b.evaluate(e => e.scrollIntoView({block: 'center'})); await b.click(); await page.waitForTimeout(2500); };
    const menuItems = () => page.locator('[role=menu]:visible [role=menuitemradio], [role=menu]:visible [role=menuitem]');
    const pick = async (button, re) => {
      for (let i = 0; i < 4; i++) {
        const b = page.locator(`button:has-text("${button}")`).last();
        await b.evaluate(e => e.scrollIntoView({block: 'center'})).catch(() => {});
        await page.waitForTimeout(400);
        await b.click().catch(() => {});
        await page.waitForTimeout(1200);
        if (await menuItems().count()) {
          const opts = (await menuItems().allInnerTexts()).map(t => t.trim());
          const want = opts.find(t => re.test(t));
          if (!want) throw notSent('freshcoins', `${button}: no match in ${opts.join(', ')}`);
          await menuItems().filter({hasText: want}).first().click();
          return;
        }
      }
      throw notSent('freshcoins', `${button} did not open`);
    };
    try {
      await page.goto('https://www.freshcoins.io/add-coin', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.waitForTimeout(6000);
      if (!page.url().includes('/add-coin')) throw notSent('freshcoins', 'not logged in; refresh FRESHCOINS_COOKIES');
      await page.getByPlaceholder('Enter coin name').fill(listing.name);
      await page.getByPlaceholder('PEPE').fill(listing.symbol || listing.name);
      for (const c of ['Memecoins', 'Pump Fun Tokens']) await page.getByText(c, {exact: true}).click().catch(() => {});
      if (logoPath) {
        await page.locator('input[type=file]').first().setInputFiles(logoPath);
        await page.waitForTimeout(2000);
        await page.locator('[role=dialog]').last().locator('button').filter({hasText: /^\s*Confirm\s*$/}).click();
        await page.waitForTimeout(3000);
      }
      const editor = page.locator('[contenteditable=true]').first();
      await editor.click(); await page.keyboard.insertText(listing.description);
      await page.locator('button:has-text("Market Details")').first().click();
      await page.waitForTimeout(3000);
      await pick('Select a blockchain', new RegExp(`^${listing.chain}$`, 'i'));
      await pick('Select a DEX', /pump|raydium|other/i);
      const ca = page.getByPlaceholder('Enter project contract address');
      await ca.click(); await ca.fill(listing.contract_address);
      await page.waitForTimeout(1000);
      await next();
      // Neither presale nor fairlaunch: the form then asks for the launch date.
      const month = page.locator('[role=spinbutton][data-type=month]:visible').first();
      if (await month.count()) {
        const [y, m, d] = listing.launch_date.split('-');
        await month.click(); await page.keyboard.type(m, {delay: 80});
        await page.locator('[role=spinbutton][data-type=day]:visible').first().click(); await page.keyboard.type(d, {delay: 80});
        await page.locator('[role=spinbutton][data-type=year]:visible').first().click(); await page.keyboard.type(y, {delay: 80});
        await page.waitForTimeout(800);
        await next();
      }
      const site = page.locator('input[name="socials.website"]');
      if (!(await site.count())) throw notSent('freshcoins', 'the links step did not open');
      await site.fill(listing.website_url || listing.x_url || listing.telegram_url);
      if (listing.telegram_url) await page.fill('input[name="socials.telegram"]', listing.telegram_url);
      if (listing.x_url) await page.fill('input[name="socials.x"]', listing.x_url);
      await next();
    } catch (e) { throw e instanceof NotPostedError ? e : notSent('freshcoins', 'could not fill the form', e); }
    const created = page.waitForResponse(r => /freshcoinsbackend\.site\/api\/coin$/.test(r.url()) && r.request().method() === 'POST', {timeout: 45000}).catch(() => null);
    const submit = page.locator('button:visible').filter({hasText: /^\s*Submit\s*$/}).last();
    await submit.evaluate(e => e.scrollIntoView({block: 'center'}));
    await submit.click();
    const r = await created;
    if (!r) return {submitted: false};
    const body = await r.json().catch(() => ({}));
    if (r.status() >= 300) throw new NotPostedError(`freshcoins rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    await context.storageState({path: statePath}).catch(() => {});
    return {submitted: true, url: body.slug ? `https://www.freshcoins.io/coins/${body.slug}` : null};
  } finally { await browser.close(); }
}

/**
 * Coinscope: Google-only account; the worker signs in with COINSCOPE_REFRESH_TOKEN (the Firebase refresh token from a
 * logged-in browser), writing the app's own auth record before loading the form. One page, Grommet dropdowns.
 */
const COINSCOPE_FIREBASE_KEY = 'AIzaSyAzzY1dDhCu5ekBTMwRe5pPBJAoDpZoOl8';

async function coinscopeLogin(page, refreshToken) {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${COINSCOPE_FIREBASE_KEY}`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', referer: 'https://www.coinscope.co/'}, body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: refreshToken}), signal: AbortSignal.timeout(20000)});
  const t = await r.json().catch(() => ({}));
  if (!t.id_token) throw notSent('coinscope', `login refresh failed (${JSON.stringify(t).slice(0, 120)}); refresh COINSCOPE_REFRESH_TOKEN`);
  await page.goto('https://www.coinscope.co/robots.txt', {waitUntil: 'domcontentloaded', timeout: 60000});
  await page.evaluate(async ({t, key}) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('firebaseLocalStorageDb', 1); q.onupgradeneeded = () => q.result.createObjectStore('firebaseLocalStorage', {keyPath: 'fbase_key'}); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const value = {uid: t.user_id, emailVerified: true, isAnonymous: false, providerData: [], stsTokenManager: {refreshToken: t.refresh_token, accessToken: t.id_token, expirationTime: Date.now() + Number(t.expires_in) * 1000}, createdAt: String(Date.now()), lastLoginAt: String(Date.now()), apiKey: key, appName: '[DEFAULT]'};
    await new Promise((res, rej) => { const tx = db.transaction('firebaseLocalStorage', 'readwrite'); tx.objectStore('firebaseLocalStorage').put({fbase_key: `firebase:authUser:${key}:[DEFAULT]`, value}); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }, {t, key: COINSCOPE_FIREBASE_KEY});
}

async function coinscopeSubmit(listing, logoPath, env = process.env) {
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const pick = async (name, rx) => {
      const el = page.locator(`input[name=${name}]`);
      for (let a = 0; a < 4; a++) {
        await el.evaluate(e => e.scrollIntoView({block: 'center'}));
        await el.click({force: true});
        const layer = page.locator('body > div').last();
        const opt = layer.locator('button, [role=option]').filter({hasText: rx});
        await opt.first().waitFor({timeout: 4000}).catch(() => {});
        // Long lists (days) render lazily: scroll the layer to reveal the rest.
        if (!(await opt.count())) { await layer.evaluate(l => l.querySelectorAll('*').forEach(e => { if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = e.scrollHeight; })).catch(() => {}); await page.waitForTimeout(600); }
        if (await opt.count()) { await opt.first().click(); await page.waitForTimeout(400); return; }
        await page.keyboard.press('Escape'); await page.waitForTimeout(800);
      }
      throw notSent('coinscope', `${name}: no option ${rx}`);
    };
    try {
      await coinscopeLogin(page, env.COINSCOPE_REFRESH_TOKEN);
      await page.goto('https://www.coinscope.co/addcoin', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.locator('input[name=name]').waitFor({timeout: 30000}).catch(() => {});
      if (!(await page.locator('input[name=name]').count())) throw notSent('coinscope', 'not logged in; refresh COINSCOPE_REFRESH_TOKEN');
      await page.waitForTimeout(2000);
      await page.fill('input[name=name]', listing.name);
      await page.fill('input[name=symbol]', listing.symbol || listing.name);
      if (logoPath) await page.locator('input[type=file]').first().setInputFiles(logoPath);
      const chainLabel = {solana: /\(SOL\)\s*Solana/, ethereum: /\(ETH\)\s*Ethereum/, bsc: /\(BSC\)/, base: /\bBase\b/};
      await pick('network', chainLabel[listing.chain] ?? new RegExp(listing.chain, 'i'));
      await page.fill('input[name=address]', listing.contract_address);
      await page.fill('textarea[name=description]', listing.description);
      if (listing.launch_date) {
        const [y, m, d] = listing.launch_date.split('-');
        await pick('deployedAtDay', new RegExp(`^\\s*${d}\\s*$`));
        await pick('deployedAtMonth', new RegExp(`^\\s*${m}\\s*$`));
        await pick('deployedAtYear', new RegExp(`^\\s*${y}\\s*$`)).catch(() => {});
      }
      if (listing.website_url) await page.fill('input[name=website]', listing.website_url);
      if (listing.x_url) await page.fill('input[name=twitter]', listing.x_url);
      if (listing.telegram_url) await page.fill('input[name=telegram]', listing.telegram_url);
      const terms = page.locator('input[name=terms]');
      const label = page.locator('label:has(input[name=terms])').first();
      await label.evaluate(e => e.scrollIntoView({block: 'center'}));
      const bb = await label.boundingBox();
      if (bb) await page.mouse.click(bb.x + 10, bb.y + bb.height / 2);
      await page.waitForTimeout(400);
      if (!(await terms.isChecked())) await label.click();
      if (!(await terms.isChecked())) throw notSent('coinscope', 'could not accept the terms');
    } catch (e) { throw e instanceof NotPostedError ? e : notSent('coinscope', 'could not fill the form', e); }
    const created = page.waitForResponse(r => /coinscope\.co\/api\/coins$/.test(r.url()) && r.request().method() === 'POST', {timeout: 45000}).catch(() => null);
    const submit = page.locator('button:has-text("Submit")').first();
    await submit.evaluate(e => e.scrollIntoView({block: 'center'}));
    await submit.click();
    const r = await created;
    if (!r) {
      const msg = (await page.locator('text=/should|required|invalid/i').allInnerTexts().catch(() => [])).join(' ').trim();
      if (msg) throw new NotPostedError(`coinscope rejected the listing: ${msg.slice(0, 200)}`);
      return {submitted: false};
    }
    const body = await r.json().catch(() => ({}));
    if (r.status() >= 300 || !body.slug) throw new NotPostedError(`coinscope rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    return {submitted: true, url: `https://www.coinscope.co/coin/${body.slug}`};
  } finally { await browser.close(); }
}

/** Logged-out: is the coin page public and about this coin? */
async function pageIsLive(url, listing) {
  if (!url) return {live: false};
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const r = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000}).catch(() => null);
    await page.waitForTimeout(3000);
    const html = (await page.content()).toLowerCase();
    const ours = html.includes(listing.contract_address.toLowerCase()) || html.includes(listing.name.toLowerCase());
    return {live: !!r?.ok() && ours && !/under review|pending approval|not found/.test(html), url};
  } catch { return {live: false}; } finally { await browser.close(); }
}

export const LISTING_SITES = {
  top100token: {enabled: () => true, submit: top100Submit, check: pageIsLive},
  gemfinder: {enabled: env => !!(env.GEMFINDER_COOKIES || (env.GEMFINDER_EMAIL && env.GEMFINDER_PASSWORD)), submit: gemfinderSubmit, check: pageIsLive},
  freshcoins: {enabled: env => !!env.FRESHCOINS_COOKIES, submit: freshcoinsSubmit, check: pageIsLive},
  coinscope: {enabled: env => !!env.COINSCOPE_REFRESH_TOKEN, submit: coinscopeSubmit, check: pageIsLive},
};

async function logoFile(client, listing) {
  const dir = await mkdtemp(join(tmpdir(), 'cm-logo-'));
  let bytes = null;
  if (listing.logo_url) { const r = await fetch(listing.logo_url, {headers: {'user-agent': 'Mozilla/5.0'}, signal: AbortSignal.timeout(15000)}).catch(() => null); if (r?.ok) bytes = Buffer.from(await r.arrayBuffer()); }
  if (!bytes && listing.image_asset_url) bytes = await client.asset(listing.image_asset_url).catch(() => null);
  if (!bytes) return {dir, path: null};
  const path = join(dir, bytes[0] === 0x89 ? 'logo.png' : 'logo.jpg'); await writeFile(path, bytes); return {dir, path};
}

/** One cycle: submit one due listing on these sites, then check one that is waiting for the site's review. */
export async function listingSitesCycle(client, {sites = LISTING_SITES, env = process.env} = {}) {
  const kinds = Object.keys(sites).filter(k => sites[k].enabled(env));
  if (!kinds.length) return;
  const c = await client.request('publish/claim', {kinds});
  if (c) {
    const logo = await logoFile(client, c.target.listing);
    try {
      const r = await sites[c.job.kind].submit(c.target.listing, logo.path, env);
      await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, submitted: r.submitted, url: r.url ?? null});
    } catch (e) {
      if (e instanceof NotPostedError) { console.error(`${c.job.kind} (${c.job.order_id}) not posted: ${e.message}`); await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message}); }
      else { console.error(`${c.job.kind} (${c.job.order_id}): ${e?.message || e}`); await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null, note: String(e?.message || e).slice(0, 300)}); }
    } finally { await rm(logo.dir, {recursive: true, force: true}); }
  }
  const due = await client.request('listings/check-claim', {kinds});
  if (due && kinds.includes(due.job.kind)) {
    const r = await sites[due.job.kind].check(due.submission?.url, due.target.listing).catch(() => ({live: false}));
    await client.request(`listings/${due.job.id}/checked`, r);
  }
}
