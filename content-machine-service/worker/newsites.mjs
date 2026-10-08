import {chromium} from 'playwright';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {browserContext, NotPostedError, redditProxy} from './reddit.mjs';
import {withLock} from './lock.mjs';
import {bitgetSubmit, okxUpdateSubmit} from './wallets.mjs';

/**
 * Newer listing sites, kept apart from the proven ones: CoinCodex (a Google Form), CNToken and Blockspot. They are
 * off for trending orders (not in TRENDING_CHANNELS) until tested. Each submit takes `{dryRun: true}`, which fills
 * the form and stops before sending anything (a screenshot is saved for review).
 */

const launch = () => chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, proxy: redditProxy(process.env.DIRECTORY_PROXY)});
const notSent = (site, what, e) => new NotPostedError(`${site}: ${what}${e ? ` (${String(e?.message || e).split('\n')[0].slice(0, 160)})` : ''}; nothing was sent.`);
const contactEmail = env => env.LISTING_CONTACT_EMAIL || env.COINSNIPER_EMAIL || '';
/** Sites that require a website get the best link the token has. */
const bestSite = l => l.website_url || l.x_url || l.telegram_url || l.chart_url;
const CHAIN_NAMES = {solana: 'Solana', ethereum: 'Ethereum', base: 'Base', bsc: 'BNB Smart Chain', polygon: 'Polygon', arbitrum: 'Arbitrum'};

async function shot(page, env, name) {
  const dir = env.DIRECTORY_DEBUG_DIR;
  if (!dir) return null;
  const path = `${dir}/${name}-${Date.now()}.png`;
  await page.screenshot({path, fullPage: true}).catch(() => {});
  return path;
}

// ---------------------------------------------------------------- CoinCodex (Google Form)

const COINCODEX_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSfminwB4C4Dd1GQbD86q3H4lL7MIONonZ-anMFg6SJoaq86Gg';
/** Form sections in order: 0 request type, 1 coin/token listing, ... 8 contact. */
const CC_PAGES = '0,1,8';
const CC = {
  requestType: 'entry.1395847187',
  name: 'entry.1284783105',
  ticker: 'entry.907092548',
  logo: 'entry.1599423114',
  description: 'entry.1652958682',
  website: 'entry.1196233477',
  releaseDate: 'entry.1798808271',
  platform: 'entry.2070782849',
  category: 'entry.1342122285',
  twitter: 'entry.184334269',
  telegram: 'entry.1674897878',
  explorer: 'entry.1286914744',
  other: 'entry.1757672348',
  email: 'entry.1863870395',
};
const EXPLORERS = {solana: 'https://solscan.io/token/', ethereum: 'https://etherscan.io/token/', base: 'https://basescan.org/token/', bsc: 'https://bscscan.com/token/', polygon: 'https://polygonscan.com/token/', arbitrum: 'https://arbiscan.io/token/'};

/** The form body CoinCodex receives (exported for tests). */
export function coincodexBody(l, env = process.env, fbzx = '') {
  const email = contactEmail(env);
  if (!email) throw notSent('coincodex', 'set LISTING_CONTACT_EMAIL on the worker (the form requires a contact e-mail)');
  if (!l.logo_public_url) throw notSent('coincodex', 'no public logo URL for this token');
  const [y, m, d] = String(l.launch_date || new Date().toISOString().slice(0, 10)).split('-');
  const f = new URLSearchParams();
  f.set(CC.requestType, 'New Coin/Token listing');
  f.set(CC.name, l.name.slice(0, 100));
  f.set(CC.ticker, l.symbol.slice(0, 20));
  f.set(CC.logo, l.logo_public_url);
  f.set(CC.description, (l.short_description || l.description || '').slice(0, 1000));
  f.set(CC.website, bestSite(l));
  f.set(`${CC.releaseDate}_year`, String(Number(y)));
  f.set(`${CC.releaseDate}_month`, String(Number(m)));
  f.set(`${CC.releaseDate}_day`, String(Number(d)));
  f.set(CC.platform, CHAIN_NAMES[l.chain] ?? l.chain);
  f.append(CC.category, 'Meme');
  if (l.x_url) f.set(CC.twitter, l.x_url);
  if (l.telegram_url) f.set(CC.telegram, l.telegram_url);
  if (EXPLORERS[l.chain]) f.set(CC.explorer, EXPLORERS[l.chain] + l.contract_address);
  f.set(CC.other, `Contract address: ${l.contract_address}\nChart: ${l.chart_url}`);
  f.set(CC.email, email);
  f.set('pageHistory', CC_PAGES);
  f.set('fvv', '1');
  if (fbzx) f.set('fbzx', fbzx);
  return f;
}

/** CoinCodex's Google Form, filled in a browser page by page (Google validates each page as a person would see). */
export async function coincodexSubmit(l, _logoPath, env = process.env, {dryRun = false} = {}) {
  const answers = Object.fromEntries(coincodexBody(l, env));
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const exact = t => new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?\\s*$`);
    const byTitle = title => page.locator('[role=listitem]').filter({has: page.locator('[role=heading]', {hasText: exact(title)})}).first();
    const text = async (title, v) => {
      if (!v) return;
      try { await byTitle(title).locator('input[type=text], input[type=url], input[type=email], textarea').first().fill(v, {timeout: 10000}); }
      catch (e) { throw new Error(`field "${title}": ${String(e.message).split('\n')[0]}`); }
    };
    const next = async () => { await page.getByRole('button', {name: 'Next'}).click(); await page.waitForTimeout(2500); };
    const problems = async () => (await page.locator('[role=alert]:visible').allInnerTexts().catch(() => [])).map(t => t.trim()).filter(Boolean).join('; ');
    try {
      await page.goto(`${COINCODEX_FORM}/viewform`, {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.waitForTimeout(3000);
      await page.getByRole('radio', {name: 'New Coin/Token listing'}).click();
      await next();
      await text('Asset name', answers[CC.name]);
      await text('Asset ticker', answers[CC.ticker]);
      await text('Logo', answers[CC.logo]);
      await text('Unique short description', answers[CC.description]);
      await text('Project website URL', answers[CC.website]);
      await text('Platform', answers[CC.platform]);
      await text('Twitter', answers[CC.twitter]);
      await text('Telegram', answers[CC.telegram]);
      await text('Explorer', answers[CC.explorer]);
      await text('Other', answers[CC.other]);
      // The page's only date field: release date.
      await page.locator('input[type=date]').first().fill(l.launch_date || new Date().toISOString().slice(0, 10), {timeout: 10000});
      await page.getByRole('checkbox', {name: 'Meme'}).click();
      await next();
      const left = await problems();
      if (left) throw new NotPostedError(`coincodex: ${left.slice(0, 200)}; nothing was sent.`);
      await text('Contact e-mail address', answers[CC.email]);
    } catch (e) {
      await shot(page, env, 'coincodex-fill');
      throw e instanceof NotPostedError ? e : notSent('coincodex', 'could not fill the form', e);
    }
    if (dryRun) return {submitted: false, dryRun: true, screenshot: await shot(page, env, 'coincodex-dry')};
    await page.getByRole('button', {name: 'Submit'}).click();
    await page.waitForTimeout(4000);
    const body = await page.locator('body').innerText().catch(() => '');
    const left = await problems();
    // Google's confirmation page (the form may use its own wording): .../formResponse, no form left, no errors.
    const recorded = /Your response has been recorded/i.test(body) || (/\/formResponse/.test(page.url()) && !left && !(await page.getByRole('button', {name: 'Submit'}).count()));
    if (recorded) return {submitted: true, url: null, note: 'request recorded; CoinCodex reviews it'};
    if (left) throw new NotPostedError(`coincodex rejected the form: ${left.slice(0, 200)}`);
    await shot(page, env, 'coincodex-noanswer');
    return {submitted: false};
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- CNToken

/** CNToken's launch-platform choice from the token itself. */
const cntokenLaunch = l => (l.chain === 'solana' && /pump$/i.test(l.contract_address) ? 'pump.fun' : l.chain === 'solana' ? 'Raydium' : l.chain === 'bsc' ? 'PancakeSwap' : l.chain === 'ethereum' ? 'UniSwap' : '无(None)');
const CNTOKEN_CHAINS = {solana: 'SOL', ethereum: 'ETH', bsc: 'BSC', base: 'Base', polygon: 'MATIC', arbitrum: 'Arbitrum'};

export async function cntokenSubmit(l, _logoPath, env = process.env, {dryRun = false} = {}) {
  if (!l.telegram_url) throw notSent('cntoken', 'CNToken requires a Telegram link and this token has none');
  if (!l.logo_public_url) throw notSent('cntoken', 'no public logo URL for this token');
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    const pick = async (index, option) => {
      await page.getByPlaceholder('Select...').nth(index).click();
      await page.waitForTimeout(600);
      const o = page.locator('li:visible, [role=option]:visible').filter({hasText: option}).first();
      if (!(await o.count())) throw notSent('cntoken', `no option ${option}`);
      await o.click();
      await page.waitForTimeout(400);
    };
    try {
      await page.goto('https://cntoken.io/addCoin', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.waitForTimeout(4000);
      await page.getByPlaceholder('e.g. Bitcoin', {exact: true}).fill(l.name);
      await page.getByPlaceholder('e.g. BTC', {exact: true}).fill(l.symbol);
      await page.locator('textarea').first().fill((l.short_description || l.description || '').slice(0, 500));
      await pick(0, CNTOKEN_CHAINS[l.chain] ?? l.chain);
      await page.getByPlaceholder('Please enter...').first().fill(l.contract_address);
      await pick(2, '无(None)'); // presale platform
      await pick(4, cntokenLaunch(l)); // launch platform
      const fill = async (ph, v, nth = 0) => { if (v) await page.getByPlaceholder(ph).nth(nth).fill(v); };
      await fill('e.g. www.baidu.com', bestSite(l));
      await fill('e.g. https://t.me/bitcoin', l.telegram_url, 0);
      await fill('e.g. https://twitter.com/bitcoin', l.x_url);
      await fill('e.g. https://i.ibb.co/logo.png', l.logo_public_url);
      const contact = page.getByPlaceholder('Please enter...');
      const n = await contact.count();
      if (contactEmail(env) && n >= 2) await contact.nth(n - 2).fill(contactEmail(env));
    } catch (e) { throw e instanceof NotPostedError ? e : notSent('cntoken', 'could not fill the form', e); }
    if (dryRun) return {submitted: false, dryRun: true, screenshot: await shot(page, env, 'cntoken-dry')};
    const answer = page.waitForResponse(r => /api\.cntoken\.io\/api\/coin\//.test(r.url()) && r.request().method() === 'POST', {timeout: 30000}).catch(() => null);
    await page.getByRole('button', {name: 'Add Coin'}).last().click();
    const r = await answer;
    if (!r) { await shot(page, env, 'cntoken-noanswer'); return {submitted: false}; }
    const body = await r.json().catch(() => ({}));
    if (r.status() >= 300 || body.code !== 1) throw new NotPostedError(`cntoken rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    return {submitted: true, url: null, note: body.msg || 'submitted for review'};
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- Blockspot

export async function blockspotSubmit(l, _logoPath, env = process.env, {dryRun = false} = {}) {
  if (!contactEmail(env)) throw notSent('blockspot', 'set LISTING_CONTACT_EMAIL on the worker');
  if (!l.logo_public_url) throw notSent('blockspot', 'no public logo URL for this token');
  const browser = await launch();
  try {
    const page = await (await browser.newContext(browserContext())).newPage();
    try {
      await page.goto('https://portal.blockspot.io/submit-coin?source=menu', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.waitForTimeout(6000);
      if (/just a moment/i.test(await page.title())) throw notSent('blockspot', "Cloudflare's check did not clear");
      const field = id => page.locator(`#${id}`);
      await page.getByPlaceholder('Paste image URL here (i.e. from your X profile)').fill(l.logo_public_url);
      await field('v-0-2').fill(l.name);
      await field('v-0-3').fill(l.symbol);
      await field('v-0-4').fill(bestSite(l));
      // Type "Token" is preselected. Blockchain: a searchable list.
      await page.getByRole('button', {name: 'Show popup'}).first().click();
      const search = page.getByRole('combobox', {name: 'Search…'});
      await search.pressSequentially(CHAIN_NAMES[l.chain] ?? l.chain, {delay: 60});
      await page.waitForTimeout(2500);
      const box = await search.getAttribute('aria-controls');
      const opt = page.locator(`[id="${box}"] [role=option]`).filter({hasText: new RegExp(`^\\s*${CHAIN_NAMES[l.chain] ?? l.chain}\\s*$`, 'i')}).first();
      if (!(await opt.count())) throw notSent('blockspot', `blockchain ${l.chain} is not offered (or the list did not load)`);
      await opt.click();
      await field('v-0-12').fill(l.contract_address);
      // "Based in a specific country?" No.
      await page.locator('[id="v-0-31:No"]').click();
      const social = async (ph, v) => { if (v) await page.getByPlaceholder(ph).fill(v); };
      await social('e.g. https://telegram.me/blockspot_io', l.telegram_url);
      await social('e.g. https://x.com/Blockspot_io', l.x_url);
      await page.locator('input[type=email]').first().fill(contactEmail(env));
      const desc = page.locator('textarea').first();
      if (await desc.count()) await desc.fill((l.short_description || l.description || '').slice(0, 1000));
      await page.getByRole('button', {name: /I agree to the Privacy Policy/}).click();
    } catch (e) { throw e instanceof NotPostedError ? e : notSent('blockspot', 'could not fill the form', e); }
    if (dryRun) return {submitted: false, dryRun: true, screenshot: await shot(page, env, 'blockspot-dry')};
    const answer = page.waitForResponse(r => /portal\.blockspot\.io\/api\/coins?/.test(r.url()) && r.request().method() === 'POST', {timeout: 45000}).catch(() => null);
    await page.getByRole('button', {name: 'Submit Coin'}).click();
    const r = await answer;
    if (!r) { await shot(page, env, 'blockspot-noanswer'); return {submitted: false}; }
    const body = await r.json().catch(() => ({}));
    if (r.status() >= 300) throw new NotPostedError(`blockspot rejected the listing: HTTP ${r.status()} ${JSON.stringify(body).slice(0, 160)}`);
    return {submitted: true, url: null, note: 'submitted for review'};
  } finally { await browser.close(); }
}

/** Enabled only with NEW_LISTING_SITES (comma list) on the worker, so nothing changes until they are tested. */
export const NEW_LISTING_SITES = {
  coincodex: {enabled: env => /(^|,)\s*coincodex\s*(,|$)/.test(env.NEW_LISTING_SITES ?? ''), submit: (l, p, e) => coincodexSubmit(l, p, e), check: async () => ({live: false})},
  cntoken: {enabled: env => /(^|,)\s*cntoken\s*(,|$)/.test(env.NEW_LISTING_SITES ?? ''), submit: (l, p, e) => withLock('cntoken', () => cntokenSubmit(l, p, e)), check: async () => ({live: false})},
  blockspot: {enabled: env => /(^|,)\s*blockspot\s*(,|$)/.test(env.NEW_LISTING_SITES ?? ''), submit: (l, p, e) => withLock('blockspot', () => blockspotSubmit(l, p, e)), check: async () => ({live: false})},
  // Wallet sites (wallets.mjs): one wallet browser at a time.
  okx_wallet: {enabled: env => /(^|,)\s*okx_wallet\s*(,|$)/.test(env.NEW_LISTING_SITES ?? ''), submit: (l, p, e) => withLock('wallet', () => okxUpdateSubmit(l, p, e)), check: async () => ({live: false})},
  bitget_wallet: {enabled: env => /(^|,)\s*bitget_wallet\s*(,|$)/.test(env.NEW_LISTING_SITES ?? ''), submit: (l, p, e) => withLock('wallet', () => bitgetSubmit(l, p, e)), check: async () => ({live: false})},
};

// `node newsites.mjs dry <site>`: fill the form with a sample token and stop before submitting.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === 'dry') {
  const sample = {
    name: 'Claudia', symbol: 'CLAUDIA', chain: 'solana', contract_address: '2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM',
    description: 'Sample description for a dry run. Nothing is submitted.', short_description: 'Sample description for a dry run.',
    website_url: null, telegram_url: 'https://t.me/example', x_url: 'https://x.com/example',
    chart_url: 'https://dexscreener.com/solana/2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM', launch_date: '2026-10-01',
    logo_public_url: 'https://dd.dexscreener.com/ds-data/tokens/solana/2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM.png',
  };
  const env = {...process.env, LISTING_CONTACT_EMAIL: process.env.LISTING_CONTACT_EMAIL || 'test@example.com'};
  const fn = {coincodex: coincodexSubmit, cntoken: cntokenSubmit, blockspot: blockspotSubmit}[process.argv[3]];
  console.log(JSON.stringify(await fn(sample, null, env, {dryRun: true}), null, 1));
}
