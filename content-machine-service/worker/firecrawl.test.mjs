// Drives firecrawlBrowser against a fake Firecrawl API whose "remote" browser is a local Chromium exposing CDP.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {firecrawlBrowser,firecrawlSite,profileName} from './firecrawl.mjs';

const port = 9400 + Math.floor(Math.random() * 400);
const remote = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH, args: [`--remote-debugging-port=${port}`]});
const calls = [];
let refuseInteract = false;
const api = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  calls.push({method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null});
  res.writeHead(200, {'content-type': 'application/json'});
  if (req.url === '/v2/scrape') return res.end(JSON.stringify({success: true, data: {metadata: {scrapeId: 'sc1'}}}));
  if (req.url === '/v2/scrape/sc1/interact' && req.method === 'POST') return res.end(JSON.stringify(refuseInteract ? {success: false, error: 'no browser'} : {success: true, cdpUrl: `http://127.0.0.1:${port}`, interactiveLiveViewUrl: 'https://live.example/x'}));
  if (req.url === '/v2/scrape/sc1/interact' && req.method === 'DELETE') return res.end(JSON.stringify({success: true, status: 'stopped'}));
  res.end('{}');
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const env = {FIRECRAWL_API_KEY: 'fc-test', FIRECRAWL_API_URL: `http://127.0.0.1:${api.address().port}`};
const dir = await mkdtemp(join(tmpdir(), 'fc-'));
try {
  assert.equal(profileName('coinvote', env), 'cm-coinvote');
  assert.equal(firecrawlSite('coinvote', {}), false);
  assert.equal(firecrawlSite('coinvote', env), true);
  assert.equal(firecrawlSite('reddit', env), false);
  assert.equal(firecrawlSite('coinsniper', {...env, FIRECRAWL_SITES: 'coinvote'}), false);

  // Starts a profile session with the proxy, connects over CDP, adds saved cookies, and stops (saving) on close.
  const state = join(dir, 'state.json');
  await writeFile(state, JSON.stringify({cookies: [{name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax'}], origins: []}));
  const b = await firecrawlBrowser('coinvote', 'https://coinvote.cc/en/login', {env});
  assert.equal(b.firecrawl.liveViewUrl, 'https://live.example/x');
  const ctx = await b.firecrawl.context(state);
  assert.ok((await ctx.cookies('http://example.com')).some(c => c.name === 'sid'));
  const page = await ctx.newPage(); await page.setContent('<p>ok</p>'); assert.equal(await page.locator('p').innerText(), 'ok');
  await b.close();
  const start = calls.find(c => c.path === '/v2/scrape');
  assert.equal(start.auth, 'Bearer fc-test');
  assert.deepEqual(start.body.profile, {name: 'cm-coinvote', saveChanges: true});
  assert.equal(start.body.proxy, 'enhanced');
  assert.equal(start.body.url, 'https://coinvote.cc/en/login');
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path === '/v2/scrape/sc1/interact'), 'session stopped on close');

  // A read-only session asks Firecrawl not to save the profile.
  calls.length = 0;
  const ro = await firecrawlBrowser('coinsniper', 'https://coinsniper.net/', {env: {...env, FIRECRAWL_PROXY: 'stealth'}, save: false});
  await ro.close();
  assert.deepEqual(calls[0].body.profile, {name: 'cm-coinsniper', saveChanges: false});
  assert.equal(calls[0].body.proxy, 'stealth');

  // A session that never gives a browser is stopped, not leaked.
  calls.length = 0; refuseInteract = true;
  await assert.rejects(firecrawlBrowser('coinsniper', 'https://coinsniper.net/login', {env}), /Firecrawl POST/);
  assert.ok(calls.some(c => c.method === 'DELETE'), 'failed session stopped');
  console.log('firecrawl tests passed');
} finally {
  api.close(); await remote.close(); await rm(dir, {recursive: true, force: true});
}
