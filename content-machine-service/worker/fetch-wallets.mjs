// Build step: downloads the official OKX Wallet and Bitget Wallet extensions from the Chrome Web Store and unpacks
// them into /opt/wallets/<name> (used by wallets.mjs). `node fetch-wallets.mjs [dir]`.
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const STORE_IDS = {okx: 'mcohilncbfahbmgdjkbpemcciiolgcge', bitget: 'jiidiaalihmmhddjgbnbgdfflelocpak'};
const out = process.argv[2] || '/opt/wallets';

for (const [name, id] of Object.entries(STORE_IDS)) {
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
  const r = await fetch(url, {redirect: 'follow'});
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const crx = Buffer.from(await r.arrayBuffer());
  if (crx.toString('latin1', 0, 4) !== 'Cr24') throw new Error(`${name}: not a Chrome extension`);
  // CRX3: magic, version, header length, header, then the zip.
  const zip = crx.subarray(12 + crx.readUInt32LE(8));
  const dir = join(out, name);
  rmSync(dir, {recursive: true, force: true});
  mkdirSync(dir, {recursive: true});
  writeFileSync(`${dir}.zip`, zip);
  execFileSync('unzip', ['-q', '-o', `${dir}.zip`, '-d', dir]);
  rmSync(`${dir}.zip`);
  console.log(`${name}: unpacked to ${dir}`);
}
