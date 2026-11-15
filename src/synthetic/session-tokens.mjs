import {createHmac,timingSafeEqual} from 'node:crypto';
import {EngineError} from '../index.mjs';

const ensure=(condition,code,message)=>{if(!condition)throw new EngineError(code,message);};
const b64=value=>Buffer.from(value).toString('base64url');
export const SYNTHETIC_ISSUER='urn:prosperity-engine:synthetic-session-issuer';
export const SYNTHETIC_METHODS=Object.freeze(['synthetic-session','synthetic-second-factor']);
/** Synthetic agents authenticate as workloads, so step-up, dispute and verification controls treat them as non-human. */
export const SYNTHETIC_WORKLOAD_METHODS=Object.freeze(['workload','synthetic-second-factor']);

/**
 * Demo-only HMAC session issuer for synthetic tenants. It is NOT a production identity provider:
 * it exists so the synthetic engine API can exercise the verifier-produced identity contract.
 */
export function createSyntheticSessionIssuer({secret,directory,ttlMs=15*60_000}){
 ensure(typeof secret==='string'&&secret.length>=32,'INVALID_SESSION_SECRET','A session secret of at least 32 characters is required');
 ensure(directory&&typeof directory.findSubject==='function','INVALID_DIRECTORY','A synthetic directory is required');
 ensure(Number.isSafeInteger(ttlMs)&&ttlMs>=1_000&&ttlMs<=3_600_000,'INVALID_SESSION_TTL','Session TTL is invalid');
 const sign=body=>createHmac('sha256',secret).update(body).digest();
 return Object.freeze({
  issuer:SYNTHETIC_ISSUER,
  issue({tenantId,subject,now}){
   const entry=directory.findSubject(tenantId,subject);
   ensure(entry,'UNKNOWN_SYNTHETIC_SUBJECT','Synthetic subject is not in the demo directory');
   const claims={v:1,iss:SYNTHETIC_ISSUER,tid:tenantId,sub:subject,iat:now,exp:now+ttlMs,amr:entry.workload?SYNTHETIC_WORKLOAD_METHODS:SYNTHETIC_METHODS};
   const body=b64(JSON.stringify(claims));
   return Object.freeze({token:`pbe1.${body}.${sign(body).toString('base64url')}`,expiresAt:claims.exp,syntheticOnly:true});
  },
  verify(token,now){
   const unverified={verified:false};
   if(typeof token!=='string'||token.length>4096)return unverified;
   const [prefix,body,signature,...rest]=token.split('.');
   if(prefix!=='pbe1'||!body||!signature||rest.length)return unverified;
   const expected=sign(body),provided=Buffer.from(signature,'base64url');
   if(provided.length!==expected.length||!timingSafeEqual(provided,expected))return unverified;
   let claims;try{claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{return unverified;}
   if(claims?.v!==1||claims.iss!==SYNTHETIC_ISSUER||!Number.isSafeInteger(claims.exp)||claims.exp<=now||!directory.findSubject(claims.tid,claims.sub))return unverified;
   return {verified:true,tenantId:claims.tid,issuer:claims.iss,subject:claims.sub,authenticatedAt:claims.iat,expiresAt:claims.exp,authenticationMethods:claims.amr};
  }
 });
}
