import assert from 'node:assert/strict';
import {LOOKS_LIKE_TRANSACTION, tokenSupply, walletBrowser} from './wallets.mjs';
import {NotPostedError} from './reddit.mjs';

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

// Without the wallet secrets nothing is attempted.
await assert.rejects(() => walletBrowser('okx', {}), e => e instanceof NotPostedError && /WEB3_WALLET_MNEMONIC/.test(e.message));
console.log('PASS: wallet requests guard (sign-ins approved, transactions refused), token supply lookup, missing wallet secrets not sent.');
