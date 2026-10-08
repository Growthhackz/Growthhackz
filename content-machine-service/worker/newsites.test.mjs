import assert from 'node:assert/strict';
import {coincodexBody, NEW_LISTING_SITES} from './newsites.mjs';
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
assert.equal(NEW_LISTING_SITES.okx_wallet.enabled({NEW_LISTING_SITES: 'okx_wallet'}), true);
assert.equal(NEW_LISTING_SITES.bitget_wallet.enabled({}), false);

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

console.log('PASS: new listing sites (and wallet sites) are off by default; CoinCodex form answers.');
