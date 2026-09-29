import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {NotPostedError} from './reddit.mjs';

/** 1888PressRelease: login, submit form → preview page → final submit; reviewed by the site before it goes live. */
export const pressConfig = (env = process.env) => ({
  origin: (env.PRESS1888_BASE_URL || 'https://www.1888pressrelease.com').replace(/\/$/, ''),
  username: env.PRESS1888_USERNAME,
  password: env.PRESS1888_PASSWORD,
  /** The issuing company, created once in the 1888 dashboard (its name can't be changed there). */
  company: env.PRESS1888_COMPANY,
  contact: env.PRESS_CONTACT_NAME,
  email: env.PRESS_CONTACT_EMAIL,
  phone: env.PRESS_CONTACT_PHONE || '',
  zip: env.PRESS_CONTACT_ZIP || '',
  country: env.PRESS_COUNTRY || 'United States',
  statePath: resolve(env.DIRECTORY_STATE_DIR || '.', 'press1888-session.json'),
  debugDir: env.DIRECTORY_DEBUG_DIR || null,
});

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function snapshot(page, cfg, tag) {
  if (!cfg.debugDir) return;
  await mkdir(cfg.debugDir, {recursive: true});
  const base = join(cfg.debugDir, `press1888-${tag}-${Date.now()}`);
  await page.screenshot({path: base + '.png', fullPage: true}).catch(() => {});
  await writeFile(base + '.html', await page.content()).catch(() => {});
}

/** Selects the first option matching the earliest pattern in `prefs` (patterns in order of preference). */
async function selectBy(page, name, prefs, required = true) {
  const sel = page.locator(`select[name="${name}"]`);
  if (!(await sel.count())) { if (required) throw new NotPostedError(`1888 form has no ${name} field.`); return; }
  const options = await sel.locator('option').evaluateAll(os => os.map(o => ({value: o.value, text: o.textContent.trim()})));
  let pick;
  for (const re of [].concat(prefs)) if ((pick = options.find(o => o.value && re.test(o.text)))) break;
  if (!pick && required) throw new NotPostedError(`1888 ${name}: no option matching ${[].concat(prefs).join(' or ')}.`);
  if (pick) await sel.selectOption(pick.value);
}

/**
 * Returns {submitted: true} when 1888 confirms receipt, {submitted: false} when the final click's outcome is unclear.
 * Throws NotPostedError when nothing was sent (login, missing company, validation alerts, no final submit button).
 */
export async function submitRelease(release, cfg = pressConfig()) {
  const missing = [['PRESS1888_USERNAME', cfg.username], ['PRESS1888_PASSWORD', cfg.password], ['PRESS1888_COMPANY', cfg.company], ['PRESS_CONTACT_NAME', cfg.contact], ['PRESS_CONTACT_EMAIL', cfg.email]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new NotPostedError(`Set ${missing.join(', ')} on the worker.`);
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined});
  try {
    const context = await browser.newContext(existsSync(cfg.statePath) ? {storageState: cfg.statePath} : {});
    const page = await context.newPage();
    const alerts = [];
    page.on('dialog', d => { alerts.push(d.message()); d.accept().catch(() => {}); });
    const submitUrl = `${cfg.origin}/submit-free-press-release.html`;
    const onForm = async () => (await page.locator('form[name="pressreleaseform"]').count()) > 0;

    await page.goto(submitUrl, {waitUntil: 'domcontentloaded', timeout: 120000});
    if (!(await onForm())) {
      await page.goto(`${cfg.origin}/login.html`, {waitUntil: 'domcontentloaded', timeout: 120000});
      await page.locator('input[name="txtusername"]').fill(cfg.username);
      await page.locator('input[name="txtpassword"]').fill(cfg.password);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.locator('form[name="login"] input[type="image"], form[name="login"] [type="submit"]').first().click()]);
      await page.waitForTimeout(2000);
      await page.goto(submitUrl, {waitUntil: 'domcontentloaded', timeout: 120000});
      if (!(await onForm())) throw new NotPostedError('1888 login failed or the submit form is not reachable.');
      await context.storageState({path: cfg.statePath});
    }

    // The company comes first: selecting it can prefill the contact fields, which we then set.
    const company = page.locator('select[name="txtcompanyname"]');
    const companies = await company.locator('option').evaluateAll(os => os.map(o => ({value: o.value, text: o.textContent.trim()})));
    const ours = companies.find(o => o.value && o.text.toLowerCase() === cfg.company.toLowerCase()) ?? companies.find(o => o.value && o.text.toLowerCase().includes(cfg.company.toLowerCase()));
    if (!ours) throw new NotPostedError(`Company "${cfg.company}" is not on the 1888 account yet; add it under Add/Manage Company.`);
    await company.selectOption(ours.value);

    await page.locator('textarea[name="txtheadline"]').fill(release.headline);
    await page.locator('textarea[name="txtsummary"]').fill(release.summary);
    await page.locator('textarea[name="txt1888pressrelease"]').fill(release.body);
    await page.locator('input[name="txtkeywords"]').fill(release.keywords);
    await selectBy(page, 'cmbprtypesuggest', [/general press release/i, /announcement/i, /product launch/i]);
    await selectBy(page, 'cmbcategory', [/financ/i, /business/i, /internet|technology/i]);
    await selectBy(page, 'cmbcountry', new RegExp(`^${cfg.country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), false);
    await selectBy(page, 'cmbmsa', [/none|not applicable/i, /other/i, /.+/], false);
    if (release.website_url) await page.locator('input[name="txturl"]').fill(release.website_url);
    await page.locator('input[name="txtemail"]').fill(cfg.email);
    await page.locator('input[name="txtcontactname"]').fill(cfg.contact);
    if (cfg.phone) await page.locator('input[name="txtphone"]').fill(cfg.phone);
    if (cfg.zip) await page.locator('input[name="txtzipcode"]').fill(cfg.zip);
    for (const name of ['chk1', 'chk2', 'chk3']) { const b = page.locator(`input[name="${name}"]`); if (await b.count()) await b.check(); }

    // Step 1 goes to preview.php; the form's own validation alerts mean nothing was sent.
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.locator('form[name="pressreleaseform"] input[type="image"], form[name="pressreleaseform"] [type="submit"]').last().click()]);
    await page.waitForTimeout(3000);
    if (await onForm()) { await snapshot(page, cfg, 'rejected'); throw new NotPostedError(`1888 rejected the form: ${alerts.join(' | ').slice(0, 300) || 'no message'}`); }
    const final = page.locator('input[type="submit"], input[type="image"], button').filter({hasNotText: /edit|back|modify|cancel/i});
    // Image buttons often carry their meaning only in the image file name (e.g. submit_btn.gif).
    const candidates = await final.evaluateAll(els => els.map((e, i) => ({i, label: `${e.value || ''} ${e.alt || ''} ${e.name || ''} ${e.id || ''} ${e.title || ''} ${e.getAttribute('src') || ''} ${e.textContent || ''}`.replace(/\s+/g, ' ').trim().toLowerCase()})));
    const pick = candidates.find(c => /submit|confirm|publish|post|continue|proceed|send|finish|complete/.test(c.label) && !/edit|back|modify|search|subscribe|newsletter|login/.test(c.label));
    if (!pick) {
      await snapshot(page, cfg, 'preview');
      const seen = candidates.map(c => c.label.slice(0, 40)).filter(Boolean).slice(0, 8).join(' | ') || 'none';
      throw new NotPostedError(`1888 preview page had no final submit button; nothing was sent. Page: ${page.url().slice(0, 100)}; buttons seen: ${seen}`);
    }

    // From the final click on, the release may have been sent.
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), final.nth(pick.i).click()]);
    await page.waitForTimeout(3000);
    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/thank you|successfully|has been (submitted|received)|pending (review|approval)|under review|will be reviewed/.test(text)) return {submitted: true};
    await snapshot(page, cfg, 'unconfirmed');
    return {submitted: false};
  } finally {
    await browser.close();
  }
}

const datePath = d => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}.html`;

/** Logged-out check of 1888's public daily news pages for our release, from the submission day to today. */
export async function checkRelease(release, submission = {}, cfg = pressConfig(), http = fetch, now = new Date()) {
  const prefix = slug(release.headline).slice(0, 40);
  const start = new Date(Date.parse(submission.submitted_at || now.toISOString()));
  for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); d >= new Date(start.getTime() - 86_400_000); d = new Date(d.getTime() - 86_400_000)) {
    const r = await http(`${cfg.origin}/${datePath(d)}`, {signal: AbortSignal.timeout(120_000)}).catch(() => null);
    if (!r?.ok) continue;
    const html = await r.text();
    const href = [...html.matchAll(/href="([^"]+-pr-\d+\.html)"/g)].map(m => m[1]).find(h => new URL(h, cfg.origin).pathname.slice(1).startsWith(prefix));
    if (href) return {live: true, url: new URL(href, cfg.origin).href};
  }
  return {live: false};
}

/** One cycle: submit one due release, then check one release that is waiting for review. */
export async function pressCycle(client, {submit = submitRelease, check = checkRelease, env = process.env} = {}) {
  if (!env.PRESS1888_USERNAME || !env.PRESS1888_PASSWORD) return;
  const c = await client.request('publish/claim', {kinds: ['press_1888']});
  if (c) {
    try {
      const r = await submit(c.target.release);
      await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, submitted: r.submitted, url: null});
    } catch (e) {
      if (e instanceof NotPostedError) { console.error(`${c.job.kind} (${c.job.order_id}) not posted: ${e.message}`); await client.request(`publish/${c.job.id}/fail`, {lease: c.job.lease, error: e.message}); }
      else {
        console.error(`${c.job.kind} (${c.job.order_id}): ${e?.message || e}`);
        await client.request(`publish/${c.job.id}/complete`, {lease: c.job.lease, url: null, note: String(e?.message || e).slice(0, 300)});
      }
    }
  }
  const due = await client.request('listings/check-claim', {kinds: ['press_1888']});
  if (due) {
    const r = await check(due.target.release, due.submission).catch(() => ({live: false}));
    await client.request(`listings/${due.job.id}/checked`, r);
  }
}
