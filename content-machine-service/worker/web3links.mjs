import {chromium} from 'playwright';
import {browserContext, NotPostedError} from './reddit.mjs';

/**
 * "Web3 Listing Updates": the token's page on the big exchanges' Web3 wallets. They list every DEX-traded token on
 * their own, so nothing is submitted; each page is opened and kept only when it shows this token (its title names
 * it), so a buyer never gets a dead or empty link. Paths per chain checked live in October 2026: OKX has no Robinhood
 * Chain pages and MEXC no Arc pages.
 */
export const WEB3_PLATFORMS = [
  {name: 'Binance Wallet', chains: {solana: 'sol', bsc: 'bsc', robinhood: 'robinhood', arc: 'arc', ethereum: 'eth', base: 'base'}, url: (c, ca) => `https://web3.binance.com/en/token/${c}/${ca}`},
  {name: 'OKX Wallet', chains: {solana: 'solana', bsc: 'bsc', arc: 'arc', ethereum: 'eth', base: 'base', polygon: 'polygon', arbitrum: 'arbitrum'}, url: (c, ca) => `https://web3.okx.com/token/${c}/${ca}`},
  {name: 'Bitget Wallet', chains: {solana: 'sol', bsc: 'bnb', robinhood: 'robinhood', arc: 'arc', ethereum: 'eth', base: 'base'}, url: (c, ca) => `https://web3.bitget.com/en/swap/${c}/${ca}`},
  {name: 'Gate Web3', chains: {solana: 'solana', bsc: 'bsc', robinhood: 'robinhood', arc: 'arc', ethereum: 'eth', base: 'base'}, url: (c, ca) => `https://web3.gate.com/trade/${c}/${ca}`},
  {name: 'MEXC DEX+', chains: {solana: 'sol', bsc: 'bsc', robinhood: 'robinhood', base: 'base'}, url: (c, ca) => `https://www.mexc.com/dex/onchain/${c}/${ca}`},
];

/** The page each platform has for this token's chain. */
export const web3Candidates = l => WEB3_PLATFORMS.filter(p => p.chains[l.chain]).map(p => ({name: p.name, url: p.url(p.chains[l.chain], l.contract_address)}));

const words = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The page names the token (symbol or name) and is still the token's page (no redirect to a home page). */
export function showsToken(title, finalUrl, l) {
  const t = ` ${words(title)} `;
  const named = [l.symbol, l.name].map(words).filter(w => w.length >= 2).some(w => t.includes(` ${w} `));
  return named && String(finalUrl).toLowerCase().includes(l.contract_address.toLowerCase());
}

export async function web3ListingsSubmit(l, _logoPath, env = process.env) {
  const candidates = web3Candidates(l);
  if (!candidates.length) throw new NotPostedError(`web3_listings: no Web3 wallet pages for ${l.chain}; nothing was sent.`);
  const browser = await chromium.launch({headless: true, executablePath: env.CHROMIUM_PATH || undefined});
  try {
    const ctx = await browser.newContext(browserContext());
    // Pages render their title client-side (Binance takes up to ~15 s): poll it rather than wait a fixed time.
    const check = async c => {
      const page = await ctx.newPage();
      try {
        await page.goto(c.url, {waitUntil: 'domcontentloaded', timeout: 45000});
        for (let waited = 0; waited < 30000; waited += 2000) {
          if (showsToken(await page.title().catch(() => ''), page.url(), l)) return c;
          await page.waitForTimeout(2000);
        }
        return null;
      } catch { return null; } finally { await page.close().catch(() => {}); }
    };
    const links = (await Promise.all(candidates.map(check))).filter(Boolean);
    if (!links.length) throw new NotPostedError('web3_listings: none of the Web3 wallet pages show this token yet; nothing was sent.');
    return {submitted: true, links, note: `${links.length} of ${candidates.length} Web3 wallet pages show the token`};
  } finally { await browser.close(); }
}
