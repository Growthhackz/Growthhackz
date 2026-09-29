import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {chromium} from 'playwright';

/** Nothing was submitted (login failed, CAPTCHA, rate limit, form missing): the job can safely be retried later. */
export class NotPostedError extends Error {}

const captcha = page => page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha').count();

const SAME_SITE = {no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict'};

/**
 * Turns a browser cookie export (Cookie-Editor / EditThisCookie JSON, or Playwright's own storage state) into a
 * Playwright storage state. Only reddit.com cookies are kept.
 */
export function cookiesToState(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(list)) throw new Error('REDDIT_COOKIES must be a JSON cookie export');
  const cookies = list
    .filter(c => c?.name && typeof c.value === 'string' && /(^|\.)reddit\.com$/.test(String(c.domain || '').replace(/^\./, '')))
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
  if (!cookies.some(c => c.name === 'reddit_session' || c.name === 'token_v2')) throw new Error('The cookie export has no Reddit login cookie (reddit_session / token_v2); export it while logged in.');
  return {cookies, origins: []};
}

/** Installs REDDIT_COOKIES as the saved session, once per distinct export (later refreshes by the worker are kept). */
export function installCookieSession(statePath, raw = process.env.REDDIT_COOKIES) {
  if (!raw) return false;
  const digest = createHash('sha256').update(raw).digest('hex');
  const marker = `${statePath}.source`;
  if (existsSync(statePath) && existsSync(marker) && readFileSync(marker, 'utf8') === digest) return false;
  mkdirSync(dirname(statePath), {recursive: true});
  writeFileSync(statePath, JSON.stringify(cookiesToState(raw)));
  writeFileSync(marker, digest);
  return true;
}

/** The logged-in username for the saved session, or null. Read-only. */
export async function redditWhoAmI({statePath = process.env.REDDIT_STATE_PATH || './reddit-session.json', base = process.env.REDDIT_BASE_URL || 'https://old.reddit.com', executablePath = process.env.CHROMIUM_PATH || undefined} = {}) {
  installCookieSession(statePath);
  if (!existsSync(statePath)) return null;
  const browser = await chromium.launch({headless: true, executablePath});
  try {
    const context = await browser.newContext({storageState: statePath});
    const page = await context.newPage();
    const r = await page.goto(`${base}/api/me.json`, {waitUntil: 'domcontentloaded'});
    const body = await r?.json().catch(() => null);
    await context.storageState({path: statePath});
    return body?.data?.name ?? null;
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
  const browser = await chromium.launch({headless: true, executablePath});
  try {
    const context = await browser.newContext(existsSync(statePath) ? {storageState: statePath} : {});
    const page = await context.newPage();
    const submitUrl = `${base}/r/${encodeURIComponent(target.subreddit)}/submit?selftext=true`;
    const title = page.locator('textarea[name="title"]');
    await page.goto(submitUrl, {waitUntil: 'domcontentloaded'});
    if (!(await title.count())) {
      await login(page, {username, password, loginUrl});
      await context.storageState({path: statePath});
      await page.goto(submitUrl, {waitUntil: 'domcontentloaded'});
      if (!(await title.count())) throw new NotPostedError(`Could not open the submit form for r/${target.subreddit}.`);
    }
    await title.fill(target.title);
    await page.locator('textarea[name="text"]').fill(target.text);
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
  const context = await browser.newContext();
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
    else await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null});
  }
}
