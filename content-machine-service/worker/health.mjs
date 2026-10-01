import {access} from 'node:fs/promises';
import {join} from 'node:path';
import {btcConfig, btcWhoAmI} from './bitcointalk.mjs';
import {cmcConfig, cmcHealth} from './cmc.mjs';
import {coinscopeHealth, freshcoinsHealth, gemfinderHealth, top100Health} from './listingsites.mjs';

/** How often every source is checked. The CMC and GemFinder checks also keep their logins fresh. */
export const HEALTH_EVERY_MS = 30 * 60_000;

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
}
