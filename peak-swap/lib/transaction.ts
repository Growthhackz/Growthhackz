import { PublicKey,VersionedTransaction } from '@solana/web3.js';
export function validAddress(value:unknown):value is string {try{return typeof value==='string'&&new PublicKey(value).toBase58()===value}catch{return false}}
export function decodeTransaction(encoded:string){if(encoded.length>2200||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Error('Invalid transaction encoding.');const bytes=Buffer.from(encoded,'base64');if(bytes.length>1232)throw Error('Transaction is too large.');return VersionedTransaction.deserialize(bytes);}
export function transactionMessage(encoded:string){return Buffer.from(decodeTransaction(encoded).message.serialize()).toString('base64');}
export async function verifySignedTransaction(encoded:string,expectedMessage:string,wallet:string){
 const tx=decodeTransaction(encoded),message=tx.message.serialize();
 if(Buffer.from(message).toString('base64')!==expectedMessage)throw Error('Transaction changed after quoting.');
 const signers=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures),i=signers.findIndex(k=>k.toBase58()===wallet);
 if(i<0)throw Error('Expected wallet is not a signer.');
 const key=await crypto.subtle.importKey('raw',new Uint8Array(signers[i].toBytes()),{name:'Ed25519'},false,['verify']);
 if(!await crypto.subtle.verify('Ed25519',key,new Uint8Array(tx.signatures[i]),new Uint8Array(message)))throw Error('Wallet signature is invalid.');
 return tx;
}
