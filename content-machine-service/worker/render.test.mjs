import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {render} from './worker.mjs';
import {verifyCallback} from './client.mjs';
import {createHmac} from 'node:crypto';
const art=await sharp({create:{width:512,height:512,channels:4,background:'#f56b36'}}).png().toBuffer();
let result;const client={asset:async()=>art,request:async(path,data)=>{result=data;}};
const order={project:{name:'Test project',symbol:'TEST',colour:'#f56b36'},copy:{meme_captions:Array(8).fill('TEST THE LAUNCH'),trailer_lines:['TEST','COMMUNITY','CONTENT','READY']},assets:[{kind:'campaign_image',url:'/assets/test'}]};
await render({order,job:{id:'test',kind:'media',lease:'lease'}},client);
assert.equal(result.files.length,10);assert.equal(result.files.filter(x=>x.mime==='video/mp4').length,2);for(const f of result.files){const b=Buffer.from(f.base64,'base64');if(f.mime==='video/mp4')assert.equal(b.subarray(4,8).toString(),'ftyp');else {const meta=await sharp(b).metadata();assert.equal(meta.width,1080);}}
const sticker=await sharp({create:{width:512,height:512,channels:4,background:'#ff00ff'}}).composite([{input:await sharp({create:{width:300,height:300,channels:4,background:'#222222'}}).png().toBuffer(),left:106,top:106}]).png().toBuffer();client.asset=async()=>sticker;order.assets=Array.from({length:5},(_,i)=>({kind:'sticker_art_'+i,url:'/assets/test'}));await render({order,job:{id:'stickers',kind:'stickers',lease:'lease'}},client);assert.equal(result.files.length,5);for(const f of result.files){const b=Buffer.from(f.base64,'base64');const meta=await sharp(b).metadata();assert.equal(meta.width,512);assert.equal(meta.height,512);assert.ok(meta.hasAlpha);assert.ok(b.length<512000);}
const t=String(Math.floor(Date.now()/1000)),raw='{"id":"e1"}',secret='test-key';const sig=createHmac('sha256',secret).update(t+'.'+raw).digest('hex');assert.equal(verifyCallback(raw,{'x-peak-timestamp':t,'x-peak-signature':sig},secret),true);assert.equal(verifyCallback(raw+'tampered',{'x-peak-timestamp':t,'x-peak-signature':sig},secret),false);
console.log('PASS: eight 1080px memes, square and vertical H.264 MP4s, five transparent 512px stickers, valid / tampered callbacks.');
// Binance: article + cover image through post-image.mjs, URL parsed from the script output.
{const {publish}=await import('./worker.mjs');const {mkdtemp,mkdir,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
const dir=await mkdtemp(join(tmpdir(),'skill-'));await mkdir(join(dir,'scripts'));await writeFile(join(dir,'scripts/post-image.mjs'),'');process.env.BINANCE_SQUARE_SKILL_DIR=dir;process.env.BINANCE_SQUARE_OPENAPI_KEY='k';
let args,completed;const fake={asset:async()=>art,request:async(path,data)=>{if(path==='publish/claim')return {job:{id:'j1',lease:'L'},order:{copy:{headline:'Moon Frog launches',article:'Body text'},assets:[{kind:'campaign_image',mime:'image/png',url:'/v1/assets/a'}]}};completed={path,data};}};
await publish(fake,async(_bin,a)=>{args=a;const cover=a[a.indexOf('--cover')+1];assert.ok((await readFile(cover)).length>0);return 'Success!\nID: 1\nLink: https://www.binance.com/en/square/post/123\n';});
assert.equal(args[args.indexOf('--title')+1],'Moon Frog launches');assert.equal(args[args.indexOf('--text')+1],'Body text');assert.ok(!args.includes('--images'));
assert.equal(completed.path,'publish/j1/complete');assert.equal(completed.data.url,'https://www.binance.com/en/square/post/123');
console.log('PASS: Binance article published with the campaign image as cover.');}
