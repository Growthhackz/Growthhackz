import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {NotPostedError} from './reddit.mjs';

/** CoinMarketCap community: posts from our profile page's compose icon (beside "All Posts"). */
export const cmcConfig = (env = process.env) => ({
  email: env.CMC_EMAIL,
  password: env.CMC_PASSWORD,
  handle: env.CMC_PROFILE_HANDLE || 'peakbuybot',
  origin: (env.CMC_BASE_URL || 'https://coinmarketcap.com').replace(/\/$/, ''),
  statePath: env.CMC_STATE_PATH || resolve(env.DIRECTORY_STATE_DIR || '.', 'cmc-session.json'),
  debugDir: env.DIRECTORY_DEBUG_DIR || null,
});

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const humanCheck = page => page.locator('iframe[src*="captcha"], iframe[src*="geetest"], iframe[src*="challenges.cloudflare"], .geetest_panel, [class*="captcha" i]').count();

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

async function snapshot(page, cfg, tag) {
  if (!cfg.debugDir) return;
  await mkdir(cfg.debugDir, {recursive: true});
  const base = join(cfg.debugDir, `cmc-${tag}-${Date.now()}`);
  await page.screenshot({path: base + '.png', fullPage: true}).catch(() => {});
  await writeFile(base + '.html', await page.content()).catch(() => {});
}

async function login(page, cfg) {
  await page.locator('button:has-text("Log In")').first().click();
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
export async function postToCmc(target, imagePath, cfg = cmcConfig()) {
  if (!cfg.email || !cfg.password) throw new NotPostedError('Set CMC_EMAIL and CMC_PASSWORD on the worker.');
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined});
  try {
    const context = await browser.newContext({...(existsSync(cfg.statePath) ? {storageState: cfg.statePath} : {}), viewport: {width: 1300, height: 900}});
    const page = await context.newPage();
    const payloads = [];
    page.on('response', async r => {
      if (!/gravity/i.test(r.url())) return;
      try { payloads.push(await r.json()); } catch {}
    });
    const profile = `${cfg.origin}/community/profile/${cfg.handle}/`;
    const loggedIn = () => page.locator('button:has-text("Edit")').first().isVisible().catch(() => false);
    await page.goto(profile, {waitUntil: 'domcontentloaded'});
    await page.locator('button:has-text("Accept Cookies")').first().click({timeout: 5000}).catch(() => {});
    await page.waitForTimeout(3000);
    if (!(await loggedIn())) {
      await login(page, cfg);
      await page.goto(profile, {waitUntil: 'domcontentloaded'});
      await page.waitForTimeout(3000);
      if (!(await loggedIn())) throw new NotPostedError(`Logged in, but ${profile} is not our editable profile (check CMC_PROFILE_HANDLE).`);
      await context.storageState({path: cfg.statePath});
    }

    const editor = await openComposer(page);
    await editor.click();
    const lines = target.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.insertText(lines[i]);
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
    if (imagePath) {
      const input = page.locator('input[type="file"][accept*="png" i]').first();
      if (await input.count()) { await input.setInputFiles(imagePath); await page.waitForTimeout(5000); }
    }
    if (await humanCheck(page)) throw new NotPostedError('CMC showed a human check before posting.');
    // Exact name: the page also has a "Posts" tab.
    const post = page.getByRole('button', {name: 'Post', exact: true}).last();
    if (await post.isDisabled()) { await snapshot(page, cfg, 'disabled'); throw new NotPostedError('CMC Post button is disabled (empty post or image still uploading).'); }

    // From the click on, the post may exist: failures are "maybe posted", never retried blindly.
    const before = payloads.length;
    await post.click();
    await page.waitForTimeout(6000);
    let id = payloads.slice(before).map(p => findPostId(p, null)).find(Boolean) ?? null;
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
  if (!env.CMC_EMAIL || !env.CMC_PASSWORD) return;
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
    if (e instanceof NotPostedError) await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message});
    else await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}
