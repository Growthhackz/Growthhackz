import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {chromium} from 'playwright';

/** Nothing was submitted (login failed, CAPTCHA, rate limit, form missing): the job can safely be retried later. */
export class NotPostedError extends Error {}

/** Opens a page and waits out Reddit's JavaScript challenge (served to browsers on new networks). */
export async function gotoSettled(page, url) {
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  // Done once the page has stopped navigating and no challenge script is left on it.
  for (let i = 0; i < 10; i++) {
    const before = page.url();
    await page.waitForLoadState('networkidle', {timeout: 10000}).catch(() => {});
    await page.waitForTimeout(1500);
    const challenged = (await page.locator('script[src*="challenge"], #challenge-form').count().catch(() => 1)) > 0;
    if (!challenged && page.url() === before) return;
  }
}

const captcha = page => page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha').count();

/** A regular desktop Chrome identity; headless Chromium otherwise announces itself as "HeadlessChrome", which sites block. */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const browserContext = (extra = {}) => ({userAgent: BROWSER_UA, locale: 'en-US', viewport: {width: 1366, height: 900}, ...extra});

/** REDDIT_PROXY (http://user:pass@host:port): Reddit blocks datacenter networks, so only Reddit traffic goes through it. */
export function redditProxy(raw = process.env.REDDIT_PROXY) {
  if (!raw) return undefined;
  const u = new URL(raw);
  return {server: `${u.protocol}//${u.host}`, ...(u.username ? {username: decodeURIComponent(u.username), password: decodeURIComponent(u.password)} : {})};
}

const SAME_SITE = {no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict'};

/**
 * Turns a browser cookie export (Cookie-Editor / EditThisCookie JSON, or Playwright's own storage state) into a
 * Playwright storage state. Only reddit.com cookies are kept.
 */
const REDDIT_COOKIES = {domain: /(^|\.)reddit\.com$/, isLogin: n => n === 'reddit_session' || n === 'token_v2', label: 'Reddit login cookie (reddit_session / token_v2)'};

export function cookiesToState(raw, site = REDDIT_COOKIES) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(list)) throw new Error('REDDIT_COOKIES must be a JSON cookie export');
  const cookies = list
    .filter(c => c?.name && typeof c.value === 'string' && site.domain.test(String(c.domain || '').replace(/^\./, '')))
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') || c.hostOnly === false ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : c.domain,
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate) : -1,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: SAME_SITE[String(c.sameSite || '').toLowerCase()] ?? (['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'),
    }));
  if (!cookies.some(c => site.isLogin(c.name))) throw new Error(`The cookie export has no ${site.label}; export it while logged in.`);
  return {cookies, origins: []};
}

/** Installs REDDIT_COOKIES as the saved session, once per distinct export (later refreshes by the worker are kept). */
export function installCookieSession(statePath, raw = process.env.REDDIT_COOKIES, site = REDDIT_COOKIES) {
  if (!raw) return false;
  const digest = createHash('sha256').update(raw).digest('hex') + ':v2';
  const marker = `${statePath}.source`;
  if (existsSync(statePath) && existsSync(marker) && readFileSync(marker, 'utf8') === digest) return false;
  mkdirSync(dirname(statePath), {recursive: true});
  writeFileSync(statePath, JSON.stringify(cookiesToState(raw, site)));
  writeFileSync(marker, digest);
  return true;
}

/** The logged-in username for the saved session, or null. Read-only. */
export async function redditWhoAmI({statePath = process.env.REDDIT_STATE_PATH || './reddit-session.json', base = process.env.REDDIT_BASE_URL || 'https://old.reddit.com', executablePath = process.env.CHROMIUM_PATH || undefined} = {}) {
  installCookieSession(statePath);
  if (!existsSync(statePath)) return null;
  const browser = await chromium.launch({headless: true, executablePath, proxy: redditProxy()});
  try {
    const context = await browser.newContext(browserContext({storageState: statePath}));
    const page = await context.newPage();
    await gotoSettled(page, `${base}/api/me.json`);
    const text = await page.locator('body').innerText().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch {}
    const name = body?.data?.name ?? null;
    // Diagnostics without secrets: where Reddit sent us and what it said.
    if (!name) console.log('Reddit session check:', page.url().split('?')[0], '|', text.replace(/\s+/g, ' ').slice(0, 200));
    return name;
  } finally { await browser.close(); }
}

async function login(page, {username, password, loginUrl}) {
  if (!username || !password) throw new NotPostedError('The Reddit session has expired: export fresh cookies into REDDIT_COOKIES on the worker.');
  await page.goto(loginUrl, {waitUntil: 'domcontentloaded'});
  if (await captcha(page)) throw new NotPostedError('Reddit showed a CAPTCHA at login; log in once by hand to refresh the session.');
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', {name: /^log in$/i}).click();
  try { await page.waitForURL(u => !/\/login/.test(u.pathname), {timeout: 30000}); }
  catch { throw new NotPostedError('Reddit login did not complete (wrong password, 2FA or a check page).'); }
}

/**
 * Posts one text post (title + body) to a subreddit through old.reddit's submit form, then checks it logged-out.
 * Returns {url, verified}. url=null means we clicked submit but could not see a result: the post may exist.
 */
export async function postToReddit(target, {
  username = process.env.REDDIT_USERNAME,
  password = process.env.REDDIT_PASSWORD,
  statePath = process.env.REDDIT_STATE_PATH || './reddit-session.json',
  base = process.env.REDDIT_BASE_URL || 'https://old.reddit.com',
  loginUrl = process.env.REDDIT_LOGIN_URL || 'https://www.reddit.com/login/',
  executablePath = process.env.CHROMIUM_PATH || undefined,
} = {}) {
  try { installCookieSession(statePath); } catch (e) { throw new NotPostedError(`REDDIT_COOKIES: ${e.message}`); }
  if ((!username || !password) && !existsSync(statePath)) throw new NotPostedError('Set REDDIT_COOKIES (a cookie export from a logged-in browser) on the worker.');
  const browser = await chromium.launch({headless: true, executablePath, proxy: redditProxy()});
  try {
    const context = await browser.newContext(browserContext(existsSync(statePath) ? {storageState: statePath} : {}));
    // Reddit now sends old.reddit's submit page to the new editor, so post through the endpoint old.reddit's form uses:
    // same logged-in session and proxy; it answers with the post URL or Reddit's own error. No session: the form below.
    const me = await context.request.get(`${base}/api/me.json`, {headers: {accept: 'application/json'}}).then(r => (r.ok() ? r.json() : null)).catch(() => null);
    const modhash = me?.data?.modhash;
    if (modhash) {
      const res = await context.request.post(`${base}/api/submit`, {
        form: {api_type: 'json', kind: 'self', sr: target.subreddit, title: target.title, text: target.text, uh: modhash, resubmit: 'true', sendreplies: 'true'},
        headers: {'x-modhash': modhash, accept: 'application/json'},
      });
      let body = null;
      try { body = await res.json(); } catch {}
      const errors = body?.json?.errors ?? [];
      if (errors.length) throw new NotPostedError(`Reddit rejected the post in r/${target.subreddit}: ${errors.map(e => [].concat(e).join(' ')).join('; ').slice(0, 250)}`);
      const posted = body?.json?.data?.url;
      if (posted) {
        await context.storageState({path: statePath});
        const url = posted.replace(/^https?:\/\/(old|www)\.reddit\.com/, 'https://www.reddit.com');
        return {url, verified: await visibleLoggedOut(browser, url, target.title)};
      }
      // A clear refusal (4xx without a post) sent nothing; anything else may have posted.
      if (res.status() >= 400 && res.status() < 500) throw new NotPostedError(`Reddit refused the submission (HTTP ${res.status()}).`);
      return {url: null, verified: false};
    }
    const page = await context.newPage();
    const submitUrl = `${base}/r/${encodeURIComponent(target.subreddit)}/submit?selftext=true`;
    const title = page.locator('textarea[name="title"]');
    await gotoSettled(page, submitUrl);
    if (!(await title.count())) {
      await login(page, {username, password, loginUrl});
      await context.storageState({path: statePath});
      await gotoSettled(page, submitUrl);
      if (!(await title.count())) throw new NotPostedError(`Could not open the submit form for r/${target.subreddit}.`);
    }
    // Some subreddits don't take text posts: the form then has no body box. Say what the page offers; nothing is sent.
    const body = page.locator('textarea[name="text"]');
    if (!(await body.count())) {
      const offers = await page.locator('form#newlink input[name="kind"], .tabmenu.formtab a').evaluateAll(els => els.map(e => (e.value || e.textContent || '').trim()).filter(Boolean)).catch(() => []);
      const note = (await page.locator('.submit_text, .md, .infobar').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      throw new NotPostedError(`r/${target.subreddit} has no text-post box (post types offered: ${offers.join(', ') || 'none shown'}; page: ${page.url().split('?')[0]}${note ? `; says: ${note}` : ''}).`);
    }
    await title.fill(target.title);
    await body.fill(target.text);
    if (await captcha(page)) throw new NotPostedError('Reddit showed a CAPTCHA on the submit form.');

    // From here on the post may exist, so failures are reported as "maybe posted", never retried blindly.
    await page.locator('button[name="submit"]').click();
    let url = null;
    try {
      await page.waitForURL(/\/comments\/[a-z0-9]+/, {timeout: 30000});
      url = page.url();
    } catch {
      const err = (await page.locator('.error:visible, .status:visible').allInnerTexts().catch(() => [])).join(' ').trim();
      // Reddit's own rejections (rate limit, subreddit restrictions) come back on the form without posting.
      if (err && (await title.count())) throw new NotPostedError(`Reddit rejected the post: ${err.slice(0, 200)}`);
      return {url: null, verified: false};
    }
    await context.storageState({path: statePath});
    return {url, verified: await visibleLoggedOut(browser, url, target.title)};
  } finally {
    await browser.close();
  }
}

async function visibleLoggedOut(browser, url, title) {
  const context = await browser.newContext(browserContext());
  try {
    const page = await context.newPage();
    const r = await page.goto(url, {waitUntil: 'domcontentloaded'});
    return !!r?.ok() && (await page.content()).includes(title.replace(/&/g, '&amp;').slice(0, 60));
  } catch { return false; } finally { await context.close(); }
}

/** One cycle: claim a Reddit post from the service, publish it, report the outcome. */
export async function publishReddit(client, post = postToReddit) {
  if (!process.env.REDDIT_USERNAME && !process.env.REDDIT_COOKIES) return;
  const c = await client.request('publish/claim', {kinds: ['reddit_moonshots', 'reddit_solanamemecoins']});
  if (!c) return;
  try {
    const {url, verified} = await post(c.target);
    await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url, verified});
  } catch (e) {
    if (e instanceof NotPostedError) await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message});
    else { console.error(`${c.job.kind} (${c.job.order_id}): ${e?.message || e}`); await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null, note: String(e?.message || e).slice(0, 300)}); }
  }
}
