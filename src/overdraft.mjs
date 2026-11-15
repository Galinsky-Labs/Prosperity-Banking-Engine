import {createHash} from 'node:crypto';
import {ConsentLedger} from './consent-ledger.mjs';
import {PolicyGateway} from './policy-gateway.mjs';
import {bounded,ensure,requireDecision} from './runtime/guards.mjs';

const code='INVALID_OVERDRAFT';
export const OVERDRAFT_RAILS=Object.freeze(['atm','one-time-debit','recurring-debit','ach','check']);
/** Rails where fee-bearing coverage always needs an affirmative per-rail opt-in, whatever tenant policy says. */
export const OPT_IN_REQUIRED_RAILS=Object.freeze(['atm','one-time-debit']);
const enrollmentContracts=new WeakSet(),policies=new WeakSet();
const DIGEST=/^[a-f0-9]{64}$/;
export const disclosureDigest=text=>createHash('sha256').update(text,'utf8').digest('hex');

export function createOverdraftEnrollmentContract({version,actions,disclosure,consentScope='overdraft:fees'}){
 bounded(version,'Enrollment version',code);bounded(consentScope,'Consent scope',code);
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,code,'Enrollment actions are required');
 const normalizedActions=Object.freeze({read:bounded(actions.read,'Read action',code),change:bounded(actions.change,'Change action',code)});
 ensure(disclosure&&typeof disclosure==='object',code,'Disclosure is required');
 bounded(disclosure.version,'Disclosure version',code);ensure(typeof disclosure.digest==='string'&&DIGEST.test(disclosure.digest),code,'Disclosure SHA-256 digest is required');
 const contract=Object.freeze({version,actions:normalizedActions,disclosure:Object.freeze({version:disclosure.version,digest:disclosure.digest}),consentScope,syntheticOnly:true});
 enrollmentContracts.add(contract);return contract;
}

/**
 * BNK-017 overdraft opt-in interface. Fee-bearing coverage is OFF by default, granular per rail, requires an
 * affirmative act on the exact current disclosure and an active BNK-005 consent scoped to overdraft fees,
 * and can be revoked at any time. Only the account holder's own verified identity can change it.
 */
export class OverdraftEnrollment {
 #contract;#gateway;#state=new Map();#requests=new Map();
 constructor({contract,gateway}){
  ensure(enrollmentContracts.has(contract),code,'Compiled enrollment contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }

 get disclosure(){return this.#contract.disclosure;}
 #key(identity,accountId){return `${identity.tenantId}:${identity.issuer}:${identity.subject}:${bounded(accountId,'Account ID',code)}`;}
 #current(identity,accountId){return this.#state.get(this.#key(identity,accountId))??Object.freeze({tenantId:identity.tenantId,accountId,optedInRails:Object.freeze([]),consentId:null,disclosureVersion:null,version:0,history:Object.freeze([]),syntheticOnly:true});}
 #rails(rails){ensure(Array.isArray(rails)&&rails.length>=1&&rails.length<=OVERDRAFT_RAILS.length&&rails.every(rail=>OVERDRAFT_RAILS.includes(rail)),code,'Known overdraft rails are required');return [...new Set(rails)].sort();}

 status({identity,accountId,assignments,now}){requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'OVERDRAFT_DENIED');return this.#current(identity,accountId);}

 optIn({identity,requestId,accountId,rails,affirmative,disclosureVersion,disclosureDigest:digest,consentLedger,consentId,expectedVersion,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.change,assignments,now},'OVERDRAFT_DENIED');bounded(requestId,'Request ID',code);
  const normalized=this.#rails(rails),current=this.#current(identity,accountId);
  const requestKey=`${identity.tenantId}:${requestId}`,terms=JSON.stringify(['OPT_IN',identity.issuer,identity.subject,accountId,normalized,disclosureVersion,digest,consentId,expectedVersion]);
  const replay=this.#requests.get(requestKey);if(replay){ensure(replay.terms===terms,'REPLAY_MISMATCH','Overdraft request replay has different terms');return replay.result;}
  ensure(affirmative===true,'AFFIRMATIVE_CONSENT_REQUIRED','Overdraft coverage requires an affirmative customer act');
  ensure(disclosureVersion===this.#contract.disclosure.version&&digest===this.#contract.disclosure.digest,'DISCLOSURE_MISMATCH','The exact current overdraft disclosure must be presented and accepted');
  ensure(consentLedger instanceof ConsentLedger&&typeof consentId==='string'&&ConsentLedger.prototype.permits.call(consentLedger,identity,{consentId,scope:this.#contract.consentScope,now}),'CONSENT_REQUIRED','An active overdraft-fee consent from the account holder is required');
  ensure(expectedVersion===current.version,'STALE_OVERDRAFT','Overdraft enrollment version changed');
  const optedInRails=[...new Set([...current.optedInRails,...normalized])].sort();
  const result=this.#write(identity,accountId,current,{optedInRails,consentId,disclosureVersion},{event:'OPTED_IN',rails:normalized,at:now});
  this.#requests.set(requestKey,{terms,result});return result;
 }

 revoke({identity,accountId,rails=null,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.change,assignments,now},'OVERDRAFT_DENIED');
  const current=this.#current(identity,accountId),removed=rails===null?[...current.optedInRails]:this.#rails(rails);
  const optedInRails=current.optedInRails.filter(rail=>!removed.includes(rail));
  return this.#write(identity,accountId,current,{optedInRails,consentId:optedInRails.length?current.consentId:null},{event:'REVOKED',rails:removed,at:now});
 }

 #write(identity,accountId,current,changes,event){
  const next=Object.freeze({...current,...changes,optedInRails:Object.freeze(changes.optedInRails),version:current.version+1,history:Object.freeze([...current.history,Object.freeze({...event,rails:Object.freeze(event.rails),version:current.version+1})])});
  this.#state.set(this.#key(identity,accountId),next);return next;
 }

 /** True only for an opted-in rail backed by a still-active consent. Revoking the consent turns coverage off. */
 feeBearingCoverage({identity,accountId,rail,consentLedger,now}){
  const current=this.#current(identity,accountId);
  return current.optedInRails.includes(rail)&&current.consentId!==null&&consentLedger instanceof ConsentLedger&&ConsentLedger.prototype.permits.call(consentLedger,identity,{consentId:current.consentId,scope:this.#contract.consentScope,now});
 }
}

export function createOverdraftPolicy({version,currency,rails,feeMinor,deMinimisMinor,maxFeesPerDay,maxOverdraftMinor}){
 bounded(version,'Policy version',code);ensure(typeof currency==='string'&&/^[A-Z]{3}$/.test(currency),code,'Currency is required');
 ensure(rails&&typeof rails==='object',code,'Rail rules are required');
 const normalized=Object.create(null);
 for(const rail of OVERDRAFT_RAILS){
  const rule=rails[rail]??'decline';
  ensure(['decline','cover-no-fee','cover-with-opt-in'].includes(rule),code,`Rail rule for ${rail} is invalid`);
  normalized[rail]=rule;
 }
 for(const [value,label,max] of [[feeMinor,'Fee',10_000],[deMinimisMinor,'De minimis threshold',100_000],[maxFeesPerDay,'Daily fee cap',10],[maxOverdraftMinor,'Overdraft limit',10_000_000]])ensure(Number.isSafeInteger(value)&&value>=0&&value<=max,code,`${label} is out of bounds`);
 const policy=Object.freeze({version,currency,rails:Object.freeze(normalized),feeMinor,deMinimisMinor,maxFeesPerDay,maxOverdraftMinor,syntheticOnly:true});
 policies.add(policy);return policy;
}

/**
 * BNK-018 rail-specific overdraft decision. Pure and deterministic: it returns a decision record and never
 * posts entries or assesses fees. A fee is possible only on a rail the tenant marks `cover-with-opt-in`, for a
 * customer with fee-bearing coverage on that rail, above the de minimis threshold and under the daily cap.
 * ATM and one-time debit transactions without opt-in are declined, never covered for a fee. Force-posted
 * items are always covered but never create a fee without opt-in at decision time.
 */
export function evaluateOverdraft(policy,{rail,currency,amountMinor,availableMinor,feeBearingCoverage,feesChargedToday,forcePost=false}){
 ensure(policies.has(policy),code,'Compiled overdraft policy is required');
 ensure(OVERDRAFT_RAILS.includes(rail),code,'Known rail is required');ensure(currency===policy.currency,code,'Currency must match the policy');
 ensure(Number.isSafeInteger(amountMinor)&&amountMinor>0&&Number.isSafeInteger(availableMinor),code,'Amounts must be safe integer minor units');
 ensure(typeof feeBearingCoverage==='boolean'&&typeof forcePost==='boolean'&&Number.isInteger(feesChargedToday)&&feesChargedToday>=0,code,'Coverage and fee count evidence are required');
 const base={policyVersion:policy.version,rail,amountMinor,forcePost,syntheticOnly:true,executesNothing:true};
 const shortfall=amountMinor-Math.max(availableMinor,0);
 if(shortfall<=0)return Object.freeze({...base,decision:'approve',overdraftMinor:0,feeMinor:0,reasons:Object.freeze(['SUFFICIENT_FUNDS'])});
 const overdraftMinor=Math.min(shortfall,amountMinor),rule=policy.rails[rail],reasons=[];
 const optInRail=OPT_IN_REQUIRED_RAILS.includes(rail);
 const feeEligible=rule==='cover-with-opt-in'&&feeBearingCoverage;
 let decision;
 if(forcePost){decision='approve';reasons.push('FORCE_POSTED');}
 else if(overdraftMinor>policy.maxOverdraftMinor){decision='decline';reasons.push('OVER_LIMIT');}
 else if(rule==='decline'){decision='decline';reasons.push('RAIL_NOT_COVERED');}
 else if(rule==='cover-no-fee'){decision='approve';reasons.push('COVERED_WITHOUT_FEE');}
 else if(feeEligible){decision='approve';reasons.push('COVERED_WITH_OPT_IN');}
 else{decision='decline';reasons.push(optInRail?'OPT_IN_REQUIRED':'NO_FEE_BEARING_COVERAGE');}
 let feeMinor=0;
 if(decision==='approve'&&feeEligible){
  if(overdraftMinor<=policy.deMinimisMinor)reasons.push('DE_MINIMIS_NO_FEE');
  else if(feesChargedToday>=policy.maxFeesPerDay)reasons.push('DAILY_FEE_CAP_REACHED');
  else{feeMinor=Math.min(policy.feeMinor,overdraftMinor);reasons.push('FEE_ELIGIBLE');}
 }else if(decision==='approve')reasons.push('NO_FEE');
 return Object.freeze({...base,decision,overdraftMinor:decision==='approve'?overdraftMinor:0,feeMinor,reasons:Object.freeze(reasons)});
}
