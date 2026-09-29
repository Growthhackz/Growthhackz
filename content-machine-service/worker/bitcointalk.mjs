import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {installCookieSession,NotPostedError} from './reddit.mjs';

/** Bitcointalk (SMF): posts a new thread from a saved browser session. Login has a captcha, so there is no password login. */
export const BTC_COOKIES = {domain: /(^|\.)bitcointalk\.org$/, isLogin: n => /^SMFCookie\d+$/.test(n), label: 'Bitcointalk login cookie (SMFCookie…)'};

export const btcConfig = (env = process.env) => ({
  origin: (env.BTCTALK_BASE_URL || 'https://bitcointalk.org').replace(/\/$/, ''),
  board: env.BTCTALK_BOARD || '67',
  cookies: env.BTCTALK_COOKIES,
  statePath: env.BTCTALK_STATE_PATH || resolve(env.DIRECTORY_STATE_DIR || '.', 'btctalk-session.json'),
  executablePath: env.CHROMIUM_PATH || undefined,
});

const humanCheck = page => page.locator('iframe[src*="captcha"], .h-captcha, .g-recaptcha, input[name="post_vv[code]"], img[src*="verificationcode"]').count();

export function topicUrl(origin, url) {
  const m = /[?&;]topic=(\d+)/.exec(url);
  return m ? `${origin}/index.php?topic=${m[1]}.0` : null;
}

/**
 * Starts one thread on the configured board. Returns {url, verified}; url=null means Post was clicked but the thread
 * could not be found (it may exist). Throws NotPostedError when nothing was sent.
 */
export async function postToBitcointalk(target, cfg = btcConfig()) {
  try { installCookieSession(cfg.statePath, cfg.cookies, BTC_COOKIES); } catch (e) { throw new NotPostedError(`BTCTALK_COOKIES: ${e.message}`); }
  if (!existsSync(cfg.statePath)) throw new NotPostedError('Set BTCTALK_COOKIES (a cookie export from a browser logged in to Bitcointalk) on the worker.');
  const browser = await chromium.launch({headless: true, executablePath: cfg.executablePath});
  try {
    const context = await browser.newContext({storageState: cfg.statePath});
    const page = await context.newPage();
    await page.goto(`${cfg.origin}/index.php?action=post;board=${cfg.board}.0`, {waitUntil: 'domcontentloaded', timeout: 60000});
    const message = page.locator('textarea[name="message"]');
    if (!(await message.count())) {
      const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new NotPostedError(`Bitcointalk post form not available (session expired or not allowed): ${text}`);
    }
    if (await humanCheck(page)) throw new NotPostedError('Bitcointalk asked for a captcha on the post form; it is not bypassed.');
    await page.locator('input[name="subject"]').fill(target.subject.slice(0, 80));
    await message.fill(target.message);
    const back = page.locator('input[name="goback"]');
    if (await back.count()) await back.check();

    // From the click on, the thread may exist: failures are "maybe posted", never retried blindly.
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.locator('input[name="post"]').click()]);
    await page.waitForTimeout(2000);
    let url = topicUrl(cfg.origin, page.url());
    if (!url) {
      const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      // SMF re-shows the form with its error list when it refuses a post (e.g. the time limit between posts).
      if ((await message.count()) && /error or errors occurred|spam protection|wait|not allowed/i.test(body))
        throw new NotPostedError(`Bitcointalk refused the post: ${(/while posting this message:?\s*(.{0,250})/i.exec(body)?.[1] ?? body.slice(0, 250)).trim()}`);
      const link = await page.locator(`a:has-text("${target.subject.slice(0, 40).replace(/"/g, '')}")`).first().getAttribute('href').catch(() => null);
      url = link ? topicUrl(cfg.origin, link) : null;
    }
    await context.storageState({path: cfg.statePath}).catch(() => {});
    if (!url) return {url: null, verified: false};
    // Confirm it logged-out.
    const anon = await browser.newContext();
    const p2 = await anon.newPage();
    const r = await p2.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000}).catch(() => null);
    const html = r?.ok() ? await p2.content() : '';
    return {url, verified: html.includes(target.subject.slice(0, 40).replace(/&/g, '&amp;'))};
  } finally {
    await browser.close();
  }
}

/** One cycle: claim a Bitcointalk thread from the service, post it, report the outcome. */
export async function publishBitcointalk(client, post = postToBitcointalk, env = process.env) {
  if (!env.BTCTALK_COOKIES) return;
  const c = await client.request('publish/claim', {kinds: ['bitcointalk']});
  if (!c) return;
  try {
    const {url, verified} = await post(c.target);
    await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url, verified});
  } catch (e) {
    if (e instanceof NotPostedError) await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message});
    else await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null});
  }
}

/** Logged-in member name for the saved session, or null. Read-only. */
export async function btcWhoAmI(cfg = btcConfig()) {
  installCookieSession(cfg.statePath, cfg.cookies, BTC_COOKIES);
  if (!existsSync(cfg.statePath)) return null;
  const browser = await chromium.launch({headless: true, executablePath: cfg.executablePath});
  try {
    const page = await (await browser.newContext({storageState: cfg.statePath})).newPage();
    await page.goto(`${cfg.origin}/index.php?action=profile`, {waitUntil: 'domcontentloaded', timeout: 60000});
    const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const name = /Name:\s*(\S+)/.exec(text)?.[1] ?? null;
    if (!name || !/logout/i.test(await page.content())) { console.log('Bitcointalk session check:', text.slice(0, 200)); return null; }
    return name;
  } finally { await browser.close(); }
}
