import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {browserContext, installCookieSession, NotOfferedError, NotPostedError, redditProxy, textOnly} from './reddit.mjs';
import {withLock} from './lock.mjs';
import {bitgetSubmit, okxUpdateSubmit} from './wallets.mjs';
import {web3ListingsSubmit} from './web3links.mjs';

/**
 * Listing sites with their own step-by-step flows (each mapped from the live form): Top100Token (no login, 3 steps,
 * free "Normal Listing") and GemFinder (email login, one page). Each submit returns {submitted, url}; the coin page is
 * then checked logged-out until it is public.
 */

const launch = () => chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, proxy: redditProxy(process.env.DIRECTORY_PROXY)});
const stateDir = (env = process.env) => resolve(env.DIRECTORY_STATE_DIR || '.');
/** A link for forms that require one: the project's own, else its DEX Screener chart. */
const anyLink = l => l.website_url || l.x_url || l.telegram_url || l.chart_url || `https://dexscreener.com/${l.chain}/${l.contract_address}`;
const notSent = (site, what, e) => new NotPostedError(`${site}: ${what}${e ? ` (${String(e?.message || e).split('\n')[0].slice(0, 160)})` : ''}; nothing was sent.`);
const notOffered = (site, chain, offered) => new NotOfferedError(`${site}: chain ${chain} is not offered${offered?.length ? ` (${offered.slice(0, 14).join(', ')})` : ''}; nothing was sent.`);

/** Each site's names for our chains (from their live forms). A chain missing here is not offered there. */
const TOP100_CHAINS = {solana: /^Solana/i, bsc: /\(BSC\)|Binance Smart Chain/i, ethereum: /^Ethereum/i, base: /^Base$/i, arbitrum: /^Arbitrum/i, polygon: /^Polygon/i, robinhood: /^Robinhood/i};
/** Top100Token's coin page paths: BSC coins live under /binance/. */
const TOP100_PATHS = {bsc: 'binance'};
const GEMFINDER_CHAINS = {bsc: /^Binance Smart Chain$/i, ethereum: /^Ethereum$/i, polygon: /^Polygon$/i, solana: /^Solana$/i, arbitrum: /^Arbitrum/i};
const FRESH_CHAINS = {bsc: /^Binance Smart Chain$/i, ethereum: /^Ethereum$/i, solana: /^Solana$/i, base: /^Base$/i, polygon: /^Matic$/i, robinhood: /^Robinhood Chain$/i};
/** FreshCoins' DEX choice by chain; "Other" when none fits. */
const FRESH_DEXES = {solana: /pump|raydium/i, bsc: /pancake/i, base: /uniswap|aerodrome/i, ethereum: /uniswap/i, robinhood: /uniswap/i};
const COINSCOPE_CHAINS = {solana: /\(SOL\)\s*Solana/, ethereum: /\(ETH\)\s*Ethereum/, bsc: /\(BSC\)/, polygon: /\(MATIC\)/, arbitrum: /\(ARBITRUM\)/};

/** Top100Token and CoinBoom run on one platform with one token database: a token submitted on either shows on both. */
const TOP100_SITES = {top100token: 'https://top100token.com', coinboom: 'https://coinboom.net'};
const top100CoinUrl = (site, l) => `${TOP100_SITES[site]}/${TOP100_PATHS[l.chain] ?? l.chain}/${l.contract_address}`;

async function top100Submit(listing, logoPath, site = 'top100token') {
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const ca = listing.contract_address;
    const coinUrl = top100CoinUrl(site, listing);
    try {
      await page.goto(`${TOP100_SITES[site]}/submit`, {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.waitForTimeout(4000);
      const chain = page.locator('select').first();
      const offered = (await chain.locator('option').allInnerTexts()).map(t => t.trim());
      const label = TOP100_CHAINS[listing.chain] && offered.find(t => TOP100_CHAINS[listing.chain].test(t));
      if (!label) throw notOffered(site, listing.chain, offered);
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
      // "Presale?" (answer: no) only shows for tokens the site doesn't know yet; for trading tokens it fills the details itself.
      const presale = page.locator('input[name=presale]');
      if ((await presale.count()) > 1) await presale.nth(1).check();
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
    } catch (e) { throw e instanceof NotPostedError ? e : notSent(site, 'could not fill the form', e); }
    const created = page.waitForResponse(r => /\/offer\/create/.test(r.url()) && r.request().method() === 'POST', {timeout: 30000}).catch(() => null);
    await page.locator('button:has-text("Submit")').last().click();
    const r = await created;
    if (!r) return {submitted: false};
    const body = await r.json().catch(() => ({}));
    if (r.status() >= 300 || body.status !== 'success') throw new NotPostedError(`${site} rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
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
      // Required by the form: Telegram when the project has one, else its other links or the chart.
      await page.fill('#telegram', listing.telegram_url || anyLink(listing));
      if (listing.website_url) await page.fill('#website', listing.website_url);
      if (listing.x_url) await page.fill('#twitter', listing.x_url);
      const offered = (await page.locator('select[name=chain] option').allInnerTexts()).map(t => t.trim());
      const chain = GEMFINDER_CHAINS[listing.chain] && offered.find(t => GEMFINDER_CHAINS[listing.chain].test(t));
      if (!chain) throw notOffered('gemfinder', listing.chain, offered);
      await page.selectOption('select[name=chain]', {label: chain});
      await page.locator('input[name=presale]').first().check();
      await page.fill('input[name=chain_address]', listing.contract_address);
      await page.fill('input[name=poocoin_link]', `https://dexscreener.com/${listing.chain}/${listing.contract_address}`);
      await page.fill('input[name=launch_date]', `${listing.launch_date}T12:00`);
      const editor = page.locator('.note-editable').first();
      if (await editor.count()) { await editor.click(); await page.keyboard.insertText(listing.description); }
      await page.locator('input[type=checkbox][required]').first().check({force: true});
      // The browser refuses to submit a form with an empty required field: report it rather than "maybe sent".
      const missing = await page.locator('[required]').evaluateAll(es => es.filter(e => !e.checkValidity()).map(e => e.name || e.id));
      if (missing.length) throw notSent('gemfinder', `required fields not filled: ${missing.join(', ')}`);
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
    // My coins lists ours newest first; the card links to /gem/<id>. The page sometimes fails to load: try it a few times.
    const find = () => page.evaluate(({name, symbol}) => {
      const has = t => [name, symbol].filter(Boolean).some(w => t.toLowerCase().includes(String(w).toLowerCase()));
      return [...document.querySelectorAll('a[href*="/gem/"]')].find(a => has(a.textContent || ''))?.href ?? null;
    }, {name: listing.name, symbol: listing.symbol}).catch(() => null);
    let url = await find();
    for (let i = 0; !url && i < 3; i++) {
      await page.waitForTimeout(4000);
      await page.goto('https://gemfinder.cc/mycoin', {waitUntil: 'domcontentloaded', timeout: 60000}).catch(() => {});
      url = await find();
    }
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
    const pick = async (button, re, {fallback, chain} = {}) => {
      for (let i = 0; i < 4; i++) {
        const b = page.locator(`button:has-text("${button}")`).last();
        await b.evaluate(e => e.scrollIntoView({block: 'center'})).catch(() => {});
        await page.waitForTimeout(400);
        await b.click().catch(() => {});
        await page.waitForTimeout(1200);
        if (await menuItems().count()) {
          const opts = (await menuItems().allInnerTexts()).map(t => t.trim());
          const want = opts.find(t => re?.test(t)) ?? (fallback && opts.find(t => fallback.test(t)));
          if (!want && chain) throw notOffered('freshcoins', chain, opts);
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
      // FreshCoins' list: Binance Smart Chain, Ethereum, Solana, Tron, Base, Matic, Avalanche, Monad, Robinhood Chain.
      await pick('Select a blockchain', FRESH_CHAINS[listing.chain], {chain: listing.chain});
      await pick('Select a DEX', FRESH_DEXES[listing.chain], {fallback: /^other/i});
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
      // The links step can take a while to render after the date step.
      await site.waitFor({state: 'visible', timeout: 15000}).catch(() => {});
      if (!(await site.count())) throw notSent('freshcoins', 'the links step did not open');
      await site.fill(anyLink(listing));
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
      if (!COINSCOPE_CHAINS[listing.chain]) throw notOffered('coinscope', listing.chain);
      await pick('network', COINSCOPE_CHAINS[listing.chain]);
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
    // Already on Coinscope (an earlier purchase or the project itself): its page is the listing; the review check confirms it.
    if (r.status() === 422 && /already exist/i.test(JSON.stringify(body?.fields ?? {})))
      return {submitted: true, url: `https://www.coinscope.co/coin/${listing.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, note: 'already listed'};
    if (r.status() >= 300 || !body.slug) throw new NotPostedError(`coinscope rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    return {submitted: true, url: `https://www.coinscope.co/coin/${body.slug}`};
  } finally { await browser.close(); }
}

/** Logged-out: is the coin page public and about this coin? */
/**
 * HKDeFi (hkdefi.io): no account and no check; its form posts one JSON request. Its ids for our chains and the DEX each
 * chain launches on (presale "None"). It needs a contact: the project's Telegram, else our listing e-mail. The coin
 * page (/coin/<id>) appears once HKDeFi approves the token; its search finds it then.
 */
const HKDEFI_API = 'https://api.hkdefi.io/api/coin';
const HKDEFI_CHAINS = {solana: 27, bsc: 14, ethereum: 15, base: 74, polygon: 30, arbitrum: 59, robinhood: 88};
const HKDEFI_DEX = {solana: 85, bsc: 19, ethereum: 21, base: 21, arbitrum: 21, robinhood: 21, polygon: 36};
const HKDEFI_HEADERS = {'content-type': 'application/json', origin: 'https://hkdefi.io', referer: 'https://hkdefi.io/addcoin', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'};

async function hkdefiFind(listing, fetchFn = fetch) {
  const r = await fetchFn(`${HKDEFI_API}/search?search=${encodeURIComponent(listing.name)}`, {headers: HKDEFI_HEADERS, signal: AbortSignal.timeout(20000)});
  const rows = (await r.json().catch(() => null))?.data?.rows ?? [];
  const hit = rows.find(c => String(c.contract ?? '').toLowerCase() === listing.contract_address.toLowerCase());
  return hit ? {live: true, url: `https://hkdefi.io/coin/${hit.id}`} : {live: false};
}

async function hkdefiSubmit(listing, _logoPath, env = process.env, fetchFn = fetch) {
  const chain = HKDEFI_CHAINS[listing.chain];
  if (!chain) throw notOffered('hkdefi', listing.chain);
  const found = await hkdefiFind(listing, fetchFn).catch(() => ({live: false}));
  if (found.live) return {submitted: true, url: found.url, note: 'already listed'};
  const contactTelegram = listing.telegram_url || env.LISTING_CONTACT_TELEGRAM || '';
  const contactEmail = contactTelegram ? '' : (env.LISTING_CONTACT_EMAIL || '');
  if (!contactTelegram && !contactEmail) throw notSent('hkdefi', 'HKDeFi needs a contact Telegram or e-mail (the project has no Telegram; set LISTING_CONTACT_EMAIL)');
  const description = String(listing.description || listing.short_description || `${listing.name} ($${listing.symbol}) community token.`).slice(0, 2000);
  const body = {
    name: listing.name, symbol: `$${String(listing.symbol).replace(/^\$/, '')}`, chain, image: listing.logo_public_url || listing.logo_url || '',
    contract: listing.contract_address, description, presale_platform: 23, presale_time: '', presale_url: '',
    launch_platform: HKDEFI_DEX[listing.chain] ?? 26, launch_time: '', launch_url: '',
    website: listing.website_url || '', telegram: listing.telegram_url || '', twitter: listing.x_url || '', discord: '',
    contact_email: contactEmail, contact_telegram: contactTelegram,
  };
  let r;
  try { r = await fetchFn(`${HKDEFI_API}/apply`, {method: 'POST', headers: HKDEFI_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)}); }
  catch (e) { throw notSent('hkdefi', 'could not reach HKDeFi', e); }
  const j = await r.json().catch(() => ({}));
  // code 1: "Submission successful, We are reviewing!"; code 0: refused with a reason (nothing was listed).
  if (!r.ok || j.code !== 1) throw new NotPostedError(`hkdefi rejected the listing: HTTP ${r.status} ${String(j.msg ?? '').slice(0, 160)}; nothing was listed.`);
  return {submitted: true, url: null};
}

/**
 * GemPump (gempump.io): no account and no check. Its form fills the token's details from its contract and signs the
 * request in the page, so the page is driven as a visitor would. Its status lookup (-1 not listed, 1 live, 2 turned
 * down in review: GemPump then asks for payment) is read first; the coin page is /en/token/<nameId> once live.
 */
const GEMPUMP_API = 'https://api.gempump.io';
const GEMPUMP_NETWORKS = {solana: 'solana', robinhood: 'robinhood', ethereum: 'ethereum', bsc: 'bsc', arc: 'arc', base: 'base', polygon: 'polygon', arbitrum: 'arbitrum'};

async function gempumpStatus(listing, fetchFn = fetch) {
  const nets = (await (await fetchFn(`${GEMPUMP_API}/network/useable`, {signal: AbortSignal.timeout(20000)})).json())?.data ?? [];
  const net = nets.find(n => n.dexscreenerName === GEMPUMP_NETWORKS[listing.chain]);
  if (!net) return {offered: false, names: nets.map(n => n.name)};
  const s = (await (await fetchFn(`${GEMPUMP_API}/token/status?network=${net.id}&address=${encodeURIComponent(listing.contract_address)}`, {signal: AbortSignal.timeout(20000)})).json())?.data ?? {};
  return {offered: true, net, status: s.status, url: s.nameId ? `https://www.gempump.io/en/token/${s.nameId}` : null};
}

async function gempumpCheck(_url, listing) {
  const s = await gempumpStatus(listing).catch(() => null);
  return s?.status === 1 && s.url ? {live: true, url: s.url} : {live: false};
}

async function gempumpSubmit(listing, logoPath, _env = process.env) {
  if (!GEMPUMP_NETWORKS[listing.chain]) throw notOffered('gempump', listing.chain);
  let s;
  try { s = await gempumpStatus(listing); } catch (e) { throw notSent('gempump', 'could not read GemPump', e); }
  if (!s.offered) throw notOffered('gempump', listing.chain, s.names);
  if (s.status === 1) return {submitted: true, url: s.url, note: 'already listed'};
  if (s.status === 2) throw new NotOfferedError('gempump: GemPump already turned this token down in review and asks for payment; nothing was sent.');
  if (s.status !== -1) return {submitted: true, url: null, note: 'already submitted, in review'};
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    try {
      await page.goto('https://www.gempump.io/en/addtoken', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.locator('button:has-text("Choose Mainnet")').first().waitFor({timeout: 30000});
      await page.waitForTimeout(2000);
      await page.locator('button:has-text("Choose Mainnet")').first().click();
      await page.locator('[data-slot=popover] [role=option]').filter({hasText: new RegExp(`^\\s*${s.net.name}\\s*$`)}).first().click({timeout: 10000});
      await page.locator('input[name=address]').fill(listing.contract_address);
      // GemPump fills name, symbol, launch time, links and description from the contract.
      await page.waitForTimeout(6000);
      const fillIf = async (sel, v) => { const e = page.locator(sel).first(); if (v && !(await e.inputValue())) await e.fill(v); };
      await fillIf('input[name=name]', listing.name);
      await fillIf('input[name=symbol]', String(listing.symbol).replace(/^\$/, ''));
      await fillIf('textarea[name=introduce]', listing.description || listing.short_description || `${listing.name} ($${listing.symbol}) community token.`);
      if (!(await page.locator('input[name=startTime]').inputValue()) && listing.launch_date) {
        const [y, m, d] = listing.launch_date.split('-');
        for (const [type, v] of [['month', m], ['day', d], ['year', y], ['hour', '12'], ['minute', '00']]) { await page.locator(`[role=spinbutton][data-type=${type}]`).first().click(); await page.keyboard.type(v); }
      }
      if (logoPath) await page.locator('input[type=file]').first().setInputFiles(logoPath);
      await page.waitForTimeout(3000);
    } catch (e) { throw e instanceof NotPostedError ? e : notSent('gempump', 'could not fill the form', e); }
    const created = page.waitForResponse(r => /\/token\/create/.test(r.url()) && r.request().method() === 'PUT', {timeout: 30000}).catch(() => null);
    const submit = page.locator('button:visible').filter({hasText: /^\s*Submit\s*$/}).last();
    await submit.click({trial: true, timeout: 15000}).catch(async e => { throw notSent('gempump', 'the submit button is not clickable', e); });
    await submit.click();
    const r = await created;
    if (!r) {
      const shown = (await page.locator('[data-slot=error-message]').allInnerTexts().catch(() => [])).filter(Boolean).join('; ');
      if (shown) throw notSent('gempump', `the form refused the details (${shown.slice(0, 160)})`);
      return {submitted: false};
    }
    const body = await r.json().catch(() => ({}));
    if (r.status() >= 300 || body.code !== 200) throw new NotPostedError(`gempump rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}; nothing was listed.`);
    return {submitted: true, url: null};
  } finally { await browser.close(); }
}

async function pageIsLive(url, listing) {
  if (!url) return {live: false};
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const r = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000}).catch(() => null);
    await page.waitForTimeout(3000);
    // Visible text only: page code and scripts contain words like "not found" that are not on the page.
    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const ours = text.includes(listing.contract_address.toLowerCase()) || text.includes(listing.name.toLowerCase());
    return {live: !!r?.ok() && ours && !/under review|pending approval|page not found|coin not found|404/.test(text), url};
  } catch { return {live: false}; } finally { await browser.close(); }
}

export {hkdefiSubmit, hkdefiFind, gempumpStatus};

export const LISTING_SITES = {
  // The coin page from the chain (older BSC records were saved under /bsc/, which Top100Token doesn't serve).
  top100token: {enabled: () => true, submit: (l, p) => top100Submit(l, p, 'top100token'), check: (_url, l) => pageIsLive(top100CoinUrl('top100token', l), l)},
  coinboom: {enabled: () => true, submit: (l, p) => top100Submit(l, p, 'coinboom'), check: (_url, l) => pageIsLive(top100CoinUrl('coinboom', l), l)},
  hkdefi: {enabled: () => true, submit: (l, p, e) => hkdefiSubmit(l, p, e), check: (_url, l) => hkdefiFind(l).catch(() => ({live: false}))},
  gempump: {enabled: () => true, submit: gempumpSubmit, check: gempumpCheck},
  gemfinder: {enabled: env => !!(env.GEMFINDER_COOKIES || (env.GEMFINDER_EMAIL && env.GEMFINDER_PASSWORD)), submit: (l, p, e) => withLock('gemfinder', () => gemfinderSubmit(l, p, e)), check: pageIsLive},
  freshcoins: {enabled: env => !!env.FRESHCOINS_COOKIES, submit: (l, p, e) => withLock('freshcoins', () => freshcoinsSubmit(l, p, e)), check: pageIsLive},
  coinscope: {enabled: env => !!env.COINSCOPE_REFRESH_TOKEN, submit: coinscopeSubmit, check: pageIsLive},
  // Web3 Listing Updates (web3links.mjs): the token's pages on the exchanges' Web3 wallets, checked, nothing submitted.
  web3_listings: {enabled: () => true, submit: (l, p, e) => web3ListingsSubmit(l, p, e), check: async () => ({live: false})},
  // Wallet sites (wallets.mjs), one wallet browser at a time; only when named in NEW_LISTING_SITES. No coin page
  // until the site reviews the token: the screenshot proof stands in.
  ...Object.fromEntries([['okx_wallet', okxUpdateSubmit], ['bitget_wallet', bitgetSubmit]].map(([site, fn]) => [site, {
    enabled: env => (env.NEW_LISTING_SITES ?? '').split(',').map(s => s.trim()).includes(site),
    submit: (l, p, e) => withLock('wallet', () => fn(l, p, e)),
    check: async () => ({live: false}),
  }])),
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
    const started = Date.now();
    try {
      const r = await sites[c.job.kind].submit(c.target.listing, logo.path, env);
      console.log(`${c.job.kind} (${c.job.order_id}): ${r.submitted ? 'submitted' : 'not confirmed'} in ${Math.round((Date.now() - started) / 1000)}s`);
      await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, submitted: r.submitted, url: r.url ?? null, note: r.note ?? null, review_url: r.review_url ?? null, proof: r.proof ?? null, ...(r.links ? {links: r.links} : {})});
    } catch (e) {
      if (e instanceof NotPostedError) { console.error(`${c.job.kind} (${c.job.order_id}) not posted: ${e.message}`); await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message, unsupported: e instanceof NotOfferedError}); }
      else { console.error(`${c.job.kind} (${c.job.order_id}): ${e?.message || e}`); await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null, note: String(e?.message || e).slice(0, 300)}); }
    } finally { await rm(logo.dir, {recursive: true, force: true}); }
  }
  const due = await client.request('listings/check-claim', {kinds});
  if (due && kinds.includes(due.job.kind)) {
    const r = await sites[due.job.kind].check(due.submission?.url, due.target.listing).catch(() => ({live: false}));
    await client.request(`listings/${due.job.id}/checked`, r);
  }
}

// ---------------------------------------------------------------- health (read-only: nothing is submitted)

const health = async (fn) => { try { return await fn(); } catch (e) { return {ok: false, detail: String(e?.message || e).split('\n')[0].slice(0, 200)}; } };

/** Top100Token needs no login: its submit form must load (it sits behind Cloudflare). */
export const top100Health = () => health(async () => {
  const browser = await launch();
  try {
    const ctx = await browser.newContext(browserContext());
    await textOnly(ctx);
    const page = await ctx.newPage();
    await page.goto('https://top100token.com/submit', {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.waitForTimeout(4000);
    return (await page.locator('select').count()) ? {ok: true, detail: 'submit form loads'} : {ok: false, detail: `submit form did not load (${(await page.title()).slice(0, 80)})`};
  } finally { await browser.close(); }
});

/** GemFinder: the add-coin form opens with the saved session, else after an email login (which is then saved). */
export const gemfinderHealth = (env = process.env) => withLock('gemfinder', () => health(async () => {
  if (!env.GEMFINDER_EMAIL || !env.GEMFINDER_PASSWORD) return {ok: false, detail: 'set GEMFINDER_EMAIL and GEMFINDER_PASSWORD'};
  const statePath = join(stateDir(env), 'gemfinder-session.json');
  const browser = await launch();
  try {
    const context = await browser.newContext(browserContext(existsSync(statePath) ? {storageState: statePath} : {}));
    await textOnly(context);
    const page = await context.newPage();
    await page.goto('https://gemfinder.cc/addcoin', {waitUntil: 'domcontentloaded', timeout: 60000});
    if (!page.url().includes('/addcoin')) {
      await page.goto('https://gemfinder.cc/login', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.locator('input[type=email], input[name=email]').first().fill(env.GEMFINDER_EMAIL);
      await page.locator('input[type=password]').first().fill(env.GEMFINDER_PASSWORD);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.locator('button[type=submit]').first().click()]);
      await page.waitForTimeout(4000);
      await page.goto('https://gemfinder.cc/addcoin', {waitUntil: 'domcontentloaded', timeout: 60000});
      if (!page.url().includes('/addcoin')) return {ok: false, detail: 'login failed (check GEMFINDER_EMAIL / GEMFINDER_PASSWORD)'};
    }
    await page.locator('#name').waitFor({timeout: 15000}).catch(() => {});
    if (!(await page.locator('#name').count())) return {ok: false, detail: 'add-coin form did not load'};
    await context.storageState({path: statePath});
    return {ok: true, detail: 'logged in, form loads'};
  } finally { await browser.close(); }
}));

/** FreshCoins (Google-only account): the saved Clerk session must still open the add-coin page. */
export const freshcoinsHealth = (env = process.env) => withLock('freshcoins', () => health(async () => {
  const statePath = join(stateDir(env), 'freshcoins-session.json');
  try { installCookieSession(statePath, env.FRESHCOINS_COOKIES, FRESHCOINS_COOKIES); } catch (e) { return {ok: false, detail: `FRESHCOINS_COOKIES: ${e.message}`}; }
  if (!existsSync(statePath)) return {ok: false, detail: 'set FRESHCOINS_COOKIES'};
  const browser = await launch();
  try {
    const context = await browser.newContext(browserContext({storageState: statePath}));
    await textOnly(context);
    const page = await context.newPage();
    await page.goto('https://www.freshcoins.io/add-coin', {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.getByPlaceholder('Enter coin name').waitFor({timeout: 20000}).catch(() => {});
    if (!page.url().includes('/add-coin') || !(await page.getByPlaceholder('Enter coin name').count()))
      return {ok: false, detail: 'session expired: export fresh FRESHCOINS_COOKIES from a logged-in browser'};
    await context.storageState({path: statePath});
    return {ok: true, detail: 'logged in, form loads'};
  } finally { await browser.close(); }
}));

/** Coinscope (Google-only account): the saved Firebase refresh token must still mint a login. */
export const coinscopeHealth = (env = process.env) => health(async () => {
  if (!env.COINSCOPE_REFRESH_TOKEN) return {ok: false, detail: 'set COINSCOPE_REFRESH_TOKEN'};
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${COINSCOPE_FIREBASE_KEY}`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', referer: 'https://www.coinscope.co/'}, body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: env.COINSCOPE_REFRESH_TOKEN}), signal: AbortSignal.timeout(20000)});
  const t = await r.json().catch(() => ({}));
  return t.id_token ? {ok: true, detail: 'login token works'} : {ok: false, detail: `login token rejected (${String(t?.error?.message ?? r.status)}); refresh COINSCOPE_REFRESH_TOKEN`};
});

/**
 * Self-healing: is this coin on our GemFinder "My coins"? {url} when found; {absent: true} only when the page loaded
 * with our other coins and this one isn't there; otherwise {note}.
 */
export const gemfinderFind = (listing, env = process.env) => withLock('gemfinder', () => health(async () => {
  const statePath = join(stateDir(env), 'gemfinder-session.json');
  if (!existsSync(statePath)) return {note: 'no saved GemFinder session'};
  const browser = await launch();
  try {
    const ctx = await browser.newContext(browserContext({storageState: statePath}));
    await textOnly(ctx);
    const page = await ctx.newPage();
    await page.goto('https://gemfinder.cc/mycoin', {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.waitForTimeout(3000);
    const r = await page.evaluate(({name, symbol}) => {
      const links = [...document.querySelectorAll('a[href*="/gem/"]')];
      const has = t => [name, symbol].filter(Boolean).some(w => t.toLowerCase().includes(String(w).toLowerCase()));
      return {count: links.length, url: links.find(a => has(a.textContent || ''))?.href ?? null};
    }, {name: listing.name, symbol: listing.symbol});
    if (r.url) return {url: r.url};
    return r.count ? {absent: true} : {note: 'My coins did not load'};
  } finally { await browser.close(); }
}));
