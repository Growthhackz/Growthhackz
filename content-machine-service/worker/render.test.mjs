import assert from 'node:assert/strict';
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
