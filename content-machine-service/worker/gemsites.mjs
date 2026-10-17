import {NotOfferedError, NotPostedError} from './reddit.mjs';
import {approveWallet, walletBrowser} from './wallets.mjs';

/**
 * CoinGem (coingem.com) and CoinDizzy (coindizzy.com): one platform, two sites, each with its own API. Both import
 * DEX tokens on their own, so most coins are already there: the coin page is found through CoinGem's search and
 * recorded without logging in. A coin they don't have is submitted signed in with our wallet ("Connect digital
 * wallet": a connect and a sign-in signature, never a transaction). Their contact must be a person's Telegram
 * username (groups are refused): LISTING_CONTACT_TELEGRAM.
 */
export const GEM_SITES = {coingem: 'https://coingem.com', coindizzy: 'https://coindizzy.com'};
const api = site => GEM_SITES[site].replace('https://', 'https://api.');
/**
 * Chains we submit on: the form's chain list starts on Solana, the one checked live; other chains are skipped until
 * their picker is mapped. Coins already on the site are found on any chain.
 */
const GEM_CHAINS = {solana: /^Solana$/i};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const notSent = (site, what, e) => new NotPostedError(`${site}: ${what}${e ? ` (${String(e?.message || e).split('\n')[0].slice(0, 160)})` : ''}; nothing was sent.`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bodyText = page => page.locator('body').innerText().catch(() => '');

/** Whether the site has this contract (live or waiting for its review). */
export async function gemExists(site, l, fetchFn = fetch) {
  const r = await fetchFn(`${api(site)}/submit-coin/check`, {method: 'POST', headers: {'content-type': 'application/json', 'user-agent': UA, origin: GEM_SITES[site]}, body: JSON.stringify({address: l.contract_address}), signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw new Error(`${site} check answered HTTP ${r.status}`);
  return (await r.json())?.exists === true;
}

/** The coin's public page on the site, or null: found through CoinGem's search, then opened on the site itself. */
export async function gemFind(site, l, fetchFn = fetch) {
  const r = await fetchFn(`https://api.coingem.com/search?query=${encodeURIComponent(l.name)}`, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(20000)});
  const hit = ((await r.json().catch(() => null))?.search ?? []).find(c => String(c.address ?? '').toLowerCase() === l.contract_address.toLowerCase());
  if (!hit?.short_url || !hit.chain?.url) return null;
  const url = `${GEM_SITES[site]}/${hit.chain.url}/${hit.short_url}`;
  const page = await fetchFn(url, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(20000)}).catch(() => null);
  return page?.ok && (await page.text()).includes(l.contract_address) ? url : null;
}

export async function gemCheck(site, l, fetchFn = fetch) {
  const url = await gemFind(site, l, fetchFn).catch(() => null);
  return url ? {live: true, url} : {live: false};
}

/** Signs in with our wallet: the site's MetaMask button, answered by our wallet (announced to the page as MetaMask). */
async function walletLogin(ctx, id, w, site) {
  await ctx.addInitScript(() => {
    const announce = () => {
      const provider = window.okxwallet || window.ethereum;
      if (provider) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: Object.freeze({info: {uuid: '0b6f1d4e-6c1e-4b7a-9d55-7c1f0c2a0001', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask'}, provider})}));
    };
    window.addEventListener('eip6963:requestProvider', announce);
    setTimeout(announce, 1500);
  });
  const page = await ctx.newPage();
  await page.goto(`${GEM_SITES[site]}/submit-coin`, {waitUntil: 'domcontentloaded', timeout: 60000});
  await sleep(3000);
  // The wallet is injected reliably from the second load on.
  await page.reload({waitUntil: 'domcontentloaded'});
  await sleep(5000);
  await page.getByText(/^\s*log ?in\s*$/i).first().click({timeout: 15000});
  await page.getByText('Connect digital wallet').first().click({timeout: 15000});
  await page.getByText('MetaMask', {exact: true}).first().click({timeout: 15000});
  if (!(await approveWallet(ctx, 'okx', id, page, w))) throw new Error('the wallet showed no sign-in request');
  const tab = ctx.pages().filter(p => !p.isClosed() && p.url().startsWith(GEM_SITES[site])).pop() ?? page;
  await sleep(3000);
  if (/please,? log ?in to submit/i.test(await bodyText(tab))) throw new Error('still signed out after the wallet sign-in');
  return tab;
}

export async function gemSubmit(site, l, logoPath, env = process.env, {dryRun = false, fetchFn = fetch} = {}) {
  let exists;
  try { exists = await gemExists(site, l, fetchFn); } catch (e) { throw notSent(site, 'could not reach the site', e); }
  if (exists) {
    const url = await gemFind(site, l, fetchFn).catch(() => null);
    return {submitted: true, url, note: url ? 'already listed' : 'already submitted, in review'};
  }
  if (!GEM_CHAINS[l.chain]) throw new NotOfferedError(`${site}: submitting ${l.chain} tokens is not set up (Solana only); nothing was sent.`);
  const contact = String(env.LISTING_CONTACT_TELEGRAM ?? '').trim().replace(/^https?:\/\/t\.me\//, '@').replace(/^(?!@)/, '@');
  if (contact.length < 3) throw notSent(site, 'set LISTING_CONTACT_TELEGRAM on the worker (a person\'s Telegram username; the site refuses groups)');
  const {ctx, id, w, close} = await walletBrowser('okx', env);
  try {
    let page;
    try {
      page = await walletLogin(ctx, id, w, site);
      const current = await page.locator('select').first().evaluate(s => s.options[s.selectedIndex]?.text?.trim() ?? '');
      if (!GEM_CHAINS[l.chain].test(current)) throw new NotOfferedError(`${site}: the form is on ${current || 'no chain'}, not ${l.chain}; nothing was sent.`);
      await page.locator('input[name=address]').fill(l.contract_address);
      await sleep(4000);
      // The contract check settles first (it can reset the fields), then the details are typed.
      for (const [sel, v] of [['input[name=name]', l.name], ['input[name=symbol]', String(l.symbol).replace(/^\$/, '')]]) {
        const e = page.locator(sel).first();
        if (!(await e.inputValue())) { await e.click(); await e.pressSequentially(v, {delay: 20}); }
      }
      await page.locator('label:has(input[name=category])').filter({hasText: /^\s*Meme\s*$/}).first().click();
      await page.locator('label:has(input[name=presale])').filter({hasText: /^\s*No\s*$/}).first().click();
      const fillIf = async (sel, v) => { const e = page.locator(sel).first(); if (v && !(await e.inputValue())) await e.fill(v); };
      await fillIf('textarea[name=description]', l.description || l.short_description || `${l.name} ($${l.symbol}) community token.`);
      await fillIf('input[name=website]', l.website_url);
      await fillIf('input[name=telegram]', l.telegram_url);
      await fillIf('input[name=twitter]', l.x_url);
      await fillIf('input[name=contact_telegram]', contact);
      if (logoPath) await page.locator('input[name=logoUrl]').first().setInputFiles(logoPath);
      await sleep(3000);
    } catch (e) {
      if (e instanceof NotPostedError) throw e;
      throw notSent(site, 'could not sign in or fill the form', e);
    }
    const button = page.locator('button:visible').filter({hasText: /^\s*Submit Coin\s*$/}).last();
    if (dryRun) return {submitted: false, dryRun: true};
    const created = page.waitForResponse(r => new RegExp(`${api(site).replace(/\./g, '\\.')}/submit-coin/?$`).test(r.url()) && r.request().method() === 'POST', {timeout: 30000}).catch(() => null);
    await button.click({timeout: 15000}).catch(e => { throw notSent(site, 'the submit button is not clickable', e); });
    const r = await created;
    if (!r) {
      const text = await bodyText(page);
      const problem = text.match(/[^.\n]{0,80}(is group|telegram username|correct errors|required)[^.\n]{0,60}/i)?.[0];
      if (problem) throw notSent(site, `the form refused the details (${problem.trim().slice(0, 160)})`);
      return {submitted: false};
    }
    if (r.status() >= 300) throw new NotPostedError(`${site} rejected the listing: HTTP ${r.status()} ${(await r.text().catch(() => '')).slice(0, 160)}; nothing was listed.`);
    return {submitted: true, url: null};
  } finally { await close(); }
}

