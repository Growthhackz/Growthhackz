// Binance Square publishing: posts the target text (handles, no links) and builds the post URL from the post ID.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publish} from './worker.mjs';

const dir = await mkdtemp(join(tmpdir(), 'bsq-'));
await mkdir(join(dir, 'scripts'));
await writeFile(join(dir, 'scripts/post-image.mjs'), '');
process.env.BINANCE_SQUARE_SKILL_DIR = dir;
process.env.BINANCE_SQUARE_OPENAPI_KEY = 'k';
const claim = {job: {id: 'j', lease: 'L', order_id: 'o'}, target: {title: 'T', text: 'Body\n\nFind Moon Frog on Telegram: @moonfrog'}, order: {copy: {headline: 'H', article: 'A'}, assets: [{kind: 'campaign_image', mime: 'image/png', url: '/v1/assets/a'}]}};
const calls = [];
const client = {asset: async () => Buffer.from('x'), request: async (p, d) => { calls.push([p, d]); return p === 'publish/claim' ? claim : {}; }};
let args;
try {
  await publish(client, async (_node, a) => { args = a; return 'Success! Post created. ID: 372000959647275'; });
  assert.equal(args[args.indexOf('--text') + 1], claim.target.text);
  assert.equal(args[args.indexOf('--title') + 1], 'T');
  assert.deepEqual(calls.at(-1), ['publish/j/complete', {lease: 'L', url: 'https://www.binance.com/en/square/post/372000959647275', verified: true, note: null}]);
  await publish(client, async () => { throw new Error('rate limited'); });
  assert.deepEqual(calls.at(-1), ['publish/j/complete', {lease: 'L', url: null, verified: false, note: 'rate limited'}]);
  console.log('PASS: Binance text with handles, URL from post ID, failure note.');
} finally { await rm(dir, {recursive: true, force: true}); }
