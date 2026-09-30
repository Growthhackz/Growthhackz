import {existsSync,readFileSync} from 'node:fs';
import {chromium} from 'playwright';

/**
 * Firecrawl browser sessions (FIRECRAWL_API_KEY): the site flows drive Firecrawl's remote Chromium over CDP instead of
 * a local one, so the traffic leaves through Firecrawl's proxy (FIRECRAWL_PROXY, default "enhanced") rather than the
 * worker's datacenter IP. Each site keeps its login in a Firecrawl profile (FIRECRAWL_PROFILE_PREFIX-<site>) that is
 * saved when the session stops; `node login.mjs <site>` fills it by hand through Firecrawl's live view.
 */
export const firecrawlEnabled = (env = process.env) => !!env.FIRECRAWL_API_KEY;
export const profileName = (site, env = process.env) => `${env.FIRECRAWL_PROFILE_PREFIX || 'cm'}-${site}`;
/** FIRECRAWL_SITES: the listing sites run through Firecrawl (default both). Firecrawl refuses Reddit, so it isn't one. */
export const firecrawlSite = (site, env = process.env) => firecrawlEnabled(env) && (env.FIRECRAWL_SITES || 'coinsniper,coinvote').split(',').map(s => s.trim()).includes(site);

async function api(path, {method = 'POST', body, timeout = 150000, env = process.env} = {}) {
  const base = (env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/$/, '');
  const res = await fetch(base + path, {
    method,
    headers: {authorization: `Bearer ${env.FIRECRAWL_API_KEY}`, 'content-type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok || json?.success === false) throw new Error(`Firecrawl ${method} ${path.split('/').slice(0, 3).join('/')}: HTTP ${res.status} ${String(json?.error || '').slice(0, 200)}`);
  return json;
}

/** A Firecrawl session with the site's profile, else a local Chromium through `proxy`. */
export async function openBrowser(site, startUrl, {proxy, executablePath = process.env.CHROMIUM_PATH || undefined, save = true} = {}) {
  return firecrawlSite(site) ? firecrawlBrowser(site, startUrl, {save}) : chromium.launch({headless: true, executablePath, proxy});
}

/** The logged-in context: the Firecrawl profile's (plus any saved cookies), else a new local one from the saved state. */
export const sessionContext = (browser, statePath, options = {}) => browser.firecrawl ? browser.firecrawl.context(statePath) : browser.newContext({...options, ...(existsSync(statePath) ? {storageState: statePath} : {})});

/**
 * Starts a Firecrawl browser on `startUrl` with the site's profile and connects to it. Returns a Playwright Browser
 * whose `firecrawl` property holds the session: `context(storageStatePath?)` is the profile's logged-in context (any
 * cookies from a saved storage state are added to it), `page` is the tab already on `startUrl` (Cloudflare can block a
 * later navigation in the session that the first load passed), and `liveViewUrl` lets a person drive the same browser.
 * close() disconnects and stops the session, which saves the profile.
 */
export async function firecrawlBrowser(site, startUrl, {env = process.env, save = true} = {}) {
  const scrape = await api('/v2/scrape', {env, body: {url: startUrl, formats: ['markdown'], onlyMainContent: false, proxy: env.FIRECRAWL_PROXY || 'enhanced', profile: {name: profileName(site, env), saveChanges: save}}});
  const id = scrape?.data?.metadata?.scrapeId;
  if (!id) throw new Error('Firecrawl did not return a scrape id');
  const stop = () => api(`/v2/scrape/${id}/interact`, {method: 'DELETE', env, timeout: 60000}).catch(e => console.error(`Firecrawl session ${id} did not stop cleanly: ${e.message}`));
  let browser;
  try {
    const s = await api(`/v2/scrape/${id}/interact`, {env, body: {code: 'page.url()', language: 'node', timeout: 30}});
    if (!s.cdpUrl) throw new Error('Firecrawl returned no CDP URL for the session');
    browser = await chromium.connectOverCDP(s.cdpUrl, {timeout: 60000});
    const context = browser.contexts()[0];
    if (!context) throw new Error('The Firecrawl browser has no context');
    browser.firecrawl = {
      id,
      page: context.pages()[0] ?? null,
      liveViewUrl: s.interactiveLiveViewUrl || s.liveViewUrl,
      async context(storageState) {
        if (storageState && existsSync(storageState)) {
          const cookies = JSON.parse(readFileSync(storageState, 'utf8')).cookies ?? [];
          if (cookies.length) await context.addCookies(cookies);
        }
        return context;
      },
    };
    const disconnect = browser.close.bind(browser);
    browser.close = async () => { await disconnect().catch(() => {}); await stop(); };
    return browser;
  } catch (e) {
    await browser?.close().catch(() => {});
    await stop();
    throw e;
  }
}
