import assert from 'node:assert/strict';
import sharp from 'sharp';
import {EVM_RPC, LOOKS_LIKE_TRANSACTION, okxUpdateSubmit, proofImage, tokenSupply, walletBrowser} from './wallets.mjs';
import {LISTING_SITES, listingSitesCycle} from './listingsites.mjs';
import {NotOfferedError, NotPostedError} from './reddit.mjs';

// Sign-in and connect screens are approved; anything that moves funds is refused.
for (const ok of ['Confirm Sign web3.okx.com Network Ethereum Wallet used 0xc5b6 Advanced Data Cancel Confirm', 'Bitget Wallet connection request ... Requesting transaction authorization. Cancel Connect', 'Signature confirmation Request source https://web3.bitget.com Signature data open27b8 Cancel Agree'])
  assert.equal(LOOKS_LIKE_TRANSACTION.test(ok), false, ok);
for (const bad of ['Send 0.1 SOL Network fee 0.000005', 'Approve USDC spending cap', 'Estimated balance change -2 USDC'])
  assert.equal(LOOKS_LIKE_TRANSACTION.test(bad), true, bad);

// Supply and decimals from the chain (Bitget requires both).
const rpc = async (_u, init) => {
  assert.equal(JSON.parse(init.body).method, 'getTokenSupply');
  return new Response(JSON.stringify({result: {value: {amount: '959611278000000', decimals: 6, uiAmountString: '959611278'}}}));
};
assert.deepEqual(await tokenSupply({chain: 'solana', contract_address: 'Mint'}, {}, rpc), {supply: '959611278', decimals: 6});
await assert.rejects(() => tokenSupply({chain: 'base', contract_address: '0x1'}, {}, rpc), NotPostedError);
await assert.rejects(() => tokenSupply({chain: 'solana', contract_address: 'Mint'}, {}, async () => new Response('{}')), NotPostedError);
// EVM chains (BSC, Robinhood, Arc...): totalSupply() and decimals() over public RPCs, falling back to the next one.
const hosts = [];
const evm = async (u, init) => {
  hosts.push(new URL(u).host);
  if (u.includes('rpc.mainnet.chain.robinhood.com')) return new Response('bad gateway', {status: 502});
  const {params: [{to, data}]} = JSON.parse(init.body);
  assert.equal(to, '0xfd71a4d9599038fe508bf5509963e1f7591c7777');
  return new Response(JSON.stringify({result: data === '0x18160ddd' ? '0x' + (10n ** 27n).toString(16).padStart(64, '0') : '0x' + (18).toString(16).padStart(64, '0')}));
};
assert.deepEqual(await tokenSupply({chain: 'robinhood', contract_address: '0xfd71a4d9599038fe508bf5509963e1f7591c7777'}, {}, evm), {supply: '1000000000', decimals: 18});
assert.deepEqual([...new Set(hosts)], ['rpc.mainnet.chain.robinhood.com', 'robinhood-rpc.publicnode.com']);
for (const chain of ['bsc', 'arc', 'robinhood', 'ethereum', 'base', 'polygon', 'arbitrum']) assert.ok(EVM_RPC[chain]?.length, chain);

// OKX has no Robinhood Chain pages: not offered (skipped), before any browser starts.
await assert.rejects(() => okxUpdateSubmit({chain: 'robinhood', contract_address: '0x1', telegram_url: 'https://t.me/x'}, null, {LISTING_CONTACT_EMAIL: 'a@b.c'}), NotOfferedError);

// The listing cycle reports a site that doesn't take the token as unsupported (the API skips it, no retries).
const sent = [];
const client = {asset: async () => null, request: async (p, d) => { sent.push([p, d]); return p === 'publish/claim' ? {job: {id: 'j', kind: 'x', lease: 'L', order_id: 'o'}, target: {listing: {chain: 'arc'}}} : null; }};
await listingSitesCycle(client, {sites: {x: {enabled: () => true, submit: async () => { throw new NotOfferedError('x: chain arc is not offered; nothing was sent.'); }, check: async () => ({live: false})}}, env: {}});
assert.deepEqual(sent.find(([p]) => p === 'publish/j/fail')[1], {lease: 'L', error: 'x: chain arc is not offered; nothing was sent.', unsupported: true});

// Without the wallet secrets nothing is attempted.
await assert.rejects(() => walletBrowser('okx', {}), e => e instanceof NotPostedError && /WEB3_WALLET_MNEMONIC/.test(e.message));
// The wallet sites run only when named in NEW_LISTING_SITES; CoinCodex, CNToken and Blockspot are gone.
assert.equal(LISTING_SITES.okx_wallet.enabled({}), false);
assert.equal(LISTING_SITES.okx_wallet.enabled({NEW_LISTING_SITES: 'bitget_wallet, okx_wallet'}), true);
assert.equal(LISTING_SITES.bitget_wallet.enabled({NEW_LISTING_SITES: 'okx_wallet'}), false);
for (const gone of ['coincodex', 'cntoken', 'blockspot']) assert.equal(LISTING_SITES[gone], undefined);

// Proof: the form as sent and the confirmation, side by side in one JPEG; a missing shot is left out.
const png = (w, h, c) => sharp({create: {width: w, height: h, channels: 3, background: c}}).jpeg().toBuffer();
const both = await sharp(Buffer.from(await proofImage([await png(1366, 900, '#f00'), null, await png(1366, 900, '#00f')]), 'base64')).metadata();
assert.deepEqual([both.format, both.height, both.width], ['jpeg', 800, 1214 * 2 + 16]);
assert.equal(await proofImage([null]), null);

console.log('PASS: wallet requests guard (sign-ins approved, transactions refused), token supply lookup, missing wallet secrets not sent, wallet sites gated, proof image.');
