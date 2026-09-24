import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import bs58 from 'bs58';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {env} from './mock-env';
import {toAtomic,fromAtomic,SOL,USDC} from '../lib/swap-shared';
import {transactionMessage,verifySignedTransaction} from '../lib/transaction';
import {createOrder,executeOrder,orderStatus,authorize,rateLimit,configuration,confirmation,tokens} from '../lib/swap-server';
import {PUMP,PUMP_PROGRAM} from '../lib/venues/pump';
import {TOKEN_2022_PROGRAM} from '../lib/solana';
const sqlite=new DatabaseSync(':memory:');for(const f of ['0000_certain_invisible_woman.sql','0001_secret_whistler.sql','0002_nosy_tyger_tiger.sql'])sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));
env.DB={prepare(sql:string){let args:any[]=[];return{bind(...a:any[]){args=a;return this},async first(){return sqlite.prepare(sql).get(...args)||null},async run(){const r=sqlite.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}}}}}};
const signer=Keypair.generate(),other=Keypair.generate(),treasury=Keypair.generate().publicKey.toBase58();
env.SOLANA_RPC_URL='https://rpc.peak.test';env.PEAK_FEE_WALLET=treasury;env.PEAK_TRADING_ENABLED='true';env.PEAK_API_KEY='test-only-integration-key';
confirmation.attempts=2;confirmation.intervalMs=1;

// ---- Mock Solana JSON-RPC: one Pump.fun bonding curve for MINT (curve/global from the SDK fixtures). ----
const fixtures=JSON.parse(readFileSync('tests/fixtures/venues.json','utf8')).accounts;
const MINT=new PublicKey(JSON.parse(readFileSync('tests/fixtures/venues.json','utf8')).keys.mint);
const b64=(d:Uint8Array)=>Buffer.from(d).toString('base64');
const mintData=Buffer.alloc(82);mintData[44]=6;
const account=(data:Uint8Array|string,owner:string,lamports=1_000_000)=>({data:[typeof data==='string'?data:b64(data),'base64'],owner,lamports,executable:false,rentEpoch:0});
const tokenAccount=(amount:bigint)=>{const d=Buffer.alloc(165);d.writeBigUInt64LE(amount,64);return account(d,TOKEN_2022_PROGRAM.toBase58())};
const WALLET_LAMPORTS=BigInt(10_000_000_000);
const rpcState={rate:(spend:bigint,full:bigint)=>spend*BigInt(5),sendMode:'ok' as 'ok'|'timeout'|'preflight',status:'confirmed' as 'confirmed'|'none'|'failed',blockHeight:10,priority:5000,gateFails:false,sent:0,full:BigInt(0)};
const calls:string[]=[];
function pumpIx(encoded:string){const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64'));const keys=tx.message.staticAccountKeys.map(String);return tx.message.compiledInstructions.map(i=>({program:keys[i.programIdIndex],data:Buffer.from(i.data)})).find(i=>i.program===PUMP_PROGRAM.toBase58())!}
function rpcResult(method:string,params:any[]):any{
 switch(method){
  case 'getLatestBlockhash':return{value:{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}};
  case 'getMultipleAccounts':return{value:params[0].map((k:string)=>k===MINT.toBase58()?account(mintData,TOKEN_2022_PROGRAM.toBase58()):k===PUMP.global.toBase58()?account(fixtures.pumpGlobal,PUMP_PROGRAM.toBase58()):k===PUMP.bondingCurve(MINT).toBase58()?account(fixtures.pumpCurve,PUMP_PROGRAM.toBase58()):k===signer.publicKey.toBase58()?account(new Uint8Array(),SystemProgram.programId.toBase58(),Number(WALLET_LAMPORTS)):null)};
  case 'getProgramAccounts':return[];
  case 'simulateTransaction':{
   const ix=pumpIx(params[0]),amount=ix.data.readBigUInt64LE(8),measuring=!!params[1].accounts;
   if(!measuring)return{value:{err:rpcState.gateFails?{InstructionError:[2,{Custom:1}]}:null,logs:rpcState.gateFails?['Program log: insufficient lamports']:[],unitsConsumed:90_000}};
   const isBuy=ix.data[0]===56,out=isBuy?rpcState.rate(amount,rpcState.full):amount/BigInt(5);
   return{value:{err:null,logs:[],unitsConsumed:90_000,accounts:[isBuy?tokenAccount(out):account(new Uint8Array(),SystemProgram.programId.toBase58(),Number(WALLET_LAMPORTS+out-BigInt(5000)))]}};
  }
  case 'getRecentPrioritizationFees':return[{slot:1,prioritizationFee:rpcState.priority}];
  case 'sendTransaction':rpcState.sent++;if(rpcState.sendMode==='timeout')throw Error('timeout');if(rpcState.sendMode==='preflight')return{error:{code:-32002,message:'Transaction simulation failed'}};return bs58.encode(VersionedTransaction.deserialize(Buffer.from(params[0],'base64')).signatures[0]);
  case 'getSignatureStatuses':return{value:[rpcState.status==='none'?null:{err:rpcState.status==='failed'?{InstructionError:[0,'x']}:null,confirmationStatus:'confirmed'}]};
  case 'getBlockHeight':return rpcState.blockHeight;
 }
 throw Error('unexpected '+method);
}
const realFetch=globalThis.fetch;
globalThis.fetch=async(url:any,options:any)=>{assert.equal(String(url),env.SOLANA_RPC_URL);const {method,params}=JSON.parse(options.body);calls.push(method);const r=rpcResult(method,params);if(r&&r.error)return Response.json({jsonrpc:'2.0',id:1,error:r.error});return Response.json({jsonrpc:'2.0',id:1,result:r})};

const buy={inputMint:SOL,outputMint:MINT.toBase58(),amount:'100000000',taker:signer.publicKey.toBase58(),slippageBps:100};
const sell={inputMint:MINT.toBase58(),outputMint:SOL,amount:'500000000',taker:signer.publicKey.toBase58(),slippageBps:100};
const signedTx=(encoded:string)=>{const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64'));tx.sign([signer]);return Buffer.from(tx.serialize()).toString('base64')};
function transaction(lamports=100){return new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:other.publicKey,lamports})]}).compileToV0Message())}
function signed(tx:VersionedTransaction){tx.sign([signer]);return Buffer.from(tx.serialize()).toString('base64')}
/** System transfers in a built transaction, in order, as [from,to,lamports]. */
function transfers(encoded:string){const m=VersionedTransaction.deserialize(Buffer.from(encoded,'base64')).message,keys=m.staticAccountKeys.map(String);return m.compiledInstructions.map((i,n)=>({n,i})).filter(({i})=>keys[i.programIdIndex]===SystemProgram.programId.toBase58()&&i.data.length===12).map(({n,i})=>({n,from:keys[i.accountKeyIndexes[0]],to:keys[i.accountKeyIndexes[1]],lamports:Buffer.from(i.data).readBigUInt64LE(4)}))}
const pumpPosition=(encoded:string)=>{const m=VersionedTransaction.deserialize(Buffer.from(encoded,'base64')).message,keys=m.staticAccountKeys.map(String);return m.compiledInstructions.findIndex(i=>keys[i.programIdIndex]===PUMP_PROGRAM.toBase58())};

await test('Atomic units preserve precision and reject invalid inputs',()=>{assert.equal(toAtomic('0.000000001',9),'1');assert.equal(toAtomic('9007199254.740993',6),'9007199254740993');assert.equal(fromAtomic('1000000000',9),'1');for(const value of ['-1','1e5','0','1.0000000001'])assert.throws(()=>toAtomic(value,9));assert.throws(()=>toAtomic('18446744073709551616',0))});
await test('Valid wallet signature accepted; altered messages and unsigned payloads rejected',async()=>{const tx=transaction();const message=transactionMessage(Buffer.from(tx.serialize()).toString('base64'));await assert.rejects(verifySignedTransaction(Buffer.from(tx.serialize()).toString('base64'),message,signer.publicKey.toBase58()));await verifySignedTransaction(signed(tx),message,signer.publicKey.toBase58());await assert.rejects(verifySignedTransaction(signed(transaction(999)),message,signer.publicKey.toBase58()))});
await test('Server blocks missing configuration, unsupported pairs and invalid input',async()=>{
 for(const [k,v] of [['PEAK_TRADING_ENABLED','false'],['PEAK_FEE_WALLET','not-an-address'],['SOLANA_RPC_URL','http://insecure.test']]){const old=env[k];env[k]=v;assert.equal(configuration().ready,false);await assert.rejects(createOrder(buy),(e:any)=>e.code==='SETUP_REQUIRED');env[k]=old}
 assert.equal(configuration().feeBps,100);
 await assert.rejects(createOrder({...buy,inputMint:USDC}),(e:any)=>e.code==='UNSUPPORTED_PAIR');
 await assert.rejects(createOrder({...buy,referralFee:0}),(e:any)=>e.code==='INVALID_INPUT');
 await assert.rejects(createOrder({...buy,amount:'-1'}),(e:any)=>e.code==='INVALID_INPUT');
 await assert.rejects(createOrder({...buy,slippageBps:501}),(e:any)=>e.code==='INVALID_INPUT');
});
await test('Buy: Pump.fun curve route, exact SOL in, 1% Peak fee on top paid before the swap',async()=>{
 const order=await createOrder(buy),q=order.quote;
 assert.equal(q.venue,'pump-curve');assert.equal(q.outAmount,'500000000');assert.equal(q.minimumReceived,'495000000');assert.equal(q.priceImpactPct,0);
 assert.equal(q.feeLamports,'1000000');assert.equal(q.totalInputAmount,'101000000');
 const fee=transfers(order.transaction).filter(t=>t.to===treasury);assert.equal(fee.length,1);assert.equal(fee[0].lamports,BigInt(1_000_000));assert.equal(fee[0].from,buy.taker);
 assert.ok(fee[0].n<pumpPosition(order.transaction));
 const ix=pumpIx(order.transaction);assert.equal(ix.data.readBigUInt64LE(8),BigInt(100_000_000));assert.equal(ix.data.readBigUInt64LE(16),BigInt(495_000_000));
 assert.ok(q.prioritizationFeeLamports<=1_000_000);
});
await test('Sell: 1% fee comes out of the SOL proceeds after the swap; reported amounts are net',async()=>{
 const order=await createOrder(sell),q=order.quote;
 assert.equal(q.venue,'pump-curve');assert.equal(q.feeLamports,'1000000');assert.equal(q.outAmount,'99000000');assert.equal(q.minimumReceived,String(99_000_000-1_000_000));
 const fee=transfers(order.transaction).filter(t=>t.to===treasury);assert.equal(fee.length,1);assert.ok(fee[0].n>pumpPosition(order.transaction));
 assert.equal(pumpIx(order.transaction).data.readBigUInt64LE(16),BigInt(99_000_000));
});
await test('Price impact, priority fees and failed simulations are enforced',async()=>{
 rpcState.rate=(spend,full)=>spend===BigInt(100_000_000)?spend*BigInt(4):spend*BigInt(5); // 20% worse at full size
 await assert.rejects(createOrder(buy),(e:any)=>e.code==='PRICE_IMPACT_LIMIT');rpcState.rate=spend=>spend*BigInt(5);
 rpcState.priority=1_000_000_000;const capped=await createOrder(buy);assert.ok(capped.quote.prioritizationFeeLamports<=1_000_000);rpcState.priority=5000;
 rpcState.gateFails=true;await assert.rejects(createOrder(buy),(e:any)=>e.code==='INSUFFICIENT_FUNDS');rpcState.gateFails=false;
});
await test('Tampered transactions (e.g. fee removed) are rejected',async()=>{const order=await createOrder(buy);await assert.rejects(executeOrder({id:order.id,signedTransaction:signed(transaction(1))}),(e:any)=>e.code==='TRANSACTION_REJECTED')});
await test('Successful swap is stored; duplicate execution returns same result without resending',async()=>{const order=await createOrder(buy);const body={id:order.id,signedTransaction:signedTx(order.transaction)},before=rpcState.sent;const r=await executeOrder(body);assert.equal(r.status,'confirmed');assert.ok(r.signature);assert.equal((await executeOrder(body)).status,'confirmed');assert.equal(rpcState.sent,before+1);assert.equal((await orderStatus(order.id)).status,'confirmed')});
await test('Expired quotes cannot be submitted',async()=>{const order=await createOrder(buy);sqlite.prepare('UPDATE swap_orders SET expires_at=0 WHERE id=?').run(order.id);await assert.rejects(executeOrder({id:order.id,signedTransaction:signedTx(order.transaction)}),(e:any)=>e.code==='QUOTE_EXPIRED')});
await test('Timeout stays unknown; a retry checks the chain before resending',async()=>{
 const order=await createOrder(buy),body={id:order.id,signedTransaction:signedTx(order.transaction)};
 rpcState.sendMode='timeout';await assert.rejects(executeOrder(body),(e:any)=>e.code==='UPSTREAM_TIMEOUT');rpcState.sendMode='ok';
 rpcState.status='none';assert.equal((await orderStatus(order.id)).status,'unknown');
 await assert.rejects(executeOrder({id:order.id,signedTransaction:signed(transaction(222))}));
 rpcState.status='confirmed';const before=rpcState.sent;assert.equal((await executeOrder(body)).status,'confirmed');assert.equal(rpcState.sent,before,'landed transaction is not resent');
});
await test('Unconfirmed submissions resolve to expired once the blockhash can no longer land',async()=>{
 const order=await createOrder(buy);rpcState.status='none';const r=await executeOrder({id:order.id,signedTransaction:signedTx(order.transaction)});assert.equal(r.status,'unknown');
 assert.equal((await orderStatus(order.id)).status,'unknown');rpcState.blockHeight=101;
 const s=await orderStatus(order.id);assert.equal(s.status,'expired');assert.match(s.result.error,/No funds moved/);rpcState.blockHeight=10;rpcState.status='confirmed';
});
await test('Preflight rejection is final and not reported as a purchase',async()=>{const order=await createOrder(buy);rpcState.sendMode='preflight';const r=await executeOrder({id:order.id,signedTransaction:signedTx(order.transaction)});rpcState.sendMode='ok';assert.equal(r.status,'rejected')});
await test('Concurrent executions produce only one submission',async()=>{const order=await createOrder(buy);const body={id:order.id,signedTransaction:signedTx(order.transaction)},before=rpcState.sent;const results=await Promise.allSettled([executeOrder(body),executeOrder(body)]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(rpcState.sent,before+1)});
await test('Token lookup reads mint decimals by address and rejects free text',async()=>{const [t]=await tokens(MINT.toBase58());assert.equal(t.decimals,6);assert.equal(t.isVerified,false);assert.equal((await tokens('usdc'))[0].id,USDC);await assert.rejects(tokens('bonk'),(e:any)=>e.code==='INVALID_QUERY')});
await test('Origin checks and bearer authorization reject outsiders',async()=>{await assert.rejects(authorize(new Request('https://peak.test/api/v1/orders',{method:'POST',headers:{Origin:'https://evil.test'}}),true));await assert.rejects(authorize(new Request('https://peak.test/api/v1/orders',{method:'POST'}),true));await assert.rejects(authorize(new Request('https://peak.test/api/v1/orders',{method:'POST',headers:{Authorization:'Bearer wrong'}}),true));assert.equal(await authorize(new Request('https://peak.test/api/v1/orders',{method:'POST',headers:{Authorization:'Bearer test-only-integration-key'}}),true),'integration')});
await test('Rate limit is persisted and enforced',async()=>{const req=new Request('https://peak.test/api/v1/orders',{headers:{'cf-connecting-ip':'192.0.2.1'}});await rateLimit(req,'test',1);await assert.rejects(rateLimit(req,'test',1),(e:any)=>e.status===429)});
globalThis.fetch=realFetch;sqlite.close();void calls;
