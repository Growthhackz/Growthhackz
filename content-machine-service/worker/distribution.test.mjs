// Drives the CMC poster and the 1888 submitter against local fakes of each site.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cmcConfig,findPostId,postToCmc,publishCmc} from './cmc.mjs';
import {checkRelease,pressConfig,pressCycle,slug,submitRelease} from './press.mjs';
import {NotPostedError} from './reddit.mjs';

const dir = await mkdtemp(join(tmpdir(), 'dist-'));
const png = join(dir, 'img.png'); await writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex'));
const page = b => `<!doctype html><html><body>${b}</body></html>`;
const body = async req => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
const listen = async server => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; };

// ---------------------------------------------------------------- fake CMC
const cmc = {posts: [], createReturnsId: true, nextId: 9001};
const profileHtml = authed => page(authed ? `
<button>Edit</button>
<div><h2>All Posts</h2><div id="search" style="display:inline-block;width:32px"><svg width="16" height="16"></svg></div><div id="compose" style="display:inline-block;width:32px"><svg width="16" height="16"></svg></div></div>
<div id="composer" style="display:none"><div contenteditable="true" id="ed"></div><input type="file" accept=".jpeg,.jpg,.png,.gif" multiple><button id="post">Post</button></div>
<script>
fetch('/gravity/v3/gravity/user/query').then(r=>r.json());
document.getElementById('compose').onclick=()=>{document.getElementById('composer').style.display='block'};
document.getElementById('post').onclick=()=>fetch('/gravity/v4/gravity/post/create',{method:'POST',body:document.getElementById('ed').innerText});
</script>` : `
<button id="open">Log In</button>
<div id="lf" style="display:none"><input type="email"><input type="password"><button id="go">Log In</button></div>
<script>
document.getElementById('open').onclick=()=>{document.getElementById('lf').style.display='block'};
document.getElementById('go').onclick=async()=>{const r=await fetch('/login',{method:'POST',body:document.querySelector('input[type=password]').value});if(r.ok)location.reload()};
</script>`);
const cmcServer = createServer(async (req, res) => {
  const authed = /sid=1/.test(req.headers.cookie || '');
  const url = new URL(req.url, 'http://x');
  const json = (o, h = {}) => { res.writeHead(200, {'content-type': 'application/json', ...h}); res.end(JSON.stringify(o)); };
  if (url.pathname === '/login') { const pw = await body(req); if (pw === 'pw') return json({ok: true}, {'set-cookie': 'sid=1; Path=/'}); res.writeHead(401); return res.end('{}'); }
  if (url.pathname === '/gravity/v4/gravity/post/create') {
    const text = await body(req); const id = String(cmc.nextId++); cmc.posts.unshift({gravityId: id, textContent: text});
    return json(cmc.createReturnsId ? {data: {gravityId: id}} : {data: {ok: true}});
  }
  if (url.pathname === '/gravity/v3/gravity/user/query') return json({data: {tweetDTOList: cmc.posts}});
  if (url.pathname === '/community/profile/peakbuybot/') { res.writeHead(200, {'content-type': 'text/html'}); return res.end(profileHtml(authed)); }
  res.writeHead(404); res.end('nf');
});
const cmcOrigin = await listen(cmcServer);
const cmcCfg = extra => ({...cmcConfig({}), origin: cmcOrigin, email: 'a@b.c', password: 'pw', statePath: join(dir, 'cmc.json'), ...extra});
const target = {text: '🔥 The $MFROG squad is cooking.\n\nTelegram: https://t.me/moonfrog'};

let r = await postToCmc(target, png, cmcCfg());
assert.equal(r.url, `${cmcOrigin}/community/post/9001/`);
assert.ok(cmc.posts[0].textContent.includes('The $MFROG squad is cooking.'));
assert.ok(cmc.posts[0].textContent.includes('Telegram: https://t.me/moonfrog'));
// Session reused; the create response has no id, so the profile listing is used.
cmc.createReturnsId = false;
r = await postToCmc({text: 'Second post about Moon Frog'}, null, cmcCfg({password: 'wrong'}));
assert.equal(r.url, `${cmcOrigin}/community/post/9002/`);
await assert.rejects(postToCmc(target, null, cmcCfg({statePath: join(dir, 'none.json'), password: 'wrong'})), NotPostedError);
await assert.rejects(postToCmc(target, null, {...cmcCfg(), email: undefined, statePath: join(dir, 'none3.json')}), NotPostedError);
assert.equal(findPostId({data: {tweetDTOList: [{gravityId: '1', textContent: 'other'}, {gravityId: '2', textContent: 'Second post about'}]}}, 'Second post about Moon'), '2');

// publishCmc reporting
const calls = [];
const client = (claim, asset = Buffer.from('89504e47', 'hex')) => ({
  request: async (path, data) => { calls.push([path, data]); return path === 'publish/claim' ? claim : null; },
  asset: async () => asset,
});
const claim = {job: {id: 'j1', kind: 'cmc_community', lease: 'L'}, target: {text: 'hi', image_asset_url: '/v1/assets/a'}};
await publishCmc(client(claim), async (_t, img) => { assert.ok(img.endsWith('.png')); return {url: 'https://coinmarketcap.com/community/post/5/'}; }, {CMC_EMAIL: 'x', CMC_PASSWORD: 'y'});
assert.deepEqual(calls.at(-1), ['publish/j1/complete', {lease: 'L', url: 'https://coinmarketcap.com/community/post/5/'}]);
await publishCmc(client(claim), async () => { throw new NotPostedError('captcha'); }, {CMC_EMAIL: 'x', CMC_PASSWORD: 'y'});
assert.deepEqual(calls.at(-1), ['publish/j1/fail', {lease: 'L', error: 'captcha'}]);
await publishCmc(client(claim), async () => { throw new Error('crash after click'); }, {CMC_EMAIL: 'x', CMC_PASSWORD: 'y'});
assert.deepEqual(calls.at(-1), ['publish/j1/complete', {lease: 'L', url: null, note: 'crash after click'}]);
cmcServer.close();

// ---------------------------------------------------------------- fake 1888
const pr = {companies: ['Peak BuyBot'], releases: [], published: [], noFree: false};
const form = () => `<form name="pressreleaseform" method="post" action="/preview.php" onsubmit="return v()">
<textarea name="txtheadline"></textarea><textarea name="txtsummary"></textarea><textarea name="txt1888pressrelease"></textarea>
<input name="txtkeywords"><select name="cmbprtypesuggest"><option value="">Select</option><option value="1">Product Launch</option><option value="6">General Press Release</option></select>
<select name="cmbcategory"><option value="">Select</option><option value="3">Art</option><option value="53">Banking &amp; Financial</option></select>
<select name="cmbmsa"><option value="">Select</option><option value="0">None</option></select>
<select name="cmbcountry"><option value="">Select</option><option value="US">United States</option></select>
<select name="cmbmonth">${['09', '10'].map(m => `<option value=${m}${m === '09' ? ' selected' : ''}>${m}</option>`).join('')}</select>
<select name="cmbday"><option value="" selected>Day</option>${Array.from({length: 31}, (_, i) => String(i + 1).padStart(2, '0')).map(d => `<option value="${d}">${d}</option>`).join('')}</select>
<select name="cmbyear"><option value=2026 selected>2026</option><option value=2027>2027</option></select><input type="hidden" name="serverdate" value="2026/09/30">
<select name="txtcompanyname"><option value="">Select Company</option>${pr.companies.map((c, i) => `<option value="${i + 1}">${c}</option>`).join('')}</select>
<input name="txturl"><input name="txtemail"><input name="txtcontactname"><input name="txtphone"><input name="txtzipcode">
<input type="checkbox" name="chk1"><input type="checkbox" name="chk2"><input type="checkbox" name="chk3"><input type="image" name="submit" src="x.png" alt="Submit"></form>
<script>function v(){var f=document.pressreleaseform;if(f.txt1888pressrelease.value.length<750){alert('Minimum 750 characters');return false}if(!f.txtcompanyname.value){alert('Select company');return false}return true}</script>`;
const prServer = createServer(async (req, res) => {
  const authed = /sid=2/.test(req.headers.cookie || '');
  const url = new URL(req.url, 'http://x');
  const send = (h, code = 200, extra = {}) => { res.writeHead(code, {'content-type': 'text/html', ...extra}); res.end(page(h)); };
  if (url.pathname === '/login.html' && req.method === 'GET') return send('<form name="login" method="POST"><input name="txtusername"><input name="txtpassword" type="password"><input type="image" src="l.png" value="Login"></form>');
  if (url.pathname === '/login.html') { const f = new URLSearchParams(await body(req)); return f.get('txtpassword') === 'pw' ? send("<script>window.location='user_info.php'</script>", 200, {'set-cookie': 'sid=2; Path=/'}) : send('Invalid Log in'); }
  if (url.pathname === '/user_info.php') return send('Welcome');
  if (url.pathname === '/submit-free-press-release.html') return authed ? send(form()) : send('', 302, {location: '/login.html'});
  // Like the real site: a plan picker with a paid plan ticked by default; each plan loads its own panel with a continue link.
  if (url.pathname === '/preview.php') {
    const f = new URLSearchParams(await body(req)); pr.pending = f;
    const box = (id, plan, checked) => `<input type="checkbox" name="r1" id="${id}" onclick="show('${plan}')"${checked ? ' checked="checked"' : ''}/>`;
    return send(`<form name="frmpreview" method="post">${box('prvtpck01', '6')}${box('prvupck01', '5', true)}${pr.noFree ? '' : box('prvfpck01', '0')}</form><div id="plan_preview"></div>
<script>var plan='5';function show(p){plan=p;fetch('/ajax_pr_preview.php',{method:'POST',body:'plan='+p}).then(r=>r.text()).then(h=>{document.getElementById('plan_preview').innerHTML=h})}
function confirm_pr(){var f=document.createElement('form');f.method='post';f.action='/final.php?plan='+plan;document.body.appendChild(f);f.submit()}show('5');</script>`);
  }
  if (url.pathname === '/ajax_pr_preview.php') { const plan = new URLSearchParams(await body(req)).get('plan'); return send(`${plan === '0' ? '' : '<b>Ultimate Plan - $150.00</b>'}<p>${pr.pending.get('txtheadline')}</p><a onclick="modify_pr()">Edit</a><a style="cursor:pointer" onClick="confirm_pr();"><img src="images/btn-continuenext.gif"></a>`); }
  if (url.pathname === '/final.php') { pr.pending.set('plan', url.searchParams.get('plan')); pr.releases.push(pr.pending); return send('<p>Thank you! Your press release has been submitted and is pending review.</p>'); }
  const m = url.pathname.match(/^\/(\d\d-\d\d-\d{4})\.html$/);
  if (m) return send(pr.published.filter(p => p.date === m[1]).map(p => `<a href="/${p.slug}-pr-7${p.n}.html">${p.h}</a>`).join(''));
  send('nf', 404);
});
const prOrigin = await listen(prServer);
const prCfg = extra => ({...pressConfig({}), origin: prOrigin, username: 'peakbuybot', password: 'pw', company: 'Peak BuyBot', contact: 'Peak Team', email: 'info@example.com', statePath: join(dir, 'pr.json'), ...extra});
const release = {headline: 'Moon Frog squad launches community kit', summary: 'The $MFROG squad is cooking.', body: 'Moon Frog body. '.repeat(60), keywords: 'Moon Frog, MFROG', website_url: 'https://t.me/moonfrog'};

assert.deepEqual(await submitRelease(release, prCfg()), {submitted: true});
const sent = pr.releases[0];
assert.equal(sent.get('txtheadline'), release.headline);
assert.equal(sent.get('txtcompanyname'), '1');
assert.equal(sent.get('cmbcategory'), '53');
assert.equal(sent.get('cmbprtypesuggest'), '6');
assert.equal(sent.get('txtcontactname'), 'Peak Team');
assert.equal(sent.get('chk3'), 'on');
assert.equal(sent.get('plan'), '0'); // the free plan, never the paid default
assert.equal(`${sent.get('cmbyear')}/${sent.get('cmbmonth')}/${sent.get('cmbday')}`, '2026/10/01'); // the site's next day
// No free plan offered: nothing is submitted.
pr.noFree = true;
await assert.rejects(submitRelease(release, prCfg()), e => e instanceof NotPostedError && /free plan/.test(e.message));
pr.noFree = false;
await assert.rejects(submitRelease({...release, body: 'too short'}, prCfg()), e => e instanceof NotPostedError && /750/.test(e.message));
await assert.rejects(submitRelease(release, prCfg({company: 'Other Co'})), e => e instanceof NotPostedError && /not on the 1888 account/.test(e.message));
await assert.rejects(submitRelease(release, prCfg({statePath: join(dir, 'none2.json'), password: 'bad'})), NotPostedError);
await assert.rejects(submitRelease(release, prCfg({contact: undefined})), e => /PRESS_CONTACT_NAME/.test(e.message));
assert.equal(pr.releases.length, 1);

const now = new Date('2026-09-30T12:00:00Z');
assert.deepEqual(await checkRelease(release, {submitted_at: '2026-09-28T10:00:00Z'}, prCfg(), fetch, now), {live: false});
pr.published.push({date: '09-29-2026', slug: slug(release.headline).slice(0, 60), n: 12, h: release.headline});
assert.deepEqual(await checkRelease(release, {submitted_at: '2026-09-28T10:00:00Z'}, prCfg(), fetch, now), {live: true, url: `${prOrigin}/${slug(release.headline)}-pr-712.html`});

// pressCycle reporting
calls.length = 0;
const pclaim = {job: {id: 'p1', kind: 'press_1888', lease: 'L'}, target: {release}};
const pclient = {request: async (path, data) => { calls.push([path, data]); return path === 'publish/claim' ? pclaim : path === 'listings/check-claim' ? {job: {id: 'p0'}, target: {release}, submission: {}} : null; }};
await pressCycle(pclient, {submit: async () => ({submitted: true}), check: async () => ({live: true, url: 'u'}), env: {PRESS1888_USERNAME: 'a', PRESS1888_PASSWORD: 'b'}});
assert.deepEqual(calls, [
  ['publish/claim', {kinds: ['press_1888']}],
  ['publish/p1/complete', {lease: 'L', submitted: true, url: null}],
  ['listings/check-claim', {kinds: ['press_1888']}],
  ['listings/p0/checked', {live: true, url: 'u'}],
]);
prServer.close();
await rm(dir, {recursive: true, force: true});
console.log('PASS: CMC login, compose, post id from API (and profile fallback), bad login not posted, cycle reporting; 1888 login, company/category/type selection, preview → final submit, validation alert and missing company not sent, live check on daily pages, cycle reporting.');
