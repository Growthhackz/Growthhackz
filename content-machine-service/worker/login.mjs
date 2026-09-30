// One-time login for a Firecrawl profile: node --env-file=.env login.mjs coinsniper|coinvote
// Opens the site's login page in a Firecrawl browser, prints a live-view link for you to log in (and pass any
// captcha) by hand, waits until the site shows us logged in, then stops the session so Firecrawl saves the profile.
// Don't run it while the worker is using the same site: a profile has one writer at a time.
import {hasListingForm, siteConfig} from './directories.mjs';
import {firecrawlBrowser, firecrawlEnabled, profileName} from './firecrawl.mjs';

const site = process.argv[2];
if (!firecrawlEnabled()) { console.error('Set FIRECRAWL_API_KEY first.'); process.exit(1); }
if (!['coinsniper', 'coinvote'].includes(site)) { console.error('Usage: node login.mjs coinsniper|coinvote (Firecrawl does not open Reddit)'); process.exit(1); }

const cfg = siteConfig(site);

/**
 * Logged in once the submit form shows in the tab you are using (the site sends you on to it, or you open it), or in a
 * tab of our own opened on it. Never navigates your tab.
 */
async function loggedIn(context, yours) {
  const onForm = async p => p.url().startsWith(cfg.origin + cfg.submit) && !(await p.locator('input[type="password"]').count()) && (await hasListingForm(p));
  if (await onForm(yours).catch(() => false)) return 'the submit form is open';
  const page = await context.newPage();
  try {
    await page.goto(cfg.origin + cfg.submit, {waitUntil: 'domcontentloaded', timeout: 45000});
    await page.waitForTimeout(2000);
    return (await onForm(page)) ? 'the submit form is open' : null;
  } catch { return null; } finally { await page.close().catch(() => {}); }
}

const browser = await firecrawlBrowser(site, cfg.origin + cfg.login);
let who = null;
try {
  const context = await browser.firecrawl.context();
  const yours = browser.firecrawl.page ?? await context.newPage();
  who = await loggedIn(context, yours);
  if (who) console.log(`Profile ${profileName(site)} is already logged in to ${site} (${who}).`);
  else {
    console.log(`Open this link and log in to ${site}, then open ${cfg.origin + cfg.submit} in the same tab (the session closes after about 9 minutes):\n\n  ${browser.firecrawl.liveViewUrl}\n`);
    for (let i = 0; i < 26 && !who; i++) { await new Promise(r => setTimeout(r, 20000)); who = await loggedIn(context, yours); }
    console.log(who ? `Logged in (${who}). Saving the profile ${profileName(site)}…` : 'Not logged in yet; nothing new was saved as logged in. Run it again.');
  }
} finally { await browser.close(); }
process.exit(who ? 0 : 2);
