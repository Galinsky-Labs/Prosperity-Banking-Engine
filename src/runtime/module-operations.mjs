import {ConsentLedger} from '../consent-ledger.mjs';
import {TenantAuditSink,createAuditSinkContract} from '../audit-sink.mjs';
import {ensure,requireDecision} from './guards.mjs';

const pick=(body,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]));

/**
 * Build the engine's journaled module operations. `write` operations are journaled and replayed; `apply` must be
 * synchronous and deterministic given (verified actor, time, resolved body, module state). `prepare` may read the
 * store and resolve server-side evidence, which is then journaled in place of caller input.
 */
export function createModuleOperations({gateway}){
 const consents=new ConsentLedger();
 const audit=new TenantAuditSink({contract:createAuditSinkContract({version:'audit-v1',actions:{read:'audit.read',write:'audit.write'},attributeKeys:['accountRef','amountMinor','channel','reasonCode']}),gateway});
 const consentGuard=({identity,assignments,now})=>requireDecision(gateway,{identity,action:'consents.manage',assignments,now},'CONSENT_DENIED');

 const operations={
  'consents.grant':{write:true,apply(ctx,body){consentGuard(ctx);return consents.grant(ctx.identity,{...pick(body,['consentId','scopes','purpose','policyVersion','expiresAt','requestId']),now:ctx.now});}},
  'consents.revoke':{write:true,apply(ctx,body){consentGuard(ctx);return consents.revoke(ctx.identity,{...pick(body,['consentId','expectedVersion','reason','requestId']),now:ctx.now});}},
  'consents.history':{write:false,apply(ctx,body){consentGuard(ctx);return {events:consents.history(ctx.identity,body.consentId),syntheticOnly:true};}},
  'consents.check':{write:false,apply(ctx,body){consentGuard(ctx);return {permitted:consents.permits(ctx.identity,{consentId:body.consentId,scope:body.scope,now:ctx.now}),syntheticOnly:true};}},
  'audit.append':{write:true,apply(ctx,body){return audit.append({...pick(body,['requestId','recordId','eventType','outcome','correlationId','attributes','occurredAt']),identity:ctx.identity,assignments:ctx.assignments,now:ctx.now});}},
  'audit.list':{write:false,apply(ctx,body){return {records:audit.list({...pick(body,['eventType','afterSequence','limit']),identity:ctx.identity,assignments:ctx.assignments,now:ctx.now}),syntheticOnly:true};}}
 };
 for(const operation of Object.values(operations))ensure(typeof operation.apply==='function','INVALID_OPERATION','Operations need apply');
 return {operations,modules:{consents,audit}};
}
