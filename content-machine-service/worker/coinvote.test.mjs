// Drives the Coinvote flow against a local fake of its add-coin page (login dialog, script-driven form, duplicate check).
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {submitListing,checkListing,siteConfig} from './directories.mjs';
import {coinvoteDescription,coinvoteLookup} from './coinvote.mjs';
import {NotOfferedError,NotPostedError} from './reddit.mjs';

// captcha: 'none' | 'passes' (an invisible check that clears and resubmits by itself) | 'stuck' (needs a person).
let deadLoads=0,captcha='none',loginCaptcha='none',reject=null,takenName=null,submits=0,logins=0;const coins=[];
const field=(raw,n)=>(raw.match(new RegExp(`name="${n.replace(/[[\]]/g,'\\$&')}"\\r\\n\\r\\n([^\\r]*)`))||[])[1];
const json=(res,code,body,h={})=>{res.writeHead(code,{'content-type':'application/json',...h});res.end(JSON.stringify(body));};
// The fake's scripts do what Coinvote's do: the form posts by fetch, a security check answer resubmits it.
const page=(logged,dead)=>`<!doctype html><html><body>
<header>${logged?'<a href="/settings/dashboard">Dashboard</a>':'<button data-ref-modal="login">Login</button>'}</header>
<div id="cv-v3-launchpad-announce" role="dialog"><strong>Boosts</strong><button>Close</button></div>
<div id="cv-ac-start" class="modal" style="display:none;position:fixed;inset:0;z-index:10;background:#000c"><button class="btn-close" data-start-skip aria-label="Close">x</button></div>
<div id="dlg" hidden><form id="login_form"><input type="email" name="username"><input type="password" name="password"><button type="submit">Log In</button></form></div>
<section id="cv-ac" class="container cv-ac"><form id="cv-ac-form" data-config='${JSON.stringify({guest:!logged,endpoint:'/processing/submit_project.php'})}'>
<input type="file" id="cv-ac-logo" name="logo"><input id="cv-ac-name" name="name"><input id="cv-ac-symbol" name="symbol">
<select id="cv-ac-category" name="category"><option value="">Choose</option><option value="2">Meme Token</option></select>
<input type="radio" name="launch_type" value="released"><input type="radio" name="launch_type" value="presale">
<textarea id="cv-ac-description" name="description"></textarea>
<input name="socials[telegram]"><input name="socials[website]"><input name="socials[twitter]">
<input id="cv-ac-address"><div id="cv-ac-detect"></div><ul id="cv-ac-contracts"></ul>
<details class="cv-ac-more"><summary>Pick the network manually</summary><div id="cv-ac-manual-chains">${[1,2,3,5,10,13,20].map(i=>`<button type="button" class="cv-ac-chip" data-chain="${i}">c${i}</button>`).join('')}</div></details>
<button type="button" id="cv-ac-submit">Submit my project</button></form></section>
<script>
window.coinvote={isLogged:${logged}};
// Like Coinvote: the form keeps a draft in localStorage, and a restored draft leaves the contract box dead.
// A load where Coinvote's add-coin script lost the race: the contract box does nothing.
const dead=${!!dead};
const drafted=!!localStorage.getItem('cv_ac_draft_v2');localStorage.setItem('cv_ac_draft_v2','{}');
// The start dialog fades in after load (only without a draft) and covers the page until closed.
setTimeout(()=>{const m=document.getElementById('cv-ac-start');if(m&&!drafted){m.classList.add('show');m.style.display='block';}},400);
document.querySelectorAll('[data-start-skip],#cv-v3-launchpad-announce button').forEach(b=>b.onclick=()=>b.closest('#cv-ac-start,#cv-v3-launchpad-announce').remove());
document.querySelector('[data-ref-modal="login"]')?.addEventListener('click',()=>{document.getElementById('dlg').hidden=false;});
document.getElementById('cv-ac-address').oninput=e=>{if(drafted||dead)return;setTimeout(()=>{document.getElementById('cv-ac-detect').textContent=e.target.value?'Address detected':'';},300);};
document.getElementById('cv-ac-manual-chains').onclick=e=>{if(drafted||dead)return;const c=e.target.closest('.cv-ac-chip');const a=document.getElementById('cv-ac-address');if(!c||!a.value)return;const h=document.createElement('input');h.type='hidden';h.name='networks['+c.dataset.chain+']';h.value=a.value;document.getElementById('cv-ac-contracts').append(h);a.value='';};
const send=(url,form,extra)=>{const fd=new FormData(form);if(extra)fd.append('cf-turnstile-response',extra);return fetch(url,{method:'POST',body:fd}).then(async r=>{const j=await r.json();if(!r.ok&&j.captchaRequired&&j.pass)setTimeout(()=>send(url,form,'tok'),500);if(r.ok&&url.includes('login'))location.reload();});};
document.getElementById('login_form').onsubmit=e=>{e.preventDefault();send('/api/login',e.target);};
document.getElementById('cv-ac-submit').onclick=()=>{if(!window.coinvote.isLogged){document.getElementById('dlg').hidden=false;return;}send('/processing/submit_project.php',document.getElementById('cv-ac-form'));};
</script></body></html>`;
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://x');const logged=/cv=1/.test(req.headers.cookie||'');const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('latin1');
 if(url.pathname==='/add-coin/released'){res.writeHead(200,{'content-type':'text/html'});return res.end(page(logged,deadLoads-->0));}
 if(url.pathname==='/api/login'){logins++;if(loginCaptcha!=='none'&&!/cf-turnstile-response/.test(raw))return json(res,403,{captchaRequired:true,captcha:{},pass:loginCaptcha==='passes'});
   return field(raw,'password')==='pw'?json(res,200,{signedIn:true},{'set-cookie':'cv=1; Path=/'}):json(res,401,{message:'Your email and password does not match.'});}
 if(url.pathname==='/processing/coin_name_check.php'){const ca=Object.entries(Object.fromEntries([...raw.matchAll(/name="networks\[(\d+)\]"\r\n\r\n([^\r]*)/g)].map(m=>[m[1],m[2]])))[0]?.[1];const c=coins.find(x=>x.ca===ca);
   return json(res,200,{listed:c?{id:c.id,name:c.name,url:'coin/'+c.slug,live:c.live}:null,name:takenName&&field(raw,'name')===takenName?{other:takenName,url:'coin/x',live:true,suggest:takenName+' Sol'}:null});}
 if(url.pathname==='/processing/submit_project.php'){if(!logged)return json(res,403,{requireEmail:true});
   if(captcha!=='none'&&!/cf-turnstile-response/.test(raw))return json(res,403,{captchaRequired:true,captcha:{},pass:captcha==='passes'});
   if(reject)return json(res,400,{errors:reject});
   submits++;const name=field(raw,'name');const nets=[...raw.matchAll(/name="networks\[(\d+)\]"\r\n\r\n([^\r]*)/g)];
   coins.push({id:500+coins.length,name,slug:name.replace(/\s+/g,'-'),ca:nets[0]?.[2],net:nets[0]?.[1],symbol:field(raw,'symbol'),category:field(raw,'category'),launch:field(raw,'launch_type'),desc:field(raw,'description'),tg:field(raw,'socials[telegram]'),logo:/name="logo"; filename="logo.png"\r\nContent-Type: image\/png/.test(raw),live:false});
   return json(res,200,{itemId:500+coins.length-1,boostCsrf:'b'});}
 res.writeHead(404);res.end('not found');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const dir=await mkdtemp(join(tmpdir(),'cv-'));const logo=join(dir,'logo.jpg');await sharp({create:{width:300,height:200,channels:3,background:'#f60'}}).jpeg().toFile(logo);
const env={COINVOTE_BASE_URL:origin,COINVOTE_EMAIL:'me@example.com',COINVOTE_PASSWORD:'pw',DIRECTORY_STATE_DIR:dir};
const cfg={...siteConfig('coinvote',env),humanCheckMs:8000,formReadyMs:1500};
const listing={name:'Moon Frog',symbol:'$MFROG',chain:'solana',contract_address:'So11111111111111111111111111111111111111112',description:'Moon Frog brings its community together on Solana.',short_description:'Short',website_url:'https://moonfrog.example',telegram_url:'https://t.me/moonfrog',x_url:null};
const fresh=n=>({...cfg,statePath:join(dir,`s${n}.json`)});
try{
 // Signs in through the dialog (the saved session is empty), fills, submits, and records the coin page from the duplicate check.
 const r=await submitListing('coinvote',listing,logo,cfg);
 assert.deepEqual(r,{submitted:true,url:`${origin}/coin/Moon-Frog`,item_id:500});
 const c=coins[0];assert.equal(c.name,'Moon Frog');assert.equal(c.symbol,'MFROG');assert.equal(c.net,'3');assert.equal(c.ca,listing.contract_address);assert.equal(c.category,'2');assert.equal(c.launch,'released');assert.equal(c.tg,'https://t.me/moonfrog');assert.equal(c.desc,listing.description);assert.ok(c.logo,'logo converted to PNG');assert.equal(logins,1);
 // Already on Coinvote (live or in review): nothing is sent, the coin page is returned.
 assert.deepEqual(await submitListing('coinvote',listing,logo,cfg),{submitted:true,url:`${origin}/coin/Moon-Frog`,note:'already submitted to Coinvote, in review'});assert.equal(submits,1);
 // The saved session is reused: no second login.
 const l2={...listing,name:'Moon Toad',contract_address:'0x'+'1'.repeat(40),chain:'robinhood'};
 assert.equal((await submitListing('coinvote',l2,logo,cfg)).url,`${origin}/coin/Moon-Toad`);assert.equal(coins[1].net,'20');assert.equal(logins,1);
 // Another coin has the name: Coinvote's suggestion is used.
 takenName='Bul';assert.equal((await submitListing('coinvote',{...listing,name:'Bul',contract_address:'0x'+'2'.repeat(40),chain:'bsc'},logo,cfg)).url,`${origin}/coin/Bul-Sol`);takenName=null;
 // A security check that clears by itself is waited for; one that needs a person is never answered: not sent.
 captcha='passes';assert.equal((await submitListing('coinvote',{...listing,name:'Gecko',contract_address:'0x'+'3'.repeat(40),chain:'base'},logo,cfg)).submitted,true);
 captcha='stuck';const before=submits;await assert.rejects(()=>submitListing('coinvote',{...listing,name:'Newt',contract_address:'0x'+'4'.repeat(40),chain:'base'},logo,cfg),e=>e instanceof NotPostedError&&/human check/.test(e.message));assert.equal(submits,before);captcha='none';
 // Coinvote refuses the details: reported, nothing listed.
 reject={description:'Write between 20 and 2000 characters.'};await assert.rejects(()=>submitListing('coinvote',{...listing,name:'Eft',contract_address:'0x'+'5'.repeat(40),chain:'base'},logo,cfg),e=>e instanceof NotPostedError&&/description/.test(e.message));reject=null;
 // Arc is not a Coinvote network: skipped, not retried.
 await assert.rejects(()=>submitListing('coinvote',{...listing,chain:'arc',contract_address:'0x'+'6'.repeat(40)},logo,cfg),NotOfferedError);
 // Wrong password, and a login check that needs a person: not sent.
 await assert.rejects(()=>submitListing('coinvote',{...listing,contract_address:'0x'+'7'.repeat(40),chain:'base'},logo,{...fresh(1),password:'nope'}),e=>e instanceof NotPostedError&&/login refused/.test(e.message));
 loginCaptcha='stuck';await assert.rejects(()=>submitListing('coinvote',{...listing,contract_address:'0x'+'8'.repeat(40),chain:'base'},logo,fresh(2)),e=>e instanceof NotPostedError&&/human check/.test(e.message));
 loginCaptcha='passes';assert.equal((await submitListing('coinvote',{...listing,name:'Axolotl',contract_address:'0x'+'9'.repeat(40),chain:'base'},logo,fresh(3))).submitted,true);loginCaptcha='none';
 // Coinvote's form script sometimes doesn't start: the page is loaded again; after three dead loads, nothing is sent.
 deadLoads=1;assert.equal((await submitListing('coinvote',{...listing,name:'Olm',contract_address:'0x'+'a'.repeat(40),chain:'base'},logo,cfg)).submitted,true);
 deadLoads=3;const n=submits;await assert.rejects(()=>submitListing('coinvote',{...listing,name:'Siren',contract_address:'0x'+'b'.repeat(40),chain:'base'},logo,cfg),e=>e instanceof NotPostedError&&/did not start/.test(e.message));assert.equal(submits,n);deadLoads=0;
 // Review check: in review, then live once approved.
 assert.deepEqual(await checkListing('coinvote',listing,{},cfg),{live:false});
 c.live=true;assert.deepEqual(await checkListing('coinvote',listing,{},cfg),{live:true,url:`${origin}/coin/Moon-Frog`});
 assert.deepEqual(await coinvoteLookup({...listing,contract_address:'none'},{origin}),{listed:null,nameTaken:null});
 assert.equal(coinvoteDescription({name:'A',symbol:'A',chain:'robinhood',description:''}),'A (A) is a community token on Robinhood Chain.');
 console.log('PASS: Coinvote dialog login (saved and reused), late start dialog, stale draft, form script race, form fill, logo as PNG, submit, coin page URL, already listed, taken name, self-clearing vs stuck check, refusal, Arc skipped, review check.');
}finally{server.close();await rm(dir,{recursive:true,force:true});}
