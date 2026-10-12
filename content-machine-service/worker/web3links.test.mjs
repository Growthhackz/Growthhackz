import assert from 'node:assert/strict';
import {showsToken, web3Candidates} from './web3links.mjs';
import {listingSitesCycle} from './listingsites.mjs';

// The pages per chain (formats checked live): Solana and BSC 5, Robinhood Chain 4 (no OKX), Arc 4 (no MEXC).
const sol = {chain: 'solana', name: 'Sean Dynasty Prosper', symbol: 'SEAN', contract_address: '8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump'};
assert.deepEqual(web3Candidates(sol), [
  {name: 'Binance Wallet', url: 'https://web3.binance.com/en/token/sol/8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump'},
  {name: 'OKX Wallet', url: 'https://web3.okx.com/token/solana/8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump'},
  {name: 'Bitget Wallet', url: 'https://web3.bitget.com/en/swap/sol/8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump'},
  {name: 'Gate Web3', url: 'https://web3.gate.com/trade/solana/8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump'},
  {name: 'MEXC DEX+', url: 'https://www.mexc.com/dex/onchain/sol/8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump'},
]);
const evm = chain => web3Candidates({chain, contract_address: '0xabc'});
assert.deepEqual(evm('bsc').map(c => c.url), ['https://web3.binance.com/en/token/bsc/0xabc', 'https://web3.okx.com/token/bsc/0xabc', 'https://web3.bitget.com/en/swap/bnb/0xabc', 'https://web3.gate.com/trade/bsc/0xabc', 'https://www.mexc.com/dex/onchain/bsc/0xabc']);
assert.deepEqual(evm('robinhood').map(c => c.name), ['Binance Wallet', 'Bitget Wallet', 'Gate Web3', 'MEXC DEX+']);
assert.deepEqual(evm('arc').map(c => c.name), ['Binance Wallet', 'OKX Wallet', 'Bitget Wallet', 'Gate Web3']);

// A page counts only when its title names the token and it is still the token's page.
const page = 'https://web3.gate.com/trade/solana/8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump';
assert.equal(showsToken('SEAN Token Price Trading on Solana | Gate Web3', page, sol), true);
assert.equal(showsToken('Sean Dynasty Prosper Price Today: Live SEAN to USD', page.toLowerCase(), sol), true);
assert.equal(showsToken('Bitget Wallet - Best Crypto Wallet for Web3', 'https://web3.bitget.com/', sol), false);
assert.equal(showsToken('404: This page could not be found.', page, sol), false);
assert.equal(showsToken('SEANCE Token Price', page, sol), false);

// The listing cycle hands the checked pages to the service.
const sent = [];
const client = {asset: async () => null, request: async (p, d) => { sent.push([p, d]); return p === 'publish/claim' ? {job: {id: 'j', kind: 'web3_listings', lease: 'L', order_id: 'o'}, target: {listing: sol}} : null; }};
const links = [{name: 'Gate Web3', url: page}];
await listingSitesCycle(client, {sites: {web3_listings: {enabled: () => true, submit: async () => ({submitted: true, links, note: '1 of 5'}), check: async () => ({live: false})}}, env: {}});
assert.deepEqual(sent.find(([p]) => p === 'publish/j/complete')[1], {lease: 'L', submitted: true, url: null, note: '1 of 5', review_url: null, proof: null, links});

console.log('PASS: Web3 Listing Updates pages per chain, page check, cycle reporting.');
