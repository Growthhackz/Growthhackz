// Drives postToReddit against a local fake of Reddit's login + old.reddit submit flow.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {postToReddit,publishReddit,NotPostedError} from './reddit.mjs';

const posts=[];let rateLimited=false;
const page=b=>`<!doctype html><html><body>${b}</body></html>`;
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://x');const authed=/session=ok/.test(req.headers.cookie||'');let body='';for await(const c of req)body+=c;const form=new URLSearchParams(body);
 const send=(html,code=200,headers={})=>{res.writeHead(code,{'content-type':'text/html',...headers});res.end(page(html));};
 if(url.pathname==='/login/'&&req.method==='GET')return send('<form method="post"><input name="username"><input name="password" type="password"><button type="submit">Log In</button></form>');
 if(url.pathname==='/login/')return form.get('password')==='pw'?send('',302,{location:'/','set-cookie':'session=ok; Path=/'}):send('<p>bad</p><form method="post"><input name="username"><input name="password"><button>Log In</button></form>');
 if(url.pathname==='/')return send('home');
 const m=url.pathname.match(/^\/r\/(\w+)\/submit$/);
 if(m&&req.method==='GET')return authed?send('<form method="post"><textarea name="title"></textarea><textarea name="text"></textarea><button type="submit" name="submit">submit</button></form>'):send('<a href="/login/">log in</a>');
 if(m){if(rateLimited)return send('<span class="error">you are doing that too much. try again in 9 minutes.</span><form method="post"><textarea name="title"></textarea><textarea name="text"></textarea><button name="submit">submit</button></form>');const id=(posts.length+1).toString(36)+'abc';posts.push({sub:m[1],id,title:form.get('title'),text:form.get('text')});return send('',302,{location:`/r/${m[1]}/comments/${id}/slug/`});}
 const c=url.pathname.match(/^\/r\/(\w+)\/comments\/(\w+)\//);const p=c&&posts.find(x=>x.id===c[2]);if(p)return send(`<h1>${p.title.replace(/&/g,'&amp;')}</h1><div>${p.text}</div>`);
 send('not found',404);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const dir=await mkdtemp(join(tmpdir(),'reddit-'));
const opts={username:'u',password:'pw',statePath:join(dir,'state.json'),base,loginUrl:`${base}/login/`,executablePath:process.env.CHROMIUM_PATH};
try{
 const target={subreddit:'moonshots',title:'Moon Frog squad launches community kit',text:'Body line one\n\nTelegram: https://t.me/moonfrog'};
 const r1=await postToReddit(target,opts);
 assert.match(r1.url,/\/r\/moonshots\/comments\/1abc\/slug\/$/);assert.equal(r1.verified,true);assert.equal(posts[0].text.replace(/\r\n/g,"\n"),target.text);
 // Second post reuses the saved session (no login page visit needed) and goes to the other sub.
 const r2=await postToReddit({...target,subreddit:'solanamemecoins'},opts);assert.match(r2.url,/\/r\/solanamemecoins\/comments\//);assert.equal(posts.length,2);
 // Wrong password: nothing posted, safe to retry.
 await assert.rejects(()=>postToReddit(target,{...opts,password:'nope',statePath:join(dir,'fresh.json')}),NotPostedError);
 // Rate limit shown on the form after submit: reported as not posted.
 rateLimited=true;await assert.rejects(()=>postToReddit(target,opts),e=>e instanceof NotPostedError&&/too much/.test(e.message));assert.equal(posts.length,2);rateLimited=false;
 // publishReddit reports outcomes to the service.
 process.env.REDDIT_USERNAME='u';const calls=[];const client={request:async(path,data)=>{calls.push([path,data]);return path==='publish/claim'?{job:{id:'j',lease:'L'},target}:{};}};
 await publishReddit(client,async()=>({url:'https://www.reddit.com/r/moonshots/comments/x1/s/',verified:true}));assert.deepEqual(calls.at(-1),['publish/j/complete',{lease:'L',url:'https://www.reddit.com/r/moonshots/comments/x1/s/',verified:true}]);
 await publishReddit(client,async()=>{throw new NotPostedError('Login failed')});assert.deepEqual(calls.at(-1),['publish/j/fail',{lease:'L',error:'Login failed'}]);
 await publishReddit(client,async()=>{throw new Error('browser crashed')});assert.deepEqual(calls.at(-1),['publish/j/complete',{lease:'L',url:null}]);
 console.log('PASS: Reddit login, session reuse, two subreddit posts with logged-out check, bad login and rate limit not posted, outcome reporting.');
}finally{server.close();await rm(dir,{recursive:true,force:true});}
