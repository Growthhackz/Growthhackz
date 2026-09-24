import {existsSync} from 'node:fs';
import {chromium} from 'playwright';

/** Nothing was submitted (login failed, CAPTCHA, rate limit, form missing): the job can safely be retried later. */
export class NotPostedError extends Error {}

const captcha = page => page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha').count();

async function login(page, {username, password, loginUrl}) {
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
  if (!username || !password) throw new NotPostedError('Set REDDIT_USERNAME and REDDIT_PASSWORD on the worker.');
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
  if (!process.env.REDDIT_USERNAME) return;
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
