import {PolicyGateway} from './policy-gateway.mjs';
import {bounded,ensure,requireDecision} from './runtime/guards.mjs';

const code='INVALID_HARDSHIP';
const compiledContracts=new WeakSet();
const KINDS=new Set(['payment-deferral','fee-waiver','payment-plan','rate-reduction','referral']);
const DAY=86_400_000;

export function createHardshipContract({version,actions,reasonCodes,options,disclosureVersion,offerValidityDays=14,maxAccounts=10}){
 bounded(version,'Hardship version',code);bounded(disclosureVersion,'Disclosure version',code);
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,code,'Hardship actions are required');
 const normalizedActions=Object.freeze(Object.fromEntries(['request','draft','decide'].map(key=>[key,bounded(actions[key],`${key} action`,code)])));
 ensure(new Set(Object.values(normalizedActions)).size===3,code,'Hardship actions must differ');
 ensure(Array.isArray(reasonCodes)&&reasonCodes.length>=1&&reasonCodes.length<=32,code,'Reason codes are required');
 ensure(Array.isArray(options)&&options.length>=1&&options.length<=32,code,'Assistance options are required');
 const catalog=Object.create(null);
 for(const option of options){
  const optionCode=bounded(option?.optionCode,'Option code',code);ensure(!catalog[optionCode],code,'Option codes must be unique');
  ensure(KINDS.has(option.kind),code,'Option kind is unsupported');
  ensure(Number.isInteger(option.maxDurationDays)&&option.maxDurationDays>=1&&option.maxDurationDays<=365,code,'Option duration bound is invalid');
  catalog[optionCode]=Object.freeze({optionCode,kind:option.kind,maxDurationDays:option.maxDurationDays});
 }
 ensure(Number.isInteger(offerValidityDays)&&offerValidityDays>=1&&offerValidityDays<=60&&Number.isInteger(maxAccounts)&&maxAccounts>=1&&maxAccounts<=50,code,'Hardship bounds are invalid');
 const contract=Object.freeze({version,actions:normalizedActions,reasonCodes:Object.freeze([...new Set(reasonCodes.map(reason=>bounded(reason,'Reason code',code)))]),options:Object.freeze(catalog),disclosureVersion,offerValidityDays,maxAccounts,syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}

/**
 * BNK-016 hardship assistance. Customers open cases; agents or staff may only draft proposals; a different,
 * fresh-MFA human decision-maker approves an offer; only the customer's affirmative, disclosed acceptance
 * creates an arrangement. While a case is open, collections contact is paused for its accounts.
 * The workflow never posts ledger entries, waives fees or changes credit by itself.
 */
export class HardshipCaseService {
 #contract;#gateway;#cases=new Map();#requests=new Map();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),code,'Compiled hardship contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }

 #authorize(identity,action,assignments,now){return requireDecision(this.#gateway,{identity,action,assignments,now},'HARDSHIP_DENIED');}
 #case(identity,caseId){bounded(caseId,'Case ID',code);const record=this.#cases.get(`${identity.tenantId}:${caseId}`);ensure(record,'HARDSHIP_NOT_FOUND','Hardship case does not exist');return record;}
 #transition(record,expectedVersion,changes,event,now,actor){
  ensure(expectedVersion===record.version,'STALE_HARDSHIP','Hardship case version changed');
  const next=Object.freeze({...record,...changes,version:record.version+1,updatedAt:now,history:Object.freeze([...record.history,Object.freeze({event,at:now,actor,version:record.version+1})])});
  this.#cases.set(`${record.tenantId}:${record.caseId}`,next);return next;
 }

 openCase({identity,requestId,caseId,reasonCodes,accountIds,assignments,now}){
  this.#authorize(identity,this.#contract.actions.request,assignments,now);bounded(requestId,'Request ID',code);bounded(caseId,'Case ID',code);
  ensure(Array.isArray(reasonCodes)&&reasonCodes.length>=1&&reasonCodes.length<=5&&reasonCodes.every(reason=>this.#contract.reasonCodes.includes(reason)),code,'Known reason codes are required');
  ensure(Array.isArray(accountIds)&&accountIds.length>=1&&accountIds.length<=this.#contract.maxAccounts,code,'Bounded account IDs are required');
  const accounts=[...new Set(accountIds.map(id=>bounded(id,'Account ID',code)))].sort(),reasons=[...new Set(reasonCodes)].sort();
  const requestKey=`${identity.tenantId}:${requestId}`,digest=JSON.stringify([identity.issuer,identity.subject,caseId,reasons,accounts]);
  const replay=this.#requests.get(requestKey);if(replay){ensure(replay.digest===digest,'REPLAY_MISMATCH','Hardship request replay has different terms');return this.#cases.get(replay.caseKey);}
  const key=`${identity.tenantId}:${caseId}`;ensure(!this.#cases.has(key),'HARDSHIP_CONFLICT','Hardship case already exists');
  const record=Object.freeze({tenantId:identity.tenantId,caseId,customer:Object.freeze({issuer:identity.issuer,subject:identity.subject}),reasonCodes:Object.freeze(reasons),accountIds:Object.freeze(accounts),state:'OPEN',proposals:null,proposedBy:null,offer:null,arrangement:null,version:1,openedAt:now,updatedAt:now,history:Object.freeze([Object.freeze({event:'OPENED',at:now,actor:identity.subject,version:1})]),syntheticOnly:true});
  this.#cases.set(key,record);this.#requests.set(requestKey,{digest,caseKey:key});return record;
 }

 draftProposals({identity,caseId,proposals,expectedVersion,assignments,now}){
  this.#authorize(identity,this.#contract.actions.draft,assignments,now);
  const record=this.#case(identity,caseId);ensure(record.state==='OPEN'||record.state==='PROPOSED','HARDSHIP_STATE','Proposals can only be drafted for open cases');
  ensure(Array.isArray(proposals)&&proposals.length>=1&&proposals.length<=5,code,'One to five proposals are required');
  const normalized=proposals.map(proposal=>{
   const option=this.#contract.options[bounded(proposal?.optionCode,'Option code',code)];ensure(option,'UNKNOWN_HARDSHIP_OPTION','Option is not in the tenant catalog');
   ensure(Number.isInteger(proposal.durationDays)&&proposal.durationDays>=1&&proposal.durationDays<=option.maxDurationDays,code,'Proposal duration exceeds the option bound');
   return Object.freeze({optionCode:option.optionCode,kind:option.kind,durationDays:proposal.durationDays});
  });
  ensure(new Set(normalized.map(proposal=>proposal.optionCode)).size===normalized.length,code,'Proposal options must be unique');
  return this.#transition(record,expectedVersion,{state:'PROPOSED',proposals:Object.freeze(normalized),proposedBy:Object.freeze({issuer:identity.issuer,subject:identity.subject})},'DRAFTED',now,identity.subject);
 }

 approveOffer({identity,caseId,optionCodes,expectedVersion,assignments,now}){
  this.#authorize(identity,this.#contract.actions.decide,assignments,now);
  const record=this.#case(identity,caseId);ensure(record.state==='PROPOSED','HARDSHIP_STATE','Only drafted proposals can be approved');
  ensure(!(record.proposedBy.issuer===identity.issuer&&record.proposedBy.subject===identity.subject),'SEPARATION_OF_DUTIES','The drafter cannot approve their own proposal');
  ensure(!(record.customer.issuer===identity.issuer&&record.customer.subject===identity.subject),'SEPARATION_OF_DUTIES','Customers cannot approve their own hardship offer');
  ensure(Array.isArray(optionCodes)&&optionCodes.length>=1,code,'Approved options are required');
  const offered=record.proposals.filter(proposal=>optionCodes.includes(proposal.optionCode));
  ensure(offered.length===new Set(optionCodes).size,code,'Only drafted proposals can be offered');
  const offer=Object.freeze({options:Object.freeze(offered),approvedBy:identity.subject,disclosureVersion:this.#contract.disclosureVersion,expiresAt:now+this.#contract.offerValidityDays*DAY});
  return this.#transition(record,expectedVersion,{state:'OFFERED',offer},'OFFER_APPROVED',now,identity.subject);
 }

 respond({identity,caseId,decision,optionCode=null,affirmative,disclosureVersion,expectedVersion,assignments,now}){
  this.#authorize(identity,this.#contract.actions.request,assignments,now);
  const record=this.#case(identity,caseId);
  ensure(record.customer.issuer===identity.issuer&&record.customer.subject===identity.subject,'HARDSHIP_DENIED','Only the case customer can respond');
  ensure(record.state==='OFFERED','HARDSHIP_STATE','No active offer');
  if(now>=record.offer.expiresAt)return this.#transition(record,expectedVersion,{state:'OPEN',offer:null,proposals:null,proposedBy:null},'OFFER_EXPIRED',now,'system');
  if(decision==='decline')return this.#transition(record,expectedVersion,{state:'DECLINED'},'DECLINED',now,identity.subject);
  ensure(decision==='accept',code,'Decision must be accept or decline');
  ensure(affirmative===true,'AFFIRMATIVE_CONSENT_REQUIRED','Acceptance requires an affirmative customer action');
  ensure(disclosureVersion===record.offer.disclosureVersion,'DISCLOSURE_MISMATCH','The customer must accept the current disclosure');
  const option=record.offer.options.find(candidate=>candidate.optionCode===optionCode);ensure(option,code,'Accepted option must be offered');
  const arrangement=Object.freeze({optionCode:option.optionCode,kind:option.kind,startsAt:now,endsAt:now+option.durationDays*DAY,accountIds:record.accountIds,disclosureVersion,requiresAdapterExecution:true,syntheticOnly:true});
  return this.#transition(record,expectedVersion,{state:'ACCEPTED',arrangement},'ACCEPTED',now,identity.subject);
 }

 get({identity,caseId,assignments,now}){
  const decision=this.#authorize(identity,this.#contract.actions.request,assignments,now),record=this.#case(identity,caseId);
  ensure(decision&&(record.customer.subject===identity.subject&&record.customer.issuer===identity.issuer),'HARDSHIP_DENIED','Only the case customer can view this case');return record;
 }

 /** Collections must not contact a customer about an account with an unresolved hardship case. */
 collectionsPaused({identity,accountId,assignments,now}){
  this.#authorize(identity,this.#contract.actions.draft,assignments,now);bounded(accountId,'Account ID',code);
  return [...this.#cases.values()].some(record=>record.tenantId===identity.tenantId&&record.accountIds.includes(accountId)&&['OPEN','PROPOSED','OFFERED'].includes(record.state));
 }
}
