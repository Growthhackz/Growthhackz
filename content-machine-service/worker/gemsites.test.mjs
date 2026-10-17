// CoinGem / CoinDizzy lookups and the decisions before any wallet sign-in, against fake APIs (nothing sent).
import assert from 'node:assert/strict';
import {gemCheck, gemExists, gemFind, gemSubmit} from './gemsites.mjs';
import {NotOfferedError, NotPostedError} from './reddit.mjs';

const CA = 'So11111111111111111111111111111111111111112';
const listing = {name: 'Moon Frog', symbol: 'MFROG', chain: 'solana', contract_address: CA};
let exists = true, page = `<html>${CA}</html>`;
const calls = [];
const fake = async (url, init = {}) => {
  calls.push(`${init.method ?? 'GET'} ${url}`);
  if (url.endsWith('/submit-coin/check')) { assert.deepEqual(JSON.parse(init.body), {address: CA}); return {ok: true, json: async () => ({exists})}; }
  if (url.startsWith('https://api.coingem.com/search')) return {ok: true, json: async () => ({search: [{address: 'other', short_url: 'x', chain: {url: 'solana'}}, {address: CA, short_url: 'moon-frog', chain: {url: 'solana'}}]})};
  return {ok: !!page, text: async () => page};
};
assert.equal(await gemExists('coindizzy', listing, fake), true);
assert.ok(calls[0].startsWith('POST https://api.coindizzy.com/submit-coin/check'));
// Already there: its page on each site, found through CoinGem's search, opened on the site itself. No sign-in.
assert.equal(await gemFind('coingem', listing, fake), 'https://coingem.com/solana/moon-frog');
assert.deepEqual(await gemSubmit('coindizzy', listing, null, {}, {fetchFn: fake}), {submitted: true, url: 'https://coindizzy.com/solana/moon-frog', note: 'already listed'});
assert.deepEqual(await gemCheck('coingem', listing, fake), {live: true, url: 'https://coingem.com/solana/moon-frog'});
// A page that doesn't show the coin is not taken as its page.
page = '<html>other</html>';
assert.deepEqual(await gemCheck('coingem', listing, fake), {live: false});
assert.deepEqual(await gemSubmit('coingem', listing, null, {}, {fetchFn: fake}), {submitted: true, url: null, note: 'already submitted, in review'});
// Not there yet: Solana only, and a person's Telegram as the contact is required before anything is opened.
exists = false;
await assert.rejects(() => gemSubmit('coingem', {...listing, chain: 'bsc'}, null, {}, {fetchFn: fake}), NotOfferedError);
await assert.rejects(() => gemSubmit('coingem', listing, null, {}, {fetchFn: fake}), e => e instanceof NotPostedError && /LISTING_CONTACT_TELEGRAM/.test(e.message));
console.log('PASS: CoinGem/CoinDizzy existing coin pages (no sign-in), page must show the coin, Solana-only submit, contact Telegram required.');
