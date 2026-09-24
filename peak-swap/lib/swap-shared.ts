export const SOL='So11111111111111111111111111111111111111112';
export const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const FEE_BPS=125;
export type Token={id:string;symbol:string;name:string;decimals:number;isVerified?:boolean;usdPrice?:number;graduatedAt?:string;launchpad?:string;organicScoreLabel?:string;audit?:{mintAuthorityDisabled?:boolean;freezeAuthorityDisabled?:boolean;isSus?:boolean}};
export const DEFAULT_TOKENS:Token[]=[{id:SOL,symbol:'SOL',name:'Solana',decimals:9,isVerified:true},{id:USDC,symbol:'USDC',name:'USD Coin',decimals:6,isVerified:true}];
export function toAtomic(value:string,decimals:number){
 if(!Number.isInteger(decimals)||decimals<0||decimals>18||!/^\d+(\.\d*)?$/.test(value))throw Error('Enter a valid amount.');
 const [whole,fraction='']=value.split('.');if(fraction.length>decimals)throw Error(`Use no more than ${decimals} decimal places.`);
 const result=BigInt(whole)*BigInt(10)**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
 if(result<=BigInt(0)||result>BigInt('18446744073709551615'))throw Error('Amount is outside the supported range.');return result.toString();
}
export function fromAtomic(value:string,decimals:number){const s=value.padStart(decimals+1,'0');return decimals?`${s.slice(0,-decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/,''):s;}
export const short=(value:string)=>value.length>16?`${value.slice(0,6)}…${value.slice(-5)}`:value;
