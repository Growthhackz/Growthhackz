import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { FEE_BPS } from './swap-shared';
import { validAddress,transactionMessage,verifySignedTransaction,decodeTransaction } from './transaction';
type Bindings={DB:D1Database;JUPITER_API_KEY?:string;JUPITER_REFERRAL_ACCOUNT?:string;PEAK_API_KEY?:string;PEAK_TRADING_ENABLED?:string};
const settings=()=>env as unknown as Bindings;
const db=()=>{const d=settings().DB;if(!d)throw new ApiError(503,'STORAGE_UNAVAILABLE','Swap storage is unavailable.');return d};
export class ApiError extends Error{constructor(public status:number,public code:string,message:string){super(message)}}
export async function digest(s:string){return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex')}
export function configuration(){const e=settings();const missing=[!e.JUPITER_API_KEY&&'Jupiter API key',!validAddress(e.JUPITER_REFERRAL_ACCOUNT)&&'Jupiter referral account',e.PEAK_TRADING_ENABLED!=='true'&&'Trading activation'].filter(Boolean);return{ready:missing.length===0,missing,feeBps:FEE_BPS,peakFeeBps:100,jupiterShareBps:25,network:'solana-mainnet',externalApiConfigured:!!e.PEAK_API_KEY}}
export async function authorize(request:Request,mutation=false){
 const origin=request.headers.get('origin'),own=new URL(request.url).origin;
 if(origin&&origin!==own)throw new ApiError(403,'ORIGIN_DENIED','Cross-origin browser access is not enabled. Use a server integration.');
 const authorization=request.headers.get('authorization');
 if(authorization){const secret=settings().PEAK_API_KEY;if(!secret||await digest(authorization)!==await digest(`Bearer ${secret}`))throw new ApiError(401,'UNAUTHORIZED','Invalid integration key.');return 'integration'}
 if(mutation&&origin!==own)throw new ApiError(401,'UNAUTHORIZED','Use a bearer API key or the Peak swap interface.');
 if(request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'ORIGIN_DENIED','Cross-site access is not allowed.');return 'browser';
}
export async function rateLimit(request:Request,bucket:string,limit=30){
 const now=Date.now(),window=Math.floor(now/60000),ip=request.headers.get('cf-connecting-ip')||'preview';
 const key=await digest(`${bucket}:${ip}:${window}`);
 const row=await db().prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,now+120000).first<{count:number}>();
 if(!row||row.count>limit)throw new ApiError(429,'RATE_LIMITED','Too many requests. Please wait a minute.');
 await db().prepare('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < ? LIMIT 100)').bind(now).run();
}
async function jupiter(path:string,body?:unknown){
 const key=settings().JUPITER_API_KEY;
 try{const r=await fetch(`https://api.jup.ag${path}`,{method:body?'POST':'GET',headers:{...(key?{'x-api-key':key}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?25000:12000)});
 if(!r.ok)throw new ApiError(r.status===429?429:502,'JUPITER_UNAVAILABLE',r.status===429?'Jupiter is busy. Please try again shortly.':'Jupiter could not complete this request.');return await r.json() as any;
 }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(504,'UPSTREAM_TIMEOUT',body?'Jupiter did not respond in time. Check this order before starting another swap.':'Jupiter did not respond in time. Please try again shortly.');}
}
export async function tokens(query:string){if(query.length<1||query.length>80)throw new ApiError(400,'INVALID_QUERY','Search by token name or contract address.');const data=await jupiter(`/tokens/v2/search?query=${encodeURIComponent(query)}`);return Array.isArray(data)?data.slice(0,20).filter(t=>validAddress(t.id)&&Number.isInteger(t.decimals)&&t.decimals>=0&&t.decimals<=18).map(t=>({id:t.id,symbol:t.symbol,name:t.name,decimals:t.decimals,isVerified:!!t.isVerified,usdPrice:t.usdPrice,graduatedAt:t.graduatedAt,launchpad:t.launchpad,organicScoreLabel:t.organicScoreLabel,audit:t.audit})):[]}
const address=z.string().refine(validAddress,'Invalid Solana address');
const inputSchema=z.object({inputMint:address,outputMint:address,amount:z.string().regex(/^[1-9]\d{0,19}$/).refine(s=>BigInt(s)<=BigInt('18446744073709551615')),taker:address,slippageBps:z.number().int().min(10).max(500).default(100),source:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional()}).strict();
export async function createOrder(payload:unknown){
 const config=configuration();if(!config.ready)throw new ApiError(503,'SETUP_REQUIRED','Trading is not active yet. Jupiter access and Peak fee collection must be configured.');
 const parsed=inputSchema.safeParse(payload);if(!parsed.success)throw new ApiError(400,'INVALID_INPUT','Check token addresses, amount, wallet and slippage (0.1%–5%).');
 const p=parsed.data;if(p.inputMint===p.outputMint)throw new ApiError(400,'SAME_TOKEN','Choose two different tokens.');
 const referral=settings().JUPITER_REFERRAL_ACCOUNT!;
 const params=new URLSearchParams({inputMint:p.inputMint,outputMint:p.outputMint,amount:p.amount,taker:p.taker,slippageBps:String(p.slippageBps),referralAccount:referral,referralFee:String(FEE_BPS),priorityFeeLamports:'1000000',jitoTipLamports:'0',broadcastFeeType:'maxCap'});
 const q=await jupiter(`/swap/v2/order?${params}`);
 if(!q.transaction||q.errorCode||q.error)throw new ApiError(422,'NO_EXECUTABLE_ROUTE',q.errorCode===1?'Insufficient funds, or this route cannot be built.':'No executable route. Check your balance and try again; liquidity may be migrating.');
 if(q.inputMint!==p.inputMint||q.outputMint!==p.outputMint||q.inAmount!==p.amount||q.taker!==p.taker)throw new ApiError(502,'QUOTE_MISMATCH','Jupiter returned an inconsistent quote.');
 if(q.referralAccount!==referral||q.feeBps!==FEE_BPS||!validAddress(q.feeMint))throw new ApiError(503,'FEE_NOT_APPLIED','Peak fee collection is not ready for this pair. No transaction was submitted.');
 if(!Number.isFinite(q.slippageBps)||q.slippageBps>p.slippageBps)throw new ApiError(422,'SLIPPAGE_LIMIT','Route exceeds your slippage limit.');
 const impact=typeof q.priceImpact==='number'?q.priceImpact/100:q.priceImpactPct!==undefined?Number(q.priceImpactPct):NaN;if(!Number.isFinite(impact)||Math.abs(impact)>0.10)throw new ApiError(422,'PRICE_IMPACT_LIMIT','Price impact is unavailable or exceeds the 10% limit.');
 if(!Number.isFinite(q.prioritizationFeeLamports)||q.prioritizationFeeLamports>1000000)throw new ApiError(422,'NETWORK_FEE_LIMIT','Priority fees exceed the 0.001 SOL limit.');
 const tx=decodeTransaction(q.transaction);if(!tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).some(k=>k.toBase58()===p.taker))throw new ApiError(502,'SIGNER_MISMATCH','Unexpected transaction signer.');
 const now=Date.now(),remoteExpiry=Date.parse(q.expireAt),expiresAt=Math.min(now+45000,Number.isFinite(remoteExpiry)?remoteExpiry:now+45000);
 if(expiresAt<now+3000)throw new ApiError(422,'QUOTE_EXPIRED','This route expired. Please request a fresh quote.');
 const id=crypto.randomUUID(),quote={inputMint:p.inputMint,outputMint:p.outputMint,inAmount:q.inAmount,outAmount:q.outAmount,minimumReceived:q.otherAmountThreshold,slippageBps:q.slippageBps,priceImpactPct:impact,router:q.router,routePlan:q.routePlan||[],feeBps:FEE_BPS,peakFeeBps:100,jupiterShareBps:25,feeMint:q.feeMint,signatureFeeLamports:q.signatureFeeLamports||0,prioritizationFeeLamports:q.prioritizationFeeLamports||0,rentFeeLamports:q.rentFeeLamports||0,gasless:!!q.gasless};
 await db().prepare('INSERT INTO swap_orders (id,request_id,wallet,message,quote,source,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,q.requestId,p.taker,transactionMessage(q.transaction),JSON.stringify(quote),p.source||null,now,expiresAt,'quoted').run();
 return{id,expiresAt,transaction:q.transaction,quote};
}
type OrderRow={id:string;request_id:string;wallet:string;message:string;quote:string;status:string;signed_hash:string|null;result:string|null;expires_at:number;executing_at:number|null};
async function getOrder(id:string){if(!z.string().uuid().safeParse(id).success)throw new ApiError(400,'INVALID_ORDER','Invalid order ID.');const row=await db().prepare('SELECT * FROM swap_orders WHERE id=?').bind(id).first<OrderRow>();if(!row)throw new ApiError(404,'NOT_FOUND','Order not found.');return row}
export async function orderStatus(id:string){const row=await getOrder(id);return{id:row.id,status:row.status==='quoted'&&row.expires_at<Date.now()?'expired':row.status==='executing'&&(row.executing_at||0)<Date.now()-60000?'unknown':row.status,result:row.result?JSON.parse(row.result):null}}
export async function executeOrder(payload:any){
 if(!configuration().ready)throw new ApiError(503,'TRADING_DISABLED','Trading is not active.');
 if(!payload||typeof payload.signedTransaction!=='string'||typeof payload.id!=='string')throw new ApiError(400,'INVALID_INPUT','Order ID and signed transaction are required.');
 const row=await getOrder(payload.id),hash=await digest(payload.signedTransaction);
 try{await verifySignedTransaction(payload.signedTransaction,row.message,row.wallet)}catch{throw new ApiError(400,'TRANSACTION_REJECTED','The transaction or wallet signature does not match this quote.');}
 if(row.signed_hash&&row.signed_hash!==hash)throw new ApiError(409,'ORDER_LOCKED','This order is already bound to another signed transaction.');
 if(row.result)return JSON.parse(row.result);
 if(row.status==='quoted'&&Date.now()>row.expires_at)throw new ApiError(410,'QUOTE_EXPIRED','Quote expired. Request a new quote before signing.');
 if(row.status==='executing'&&(row.executing_at||0)>Date.now()-60000)throw new ApiError(409,'IN_PROGRESS','This transaction is being processed. Check its status.');
 const claim=await db().prepare("UPDATE swap_orders SET status='executing',signed_hash=?,executing_at=? WHERE id=? AND (status IN ('quoted','unknown') OR (status='executing' AND executing_at<?)) AND (signed_hash IS NULL OR signed_hash=?)").bind(hash,Date.now(),row.id,Date.now()-60000,hash).run();
 if(!claim.meta.changes)throw new ApiError(409,'IN_PROGRESS','This order is already being processed.');
 try{const result=await jupiter('/swap/v2/execute',{signedTransaction:payload.signedTransaction,requestId:row.request_id});
 const confirmed=result.status==='Success'&&result.code===0;
 // An ambiguous or failed submission is never labelled as a confirmed purchase.
 const status=confirmed?'confirmed':result.status==='Failed'?'failed':'unknown';
 const safe={id:row.id,status,signature:typeof result.signature==='string'?result.signature:null,code:result.code,totalInputAmount:result.totalInputAmount,totalOutputAmount:result.totalOutputAmount,error:confirmed?null:'Transaction not confirmed. Inspect the signature before making another trade.'};
 await db().prepare('UPDATE swap_orders SET status=?,result=? WHERE id=?').bind(status,status==='unknown'?null:JSON.stringify(safe),row.id).run();return safe;
 }catch(e){await db().prepare("UPDATE swap_orders SET status='unknown' WHERE id=?").bind(row.id).run();throw e;}
}
export async function jsonBody(r:Request){if(!r.headers.get('content-type')?.includes('application/json'))throw new ApiError(415,'CONTENT_TYPE','Use application/json.');const reader=r.body?.getReader();if(!reader)throw new ApiError(400,'INVALID_BODY','JSON body required.');const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();throw new ApiError(413,'BODY_TOO_LARGE','Request too large.')}chunks.push(value)}try{return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))}catch{throw new ApiError(400,'INVALID_JSON','Invalid JSON.')}}
