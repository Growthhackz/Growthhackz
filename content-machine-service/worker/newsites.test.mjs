import assert from 'node:assert/strict';
import {coincodexBody, coincodexSubmit, NEW_LISTING_SITES} from './newsites.mjs';
import {NotPostedError} from './reddit.mjs';

const listing = {
  name: 'Moon Frog', symbol: 'MFROG', chain: 'solana', contract_address: 'So1anaMint1111111111111111111111111111111111',
  short_description: 'The frog community.', description: 'Long description.', website_url: null, telegram_url: 'https://t.me/moonfrog',
  x_url: 'https://x.com/moonfrog', chart_url: 'https://dexscreener.com/solana/x', launch_date: '2026-10-01', logo_public_url: 'https://cdn.example.com/logo.png',
};
const env = {LISTING_CONTACT_EMAIL: 'listings@example.com'};

// Off unless named in NEW_LISTING_SITES.
assert.equal(NEW_LISTING_SITES.coincodex.enabled({}), false);
assert.equal(NEW_LISTING_SITES.coincodex.enabled({NEW_LISTING_SITES: 'cntoken, coincodex'}), true);
assert.equal(NEW_LISTING_SITES.blockspot.enabled({NEW_LISTING_SITES: 'coincodex'}), false);

// The CoinCodex form answers: new token listing, Meme, the best link as the website, the release date split.
const body = coincodexBody(listing, env, '123');
assert.equal(body.get('entry.1395847187'), 'New Coin/Token listing');
assert.equal(body.get('entry.1196233477'), 'https://x.com/moonfrog');
assert.deepEqual([body.get('entry.1798808271_year'), body.get('entry.1798808271_month'), body.get('entry.1798808271_day')], ['2026', '10', '1']);
assert.equal(body.get('entry.1342122285'), 'Meme');
assert.equal(body.get('entry.1863870395'), 'listings@example.com');
assert.equal(body.get('pageHistory'), '0,1,8');
assert.throws(() => coincodexBody(listing, {}), NotPostedError);
assert.throws(() => coincodexBody({...listing, logo_public_url: null}, env), NotPostedError);

// Submit: recorded → done (no link until CoinCodex lists it); a rejected form is "not sent"; dry run sends nothing.
const posts = [];
const fake = answer => async (url, init) => {
  if (!init?.method) return new Response('<input type="hidden" name="fbzx" value="-42">');
  posts.push(String(init.body));
  return answer();
};
assert.deepEqual(await coincodexSubmit(listing, null, env, {fetchFn: fake(() => new Response('<div>Your response has been recorded.</div>'))}), {submitted: true, url: null, note: 'request recorded; CoinCodex reviews it'});
assert.match(posts[0], /fbzx=-42/);
await assert.rejects(() => coincodexSubmit(listing, null, env, {fetchFn: fake(() => new Response('This is a required question', {status: 400}))}), NotPostedError);
const dry = await coincodexSubmit(listing, null, env, {dryRun: true, fetchFn: fake(() => { throw new Error('must not post'); })});
assert.equal(dry.dryRun, true);
assert.equal(posts.length, 2);
console.log('PASS: new listing sites are off by default; CoinCodex form answers, submit, rejection and dry run.');
