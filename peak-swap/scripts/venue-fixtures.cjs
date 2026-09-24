// Dev-only. Run from a scratch directory with the SDK versions below installed:
//   npm i @pump-fun/pump-sdk@2.0.0 @pump-fun/pump-swap-sdk@1.20.0 @raydium-io/raydium-sdk-v2@0.2.73-alpha @meteora-ag/cp-amm-sdk@1.4.10 @meteora-ag/dlmm@1.9.14 @solana/web3.js@1.98.4
//   cp <pump-sdk>/src/idl/pump.json <pump-swap-sdk>/src/idl/pump_amm.json .
//   node venue-fixtures.cjs tests/fixtures/venues.json
// Builds reference instructions and accounts with the venues' official SDKs.
// Output: tests/fixtures/venues.json in the peak-swap project.
const fs=require('fs');
const {Keypair,PublicKey,Connection}=require('@solana/web3.js');
const BN=require('bn.js');
const anchor=require('@coral-xyz/anchor');
const pumpSdk=require('@pump-fun/pump-sdk'),ammSdk=require('@pump-fun/pump-swap-sdk');
const ray=require('@raydium-io/raydium-sdk-v2'),cpamm=require('@meteora-ag/cp-amm-sdk'),dlmm=require('@meteora-ag/dlmm');
const spl=require('@solana/spl-token');
const key=n=>Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const S=k=>k.toBase58();
const dump=i=>({programId:S(i.programId),keys:i.keys.map(k=>[S(k.pubkey),k.isWritable,k.isSigner]),data:Buffer.from(i.data).toString('hex')});
const SOL=spl.NATIVE_MINT,T=spl.TOKEN_PROGRAM_ID,T22=spl.TOKEN_2022_PROGRAM_ID;
const user=key(1),mint=key(2),creator=key(3),feeR=key(4),buyback=key(5),pool=key(6);
const out={generatedWith:{'@pump-fun/pump-sdk':'2.0.0','@pump-fun/pump-swap-sdk':'1.20.0','@raydium-io/raydium-sdk-v2':'0.2.73-alpha','@meteora-ag/cp-amm-sdk':'1.4.10','@meteora-ag/dlmm':'1.9.14'},keys:{user:S(user),mint:S(mint),creator:S(creator),feeRecipient:S(feeR),buyback:S(buyback),pool:S(pool),buybackList0:S(key(40)),ammProtocol0:S(key(50)),ammBuyback0:S(key(70)),canonicalPool:S(pumpSdk.canonicalPumpPoolPda(mint)),bitmapExtension:S(key(113))},instructions:{},accounts:{}};

// Default-valued account encoder from an Anchor IDL, with overrides.
function defaults(idl,t){const types=Object.fromEntries(idl.types.map(x=>[x.name,x]));
 if(typeof t==='string')return t==='pubkey'?PublicKey.default:t==='bool'?false:/^(u|i)(8|16|32)$/.test(t)?0:new BN(0);
 if(t.array)return Array.from({length:t.array[1]},()=>defaults(idl,t.array[0]));
 if(t.defined){const d=types[t.defined.name||t.defined].type;if(d.kind==='struct')return Array.isArray(d.fields)&&typeof d.fields[0]!=='object'?d.fields.map(f=>defaults(idl,f)):Object.fromEntries(d.fields.map(f=>[f.name,defaults(idl,f.type)]));if(d.kind==='enum')return{[d.variants[0].name]:{}}}
 throw Error(JSON.stringify(t));}
async function encode(idl,name,over){const coder=new anchor.BorshAccountsCoder(idl);const acc=idl.types.find(x=>x.name===name).type;const v=Object.fromEntries(acc.fields.map(f=>[f.name,defaults(idl,f.type)]));Object.assign(v,over);const L=coder.accountLayouts.get(name),b=Buffer.alloc(20000),n=L.layout.encode(v,b);return Buffer.concat([coder.accountDiscriminator(name),b.subarray(0,n)]).toString("base64");}

(async()=>{
 // Pump.fun bonding curve: SDK builds legacy `buy`; Peak sends `buy_exact_sol_in`, which has the identical account list and arg layout.
 for(const [tp,tag] of [[T22,'t22'],[T,'spl']]){
  out.instructions[`pumpBuy_${tag}`]=dump(await pumpSdk.PUMP_SDK.getBuyInstructionRaw({user,mint,creator,amount:new BN(1000),solAmount:new BN(2000),feeRecipient:feeR,buybackFeeRecipient:buyback,tokenProgram:tp}));
  for(const cashback of [false,true])out.instructions[`pumpSell_${tag}_${cashback?'cashback':'plain'}`]=dump(await pumpSdk.PUMP_SDK.getSellInstructionRaw({user,mint,creator,amount:new BN(1000),solAmount:new BN(2000),feeRecipient:feeR,buybackFeeRecipient:buyback,tokenProgram:tp,cashback}));
 }
 const pumpIdl=JSON.parse(fs.readFileSync('pump.json')),ammIdl=JSON.parse(fs.readFileSync('pump_amm.json'));
 out.accounts.pumpGlobal=await encode(pumpIdl,'Global',{fee_recipient:feeR,fee_recipients:Array.from({length:7},(_,i)=>key(20+i)),reserved_fee_recipient:key(30),reserved_fee_recipients:Array.from({length:7},(_,i)=>key(31+i)),buyback_fee_recipients:Array.from({length:8},(_,i)=>key(40+i))});
 out.accounts.pumpCurve=await encode(pumpIdl,'BondingCurve',{virtual_token_reserves:new BN(111),virtual_quote_reserves:new BN(222),real_quote_reserves:new BN(333),creator,is_mayhem_mode:true,is_cashback_coin:true,quote_mint:SOL});
 out.accounts.ammGlobalConfig=await encode(ammIdl,'GlobalConfig',{protocol_fee_recipients:Array.from({length:8},(_,i)=>key(50+i)),reserved_fee_recipient:key(60),reserved_fee_recipients:Array.from({length:7},(_,i)=>key(61+i)),buyback_fee_recipients:Array.from({length:8},(_,i)=>key(70+i))});
 // PumpSwap: SDK swap builders pick fee recipients with Math.random; pin it to index 0.
 Math.random=()=>0;
 for(const [cashback,coinCreator,small] of [[false,creator,false],[true,creator,true],[false,PublicKey.default,false]]){
  const poolState={baseMint:mint,quoteMint:SOL,poolBaseTokenAccount:key(80),poolQuoteTokenAccount:key(81),coinCreator,isMayhemMode:false,isCashbackCoin:cashback,creator:key(82),virtualQuoteReserves:new BN(0),creatorFeeBps:new BN(0)};
  out.accounts[`ammPool_${cashback}_${coinCreator.equals(PublicKey.default)?'nocreator':'creator'}`]=await encode(ammIdl,'Pool',{base_mint:mint,quote_mint:SOL,pool_base_token_account:key(80),pool_quote_token_account:key(81),coin_creator:coinCreator,is_cashback_coin:cashback});
  const state={globalConfig:{protocolFeeRecipients:[feeR],buybackFeeRecipients:[buyback],reservedFeeRecipient:key(9),reservedFeeRecipients:[]},feeConfig:null,poolKey:pool,poolAccountInfo:{data:Buffer.alloc(small?270:300)},pool:poolState,poolBaseAmount:new BN(1),poolQuoteAmount:new BN(1),baseTokenProgram:T22,quoteTokenProgram:T,baseMint:mint,user,userBaseTokenAccount:spl.getAssociatedTokenAddressSync(mint,user,true,T22),userQuoteTokenAccount:spl.getAssociatedTokenAddressSync(SOL,user,true,T),userBaseAccountInfo:null,userQuoteAccountInfo:null};
  const tag=`${cashback?'cashback':'plain'}_${coinCreator.equals(PublicKey.default)?'nocreator':'creator'}${small?'_extend':''}`;
  out.instructions[`ammBuy_${tag}`]=(await ammSdk.PUMP_AMM_SDK.buyInstructions(state,new BN(1000),new BN(2000))).map(dump);
  out.instructions[`ammSell_${tag}`]=(await ammSdk.PUMP_AMM_SDK.sellInstructions(state,new BN(1000),new BN(2000))).map(dump);
 }
 // Raydium CPMM + AMM v4.
 const cp={config:key(90),vaultA:key(91),vaultB:key(92),mintA:SOL,mintB:mint,programA:T,programB:T22,observation:key(93)};
 const cpBuf=Buffer.alloc(ray.CpmmPoolInfoLayout.span);ray.CpmmPoolInfoLayout.encode({...Object.fromEntries(ray.CpmmPoolInfoLayout.fields.map(f=>[f.property,f.span===32?PublicKey.default:f.property&&f.count?Array(f.count).fill(new BN(0)):f.span===1?0:new BN(0)])),configId:cp.config,poolCreator:key(94),vaultA:cp.vaultA,vaultB:cp.vaultB,mintLp:key(95),mintA:cp.mintA,mintB:cp.mintB,mintProgramA:cp.programA,mintProgramB:cp.programB,observationId:cp.observation,enableCreatorFee:false},cpBuf);
 out.accounts.cpmmPool=cpBuf.toString('base64');out.accounts.cpmmPoolSize=ray.CpmmPoolInfoLayout.span;
 const auth=ray.getPdaPoolAuthority(ray.CREATE_CPMM_POOL_PROGRAM).publicKey;
 out.instructions.cpmmBuy=dump(ray.makeSwapCpmmBaseInInstruction(ray.CREATE_CPMM_POOL_PROGRAM,user,auth,cp.config,pool,spl.getAssociatedTokenAddressSync(SOL,user,true,T),spl.getAssociatedTokenAddressSync(mint,user,true,T22),cp.vaultA,cp.vaultB,T,T22,SOL,mint,cp.observation,new BN(1000),new BN(2000)));
 out.instructions.cpmmSell=dump(ray.makeSwapCpmmBaseInInstruction(ray.CREATE_CPMM_POOL_PROGRAM,user,auth,cp.config,pool,spl.getAssociatedTokenAddressSync(mint,user,true,T22),spl.getAssociatedTokenAddressSync(SOL,user,true,T),cp.vaultB,cp.vaultA,T22,T,mint,SOL,cp.observation,new BN(1000),new BN(2000)));
 const v4Fields=Object.fromEntries(ray.liquidityStateV4Layout.fields.map(f=>[f.property,f.span===32?PublicKey.default:f.count?Array(f.count).fill(new BN(0)):new BN(0)]));
 const v4Buf=Buffer.alloc(ray.liquidityStateV4Layout.span);ray.liquidityStateV4Layout.encode({...v4Fields,baseVault:key(96),quoteVault:key(97),baseMint:mint,quoteMint:SOL},v4Buf);
 out.accounts.ammV4Pool=v4Buf.toString('base64');out.accounts.ammV4PoolSize=ray.liquidityStateV4Layout.span;
 out.instructions.ammV4Sell=dump(ray.swapBaseInV2Instruction(ray.AMM_V4,pool,new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),key(96),key(97),spl.getAssociatedTokenAddressSync(mint,user,true,T),spl.getAssociatedTokenAddressSync(SOL,user,true,T),user,new BN(1000),new BN(2000)));
 // Meteora DAMM v2 via its IDL (same call the SDK makes), with the rate-limiter sysvar the SDK adds when needed.
 const conn=new Connection('http://127.0.0.1:1');const provider=new anchor.AnchorProvider(conn,{publicKey:user,signTransaction:async t=>t,signAllTransactions:async t=>t},{});
 const damm=new anchor.Program(cpamm.CpAmmIdl,provider);
 out.accounts.dammPool=await encode(cpamm.CpAmmIdl,'Pool',{token_a_mint:SOL,token_b_mint:mint,token_a_vault:key(100),token_b_vault:key(101),token_a_flag:0,token_b_flag:1});
 out.instructions.dammBuy=dump(await damm.methods.swap({amountIn:new BN(1000),minimumAmountOut:new BN(2000)}).accountsPartial({poolAuthority:cpamm.derivePoolAuthority(),pool,payer:user,inputTokenAccount:spl.getAssociatedTokenAddressSync(SOL,user,true,T),outputTokenAccount:spl.getAssociatedTokenAddressSync(mint,user,true,T22),tokenAVault:key(100),tokenBVault:key(101),tokenAMint:SOL,tokenBMint:mint,tokenAProgram:T,tokenBProgram:T22,referralTokenAccount:null}).remainingAccounts([{pubkey:require('@solana/web3.js').SYSVAR_INSTRUCTIONS_PUBKEY,isSigner:false,isWritable:false}]).instruction());
 // Meteora DLMM swap2, as DLMM.swap builds it.
 const lb=new anchor.Program(dlmm.IDL,provider);
 const bitmap=Array(16).fill(0).map(()=>new BN(0));const setBit=i=>{const b=i+512;bitmap[b>>6]=bitmap[b>>6].or(new BN(1).shln(b&63))};[-3,-1,0,2,5,9].forEach(setBit);
 out.accounts.lbPair=await encode(dlmm.IDL,'LbPair',{active_id:-5,token_x_mint:mint,token_y_mint:SOL,reserve_x:key(110),reserve_y:key(111),oracle:key(112),bin_array_bitmap:bitmap,token_mint_x_program_flag:1,token_mint_y_program_flag:0});
 const lbState={activeId:-5,binArrayBitmap:bitmap};
 const walk=swapForY=>{const r=[];let id=new BN(-5);for(let n=0;n<3;n++){const idx=dlmm.findNextBinArrayIndexWithLiquidity(swapForY,id,lbState,null);if(idx===null)break;r.push(S(dlmm.deriveBinArray(pool,idx,lb.programId)[0]));const [lo,hi]=dlmm.getBinArrayLowerUpperBinId(idx);id=swapForY?lo.subn(1):hi.addn(1)}return r};
 out.binArrays={swapForY:walk(true),swapForX:walk(false)};
 const bins=out.binArrays.swapForX.map(k=>({pubkey:new PublicKey(k),isSigner:false,isWritable:true}));
 for(const ext of [null,key(113)])out.instructions[`dlmmBuy_${ext?'ext':'noext'}`]=dump(await lb.methods.swap2(new BN(1000),new BN(2000),{slices:[]}).accountsPartial({lbPair:pool,reserveX:key(110),reserveY:key(111),tokenXMint:mint,tokenYMint:SOL,tokenXProgram:T22,tokenYProgram:T,user,userTokenIn:spl.getAssociatedTokenAddressSync(SOL,user,true,T),userTokenOut:spl.getAssociatedTokenAddressSync(mint,user,true,T22),binArrayBitmapExtension:ext,oracle:key(112),hostFeeIn:null,memoProgram:dlmm.MEMO_PROGRAM_ID}).remainingAccounts(bins).instruction());
 fs.writeFileSync(process.argv[2],JSON.stringify(out,null,1));console.log('ok',Object.keys(out.instructions).length,'instructions',Object.keys(out.accounts).length,'accounts');
})().catch(e=>{console.error(e);process.exit(1)});
