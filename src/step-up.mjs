import {createHash} from 'node:crypto';
import {PolicyGateway} from './policy-gateway.mjs';
import {bounded,ensure,requireDecision} from './runtime/guards.mjs';

const code='INVALID_STEP_UP';
const compiledContracts=new WeakSet();
const NON_HUMAN_METHODS=new Set(['workload','agent','service','client-credentials']);
const canonical=value=>{
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){ensure(Number.isSafeInteger(value),code,'Bound terms may contain only safe integers');return String(value);}
 if(Array.isArray(value)){ensure(value.length<=64,code,'Bound term arrays are too large');return `[${value.map(canonical).join(',')}]`;}
 ensure(value&&Object.getPrototypeOf(value)===Object.prototype,code,'Bound terms must be plain JSON');
 const keys=Object.keys(value).sort();ensure(keys.length<=64,code,'Bound terms are too large');
 return `{${keys.map(key=>`${JSON.stringify(bounded(key,'Term key',code))}:${canonical(value[key])}`).join(',')}}`;
};
export const isNonHumanIdentity=identity=>identity.authenticationMethods.some(method=>NON_HUMAN_METHODS.has(method));

export function createStepUpContract({version,actions,actionTypes,challengeTtlMs=300_000}){
 bounded(version,'Step-up version',code);
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,code,'Step-up actions are required');
 const normalizedActions=Object.freeze({request:bounded(actions.request,'Request action',code),approve:bounded(actions.approve,'Approve action',code)});
 ensure(normalizedActions.request!==normalizedActions.approve,code,'Request and approve actions must differ');
 ensure(Array.isArray(actionTypes)&&actionTypes.length>=1&&actionTypes.length<=64,code,'Action types are required');
 const types=Object.create(null);
 for(const type of actionTypes){
  const name=bounded(type?.actionType,'Action type',code);ensure(!types[name],code,'Action types must be unique');
  ensure(typeof type.requiresSecondApprover==='boolean',code,'Second-approver requirement must be explicit');
  ensure(type.maxAmountMinor===null||(Number.isSafeInteger(type.maxAmountMinor)&&type.maxAmountMinor>0),code,'Amount ceiling is invalid');
  types[name]=Object.freeze({actionType:name,requiresSecondApprover:type.requiresSecondApprover,maxAmountMinor:type.maxAmountMinor});
 }
 ensure(Number.isSafeInteger(challengeTtlMs)&&challengeTtlMs>=10_000&&challengeTtlMs<=900_000,code,'Challenge lifetime is invalid');
 const contract=Object.freeze({version,actions:normalizedActions,actionTypes:Object.freeze(types),challengeTtlMs,syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}

/**
 * BNK-019 bound step-up approvals. An approval is bound to a SHA-256 digest of the tenant, initiator, action
 * type and exact canonical terms. It needs a fresh-MFA human approver, a different approver when the action
 * type requires it, and is consumed exactly once before expiry. Any change to the terms invalidates it.
 * Agents and other non-human identities may request but never approve, including their own requests.
 */
export class StepUpApprovals {
 #contract;#gateway;#challenges=new Map();#requests=new Map();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),code,'Compiled step-up contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }

 #digest(tenantId,initiator,actionType,terms){return createHash('sha256').update(canonical({tenantId,initiator,actionType,terms,contractVersion:this.#contract.version})).digest('hex');}
 #challenge(identity,challengeId){bounded(challengeId,'Challenge ID',code);const challenge=this.#challenges.get(`${identity.tenantId}:${challengeId}`);ensure(challenge,'CHALLENGE_NOT_FOUND','Step-up challenge does not exist');return challenge;}
 #save(challenge){this.#challenges.set(`${challenge.tenantId}:${challenge.challengeId}`,challenge);return challenge;}

 request({identity,requestId,challengeId,actionType,terms,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.request,assignments,now},'STEP_UP_DENIED');
  bounded(requestId,'Request ID',code);bounded(challengeId,'Challenge ID',code);
  const type=this.#contract.actionTypes[actionType];ensure(type,'UNKNOWN_STEP_UP_ACTION','Action type is not configured');
  if(type.maxAmountMinor!==null)ensure(Number.isSafeInteger(terms?.amountMinor)&&terms.amountMinor>0&&terms.amountMinor<=type.maxAmountMinor,'STEP_UP_LIMIT','Amount exceeds the step-up ceiling for this action');
  const initiator={issuer:identity.issuer,subject:identity.subject},digest=this.#digest(identity.tenantId,initiator,actionType,terms);
  const requestKey=`${identity.tenantId}:${requestId}`,replay=this.#requests.get(requestKey);
  if(replay){ensure(replay.digest===digest&&replay.challengeId===challengeId,'REPLAY_MISMATCH','Step-up request replay has different terms');return this.#challenges.get(`${identity.tenantId}:${challengeId}`);}
  ensure(!this.#challenges.has(`${identity.tenantId}:${challengeId}`),'CHALLENGE_CONFLICT','Challenge ID already exists');
  const challenge=Object.freeze({tenantId:identity.tenantId,challengeId,actionType,digest,initiator:Object.freeze(initiator),initiatorIsAgent:isNonHumanIdentity(identity),requiresSecondApprover:type.requiresSecondApprover,state:'PENDING',createdAt:now,expiresAt:now+this.#contract.challengeTtlMs,approvedBy:null,approvedAt:null,consumedAt:null,syntheticOnly:true});
  this.#requests.set(requestKey,{digest,challengeId});return this.#save(challenge);
 }

 approve({identity,challengeId,digest,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.approve,assignments,now},'STEP_UP_DENIED');
  ensure(!isNonHumanIdentity(identity),'NON_HUMAN_APPROVER','Agents and service identities cannot approve financial actions');
  const challenge=this.#challenge(identity,challengeId);
  ensure(challenge.state==='PENDING','CHALLENGE_STATE','Challenge is not pending');
  if(now>=challenge.expiresAt){this.#save(Object.freeze({...challenge,state:'EXPIRED'}));ensure(false,'CHALLENGE_EXPIRED','Step-up challenge expired');}
  ensure(digest===challenge.digest,'DIGEST_MISMATCH','Approval must reference the exact bound terms');
  const self=challenge.initiator.issuer===identity.issuer&&challenge.initiator.subject===identity.subject;
  ensure(!(self&&(challenge.requiresSecondApprover||challenge.initiatorIsAgent)),'SEPARATION_OF_DUTIES','This action needs a different human approver');
  return this.#save(Object.freeze({...challenge,state:'APPROVED',approvedBy:Object.freeze({issuer:identity.issuer,subject:identity.subject}),approvedAt:now}));
 }

 /** Called by the executing service immediately before acting. Single use; recomputes the binding. */
 consume({identity,challengeId,actionType,terms,initiator,now}){
  const challenge=this.#challenge(identity,challengeId);
  ensure(challenge.state==='APPROVED','CHALLENGE_STATE','Challenge is not approved or was already used');
  ensure(now<challenge.expiresAt,'CHALLENGE_EXPIRED','Step-up approval expired');
  ensure(this.#digest(identity.tenantId,initiator,actionType,terms)===challenge.digest,'DIGEST_MISMATCH','Action terms differ from the approved terms');
  const consumed=this.#save(Object.freeze({...challenge,state:'CONSUMED',consumedAt:now}));
  return Object.freeze({challengeId,digest:consumed.digest,actionType,approvedBy:consumed.approvedBy,approvedAt:consumed.approvedAt,consumedAt:now,syntheticOnly:true});
 }
}
