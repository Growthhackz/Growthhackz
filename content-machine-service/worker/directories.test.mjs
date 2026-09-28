// Drives the directory submitter against a local fake listing site.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {submitListing,checkListing,inspect,directoryCycle,siteConfig} from './directories.mjs';
import {NotPostedError} from './reddit.mjs';

let extraRequired=false;const coins=[];
const page=b=>`<!doctype html><html><body>${b}</body></html>`;
const form=()=>`<form method="post" enctype="multipart/form-data" action="/submit">
<label for="n">Coin Name</label><input id="n" name="coin_name" required>
<label for="s">Symbol</label><input id="s" name="symbol" required>
<label for="c">Chain</label><select id="c" name="chain" required><option value="">Select</option><option value="56">Binance Smart Chain</option><option value="sol">Solana</option><option value="1">Ethereum</option></select>
<label for="ca">Contract Address</label><input id="ca" name="contract" required>
<label for="ld">Launch Date</label><input id="ld" type="date" name="launch_date" required>
<label for="d">Description</label><textarea id="d" name="description" required></textarea>
<label for="w">Website</label><input id="w" name="website">
<label for="t">Telegram</label><input id="t" name="telegram">
<label for="x">Twitter</label><input id="x" name="twitter">
<label for="dc">Discord</label><input id="dc" name="discord">
<label for="l">Logo</label><input id="l" type="file" name="logo" required>
${extraRequired?'<label for="ts">Total Supply</label><input id="ts" name="total_supply" required>':''}
<label><input type="checkbox" name="terms" required> I agree to the terms</label>
<button type="submit">Submit Coin</button></form>`;
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://x');const authed=/sid=1/.test(req.headers.cookie||'');const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('latin1');
 const send=(html,code=200,h={})=>{res.writeHead(code,{'content-type':'text/html',...h});res.end(page(html));};
 if(url.pathname==='/login'&&req.method==='GET')return send('<form method="post"><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form>');
 if(url.pathname==='/login'){const f=new URLSearchParams(raw);return f.get('password')==='pw'?send('',302,{location:'/','set-cookie':'sid=1; Path=/'}):send('bad login');}
 if(url.pathname==='/submit'&&req.method==='GET')return authed?send(form()):send('',302,{location:'/login'});
 if(url.pathname==='/submit'){const get=n=>(raw.match(new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`))||[])[1];const hasLogo=/name="logo"; filename="logo.png"/.test(raw);
   if(coins.some(c=>c.contract===get('contract')))return send('<div class="alert-danger">This coin is already listed</div>'+form());
   coins.push({id:coins.length+101,name:get('coin_name'),symbol:get('symbol'),chain:get('chain'),contract:get('contract'),date:get('launch_date'),desc:get('description'),tg:get('telegram'),discord:get('discord'),hasLogo,live:false});
   return send('<h2>Thank you! Your coin was submitted and is pending review.</h2>');}
 if(url.pathname==='/new')return send(coins.filter(c=>c.live).map(c=>`<a href="/coin/${c.id}">${c.name}</a>`).join(''));
 const m=url.pathname.match(/^\/coin\/(\d+)$/);const c=m&&coins.find(x=>x.id===+m[1]&&x.live);if(c)return send(`<h1>${c.name}</h1><p>${c.contract}</p>`);
 send('not found',404);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const dir=await mkdtemp(join(tmpdir(),'dir-'));const logo=join(dir,'logo.png');await writeFile(logo,Buffer.from('89504e470d0a1a0a','hex'));
const env={COINSNIPER_BASE_URL:origin,COINSNIPER_EMAIL:'me@example.com',COINSNIPER_PASSWORD:'pw',DIRECTORY_STATE_DIR:dir};
const cfg={...siteConfig('coinsniper',env),login:'/login',submit:'/submit',browse:['/new']};
const listing={name:'Moon Frog',symbol:'MFROG',chain:'solana',contract_address:'So11111111111111111111111111111111111111112',description:'Moon Frog brings its community together.\n\nSecond paragraph.',short_description:'Short',website_url:'https://moonfrog.example',telegram_url:'https://t.me/moonfrog',x_url:null,launch_date:'2026-09-20'};
try{
 const fields=await inspect('coinsniper',{...cfg,debugDir:dir});
 assert.equal(fields.find(f=>f.name==='chain').plan.value.chain,'solana');assert.equal(fields.find(f=>f.name==='discord').plan,null);assert.equal(fields.find(f=>f.name==='logo').plan.action,'file');
 const r=await submitListing('coinsniper',listing,logo,cfg);
 assert.deepEqual(r,{submitted:true,url:null});
 const c=coins[0];assert.equal(c.name,'Moon Frog');assert.equal(c.symbol,'MFROG');assert.equal(c.chain,'sol');assert.equal(c.contract,listing.contract_address);assert.equal(c.date,'2026-09-20');assert.equal(c.tg,'https://t.me/moonfrog');assert.equal(c.discord,'');assert.ok(c.hasLogo);assert.equal(c.desc.replace(/\r/g,''),listing.description.split('\n')[0]);
 // Resubmitting the same contract: the site says it's already listed, which counts as submitted.
 assert.equal((await submitListing('coinsniper',listing,logo,cfg)).submitted,true);assert.equal(coins.length,1);
 // A required field we can't map: nothing is sent.
 extraRequired=true;await assert.rejects(()=>submitListing('coinsniper',{...listing,contract_address:'0x'+'1'.repeat(40)},logo,cfg),e=>e instanceof NotPostedError&&/Total Supply/.test(e.message));assert.equal(coins.length,1);extraRequired=false;
 // Wrong password: nothing sent.
 await assert.rejects(()=>submitListing('coinsniper',listing,logo,{...cfg,password:'nope',statePath:join(dir,'x.json')}),NotPostedError);
 // Review: not live yet, then live after approval, found via the new-coins page.
 assert.deepEqual(await checkListing('coinsniper',listing,{},cfg),{live:false});
 c.live=true;assert.deepEqual(await checkListing('coinsniper',listing,{},cfg),{live:true,url:`${origin}/coin/101`});
 // Cycle wiring: submit outcome and review check reported to the service.
 const calls=[];const client={asset:async()=>Buffer.from('x'),request:async(p,d)=>{calls.push([p,d]);if(p==='publish/claim')return {job:{id:'j',kind:'coinsniper',lease:'L'},target:{listing}};if(p==='listings/check-claim')return {job:{id:'j',kind:'coinsniper'},target:{listing},submission:{}};return {};}};
 await directoryCycle(client,{env,submit:async()=>({submitted:true,url:null}),check:async()=>({live:true,url:'https://coinsniper.net/coin/9'})});
 assert.deepEqual(calls.find(c=>c[0]==='publish/claim')[1],{kinds:['coinsniper']});
 assert.deepEqual(calls.find(c=>c[0]==='publish/j/complete')[1],{lease:'L',submitted:true,url:null});
 assert.deepEqual(calls.find(c=>c[0]==='listings/j/checked')[1],{live:true,url:'https://coinsniper.net/coin/9'});
 console.log('PASS: login, label-based form fill (chain select, date, logo upload, terms), submit, already-listed, unmapped required field and bad login not sent, review check, cycle reporting.');
}finally{server.close();await rm(dir,{recursive:true,force:true});}
