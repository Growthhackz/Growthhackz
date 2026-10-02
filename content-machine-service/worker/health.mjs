import {access} from 'node:fs/promises';
import {join} from 'node:path';
import {btcConfig, btcWhoAmI} from './bitcointalk.mjs';
import {cmcConfig, cmcFindPost, cmcHealth} from './cmc.mjs';
import {chromium} from 'playwright';
import {hasStickySession, proxySettings, rotateProxySession, setProxyDown} from './reddit.mjs';
import {coinscopeHealth, freshcoinsHealth, gemfinderFind, gemfinderHealth, top100Health} from './listingsites.mjs';

/** How often every source is checked. The CMC and GemFinder checks also keep their logins fresh. */
export const HEALTH_EVERY_MS = 30 * 60_000;
/** While a source is broken it is rechecked (each check also renews its login where it can) this often. */
export const FIXING_EVERY_MS = 5 * 60_000;

const safe = async (fn) => { try { return await fn(); } catch (e) { return {ok: false, detail: String(e?.message || e).split('\n')[0].slice(0, 200)}; } };

/** Read-only checks of every source the worker posts to; nothing is published. Sources not configured are left out. */
export async function sourceChecks(env = process.env, retryMs = 10000) {
  const checks = [];
  // A failure is checked again once after a short wait, so one slow page load doesn't page the admins.
  const add = async (source, enabled, fn) => {
    if (!enabled) return;
    let r = await safe(fn);
    if (!r.ok) { await new Promise(res => setTimeout(res, retryMs)); r = await safe(fn); }
    checks.push({source, ...r});
  };
  // The residential proxy first: when it isn't answering, every site after this runs without it until it is back.
  await add('proxy', env.DIRECTORY_PROXY, async () => {
    let r = await probeProxy(env.DIRECTORY_PROXY);
    // A sticky session whose home IP went offline: take a fresh session (fresh IP), up to twice.
    for (let i = 0; !r.ok && i < 2 && hasStickySession(env.DIRECTORY_PROXY); i++) {
      const id = rotateProxySession();
      r = await probeProxy(env.DIRECTORY_PROXY);
      if (r.ok) { r = {ok: true, detail: `${r.detail}; switched to a fresh session (${id}) after the previous IP stopped answering`}; console.log(`Proxy: rotated to session ${id}`); }
    }
    setProxyDown(!r.ok);
    return r.ok ? r : {ok: false, detail: `${r.detail}; sites are running without the proxy until it answers again`};
  });
  await add('cmc', env.CMC_COOKIES || env.CMC_EMAIL, () => cmcHealth(cmcConfig(env)));
  await add('bitcointalk', env.BTCTALK_COOKIES, async () => {
    const who = await btcWhoAmI(btcConfig(env));
    return who ? {ok: true, detail: `logged in as ${who}`} : {ok: false, detail: 'logged out: export fresh BTCTALK_COOKIES from a logged-in browser'};
  });
  await add('binance', env.BINANCE_SQUARE_SKILL_DIR || env.BINANCE_SQUARE_OPENAPI_KEY, async () => {
    if (!env.BINANCE_SQUARE_OPENAPI_KEY) return {ok: false, detail: 'set BINANCE_SQUARE_OPENAPI_KEY'};
    await access(join(env.BINANCE_SQUARE_SKILL_DIR || '', 'scripts/post-image.mjs')).catch(() => { throw new Error('the Binance Square skill is missing from the worker image'); });
    return {ok: true, detail: 'key and posting script present'};
  });
  await add('top100token', env.TOP100_HEALTH !== 'off', () => top100Health());
  await add('gemfinder', env.GEMFINDER_EMAIL, () => gemfinderHealth(env));
  await add('freshcoins', env.FRESHCOINS_COOKIES, () => freshcoinsHealth(env));
  await add('coinscope', env.COINSCOPE_REFRESH_TOKEN, () => coinscopeHealth(env));
  return checks;
}

/** One round: check everything and hand the results to the service (which alerts admins on any change). */
export async function healthRound(client, env = process.env) {
  const checks = await sourceChecks(env);
  for (const c of checks) console.log(`Health ${c.source}: ${c.ok ? 'ok' : 'BROKEN'} (${c.detail})`);
  await client.request('health/report', {checks});
  return checks;
}

/** How long until the next round: sooner while something is broken. */
export const nextRoundIn = checks => (checks.some(c => !c.ok) ? FIXING_EVERY_MS : HEALTH_EVERY_MS);

/**
 * Self-healing: takes one uncertain publication (a CMC post or GemFinder listing that may or may not have gone out),
 * looks for it on our account and reports: found (its link), absent (posted again), or could not tell.
 */
export async function verifyCycle(client, env = process.env) {
  const kinds = [...(env.CMC_COOKIES || env.CMC_EMAIL ? ['cmc_community'] : []), ...(env.GEMFINDER_EMAIL ? ['gemfinder'] : [])];
  if (!kinds.length) return;
  const c = await client.request('verify/claim', {kinds});
  if (!c) return;
  const r = c.job.kind === 'cmc_community' ? await cmcFindPost(c.target.text, cmcConfig(env)) : await gemfinderFind(c.target.listing, env);
  console.log(`Verify ${c.job.kind} (${c.job.order_id}): ${r.url ? `found ${r.url}` : r.absent ? 'not on our account; it will be posted again' : `could not tell (${r.note ?? r.detail})`}`);
  await client.request(`verify/${c.job.id}/result`, {url: r.url ?? null, absent: r.absent === true, note: r.note ?? r.detail ?? null});
}

/** One tiny page through the proxy: does it answer, and from which IP. */
export async function probeProxy(raw) {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, proxy: proxySettings(raw)});
  try {
    const page = await browser.newPage();
    await page.goto('https://ipv4.icanhazip.com', {waitUntil: 'domcontentloaded', timeout: 25000});
    const ip = (await page.locator('body').innerText()).trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? {ok: true, detail: `answering (exit IP ${ip})`} : {ok: false, detail: `not answering properly (${ip.slice(0, 80)})`};
  } catch (e) {
    return {ok: false, detail: `not answering: ${String(e?.message || e).split('\n')[0].slice(0, 120)} (out of data on the IPRoyal plan, or an outage)`};
  } finally { await browser.close(); }
}
