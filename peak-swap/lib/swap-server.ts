import { env } from 'cloudflare:workers';
import { z } from 'zod';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { FEE_BPS,DEFAULT_TOKENS,type Token } from './swap-shared';
import { validAddress,transactionMessage,verifySignedTransaction,decodeTransaction } from './transaction';
import { solanaRpc,RpcError } from './rpc';
import { buildQuote,RouteError } from './router';
import { isTokenProgram,pda,pk,readU16 } from './solana';
import { VENUE_LABELS } from './venues/types';
type Bindings={DB:D1Database;SOLANA_RPC_URL?:string;PEAK_FEE_WALLET?:string;PEAK_API_KEY?:string;PEAK_TRADING_ENABLED?:string};
const settings=()=>env as unknown as Bindings;
const db=()=>{const d=settings().DB;if(!d)throw new ApiError(503,'STORAGE_UNAVAILABLE','Swap storage is unavailable.');return d};
export class ApiError extends Error{constructor(public status:number,public code:string,message:string){super(message)}}
export async function digest(s:string){return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex')}
export function configuration(){const e=settings();const missing=[!/^https:\/\/\S+$/.test(e.SOLANA_RPC_URL||'')&&'Solana RPC endpoint',!validAddress(e.PEAK_FEE_WALLET)&&'Peak fee wallet',e.PEAK_TRADING_ENABLED!=='true'&&'Trading activation'].filter(Boolean);return{ready:missing.length===0,missing,feeBps:FEE_BPS,feeMint:DEFAULT_TOKENS[0].id,venues:Object.values(VENUE_LABELS),network:'solana-mainnet',externalApiConfigured:!!e.PEAK_API_KEY}}
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
const rpc=()=>solanaRpc(settings().SOLANA_RPC_URL!);
/** Test hook: confirmation polling during /execute. */
export const confirmation={attempts:12,intervalMs:1500};
async function upstream<T>(work:()=>Promise<T>,submitting=false):Promise<T>{
 try{return await work()}catch(e){
  if(e instanceof ApiError)throw e;
  if(e instanceof RouteError)throw new ApiError(e.status,e.code,e.message);
  if(e instanceof RpcError)throw new ApiError(e.timeout?504:502,e.timeout?'UPSTREAM_TIMEOUT':'RPC_UNAVAILABLE',submitting?'Solana did not respond in time. Check this order before starting another swap.':'Solana RPC is unavailable. Please try again shortly.');
  throw e;
 }
}
const METADATA_PROGRAM=pk('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
function borshStrings(d:Buffer,offset:number,count:number){const out:string[]=[];for(let i=0;i<count;i++){if(offset+4>d.length)return null;const len=d.readUInt32LE(offset);if(len>200||offset+4+len>d.length)return null;out.push(d.subarray(offset+4,offset+4+len).toString('utf8').replace(/\0/g,'').trim());offset+=4+len}return out}
/** Name and symbol from the Token-2022 metadata extension (TLV type 19), if present. */
function token2022Metadata(d:Buffer){if(d.length<=170||d[165]!==1)return null;for(let o=166;o+4<=d.length;){const type=readU16(d,o),len=readU16(d,o+2);if(type===19)return borshStrings(d,o+4+64,2);if(!type)break;o+=4+len}return null}
export async function tokens(query:string){
 const q=query.trim();if(q.length<1||q.length>80)throw new ApiError(400,'INVALID_QUERY','Paste a token mint address.');
 const local=DEFAULT_TOKENS.filter(t=>t.id===q||t.symbol.toLowerCase()===q.toLowerCase());if(local.length)return local;
 if(!validAddress(q))throw new ApiError(400,'INVALID_QUERY','Paste the token’s mint address. Name search covers SOL and USDC only.');
 if(configuration().missing.includes('Solana RPC endpoint'))throw new ApiError(503,'SETUP_REQUIRED','Token lookup needs the Solana RPC endpoint to be configured.');
 const mint=new PublicKey(q),[account,metadata]=await upstream(()=>rpc().getAccounts([mint,pda(['metadata',METADATA_PROGRAM.toBytes(),mint.toBytes()],METADATA_PROGRAM)]));
 if(!account||!isTokenProgram(account.owner)||account.data.length<82)return[];
 const d=Buffer.from(account.data),names=token2022Metadata(d)||(metadata?borshStrings(Buffer.from(metadata.data),65,2):null)||['',''];
 return[{id:q,symbol:(names[1]||q.slice(0,4)).slice(0,16),name:(names[0]||'Unlisted token').slice(0,64),decimals:d[44],isVerified:false,tokenProgram:account.owner} satisfies Token];
}
const address=z.string().refine(validAddress,'Invalid Solana address');
const inputSchema=z.object({inputMint:address,outputMint:address,amount:z.string().regex(/^[1-9]\d{0,19}$/).refine(s=>BigInt(s)<=BigInt('18446744073709551615')),taker:address,slippageBps:z.number().int().min(10).max(500).default(100),source:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional()}).strict();
/** Defense in depth: the message about to be stored must pay Peak exactly `lamports` from the taker. */
export function hasFeeTransfer(encoded:string,taker:string,treasury:string,lamports:bigint){
 const m=decodeTransaction(encoded).message,keys=m.staticAccountKeys.map(k=>k.toBase58());
 return m.compiledInstructions.some(i=>keys[i.programIdIndex]==='11111111111111111111111111111111'&&i.data.length===12&&Buffer.from(i.data).readUInt32LE(0)===2&&Buffer.from(i.data).readBigUInt64LE(4)===lamports&&keys[i.accountKeyIndexes[0]]===taker&&keys[i.accountKeyIndexes[1]]===treasury);
}
export async function createOrder(payload:unknown){
 const config=configuration();if(!config.ready)throw new ApiError(503,'SETUP_REQUIRED','Trading is not active yet. The Solana RPC endpoint and Peak fee wallet must be configured.');
 const parsed=inputSchema.safeParse(payload);if(!parsed.success)throw new ApiError(400,'INVALID_INPUT','Check token addresses, amount, wallet and slippage (0.1%–5%).');
 const p=parsed.data;if(p.inputMint===p.outputMint)throw new ApiError(400,'SAME_TOKEN','Choose two different tokens.');
 const treasury=settings().PEAK_FEE_WALLET!;
 const built=await upstream(()=>buildQuote(rpc(),{...p,amount:BigInt(p.amount),treasury}));
 const q=built.quote;
 if(q.inputMint!==p.inputMint||q.outputMint!==p.outputMint||q.inAmount!==p.amount)throw new ApiError(502,'QUOTE_MISMATCH','The route builder returned an inconsistent quote.');
 if(!Number.isFinite(q.priceImpactPct)||q.priceImpactPct>0.10)throw new ApiError(422,'PRICE_IMPACT_LIMIT','Price impact is unavailable or exceeds the 10% limit.');
 if(q.prioritizationFeeLamports>1000000)throw new ApiError(422,'NETWORK_FEE_LIMIT','Priority fees exceed the 0.001 SOL limit.');
 const tx=decodeTransaction(built.transaction);if(tx.message.staticAccountKeys[0]?.toBase58()!==p.taker)throw new ApiError(502,'SIGNER_MISMATCH','Unexpected transaction signer.');
 if(!hasFeeTransfer(built.transaction,p.taker,treasury,BigInt(q.feeLamports)))throw new ApiError(503,'FEE_NOT_APPLIED','Peak fee could not be applied. No transaction was created.');
 const now=Date.now(),expiresAt=now+45000,id=crypto.randomUUID();
 // request_id holds the quote's recent blockhash; last_valid_block_height bounds when the signed transaction can still land.
 await db().prepare('INSERT INTO swap_orders (id,request_id,wallet,message,quote,source,created_at,expires_at,status,last_valid_block_height) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id,built.blockhash,p.taker,transactionMessage(built.transaction),JSON.stringify(q),p.source||null,now,expiresAt,'quoted',built.lastValidBlockHeight).run();
 return{id,expiresAt,transaction:built.transaction,quote:q};
}
type OrderRow={id:string;request_id:string;wallet:string;message:string;quote:string;status:string;signed_hash:string|null;signature:string|null;last_valid_block_height:number|null;result:string|null;expires_at:number;executing_at:number|null};
async function getOrder(id:string){if(!z.string().uuid().safeParse(id).success)throw new ApiError(400,'INVALID_ORDER','Invalid order ID.');const row=await db().prepare('SELECT * FROM swap_orders WHERE id=?').bind(id).first<OrderRow>();if(!row)throw new ApiError(404,'NOT_FOUND','Order not found.');return row}
const OUTCOME_MESSAGES:Record<string,string|null>={confirmed:null,failed:'Transaction failed on-chain. Inspect the signature before making another trade.',expired:'Transaction expired without landing. No funds moved; request a new quote.',rejected:'Transaction was rejected before sending. No funds moved; request a new quote.'};
async function settle(row:OrderRow,status:keyof typeof OUTCOME_MESSAGES){
 const q=JSON.parse(row.quote);
 const safe={id:row.id,status,signature:row.signature,venue:q.venueLabel,totalInputAmount:q.totalInputAmount,quotedOutputAmount:q.outAmount,minimumReceived:q.minimumReceived,error:OUTCOME_MESSAGES[status]};
 await db().prepare('UPDATE swap_orders SET status=?,result=? WHERE id=?').bind(status,JSON.stringify(safe),row.id).run();return safe;
}
/** Resolves a submitted signature against chain state; null while it may still land. */
async function resolveOnChain(row:OrderRow){
 if(!row.signature)return null;
 const s=await upstream(()=>rpc().signatureStatus(row.signature!,true));
 if(s)return s.err?settle(row,'failed'):['confirmed','finalized'].includes(s.confirmationStatus)?settle(row,'confirmed'):null;
 if(row.last_valid_block_height!==null&&await upstream(()=>rpc().blockHeight())>row.last_valid_block_height)return settle(row,'expired');
 return null;
}
const pending=(row:OrderRow)=>({id:row.id,status:'unknown',signature:row.signature,error:'Submitted to Solana and awaiting confirmation. Check status before trading again.'});
export async function orderStatus(id:string){
 let row=await getOrder(id);
 if(!row.result&&row.signature&&['executing','unknown'].includes(row.status)){const settled=await resolveOnChain(row);if(settled)row=await getOrder(id)}
 return{id:row.id,status:row.status==='quoted'&&row.expires_at<Date.now()?'expired':row.status==='executing'&&(row.executing_at||0)<Date.now()-60000?'unknown':row.status,result:row.result?JSON.parse(row.result):null};
}
export async function executeOrder(payload:any){
 if(!configuration().ready)throw new ApiError(503,'TRADING_DISABLED','Trading is not active.');
 if(!payload||typeof payload.signedTransaction!=='string'||typeof payload.id!=='string')throw new ApiError(400,'INVALID_INPUT','Order ID and signed transaction are required.');
 const row=await getOrder(payload.id),hash=await digest(payload.signedTransaction);
 let signature:string;
 try{signature=bs58.encode((await verifySignedTransaction(payload.signedTransaction,row.message,row.wallet)).signatures[0])}catch{throw new ApiError(400,'TRANSACTION_REJECTED','The transaction or wallet signature does not match this quote.');}
 if(row.signed_hash&&row.signed_hash!==hash)throw new ApiError(409,'ORDER_LOCKED','This order is already bound to another signed transaction.');
 if(row.result)return JSON.parse(row.result);
 if(row.status==='quoted'&&Date.now()>row.expires_at)throw new ApiError(410,'QUOTE_EXPIRED','Quote expired. Request a new quote before signing.');
 if(row.status==='executing'&&(row.executing_at||0)>Date.now()-60000)throw new ApiError(409,'IN_PROGRESS','This transaction is being processed. Check its status.');
 const claim=await db().prepare("UPDATE swap_orders SET status='executing',signed_hash=?,signature=?,executing_at=? WHERE id=? AND (status IN ('quoted','unknown') OR (status='executing' AND executing_at<?)) AND (signed_hash IS NULL OR signed_hash=?)").bind(hash,signature,Date.now(),row.id,Date.now()-60000,hash).run();
 if(!claim.meta.changes)throw new ApiError(409,'IN_PROGRESS','This order is already being processed.');
 const current={...row,signature,signed_hash:hash};
 try{
  // A retry of an earlier submission may already have landed: never resend without checking.
  if(row.signature){const settled=await resolveOnChain(current);if(settled)return settled}
  try{await rpc().send(payload.signedTransaction)}catch(e){
   // Preflight rejection (-32002) means the transaction was not forwarded; the same bytes can never be charged later once checked above.
   if(e instanceof RpcError&&e.code===-32002&&!row.signature)return settle(current,'rejected');
   if(e instanceof RpcError&&e.code===-32002){const settled=await resolveOnChain(current);if(settled)return settled}
   throw e;
  }
  for(let i=0;i<confirmation.attempts;i++){
   await new Promise(r=>setTimeout(r,i?confirmation.intervalMs:Math.min(500,confirmation.intervalMs)));
   const s=await rpc().signatureStatus(signature,false).catch(()=>null);
   if(s?.err)return settle(current,'failed');
   if(s&&['confirmed','finalized'].includes(s.confirmationStatus))return settle(current,'confirmed');
  }
  await db().prepare("UPDATE swap_orders SET status='unknown' WHERE id=?").bind(row.id).run();return pending(current);
 }catch(e){await db().prepare("UPDATE swap_orders SET status='unknown' WHERE id=?").bind(row.id).run();return upstream(()=>Promise.reject(e),true);}
}
export async function jsonBody(r:Request){if(!r.headers.get('content-type')?.includes('application/json'))throw new ApiError(415,'CONTENT_TYPE','Use application/json.');const reader=r.body?.getReader();if(!reader)throw new ApiError(400,'INVALID_BODY','JSON body required.');const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();throw new ApiError(413,'BODY_TOO_LARGE','Request too large.')}chunks.push(value)}try{return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))}catch{throw new ApiError(400,'INVALID_JSON','Invalid JSON.')}}
