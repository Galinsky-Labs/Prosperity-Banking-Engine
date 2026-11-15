import {EngineError} from '../index.mjs';
import {assertVerifiedIdentity} from '../identity.mjs';
import {PolicyGateway} from '../policy-gateway.mjs';

export const ID=/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
export const ensure=(condition,code,message)=>{if(!condition)throw new EngineError(code,message);};
export const bounded=(value,label,code='INVALID_REQUEST')=>{ensure(typeof value==='string'&&ID.test(value),code,`${label} is required`);return value;};

export function activeIdentity(identity,now){
 assertVerifiedIdentity(identity);
 ensure(Number.isSafeInteger(now)&&now>=identity.authenticatedAt&&identity.expiresAt>now,'IDENTITY_EXPIRED','Active verified identity is required');
 return identity;
}

/** Require an exact allow decision from the deterministic policy gateway for the caller's own tenant. */
export function requireDecision(gateway,{identity,action,assignments,consentLedger=null,consentId=null,now},code){
 activeIdentity(identity,now);
 const decision=PolicyGateway.prototype.decide.call(gateway,{identity,action,resourceTenantId:identity.tenantId,assignments,consentLedger,consentId,now});
 ensure(decision?.allow===true&&decision.action===action&&decision.tenantId===identity.tenantId&&decision.subject===identity.subject,code,'Exact policy authorization is required');
 return decision;
}
