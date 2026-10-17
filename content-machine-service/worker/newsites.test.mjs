// HKDeFi's submission and lookup, and GemPump's status reading, against fake APIs (no browser, nothing sent).
import assert from 'node:assert/strict';
import {gempumpStatus, hkdefiFind, hkdefiSubmit, LISTING_SITES} from './listingsites.mjs';
import {NotOfferedError, NotPostedError} from './reddit.mjs';

const listing = {name: 'Moon Frog', symbol: 'MFROG', chain: 'solana', contract_address: 'So11111111111111111111111111111111111111112', description: 'Moon Frog brings its community together.', website_url: 'https://moonfrog.example', telegram_url: 'https://t.me/moonfrog', x_url: 'https://x.com/moonfrog', logo_public_url: 'https://cdn.example/logo.png'};
const res = (body, status = 200) => ({ok: status < 300, status, json: async () => body});

// HKDeFi: one JSON request with their chain/DEX ids, the project's Telegram as contact, presale "None".
const sent = [];
let listed = [], answer = {code: 1, msg: 'Submission successful, We are reviewing!'};
const hk = async (url, init = {}) => {
  if (url.includes('/search?')) return res({code: 1, data: {rows: listed}});
  sent.push(JSON.parse(init.body)); return res(answer);
};
assert.deepEqual(await hkdefiSubmit(listing, null, {}, hk), {submitted: true, url: null});
assert.deepEqual(sent[0], {name: 'Moon Frog', symbol: '$MFROG', chain: 27, image: 'https://cdn.example/logo.png', contract: listing.contract_address, description: listing.description, presale_platform: 23, presale_time: '', presale_url: '', launch_platform: 85, launch_time: '', launch_url: '', website: 'https://moonfrog.example', telegram: 'https://t.me/moonfrog', twitter: 'https://x.com/moonfrog', discord: '', contact_email: '', contact_telegram: 'https://t.me/moonfrog'});
// No Telegram: our listing e-mail is the contact; without one, nothing is sent.
await hkdefiSubmit({...listing, telegram_url: null, chain: 'bsc'}, null, {LISTING_CONTACT_EMAIL: 'ops@example.com'}, hk);
assert.equal(sent[1].contact_email, 'ops@example.com'); assert.equal(sent[1].chain, 14); assert.equal(sent[1].launch_platform, 19);
await assert.rejects(() => hkdefiSubmit({...listing, telegram_url: null}, null, {}, hk), e => e instanceof NotPostedError && /contact/.test(e.message));
assert.equal(sent.length, 2);
// A refusal (code 0) is reported as not listed; a chain HKDeFi lacks is skipped.
answer = {code: 0, msg: '联系人邮箱或电报必须填一个'};
await assert.rejects(() => hkdefiSubmit(listing, null, {}, hk), e => e instanceof NotPostedError && /rejected/.test(e.message));
await assert.rejects(() => hkdefiSubmit({...listing, chain: 'arc'}, null, {}, hk), NotOfferedError);
// Once approved, search finds it by contract: its coin page; already listed means nothing is sent.
listed = [{id: 123, name: 'Moon Frog', contract: listing.contract_address}, {id: 9, name: 'Moon Frog', contract: 'other'}];
assert.deepEqual(await hkdefiFind(listing, hk), {live: true, url: 'https://hkdefi.io/coin/123'});
const before = sent.length;
assert.deepEqual(await hkdefiSubmit(listing, null, {}, hk), {submitted: true, url: 'https://hkdefi.io/coin/123', note: 'already listed'});
assert.equal(sent.length, before);

// GemPump: its network ids and the token's review status.
let status = {status: -1, name: ''};
const gp = async url => url.includes('/network/useable') ? res({data: [{dexscreenerName: 'solana', name: 'Solana', id: 'S1'}, {dexscreenerName: 'robinhood', name: 'Robinhood', id: 'R1'}]}) : (assert.match(url, /network=S1&address=So1/), res({data: status}));
assert.deepEqual(await gempumpStatus(listing, gp), {offered: true, net: {dexscreenerName: 'solana', name: 'Solana', id: 'S1'}, status: -1, url: null});
status = {status: 1, nameId: 'moon-frog'};
assert.equal((await gempumpStatus(listing, gp)).url, 'https://www.gempump.io/en/token/moon-frog');
assert.equal((await gempumpStatus({...listing, chain: 'base'}, gp)).offered, false);

// CoinBoom shares Top100Token's flow and coin pages on its own domain.
assert.ok(LISTING_SITES.coinboom && LISTING_SITES.hkdefi && LISTING_SITES.gempump);
console.log('PASS: HKDeFi payload, contact rules, refusal, already listed and coin page lookup; GemPump status and coin page; new sites registered.');
