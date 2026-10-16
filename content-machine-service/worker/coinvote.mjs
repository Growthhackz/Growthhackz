import sharp from 'sharp';
import {NotOfferedError, NotPostedError} from './reddit.mjs';

/**
 * Coinvote (coinvote.cc). Its add-coin page is one script-driven form that posts to /processing/submit_project.php and
 * asks a guest to sign in first. The same page's duplicate check (/processing/coin_name_check.php) says whether a
 * contract is already listed and gives its coin page (`coin/<slug>`) even while the listing waits for review, so the
 * URL is recorded straight after submitting and no page scraping is needed.
 */

/** Coinvote's own network ids (the add-coin form's data-config). Arc is not one of them. */
export const COINVOTE_CHAINS = {bsc: 1, ethereum: 2, solana: 3, polygon: 5, arbitrum: 10, base: 13, robinhood: 20};

export const coinvoteSymbol = l => String(l.symbol ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
const absolute = (origin, path) => (path ? new URL(String(path).replace(/^\/+/, ''), origin + '/').href : null);

/**
 * Read-only: {listed: {url, live} | null, nameTaken: {suggest} | null}. `listed` is this contract on Coinvote (live or
 * in review); `nameTaken` means another coin already uses the name, with the name Coinvote proposes instead.
 */
export async function coinvoteLookup(listing, {origin = 'https://coinvote.cc', name = listing.name, fetchImpl = fetch} = {}) {
  const network = COINVOTE_CHAINS[listing.chain];
  if (!network) throw new NotOfferedError(`coinvote: chain ${listing.chain} is not offered; nothing was sent.`);
  const body = new FormData();
  body.append('name', name);
  body.append('symbol', coinvoteSymbol(listing));
  body.append(`networks[${network}]`, listing.contract_address);
  const r = await fetchImpl(`${origin}/processing/coin_name_check.php`, {method: 'POST', body, headers: {referer: `${origin}/add-coin/released`}, signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw new Error(`Coinvote's duplicate check answered HTTP ${r.status}`);
  const j = await r.json();
  return {
    listed: j?.listed ? {url: absolute(origin, j.listed.url), live: !!j.listed.live} : null,
    nameTaken: j?.name ? {suggest: j.name.suggest ?? null} : null,
  };
}

/** Logged-out review check: live once Coinvote has approved the listing. */
export async function coinvoteCheck(listing, opts = {}) {
  const {listed} = await coinvoteLookup(listing, opts);
  return listed?.live && listed.url ? {live: true, url: listed.url} : {live: false};
}

const CHAIN_LABELS = {bsc: 'BNB Chain', ethereum: 'Ethereum', solana: 'Solana', polygon: 'Polygon', arbitrum: 'Arbitrum', base: 'Base', robinhood: 'Robinhood Chain'};

/** Description within Coinvote's 20 to 2000 characters. */
export function coinvoteDescription(l) {
  const text = String(l.description || l.short_description || '').trim();
  const padded = text.length >= 20 ? text : `${l.name} (${coinvoteSymbol(l)}) is a community token on ${CHAIN_LABELS[l.chain] ?? l.chain}.${text ? ` ${text}` : ''}`;
  return padded.slice(0, 2000);
}

/** The logo as a 512×512 PNG, which Coinvote always takes (PNG/JPG/WebP/GIF, 64–4096 px, under 2 MB). */
async function logoPng(logoPath) {
  if (!logoPath) return null;
  try { return {name: 'logo.png', mimeType: 'image/png', buffer: await sharp(logoPath).resize(512, 512, {fit: 'contain', background: {r: 0, g: 0, b: 0, alpha: 0}}).png().toBuffer()}; }
  catch { return null; }
}

const formConfig = page => page.evaluate(() => { try { return JSON.parse(document.querySelector('#cv-ac-form')?.dataset.config || 'null'); } catch { return null; } });
/** Coinvote's own flag (what its form checks before sending), else the form's config, else a visible Login button. */
async function signedIn(page) {
  const logged = await page.evaluate(() => window.coinvote?.isLogged).catch(() => undefined);
  if (logged !== undefined) return !!logged;
  const c = await formConfig(page);
  if (typeof c?.guest === 'boolean') return !c.guest;
  return !(await page.locator('[data-ref-modal="login"]:visible').count());
}

/** The launch announcement and the "how do you want to start" dialog sit over the form: their own close buttons. */
async function closeOverlays(page) {
  for (const sel of ['#cv-v3-launchpad-announce button:has-text("Close")', '#cv-ac-start.show [data-start-skip].btn-close', '#cv-ac-start.show [data-start-skip]']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) { await b.click({timeout: 5000}).catch(() => {}); await page.waitForTimeout(600); }
  }
}

/** Signs in through Coinvote's login dialog. A security check it raises is only ever waited on, never answered for it. */
async function signIn(page, cfg) {
  if (!cfg.username || !cfg.password) throw new NotPostedError('coinvote: the saved session has expired; set COINVOTE_EMAIL and COINVOTE_PASSWORD (or fresh COINVOTE_COOKIES) on the worker.');
  await page.locator('[data-ref-modal="login"]:visible').first().click({timeout: 15000});
  const form = page.locator('#login_form');
  await form.waitFor({state: 'visible', timeout: 20000});
  await form.locator('input[name="username"]').fill(cfg.username);
  await form.locator('input[name="password"]').fill(cfg.password);
  const answers = [];
  page.on('response', async r => { if (/\/api\/login\b/.test(r.url()) && r.request().method() === 'POST') answers.push({ok: r.ok(), body: await r.json().catch(() => ({}))}); });
  await form.locator('[type="submit"]').click({timeout: 15000});
  for (let t = 0; t < (cfg.humanCheckMs ?? 45000) && !answers.some(a => a.ok); t += 1500) {
    await page.waitForTimeout(1500);
    const last = answers.at(-1);
    if (last && !last.ok && !last.body?.captchaRequired) throw new NotPostedError(`coinvote: login refused (${String(last.body?.message || 'no reason given').slice(0, 120)}); nothing was sent.`);
  }
  if (!answers.some(a => a.ok)) throw new NotPostedError(answers.length ? 'coinvote: the login asked for a human check that did not pass by itself; nothing was sent.' : 'coinvote: the login got no answer; nothing was sent.');
  await page.waitForTimeout(2000);
}

/**
 * Opens the add-coin form signed in. Returns once `#cv-ac-form` is there and Coinvote treats us as signed in, saving
 * the session for next time.
 */
async function openForm(page, context, cfg) {
  const url = cfg.origin + cfg.submit;
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.locator('#cv-ac-form').waitFor({timeout: 30000}).catch(() => { throw new NotPostedError(`coinvote: the add-coin form did not load (${page.url().split('?')[0]}); nothing was sent.`); });
  await closeOverlays(page);
  if (!(await signedIn(page))) {
    await signIn(page, cfg);
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    await page.locator('#cv-ac-form').waitFor({timeout: 30000});
    await closeOverlays(page);
    if (!(await signedIn(page))) throw new NotPostedError('coinvote: still signed out after logging in; nothing was sent.');
  }
  await context.storageState({path: cfg.statePath}).catch(() => {});
}

/** Fills the form; checks what it filled. Sends nothing. */
export async function fillCoinvote(page, listing, logoPath, name) {
  const network = COINVOTE_CHAINS[listing.chain];
  // Contract first: Coinvote may prefill name/description from it, which the fields below then overwrite.
  await page.locator('#cv-ac-address').fill(listing.contract_address);
  const details = page.locator('details.cv-ac-more:has(#cv-ac-manual-chains)');
  if (!(await details.evaluate(d => d.open).catch(() => false))) await details.locator('summary').click();
  await page.locator(`#cv-ac-manual-chains .cv-ac-chip[data-chain="${network}"]`).click({timeout: 10000});
  await page.waitForTimeout(1500);
  const added = await page.locator(`input[type="hidden"][name="networks[${network}]"]`).inputValue().catch(() => null);
  if (added !== listing.contract_address) throw new NotPostedError(`coinvote: the contract address was not taken (network ${network}); nothing was sent.`);
  const logo = await logoPng(logoPath);
  if (logo) await page.locator('#cv-ac-logo').setInputFiles(logo);
  await page.locator('#cv-ac-name').fill(name);
  await page.locator('#cv-ac-symbol').fill(coinvoteSymbol(listing));
  await page.locator('#cv-ac-category').selectOption('2'); // Meme Token
  await page.locator('input[name="launch_type"][value="released"]').check();
  await page.locator('#cv-ac-description').fill(coinvoteDescription(listing));
  const socials = {telegram: listing.telegram_url, website: listing.website_url, twitter: listing.x_url};
  for (const [k, v] of Object.entries(socials)) if (v) await page.locator(`[name="socials[${k}]"]`).fill(v);
  if (!Object.values(socials).some(Boolean)) throw new NotPostedError('coinvote: needs a website or a social link, and the project has none; nothing was sent.');
  await page.waitForTimeout(1500);
}

/** Field errors the form shows (its own validation), or ''. */
const formErrors = page => page.locator('#cv-ac-form .cv-ac-error:visible').allInnerTexts().then(t => t.map(s => s.trim()).filter(Boolean).join('; ')).catch(() => '');

/**
 * Signs in, fills and submits. {submitted: true, url} with the coin page (in review until Coinvote approves it), or
 * {submitted: true, url, note: 'already on Coinvote'} without sending anything. NotPostedError whenever nothing went
 * out; NotOfferedError for a chain Coinvote doesn't list. `dryRun` stops before the submit click.
 */
export async function coinvoteSubmit({browser, sessionContext, contextOptions, snapshot = async () => {}}, cfg, listing, logoPath, {dryRun = false, fetchImpl = fetch} = {}) {
  const before = await coinvoteLookup(listing, {origin: cfg.origin, fetchImpl}).catch(e => { if (e instanceof NotPostedError) throw e; throw new NotPostedError(`coinvote: duplicate check failed (${e.message}); nothing was sent.`); });
  if (before.listed && !dryRun) return {submitted: true, url: before.listed.url, note: before.listed.live ? 'already on Coinvote' : 'already submitted to Coinvote, in review'};
  // Another coin has the name: Coinvote's own suggestion (e.g. "Bul Sol"), else the name with the ticker.
  const name = before.nameTaken ? (before.nameTaken.suggest || `${listing.name} ${coinvoteSymbol(listing)}`) : listing.name;
  const context = await sessionContext(browser, cfg.statePath, contextOptions);
  const page = await context.newPage();
  try {
    // Everything up to the submit click sends nothing, so any failure there is safe to retry.
    try {
      await openForm(page, context, cfg);
      await fillCoinvote(page, listing, logoPath, name);
    } catch (e) {
      if (e instanceof NotPostedError) throw e;
      await snapshot(page, 'unfilled');
      throw new NotPostedError(`coinvote: could not open or fill the form (${String(e?.message || e).split('\n')[0].slice(0, 160)}); nothing was sent.`);
    }
    if (dryRun) { await snapshot(page, 'dryrun'); return {submitted: false, dryRun: true, name, form: await page.evaluate(() => [...new FormData(document.querySelector('#cv-ac-form')).entries()].map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 80) : `file:${v.name}:${v.size}`]))}; }
    const answers = [];
    page.on('response', async r => { if (/\/processing\/submit_project\.php/.test(r.url()) && r.request().method() === 'POST') answers.push({ok: r.ok(), status: r.status(), body: await r.json().catch(() => ({}))}); });
    const submit = page.locator('#cv-ac-submit');
    // A click that never happens sent nothing; from a completed click on, the listing may have been sent.
    await submit.click({trial: true, timeout: 15000}).catch(async e => { await snapshot(page, 'unclickable'); throw new NotPostedError(`coinvote: submit button not clickable (${String(e.message).split('\n')[0].slice(0, 120)}); nothing was sent.`); });
    await submit.click();
    // Coinvote may ask for its security check (an invisible one that passes by itself and resubmits). Never answered for it.
    for (let t = 0; t < (cfg.humanCheckMs ?? 60000) && !answers.some(a => a.ok); t += 1500) {
      await page.waitForTimeout(1500);
      const last = answers.at(-1);
      if (last && !last.ok && !last.body?.captchaRequired) break;
      if (!answers.length && t >= 6000) {
        const shown = await formErrors(page);
        if (shown) { await snapshot(page, 'invalid'); throw new NotPostedError(`coinvote: the form refused the details (${shown.slice(0, 200)}); nothing was sent.`); }
        if (await page.locator('#login_form:visible').count()) throw new NotPostedError('coinvote: signed out at submit; nothing was sent.');
      }
    }
    const ok = answers.find(a => a.ok);
    if (!ok) {
      const last = answers.at(-1);
      await snapshot(page, 'rejected');
      if (!last) throw new NotPostedError('coinvote: the submit got no answer; nothing was sent.');
      if (last.body?.captchaRequired) throw new NotPostedError('coinvote: asked for a human check that did not pass by itself; the listing was not sent.');
      if (last.body?.conflict?.type === 'listed') {
        const again = await coinvoteLookup(listing, {origin: cfg.origin, fetchImpl}).catch(() => null);
        return {submitted: true, url: again?.listed?.url ?? null, note: 'already on Coinvote'};
      }
      const why = last.body?.errors ? Object.entries(last.body.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : last.body?.message || `HTTP ${last.status}`;
      throw new NotPostedError(`coinvote rejected the listing (${String(why).slice(0, 200)}); nothing was listed.`);
    }
    // Sent. The duplicate check now has the coin page (in review). The paid "launch boost" offer that opens is left alone.
    let after = null;
    for (let i = 0; i < 3 && !after?.listed; i++) { if (i) await page.waitForTimeout(3000); after = await coinvoteLookup(listing, {origin: cfg.origin, name, fetchImpl}).catch(() => null); }
    return {submitted: true, url: after?.listed?.url ?? null, ...(ok.body?.itemId ? {item_id: ok.body.itemId} : {})};
  } finally { await context.close().catch(() => {}); }
}
