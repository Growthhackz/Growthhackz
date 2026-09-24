/** Server-side integration client. Never bundle this API key into a browser. */
export class PeakSwapClient {
 constructor(private baseUrl:string,private apiKey:string){}
 private async request(path:string,body?:unknown){
  const response=await fetch(`${this.baseUrl.replace(/\/$/,'')}/${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(35000)});
  const data:any=await response.json();if(!response.ok)throw Object.assign(new Error(data.error?.message||'Peak request failed'),{status:response.status,code:data.error?.code});return data;
 }
 health(){return this.request('health')}
 tokens(query:string){return this.request(`tokens?query=${encodeURIComponent(query)}`)}
 order(input:{inputMint:string;outputMint:string;amount:string;taker:string;slippageBps?:number;source?:string}){return this.request('orders',input)}
 execute(id:string,signedTransaction:string){return this.request('execute',{id,signedTransaction})}
 status(id:string){return this.request(`orders/${encodeURIComponent(id)}`)}
}
