import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {NotPostedError, redditProxy} from './reddit.mjs';

/**
 * Token info submissions that need a browser wallet connected to the site: OKX Wallet (web3.okx.com "Update token
 * info") and Bitget Wallet (web3.bitget.com "Submit Token"). Any wallet works; ours is a dedicated, empty one whose
 * seed phrase is WEB3_WALLET_MNEMONIC (password WEB3_WALLET_PASSWORD). Each run imports it into a fresh browser
 * profile, so there is no saved browser state to go stale. Only connect and sign-in requests are approved; anything
 * that looks like a transaction is refused.
 */

const EXT = {
  okx: {dir: env => env.OKX_WALLET_EXT || '/opt/wallets/okx', approval: 'notification.html'},
  bitget: {dir: env => env.BITGET_WALLET_EXT || '/opt/wallets/bitget', approval: 'popup.html'},
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const notSent = (site, what, e) => new NotPostedError(`${site}: ${what}${e ? ` (${String(e?.message || e).split('\n')[0].slice(0, 160)})` : ''}; nothing was sent.`);
const contactEmail = env => env.LISTING_CONTACT_EMAIL || env.COINSNIPER_EMAIL || '';
const tgHandle = url => url?.match(/^https:\/\/(?:www\.)?(?:t|telegram)\.me\/([A-Za-z0-9_]{4,32})\/?$/)?.[1] ?? null;
/** A wallet's own pages sometimes render inside a frame. */
async function root(page) {
  if (!(await page.locator('iframe').count().catch(() => 0))) return page;
  const f = page.frameLocator('iframe').first();
  return (await f.locator('body *:visible').count().catch(() => 0)) > 3 ? f : page;
}

async function debugShot(page, env, name) {
  if (env.DIRECTORY_DEBUG_DIR && page && !page.isClosed()) await page.screenshot({path: `${env.DIRECTORY_DEBUG_DIR}/${name}-${Date.now()}.png`, fullPage: true}).catch(() => {});
}

// ---------------------------------------------------------------- wallet setup

async function waitForTab(ctx, part, ms = 20000) {
  for (let t = 0; t < ms; t += 500) {
    const p = ctx.pages().find(x => !x.isClosed() && x.url().includes(part));
    if (p) return p;
    await sleep(500);
  }
  if (process.env.DIRECTORY_DEBUG_DIR) for (const [i, x] of ctx.pages().entries()) { console.error('tab', x.url()); await x.screenshot({path: `${process.env.DIRECTORY_DEBUG_DIR}/tab-${i}.png`}).catch(() => {}); }
  throw new Error(`the wallet did not open ${part}`);
}

async function importOkx(ctx, id, w) {
  const dbg = (...a) => { if (process.env.WALLET_DEBUG) console.error('[okx import]', ...a, ctx.pages().map(x => x.url().slice(-40))); };
  // The wallet opens its setup page itself on install; use it (or open it).
  let home = await waitForTab(ctx, 'notification.html#/initialize', 10000).catch(() => null);
  if (!home) { home = await ctx.newPage(); await home.goto(`chrome-extension://${id}/notification.html#/initialize`); }
  await home.setViewportSize({width: 420, height: 800});
  await sleep(4000);
  dbg('setup page');
  await (await root(home)).getByText('Import wallet', {exact: true}).last().click();
  await sleep(3000);
  const step = home.isClosed() ? await waitForTab(ctx, 'initialize-import') : home;
  await (await root(step)).getByText('Seed phrase or private key', {exact: true}).last().click();
  await sleep(2000);
  dbg('after Seed phrase');
  const page = await waitForTab(ctx, 'import-with-seed');
  await sleep(4000);
  let r = await root(page);
  await r.getByText('OK', {exact: true}).last().click({timeout: 10000}).catch(() => {});
  await sleep(1000);
  r = await root(page);
  const words = w.mnemonic.trim().split(/\s+/);
  const inputs = r.locator('input:visible');
  if ((await inputs.count()) < words.length) throw new Error('OKX Wallet: seed phrase boxes not found');
  for (let i = 0; i < words.length; i++) await inputs.nth(i).fill(words[i]);
  await r.getByText('Confirm', {exact: true}).last().click();
  await sleep(5000);
  r = await root(page);
  await r.getByText('Password', {exact: true}).first().click();
  await r.getByText('Next', {exact: true}).last().click();
  await sleep(3000);
  r = await root(page);
  const pw = r.locator('input[type=password]:visible');
  for (let i = 0; i < await pw.count(); i++) await pw.nth(i).fill(w.password);
  await r.getByText('Confirm', {exact: true}).last().click();
  await sleep(6000);
  if (!/Welcome to OKX Wallet|Web3 journey/i.test(await (await root(page)).locator('body').innerText().catch(() => ''))) throw new Error('OKX Wallet: import did not finish');
}

async function importBitget(ctx, id, w) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/onboarding.html`);
  await sleep(5000);
  await page.getByText('Import an existing wallet', {exact: true}).last().click();
  await sleep(3000);
  const words = w.mnemonic.trim().split(/\s+/);
  const inputs = page.locator('input:visible');
  if ((await inputs.count()) < words.length) throw new Error('Bitget Wallet: seed phrase boxes not found');
  for (let i = 0; i < words.length; i++) await inputs.nth(i).fill(words[i]);
  await page.getByRole('button', {name: 'Confirm'}).last().click();
  await sleep(4000);
  await page.getByPlaceholder('PIN code must be at least 8 digits long.').fill(w.password);
  await page.getByPlaceholder('Enter the password again').fill(w.password);
  await page.getByRole('button', {name: 'Confirm'}).last().click();
  await sleep(6000);
  if (!/Wallet imported/i.test(await page.locator('body').innerText().catch(() => ''))) throw new Error('Bitget Wallet: import did not finish');
}

/** A browser with the wallet extension loaded and our wallet imported. `close()` throws the profile away. */
export async function walletBrowser(name, env = process.env) {
  const w = {mnemonic: env.WEB3_WALLET_MNEMONIC ?? '', password: env.WEB3_WALLET_PASSWORD ?? ''};
  if (w.mnemonic.trim().split(/\s+/).length < 12 || w.password.length < 8) throw notSent(`${name} wallet`, 'set WEB3_WALLET_MNEMONIC and WEB3_WALLET_PASSWORD on the worker');
  const profile = await mkdtemp(join(tmpdir(), 'cm-wallet-'));
  const dir = EXT[name].dir(env);
  let ctx;
  const close = async () => { await ctx?.close().catch(() => {}); await rm(profile, {recursive: true, force: true}).catch(() => {}); };
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      headless: true, channel: 'chromium', executablePath: env.CHROMIUM_FULL_PATH || undefined, proxy: redditProxy(env.DIRECTORY_PROXY),
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`], viewport: {width: 1366, height: 900},
    });
    // The extensions open their own welcome pages; those are closed.
    ctx.on('page', async p => {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      if (/^https:\/\/(web3\.okx\.com\/extension|web3\.bitget\.com\/[^/]+\/wallet-download)/.test(p.url())) await p.close().catch(() => {});
    });
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', {timeout: 30000});
    const id = new URL(sw.url()).host;
    await (name === 'okx' ? importOkx : importBitget)(ctx, id, w);
    for (const p of ctx.pages()) if (p.url().startsWith('chrome-extension://')) await p.close().catch(() => {});
    return {ctx, id, w, close};
  } catch (e) {
    await close();
    throw e instanceof NotPostedError ? e : notSent(`${name} wallet`, 'could not set up the wallet', e);
  }
}

/** A transaction (not a sign-in): never approved. */
export const LOOKS_LIKE_TRANSACTION = /network fee|gas fee|estimated (fee|balance change)|you (send|pay)|spending cap|token approval/i;
const APPROVAL_SCREEN = /signature confirmation|connection request|identity verification|connect account|confirm sign|sign message|signature request/i;

/** Approves the site's connect / sign-in requests in the wallet (unlocking it first), however many come in a row. */
async function approve(ctx, name, id, site, w) {
  let approved = 0;
  for (let round = 0; round < 4; round++) {
    const n = await approveWindow(ctx, name, id, site, w);
    approved += n;
    if (!n) break;
  }
  return approved;
}

async function approveWindow(ctx, name, id, site, w) {
  await sleep(3000);
  let pop = ctx.pages().filter(p => !p.isClosed() && p.url().includes(EXT[name].approval)).pop();
  if (!pop) {
    // Headless: the wallet can't always open its window; open its approval page ourselves, in a window of its own
    // (the wallet closes that window when done, which must not be the site's).
    const cdp = await ctx.newCDPSession(site);
    const opened = ctx.waitForEvent('page', {timeout: 15000});
    await cdp.send('Target.createTarget', {url: `chrome-extension://${id}/${EXT[name].approval}`, newWindow: true});
    pop = await opened;
  }
  await sleep(2500);
  for (const r of [pop, pop.frameLocator('iframe').first()]) {
    const pw = r.locator('input[type=password]:visible');
    if (await pw.count().catch(() => 0)) {
      await pw.first().fill(w.password);
      await pw.first().press('Enter');
      await sleep(2500);
      if (await pw.count().catch(() => 0)) await r.getByText('Unlock', {exact: true}).last().click({force: true}).catch(() => {});
      await sleep(3500);
      break;
    }
  }
  let approved = 0;
  for (let i = 0; i < 4 && !pop.isClosed(); i++) {
    const r = await root(pop);
    const text = (await r.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (process.env.WALLET_DEBUG) console.error('[approve]', name, i, pop.url().slice(-50), text.slice(0, 160));
    if (LOOKS_LIKE_TRANSACTION.test(text)) throw new Error(`refused a wallet request that looks like a transaction: ${text.slice(0, 120)}`);
    if (!APPROVAL_SCREEN.test(text)) break;
    let clicked = false;
    for (const n of ['Agree', 'Connect', 'Confirm', 'Approve', 'Sign']) {
      const b = r.locator('button:visible').filter({hasText: new RegExp(`^\\s*${n}\\s*$`)});
      for (let k = (await b.count()) - 1; k >= 0 && !clicked; k--) {
        const bb = await b.nth(k).boundingBox().catch(() => null);
        if (bb && bb.width > 0 && bb.y >= 0 && bb.y + bb.height <= 900) { await b.nth(k).click({timeout: 5000}); clicked = true; }
      }
      if (clicked) break;
    }
    if (!clicked) break;
    approved++;
    await sleep(3500);
  }
  // A window we opened that had nothing to approve is closed again (not Bitget's: closing it drops the site session).
  if (!approved && name !== 'bitget' && !pop.isClosed()) await pop.close().catch(() => {});
  await sleep(2000);
  return approved;
}

/** The site's tab after the wallet is done (it may have been replaced). */
const siteTab = (ctx, host) => ctx.pages().filter(p => !p.isClosed() && p.url().includes(host)).pop();

// ---------------------------------------------------------------- OKX: Update token info

/** Closes OKX's what's-new tours, tips and cookie banner, which block the page in a fresh browser. */
async function clearOkxPopups(page) {
  await page.getByRole('button', {name: 'Accept All Cookies'}).click({timeout: 2000}).catch(() => {});
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    const close = page.locator('[class*="dialog"] [class*="close"]:visible, [class*="modal"] [class*="close"]:visible, [aria-label="Close"]:visible, [aria-label="close"]:visible').first();
    if (await close.count()) { await close.click({force: true}).catch(() => {}); await sleep(800); continue; }
    const ok = page.locator('[class*="popover"] button:visible, [class*="coach"] button:visible').filter({hasText: /^(OK|Got it)$/}).first();
    if (await ok.count()) { await ok.click({force: true}).catch(() => {}); await sleep(600); continue; }
    break;
  }
}

const OKX_CHAINS = {solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc', polygon: 'polygon', arbitrum: 'arbitrum'};

export async function okxUpdateSubmit(l, logoPath, env = process.env, {dryRun = false} = {}) {
  const chain = OKX_CHAINS[l.chain];
  if (!chain) throw notSent('okx_wallet', `chain ${l.chain} is not supported`);
  const telegram = env.LISTING_CONTACT_TELEGRAM || (tgHandle(l.telegram_url) ? `@${tgHandle(l.telegram_url)}` : '');
  if (!telegram || !contactEmail(env)) throw notSent('okx_wallet', 'OKX requires a contact Telegram and e-mail (LISTING_CONTACT_TELEGRAM / LISTING_CONTACT_EMAIL)');
  const {ctx, id, w, close} = await walletBrowser('okx', env);
  let page;
  try {
    const url = `https://web3.okx.com/token/${chain}/${l.contract_address}`;
    try {
      page = await ctx.newPage();
      await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000});
      await sleep(4000);
      // The wallet is injected reliably from the second load on.
      await page.reload({waitUntil: 'domcontentloaded'});
      await sleep(7000);
      await clearOkxPopups(page);
      await page.getByText('Connect wallet', {exact: true}).first().click({force: true});
      await sleep(2500);
      await page.locator('div[class*="index_extension"] button').first().click({timeout: 10000});
      if (!(await approve(ctx, 'okx', id, page, w))) throw new Error('the wallet showed no connect request');
      page = siteTab(ctx, 'web3.okx.com') ?? page;
      await sleep(2000);
      await clearOkxPopups(page);
      await page.locator('[aria-label="More actions"]').first().click({force: true});
      await sleep(1500);
      await page.getByText('Update info', {exact: true}).first().click();
      await page.getByPlaceholder('e.g. https://x.com/username').waitFor({timeout: 15000});
      await sleep(1500);
      if (logoPath) {
        // OKX asks the wallet to sign the logo upload.
        await page.locator('input[type=file]').last().setInputFiles(logoPath);
        await approve(ctx, 'okx', id, page, w);
        page = siteTab(ctx, 'web3.okx.com') ?? page;
        await sleep(2000);
        if (await page.getByText('Upload failed', {exact: true}).count()) throw new Error('the logo upload failed');
      }
      if (l.website_url) await page.getByPlaceholder('e.g. https://example.com').fill(l.website_url);
      if (l.x_url) await page.getByPlaceholder('e.g. https://x.com/username').fill(l.x_url);
      const extra = [l.short_description || l.description, l.telegram_url && `Telegram: ${l.telegram_url}`].filter(Boolean).join('\n').replace(/<[^>]*>/g, '');
      await page.getByPlaceholder(/Any other information/).fill(extra.slice(0, 500));
      await page.getByPlaceholder('e.g. @username').fill(telegram);
      await page.getByPlaceholder('e.g. name@example.com').fill(contactEmail(env));
      const boxes = page.locator('input[type=checkbox]').filter({visible: true});
      const n = await boxes.count();
      // Custom checkboxes: click what is drawn (the wrapper), then confirm it took.
      for (let i = 0; i < n; i++) {
        const b = boxes.nth(i);
        if (await b.isChecked()) continue;
        await b.evaluate(e => (e.closest('label') ?? e.parentElement).click());
        await sleep(300);
        if (!(await b.isChecked())) await b.evaluate(e => e.click());
        if (!(await b.isChecked())) throw new Error(`confirmation box ${i + 1} would not tick`);
      }
    } catch (e) {
      await debugShot(page, env, 'okx-wallet-fill');
      throw e instanceof NotPostedError ? e : notSent('okx_wallet', 'could not fill the form', e);
    }
    if (dryRun) { await debugShot(page, env, 'okx-wallet-dry'); return {submitted: false, dryRun: true}; }
    const answer = page.waitForResponse(r => r.request().method() === 'POST' && /okx\.com\/.*(token|update|apply|submit)/i.test(r.url()) && !/log|track|monitor|collect/i.test(r.url()), {timeout: 60000}).catch(() => null);
    await page.getByRole('button', {name: 'Submit', exact: true}).last().click();
    // Submitting may ask the wallet to sign.
    await approve(ctx, 'okx', id, page, w).catch(() => 0);
    page = siteTab(ctx, 'web3.okx.com') ?? page;
    const r = await answer;
    const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    await debugShot(page, env, 'okx-wallet-after');
    const body = r ? await r.json().catch(() => ({})) : {};
    if (r && (r.status() >= 400 || (body.code && String(body.code) !== '0'))) throw new NotPostedError(`okx_wallet rejected the update: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    if (!r && !/submitted|success|under review|in review/i.test(text)) return {submitted: false};
    return {submitted: true, url: null, note: 'token info update submitted; OKX reviews it'};
  } finally { await close(); }
}

// ---------------------------------------------------------------- Bitget: Submit Token

const BITGET_CHAINS = {solana: 'Solana', ethereum: 'Ethereum', bsc: 'BNB Chain', base: 'Base', polygon: 'Polygon', arbitrum: 'Arbitrum'};

/** Total supply and decimals from the chain (Bitget requires both). Solana only for now. */
export async function tokenSupply(l, env = process.env, fetchFn = fetch) {
  if (l.chain !== 'solana') throw notSent('bitget_wallet', `total supply lookup for ${l.chain} is not supported yet`);
  const r = await fetchFn(env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [l.contract_address]}), signal: AbortSignal.timeout(20000),
  }).catch(e => { throw notSent('bitget_wallet', 'could not read the token supply', e); });
  const v = (await r.json().catch(() => ({})))?.result?.value;
  if (!v || typeof v.decimals !== 'number') throw notSent('bitget_wallet', 'could not read the token supply');
  return {supply: String(Math.floor(Number(v.uiAmountString ?? v.uiAmount))), decimals: v.decimals};
}

const noScheme = u => (u ? u.replace(/^https?:\/\//, '') : '');

export async function bitgetSubmit(l, logoPath, env = process.env, {dryRun = false} = {}) {
  const chain = BITGET_CHAINS[l.chain];
  if (!chain) throw notSent('bitget_wallet', `chain ${l.chain} is not supported`);
  if (!logoPath) throw notSent('bitget_wallet', 'Bitget requires a token icon and this token has none');
  const {supply, decimals} = await tokenSupply(l, env);
  // JPG/PNG, ideally under 100KB.
  const icon = join(await mkdtemp(join(tmpdir(), 'cm-icon-')), 'icon.png');
  await writeFile(icon, await sharp(logoPath).resize(200, 200, {fit: 'cover'}).png({compressionLevel: 9, palette: true}).toBuffer());
  const {ctx, id, w, close} = await walletBrowser('bitget', env);
  let page;
  try {
    try {
      page = await ctx.newPage();
      await page.goto('https://web3.bitget.com/en/business/service/token-manage', {waitUntil: 'domcontentloaded', timeout: 60000});
      await sleep(4000);
      await page.reload({waitUntil: 'domcontentloaded'});
      await sleep(7000);
      await page.keyboard.press('Escape');
      if (process.env.WALLET_DEBUG) console.error('[bitget] connect button', await page.locator('.connectWallet:visible').count(), await page.evaluate(() => typeof window.bitkeep));
      await page.locator('.connectWallet:visible').first().click();
      if (!(await approve(ctx, 'bitget', id, page, w))) throw new Error('the wallet showed no connect request');
      page = siteTab(ctx, 'web3.bitget.com') ?? page;
      // Once the wallet trusts the site, a reload reconnects it; the header then shows our address.
      for (let i = 0; i < 3 && !(await page.locator('.connectWallet:visible').first().innerText().catch(() => '')).startsWith('0x'); i++) {
        await page.reload({waitUntil: 'domcontentloaded'});
        await sleep(6000);
        if (!(await page.locator('.connectWallet:visible').first().innerText().catch(() => '')).startsWith('0x')) {
          await page.locator('.connectWallet:visible').first().click().catch(() => {});
          await approve(ctx, 'bitget', id, page, w);
          page = siteTab(ctx, 'web3.bitget.com') ?? page;
        }
      }
      if (!(await page.locator('.connectWallet:visible').first().innerText().catch(() => '')).startsWith('0x')) throw new Error('the wallet did not stay connected');
      await page.getByRole('button', {name: 'Submit Token'}).click();
      await page.locator('#dynamic_rule_name').waitFor({timeout: 20000});
      if (process.env.WALLET_DEBUG) page.on('response', async r => { if (r.request().method() === 'POST' && !/log|track|collect|sentry/i.test(r.url())) console.error('[bitget POST]', r.status(), r.url().slice(0, 120), (await r.text().catch(() => '')).slice(0, 160)); });
      await page.locator('#dynamic_rule_icon').setInputFiles(icon);
      // The upload may ask the wallet to sign; then the preview shows.
      await sleep(2500);
      if (!(await page.locator('.ant-upload-list-item, .ant-upload img, [class*=upload] img').count())) await approve(ctx, 'bitget', id, page, w);
      await sleep(2000);
      if (process.env.WALLET_DEBUG) console.error('[bitget] icon', await page.locator('.ant-upload-list-item, .ant-upload img, [class*=upload] img').count(), JSON.stringify(await page.locator('.ant-message:visible, .ant-upload-list-item-error').allInnerTexts().catch(() => [])));
      await page.locator('#dynamic_rule_name').fill(l.name);
      await page.locator('#dynamic_rule_coin').fill(l.symbol);
      await page.locator('#dynamic_rule_chain').click();
      await sleep(1200);
      await page.locator('.ant-select-dropdown-menu-item').filter({hasText: new RegExp(`^${chain}$`)}).first().click();
      await page.locator('#dynamic_rule_supplyTotal input').fill(supply);
      await page.locator('#dynamic_rule_contract').fill(l.contract_address);
      await page.locator('#dynamic_rule_decimals input').fill(String(decimals));
      if (l.launch_date) {
        await page.locator('#dynamic_rule_issue_date input').first().click();
        await page.locator('.ant-calendar-input').first().fill(l.launch_date.replace(/-/g, '/'));
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
      }
      if (l.x_url) await page.locator('#dynamic_rule_twitter').fill(noScheme(l.x_url));
      if (l.website_url) await page.locator('#dynamic_rule_website').fill(noScheme(l.website_url));
      if (l.telegram_url) await page.locator('#dynamic_rule_telegram').fill(noScheme(l.telegram_url));
      if (contactEmail(env)) await page.locator('#dynamic_rule_email').fill(contactEmail(env));
      const tg = env.LISTING_CONTACT_TELEGRAM || (tgHandle(l.telegram_url) ? `@${tgHandle(l.telegram_url)}` : '');
      if (tg) await page.locator('#dynamic_rule_contact_telegram').fill(tg);
      const intro = page.locator('textarea').first();
      if (await intro.count()) await intro.fill((l.short_description || l.description || '').slice(0, 500));
    } catch (e) {
      await debugShot(page, env, 'bitget-wallet-fill');
      throw e instanceof NotPostedError ? e : notSent('bitget_wallet', 'could not fill the form', e);
    }
    if (dryRun) { await debugShot(page, env, 'bitget-wallet-dry'); return {submitted: false, dryRun: true}; }
    // Bitget's API answers {status: 0} on success.
    const answer = page.waitForResponse(r => r.request().method() === 'POST' && /\/openApi\/open\/token\//.test(r.url()) && !/getChainNameList|list|detail|query/i.test(r.url()), {timeout: 60000}).catch(() => null);
    await page.getByRole('button', {name: 'Submit', exact: true}).last().click();
    await approve(ctx, 'bitget', id, page, w).catch(() => 0);
    page = siteTab(ctx, 'web3.bitget.com') ?? page;
    const r = await answer;
    await debugShot(page, env, 'bitget-wallet-after');
    const errors = (await page.locator('.ant-form-explain:visible, .ant-message-error:visible').allInnerTexts().catch(() => [])).join(' ').trim();
    if (errors) throw new NotPostedError(`bitget_wallet rejected the form: ${errors.slice(0, 200)}`);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (r && (r.status() >= 400 || (body.status !== undefined && body.status !== 0))) throw new NotPostedError(`bitget_wallet rejected the token: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    if (!r) return {submitted: false};
    return {submitted: true, url: null, note: 'token submitted; Bitget Wallet reviews it'};
  } finally { await close(); await rm(join(icon, '..'), {recursive: true, force: true}).catch(() => {}); }
}

// `node wallets.mjs dry <okx_wallet|bitget_wallet> <logo path>`: JUGS sample, fills the form and stops before Submit.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === 'dry') {
  const l = {
    name: 'GoalDaddy', symbol: 'JUGS', chain: 'solana', contract_address: 'APxxh2tWCh95tbHitFJchcdbMsctSBgRS2Zzju9Bpump',
    short_description: 'Dry run: nothing is submitted.', description: 'Dry run.', website_url: null,
    telegram_url: 'https://t.me/GoalDaddyJUGS', x_url: 'https://x.com/goaldaddyllc', launch_date: '2026-10-01',
  };
  const fn = {okx_wallet: okxUpdateSubmit, bitget_wallet: bitgetSubmit}[process.argv[3]];
  console.log(JSON.stringify(await fn(l, process.argv[4] || null, process.env, {dryRun: true})));
}
