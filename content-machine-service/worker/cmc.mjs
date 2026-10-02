import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {browserContext, installCookieSession, NotPostedError, redditProxy, textOnly} from './reddit.mjs';
import {withLock} from './lock.mjs';

/** A cookie export from a browser logged in to CoinMarketCap skips the login (and its human check). */
export const CMC_COOKIES = {domain: /(^|\.)coinmarketcap\.com$/, isLogin: () => true, label: 'CoinMarketCap login cookies'};

/** CoinMarketCap community: posts from our profile page's compose icon (beside "All Posts"). */
export const cmcConfig = (env = process.env) => ({
  email: env.CMC_EMAIL,
  password: env.CMC_PASSWORD,
  handle: env.CMC_PROFILE_HANDLE || 'peakbuybot',
  origin: (env.CMC_BASE_URL || 'https://coinmarketcap.com').replace(/\/$/, ''),
  statePath: env.CMC_STATE_PATH || resolve(env.DIRECTORY_STATE_DIR || '.', 'cmc-session.json'),
  debugDir: env.DIRECTORY_DEBUG_DIR || null,
  cookies: env.CMC_COOKIES,
  /** CMC_PROXY, else DIRECTORY_PROXY: a residential exit instead of the datacenter one. */
  proxy: env.CMC_PROXY || env.DIRECTORY_PROXY,
});

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Only a check that is actually on screen counts: CMC's pages carry hidden captcha containers all the time. */
const humanCheck = page => page.locator('iframe[src*="captcha"]:visible, iframe[src*="geetest"]:visible, iframe[src*="challenges.cloudflare"]:visible, .geetest_panel:visible, [class*="captcha" i]:visible').count();

/** Finds a post id in a CMC API payload: the created post, or the newest post matching our text. */
export function findPostId(payload, text) {
  const want = norm(text).slice(0, 40);
  let found = null;
  const walk = v => {
    if (found || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    const id = v.gravityId ?? v.rootId;
    const have = norm(v.textContent).slice(0, 40);
    const matches = !text || (have.length >= 15 && (have.startsWith(want) || want.startsWith(have)));
    if (id && /^\d+$/.test(String(id)) && matches) { found = String(id); return; }
    Object.values(v).forEach(walk);
  };
  walk(payload);
  return found;
}

/** The id of a listed post whose text contains `text` (its first 60 characters, normalized), or null. */
export function findPostContaining(payload, text) {
  const want = norm(text).slice(0, 60);
  let found = null;
  const walk = v => {
    if (found || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    const id = v.gravityId ?? v.rootId;
    if (id && /^\d+$/.test(String(id)) && want.length >= 15 && norm(v.textContent).includes(want)) { found = String(id); return; }
    Object.values(v).forEach(walk);
  };
  walk(payload);
  return found;
}

async function snapshot(page, cfg, tag) {
  if (!cfg.debugDir) return;
  await mkdir(cfg.debugDir, {recursive: true});
  const base = join(cfg.debugDir, `cmc-${tag}-${Date.now()}`);
  await page.screenshot({path: base + '.png', fullPage: true}).catch(() => {});
  await writeFile(base + '.html', await page.content()).catch(() => {});
}

/** Our profile shows its Edit button when logged in, a Log In button when not; the page can take a while to show either. */
async function profileState(page, ms = 30000) {
  const edit = page.locator('button:has-text("Edit")').first();
  const logIn = page.locator('button:has-text("Log In")').first();
  for (let t = 0; t < ms; t += 500) {
    if (await edit.isVisible().catch(() => false)) return 'in';
    if (await logIn.isVisible().catch(() => false)) return 'out';
    await page.waitForTimeout(500);
  }
  return null;
}

async function login(page, cfg) {
  await page.locator('button:has-text("Log In")').first().click({timeout: 15000});
  const email = page.locator('input[type="email"]').first();
  await email.waitFor({timeout: 15000}).catch(() => {});
  if (!(await email.count())) throw new NotPostedError('CMC login form did not open.');
  await email.fill(cfg.email);
  await page.locator('input[type="password"]').first().fill(cfg.password);
  await page.locator('button:has-text("Log In")').last().click();
  await page.waitForTimeout(6000);
  if (await humanCheck(page)) throw new NotPostedError('CMC showed a human check at login; it is not bypassed.');
  if (await page.locator('input[type="email"]:visible, input[inputmode="numeric"]:visible').count())
    throw new NotPostedError('CMC login did not complete (wrong password or an email verification code).');
}

async function openComposer(page) {
  await page.locator('text=All Posts').first().waitFor({timeout: 20000});
  const marked = await page.evaluate(() => {
    const h = [...document.querySelectorAll('*')].find(e => e.textContent?.trim() === 'All Posts');
    const icons = h?.parentElement ? [...h.parentElement.querySelectorAll('button, [role=button], div, span')].filter(x => x.querySelector('svg') && x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().width < 60) : [];
    icons.forEach((b, i) => b.setAttribute('data-cm-icon', String(i)));
    return icons.length;
  });
  if (!marked) throw new NotPostedError('CMC compose icon not found on the profile page.');
  await page.locator('[data-cm-icon]').last().click();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({timeout: 15000}).catch(() => {});
  if (!(await editor.count())) throw new NotPostedError('CMC post composer did not open.');
  return editor;
}

/**
 * Posts `target.text` (+ image) from our CMC profile. Returns {url} with the public post URL, or {url: null} when
 * Post was clicked but the post could not be found (it may exist).
 */
/**
 * CMC's OneTrust cookie banner can appear after the page loads and covers the Post button: accept it, and if it is
 * still there take it off the page (it is only the consent banner).
 */
async function clearCookieBanner(page) {
  await page.locator('#onetrust-accept-btn-handler, button:has-text("Accept Cookies")').first().click({timeout: 3000}).catch(() => {});
  await page.evaluate(() => document.getElementById('onetrust-consent-sdk')?.remove()).catch(() => {});
}

export const postToCmc = (target, imagePath, cfg = cmcConfig()) => withLock('cmc', () => postUnlocked(target, imagePath, cfg));

/**
 * Health check that also keeps the login alive: opens our profile, logs in again if the session lapsed (saving the
 * fresh cookies, including CMC's security token), and reports whether we could post right now.
 */
export const cmcHealth = (cfg = cmcConfig()) => withLock('cmc', async () => {
  if (cfg.cookies) { try { installCookieSession(cfg.statePath, cfg.cookies, CMC_COOKIES); } catch (e) { return {ok: false, detail: `CMC_COOKIES: ${e.message}`}; } }
  if (!existsSync(cfg.statePath) && (!cfg.email || !cfg.password)) return {ok: false, detail: 'no CMC_COOKIES or CMC_EMAIL / CMC_PASSWORD on the worker'};
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, proxy: redditProxy(cfg.proxy)});
  try {
    const context = await browser.newContext(browserContext(existsSync(cfg.statePath) ? {storageState: cfg.statePath} : {}));
    await textOnly(context);
    const page = await context.newPage();
    const profile = `${cfg.origin}/community/profile/${cfg.handle}/`;
    await page.goto(profile, {waitUntil: 'domcontentloaded', timeout: 60000});
    let state = await profileState(page);
    if (!state && await humanCheck(page)) return {ok: false, detail: 'CMC shows a human check on our profile (log in by hand once from a browser and refresh CMC_COOKIES)'};
    if (state === 'out') {
      await clearCookieBanner(page);
      try { await login(page, cfg); } catch (e) { return {ok: false, detail: `login failed: ${String(e?.message || e).split('\n')[0].slice(0, 160)}`}; }
      await page.goto(profile, {waitUntil: 'domcontentloaded', timeout: 60000});
      state = await profileState(page);
    }
    if (state !== 'in') return {ok: false, detail: state === 'out' ? 'logged out and the login did not stick' : 'profile page did not load'};
    await context.storageState({path: cfg.statePath});
    return {ok: true, detail: 'logged in'};
  } catch (e) {
    return {ok: false, detail: String(e?.message || e).split('\n')[0].slice(0, 200)};
  } finally { await browser.close(); }
});

/**
 * Self-healing: is this post on our profile? {url} when found; {absent: true} only when our post list loaded and it
 * isn't in it; otherwise {note} (could not tell).
 */
export const cmcFindPost = (text, cfg = cmcConfig()) => withLock('cmc', async () => {
  if (!existsSync(cfg.statePath)) return {note: 'no saved CMC session'};
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, proxy: redditProxy(cfg.proxy)});
  try {
    const context = await browser.newContext(browserContext({storageState: cfg.statePath}));
    await textOnly(context);
    const page = await context.newPage();
    const payloads = [];
    page.on('response', async r => { if (/gravity/i.test(r.url())) { try { payloads.push(await r.json()); } catch {} } });
    await page.goto(`${cfg.origin}/community/profile/${cfg.handle}/`, {waitUntil: 'domcontentloaded', timeout: 60000});
    for (let t = 0; t < 20000 && !payloads.some(listsPosts); t += 1000) await page.waitForTimeout(1000);
    // Match on the body, not the title line: titles repeat across a token's purchases, bodies never do.
    const body = text.split('\n\n').find((part, i) => i > 0 && part.length > 40) ?? text;
    const id = payloads.map(p => findPostContaining(p, body)).find(Boolean) ?? null;
    if (id) return {url: `${cfg.origin}/community/post/${id}/`};
    return payloads.some(listsPosts) ? {absent: true} : {note: 'our post list did not load'};
  } catch (e) { return {note: String(e?.message || e).split('\n')[0].slice(0, 160)}; } finally { await browser.close(); }
});

/** A CMC payload that lists our posts (the profile feed). */
const listsPosts = p => { let found = false; const walk = v => { if (found || !v || typeof v !== 'object') return; if (Array.isArray(v.tweetDTOList) && v.tweetDTOList.length) found = true; else Object.values(v).forEach(walk); }; walk(p); return found; };

async function postUnlocked(target, imagePath, cfg) {
  if (cfg.cookies) {
    try { installCookieSession(cfg.statePath, cfg.cookies, CMC_COOKIES); } catch (e) { throw new NotPostedError(`CMC_COOKIES: ${e.message}`); }
  }
  if (!existsSync(cfg.statePath) && (!cfg.email || !cfg.password)) throw new NotPostedError('Set CMC_COOKIES (or CMC_EMAIL and CMC_PASSWORD) on the worker.');
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, proxy: redditProxy(cfg.proxy)});
  try {
    const context = await browser.newContext(browserContext(existsSync(cfg.statePath) ? {storageState: cfg.statePath} : {}));
    const page = await context.newPage();
    const payloads = [];
    page.on('response', async r => {
      if (!/gravity/i.test(r.url())) return;
      try { payloads.push(await r.json()); } catch {}
    });
    const profile = `${cfg.origin}/community/profile/${cfg.handle}/`;
    // Everything up to the Post click sends nothing: any failure here is "not posted", safe to retry.
    let post;
    try {
    await page.goto(profile, {waitUntil: 'domcontentloaded'});
    await page.locator('button:has-text("Accept Cookies")').first().click({timeout: 5000}).catch(() => {});
    const state = await profileState(page);
    if (!state) { await snapshot(page, cfg, 'profile'); throw new NotPostedError('CMC profile page did not load (neither our Edit button nor Log In showed).'); }
    if (state === 'out') {
      await clearCookieBanner(page);
      await login(page, cfg);
      await page.goto(profile, {waitUntil: 'domcontentloaded'});
      if ((await profileState(page)) !== 'in') throw new NotPostedError(`Logged in, but ${profile} is not our editable profile (check CMC_PROFILE_HANDLE).`);
      await context.storageState({path: cfg.statePath});
    }

    await clearCookieBanner(page);
    const editor = await openComposer(page);
    await clearCookieBanner(page);
    try {
      await editor.click({timeout: 20000});
    } catch (e) {
      await snapshot(page, cfg, 'composer');
      throw new NotPostedError(`CMC post box could not be clicked (${String(e?.message || e).split('\n')[0].slice(0, 120)}); nothing was sent.`);
    }
    const lines = target.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.insertText(lines[i]);
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
    if (imagePath) {
      const input = page.locator('input[type="file"][accept*="png" i]').first();
      if (await input.count()) { await input.setInputFiles(imagePath); await page.waitForTimeout(5000); }
    }
    // CMC's security check is often an automatic one that clears by itself within seconds: give it the chance.
    for (let t = 0; t < 25000 && (await humanCheck(page)); t += 1000) await page.waitForTimeout(1000);
    if (await humanCheck(page)) { await snapshot(page, cfg, 'check'); throw new NotPostedError('CMC showed a human check before posting.'); }
    await clearCookieBanner(page);
    // Exact name: the page also has a "Posts" tab.
    post = page.getByRole('button', {name: 'Post', exact: true}).last();
    if (await post.isDisabled()) { await snapshot(page, cfg, 'disabled'); throw new NotPostedError('CMC Post button is disabled (empty post or image still uploading).'); }
    } catch (e) {
      if (e instanceof NotPostedError) throw e;
      await snapshot(page, cfg, 'before-post');
      throw new NotPostedError(`CMC: ${String(e?.message || e).split('\n')[0].slice(0, 160)}; nothing was sent.`);
    }

    // A click that never lands (something covers the button) sends nothing, so it is safe to retry.
    const before = payloads.length;
    try {
      await post.click({timeout: 20000});
    } catch (e) {
      await snapshot(page, cfg, 'unclickable');
      throw new NotPostedError(`CMC Post button could not be clicked (${String(e?.message || e).split('\n')[0].slice(0, 120)}); nothing was sent.`);
    }
    // From the click on, the post may exist: failures are "maybe posted", never retried blindly.
    // The create response carries the new post's id: take it as soon as it arrives (up to 15 s).
    let id = null;
    for (let waited = 0; !id && waited < 15000; waited += 250) {
      await page.waitForTimeout(250);
      id = payloads.slice(before).map(p => findPostId(p, null)).find(Boolean) ?? null;
    }
    if (!id) {
      payloads.length = 0;
      await page.goto(profile, {waitUntil: 'domcontentloaded'}).catch(() => {});
      await page.waitForTimeout(6000);
      id = payloads.map(p => findPostId(p, target.text)).find(Boolean) ?? null;
    }
    await context.storageState({path: cfg.statePath}).catch(() => {});
    if (!id) { await snapshot(page, cfg, 'unconfirmed'); return {url: null}; }
    return {url: `${cfg.origin}/community/post/${id}/`};
  } finally {
    await browser.close();
  }
}

/** One cycle: claim a CMC post from the service, publish it with the campaign image, report the outcome. */
export async function publishCmc(client, post = postToCmc, env = process.env) {
  if (!env.CMC_COOKIES && (!env.CMC_EMAIL || !env.CMC_PASSWORD)) return;
  const c = await client.request('publish/claim', {kinds: ['cmc_community']});
  if (!c) return;
  const dir = await mkdtemp(join(tmpdir(), 'cm-cmc-'));
  try {
    let image = null;
    if (c.target.image_asset_url) {
      const bytes = await client.asset(c.target.image_asset_url);
      image = join(dir, bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image.jpg' : 'image.png');
      await writeFile(image, bytes);
    }
    const {url} = await post(c.target, image);
    await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url});
  } catch (e) {
    if (e instanceof NotPostedError) {
      console.error(`${c.job.kind} (${c.job.order_id}) not posted: ${e.message}`);
      await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message});
    } else {
      console.error(`${c.job.kind} (${c.job.order_id}): ${e?.message || e}`);
      await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null, note: String(e?.message || e).slice(0, 300)});
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}
