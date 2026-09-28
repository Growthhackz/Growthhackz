// Manual end-to-end check: real HTTP server + real companion worker (sharp/ffmpeg) with providers faked.
// Run: npx tsx test/e2e-worker.ts   (needs worker/node_modules and ffmpeg)
import { createRequire } from 'node:module';
// @ts-expect-error plain-JS worker, no type declarations
import { ContentMachineClient } from '../worker/client.mjs';
// @ts-expect-error plain-JS worker, no type declarations
import { render } from '../worker/worker.mjs';
import { json, liveCopy, makeApp, SOL } from './helpers.js';

const sharp = createRequire(new URL('../worker/package.json', import.meta.url))('sharp');
const t = makeApp();
const mascot = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#ff00ff' } })
  .composite([{ input: await sharp({ create: { width: 300, height: 300, channels: 4, background: '#1f8a3b' } }).png().toBuffer(), left: 106, top: 106 }])
  .png()
  .toBuffer();
t.http
  .on('api.dexscreener.com/', () => json([]))
  .on('cdn.example.com/', () => new Response(mascot, { headers: { 'content-type': 'image/png' } }))
  .on('generativelanguage.googleapis.com/', (_u, init) =>
    JSON.parse(String(init.body)).generationConfig?.responseModalities
      ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: mascot.toString('base64') } }] } }] })
      : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(liveCopy) }] } }] }),
  );
await t.setSetting('GEMINI_API_KEY', 'G');
const key = (await t.api('POST', '/v1/keys', { name: 'worker' })).body.key;
const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
const client = new ContentMachineClient({ url: address, key });

const order = await client.createOrder({
  order_id: 'e2e-1', chain: 'solana', contract_address: SOL, name: 'Moon Frog', symbol: 'MFROG',
  telegram_url: 'https://t.me/moonfrog', logo_url: 'https://cdn.example.com/logo.png',
});
const drain = async () => { for (let i = 0; i < 10; i++) if (!(await client.request('tick', {})).processed) return; };
await drain();
for (const expected of ['media', 'stickers']) {
  const c = await client.request('render/claim', {});
  if (c?.job.kind !== expected) throw new Error(`expected ${expected} claim, got ${JSON.stringify(c?.job)}`);
  await render(c, client);
  await drain();
}
const done = await client.getOrder(order.id);
const pending = done.jobs.filter((j: any) => !['delivered', 'skipped'].includes(j.status)).map((j: any) => `${j.kind}:${j.status}:${j.error}`);
console.log({ status: done.status, assets: done.assets.length, pending });
await t.app.close();
if (pending.some((p: string) => !p.startsWith('sticker_publish'))) process.exit(1);
