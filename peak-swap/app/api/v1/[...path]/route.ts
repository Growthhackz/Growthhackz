import { ApiError,authorize,configuration,rateLimit,tokens,createOrder,executeOrder,orderStatus,jsonBody } from '@/lib/swap-server';
export const dynamic='force-dynamic';
async function handle(request:Request){
 const path=new URL(request.url).pathname.replace('/api/v1/','');
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 try{
 await authorize(request,request.method==='POST');
 if(path==='health'&&request.method==='GET')return Response.json(configuration(),{headers});
 await rateLimit(request,path==='tokens'?'tokens':request.method==='POST'?'trade':'status',path==='tokens'?20:30);
 if(path==='tokens'&&request.method==='GET')return Response.json({tokens:await tokens(new URL(request.url).searchParams.get('query')||'')},{headers});
 if(path==='orders'&&request.method==='POST')return Response.json(await createOrder(await jsonBody(request)),{status:201,headers});
 if(path==='execute'&&request.method==='POST')return Response.json(await executeOrder(await jsonBody(request)),{headers});
 if(path.startsWith('orders/')&&request.method==='GET')return Response.json(await orderStatus(path.slice(7)),{headers});
 return Response.json({error:{code:'NOT_FOUND',message:'Endpoint not found.'}},{status:404,headers});
 }catch(e){const known=e instanceof ApiError;if(!known)console.error('Peak swap request failed',e instanceof Error?e.name:'Unknown');return Response.json({error:{code:known?e.code:'UNAVAILABLE',message:known?e.message:'The swap service is temporarily unavailable.'}},{status:known?e.status:503,headers:{...headers,...(known&&e.status===429?{'Retry-After':'60'}:{})}})}
}
export const GET=handle;export const POST=handle;
