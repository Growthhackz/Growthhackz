import {createHmac,timingSafeEqual} from 'node:crypto';

/** Minimal client for content-machine-service. Used by the worker and by Peak Buybot for intake/polling. */
export class ContentMachineClient {
 constructor({url=process.env.CONTENT_MACHINE_URL,key=process.env.CONTENT_MACHINE_API_KEY}={}){if(!url||!key)throw new Error('Set CONTENT_MACHINE_URL and CONTENT_MACHINE_API_KEY');this.url=url.replace(/\/$/,'');this.headers={'Authorization':`Bearer ${key}`};}
 async request(path,data){const r=await fetch(this.url+'/v1/'+path,{method:data===undefined?'GET':'POST',headers:{...this.headers,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(150000),redirect:'error'});let result;try{result=await r.json();}catch{throw new Error(`Non-JSON response (HTTP ${r.status})`);}if(!r.ok)throw new Error(result?.error?.message||`HTTP ${r.status}`);return result;}
 createOrder(order){return this.request('orders',order);}
 getOrder(id){return this.request('orders/'+encodeURIComponent(id));}
 getOrderByExternalId(orderId){return this.request('orders/by-external-id/'+encodeURIComponent(orderId));}
 async asset(path){const u=new URL(path,this.url);if(u.origin!==new URL(this.url).origin)throw new Error('Asset origin mismatch');const r=await fetch(u,{headers:this.headers,redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Asset download failed');return Buffer.from(await r.arrayBuffer());}
}

/** Verify an incoming callback BEFORE parsing it. `rawBody` must be the exact bytes received. */
export function verifyCallback(rawBody,headers,secret){const timestamp=headers['x-peak-timestamp'];const supplied=headers['x-peak-signature'];if(!timestamp||!supplied||Math.abs(Date.now()/1000-Number(timestamp))>300||!/^[a-f0-9]{64}$/.test(supplied))return false;const expected=createHmac('sha256',secret).update(timestamp+'.').update(rawBody).digest();return timingSafeEqual(expected,Buffer.from(supplied,'hex'));}
