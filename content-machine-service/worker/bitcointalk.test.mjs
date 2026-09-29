// Drives the Bitcointalk poster against a local fake of SMF's post form.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BTC_COOKIES,postToBitcointalk,publishBitcointalk,topicUrl} from './bitcointalk.mjs';
import {cookiesToState,NotPostedError} from './reddit.mjs';

const topics = []; let limit = false;
const page = b => `<!doctype html><html><body>${b}</body></html>`;
const form = (err = '') => `${err}<form action="/index.php?action=post2;start=0;board=67" method="post" name="postmodify">
<input type="text" name="subject" maxlength="80"><textarea name="message"></textarea>
<input type="checkbox" name="goback"><input type="hidden" name="sc" value="x"><input type="submit" name="post" value="Post"></form>`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const authed = /SMFCookie129=ok/.test(req.headers.cookie || '');
  let body = ''; for await (const c of req) body += c; const f = new URLSearchParams(body);
  const send = (h, code = 200, hd = {}) => { res.writeHead(code, {'content-type': 'text/html', ...hd}); res.end(page(h)); };
  const action = url.search.match(/action=([a-z0-9]+)/)?.[1];
  if (action === 'post' && req.method === 'GET') return authed ? send(form()) : send('An Error Has Occurred! The user is not logged in.');
  if (action === 'post2') {
    if (limit) return send(form('<div>The following error or errors occurred while posting this message: You have exceeded a spam protection time limit. Please wait 360 seconds.</div>'));
    const id = 5500000 + topics.length; topics.push({id, subject: f.get('subject'), message: f.get('message'), goback: f.get('goback')});
    return send('', 302, {location: `/index.php?topic=${id}.0`});
  }
  const t = url.search.match(/topic=(\d+)/); const tp = t && topics.find(x => x.id === +t[1]);
  if (tp) return send(`<h1>${tp.subject.replace(/&/g, '&amp;')}</h1><div>${tp.message}</div>`);
  send('nf', 404);
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
const dir = await mkdtemp(join(tmpdir(), 'btc-'));
try {
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, JSON.stringify({cookies: [{name: 'SMFCookie129', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax'}], origins: []}));
  const cfg = {origin, board: '67', statePath, executablePath: process.env.CHROMIUM_PATH};
  const target = {subject: 'Moon Frog & friends: anyone watching $MFROG?', message: 'Body\n\nTelegram: https://t.me/moonfrog'};
  const r = await postToBitcointalk(target, cfg);
  assert.equal(r.url, `${origin}/index.php?topic=5500000.0`); assert.equal(r.verified, true);
  assert.equal(topics[0].subject, target.subject); assert.equal(topics[0].message.replace(/\r\n/g, '\n'), target.message); assert.equal(topics[0].goback, 'on');
  // The time limit between posts: nothing sent, safe to retry later.
  limit = true; await assert.rejects(() => postToBitcointalk(target, cfg), e => e instanceof NotPostedError && /spam protection/.test(e.message)); limit = false;
  assert.equal(topics.length, 1);
  // Expired session.
  await writeFile(statePath, JSON.stringify({cookies: [], origins: []}));
  await assert.rejects(() => postToBitcointalk(target, cfg), e => e instanceof NotPostedError && /not available/.test(e.message));
  // Cookie export: needs the SMFCookie, keeps only bitcointalk.org cookies.
  const st = cookiesToState(JSON.stringify([{domain: 'bitcointalk.org', hostOnly: true, name: 'SMFCookie129', value: 'v', path: '/', expirationDate: 1825220966.08, secure: true, httpOnly: true, sameSite: 'lax'}, {domain: 'bitcointalk.org', name: 'sessionid', value: 's', session: true}, {domain: '.google.com', name: 'x', value: 'y'}]), BTC_COOKIES);
  assert.deepEqual(st.cookies.map(c => [c.name, c.domain, c.expires]), [['SMFCookie129', 'bitcointalk.org', 1825220966], ['sessionid', 'bitcointalk.org', -1]]);
  assert.throws(() => cookiesToState('[{"domain":"bitcointalk.org","name":"sessionid","value":"s"}]', BTC_COOKIES), /SMFCookie/);
  assert.equal(topicUrl('https://bitcointalk.org', 'https://bitcointalk.org/index.php?topic=123.msg456#msg456'), 'https://bitcointalk.org/index.php?topic=123.0');
  // Cycle reporting.
  const calls = []; const client = {request: async (p, d) => { calls.push([p, d]); return p === 'publish/claim' ? {job: {id: 'b1', lease: 'L'}, target} : null; }};
  const env = {BTCTALK_COOKIES: 'x'};
  await publishBitcointalk(client, async () => ({url: 'https://bitcointalk.org/index.php?topic=9.0', verified: true}), env);
  assert.deepEqual(calls.at(-1), ['publish/b1/complete', {lease: 'L', url: 'https://bitcointalk.org/index.php?topic=9.0', verified: true}]);
  await publishBitcointalk(client, async () => { throw new NotPostedError('wait 360s'); }, env);
  assert.deepEqual(calls.at(-1), ['publish/b1/fail', {lease: 'L', error: 'wait 360s'}]);
  await publishBitcointalk(client, async () => { throw new Error('crash'); }, env);
  assert.deepEqual(calls.at(-1), ['publish/b1/complete', {lease: 'L', url: null, note: 'crash'}]);
  console.log('PASS: Bitcointalk thread from a saved session with logged-out check, time limit and expired session not posted, cookie export, cycle reporting.');
} finally { server.close(); await rm(dir, {recursive: true, force: true}); }
