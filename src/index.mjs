/** Nonproduction synthetic engine foundation. No real banking connections. */
export class EngineError extends Error {constructor(code,message){super(message);this.code=code;}}
const ensure=(v,c,m)=>{if(!v)throw new EngineError(c,m);};
export function context(tenantId,actorId){ensure(/^tenant_[a-z0-9_-]+$/.test(tenantId),'INVALID_TENANT','Valid tenant required');ensure(actorId,'INVALID_ACTOR','Actor required');return Object.freeze({tenantId,actorId});}
export function checkTenant(ctx,row){ensure(row?.tenantId===ctx.tenantId,'TENANT_DENIED','Cross-tenant access denied');}
export class Consents {
 #map=new Map();
 grant(ctx,{id,customerId,scope}){ensure(id&&customerId&&scope,'INVALID','Consent parameters required');const key=ctx.tenantId+':'+id;ensure(!this.#map.has(key),'CONFLICT','Duplicate consent');this.#map.set(key,{tenantId:ctx.tenantId,id,customerId,scope,revoked:false});}
 revoke(ctx,id){const v=this.#map.get(ctx.tenantId+':'+id);ensure(v,'NOT_FOUND','Consent missing');v.revoked=true;}
 permits(ctx,{id,customerId,scope}){const v=this.#map.get(ctx.tenantId+':'+id);return !!v&&!v.revoked&&v.customerId===customerId&&v.scope===scope;}
}
export class OverdraftCoverage {
 #state=new Map();
 get(ctx,customerId){return this.#state.get(ctx.tenantId+':'+customerId)??{state:'OFF'};}
 enable(ctx,{customerId,consentId,rails,disclosureVersion,affirmative}){ensure(affirmative===true&&customerId&&consentId&&disclosureVersion&&Array.isArray(rails)&&rails.length,'DENIED','Affirmative disclosed opt-in required');this.#state.set(ctx.tenantId+':'+customerId,{state:'ON',consentId,rails:[...new Set(rails)],disclosureVersion});}
 revoke(ctx,customerId){this.#state.set(ctx.tenantId+':'+customerId,{state:'REVOKED'});}
 feePermitted(ctx,{customerId,consentId,rail,consents}){const r=this.get(ctx,customerId);return r.state==='ON'&&r.consentId===consentId&&r.rails.includes(rail)&&consents.permits(ctx,{id:consentId,customerId,scope:'overdraft:fees'});}
}
export function authorize(ctx,action,consents){checkTenant(ctx,action);const scopes={read:'financial:read',payment:'payment:execute'};const scope=scopes[action.kind];ensure(scope&&consents.permits(ctx,{id:action.consentId,customerId:action.customerId,scope}),'DENIED','No scoped customer consent');if(action.kind==='payment'){ensure(Number.isSafeInteger(action.amountMinor)&&action.amountMinor>0,'DENIED','Payment amount must be positive integer minor units');ensure(action.stepUpApproved===true,'DENIED','Step-up required');}return Object.freeze({allow:true,syntheticOnly:true});}
export class FakePaymentProvider {
 #receipts=new Map();
 async submit(ctx,command){checkTenant(ctx,command);ensure(command.idempotencyKey&&command.customerId,'INVALID','Missing payment identity');ensure(Number.isSafeInteger(command.amountMinor)&&command.amountMinor>0,'INVALID','Invalid payment amount');const key=ctx.tenantId+':'+command.idempotencyKey;const digest=JSON.stringify([command.customerId,command.amountMinor,command.currency,command.destination]);const prev=this.#receipts.get(key);if(prev){ensure(prev.digest===digest,'REPLAY_MISMATCH','Replay has different terms');return {...prev.result};}const result={state:'SYNTHETIC_ONLY',reference:'demo-'+(this.#receipts.size+1),tenantId:ctx.tenantId};this.#receipts.set(key,{digest,result});return {...result};}
}
export * from './data-classification.mjs';
export * from './identity.mjs';
export * from './consent-ledger.mjs';
export * from './policy-gateway.mjs';
export * from './event-outbox.mjs';
export * from './bank-adapter.mjs';

export * from './evidence-vault.mjs';
export * from './audit-sink.mjs';
