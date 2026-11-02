import {createHash} from 'node:crypto';
import {EngineError} from './index.mjs';
import {authorizeDataUse} from './data-classification.mjs';
import {assertVerifiedIdentity} from './identity.mjs';
import {PolicyGateway} from './policy-gateway.mjs';

const ensure=(condition,code,message)=>{if(!condition)throw new EngineError(code,message);};
const ID=/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const SENSITIVE=/(?:body|content|credential|customer|document|email|message|password|payload|phone|prompt|secret|stack|token)/i;
const compiledContracts=new WeakSet();
const bounded=(value,label)=>{ensure(typeof value==='string'&&ID.test(value),'INVALID_AUDIT_RECORD',`${label} is required`);return value;};
const activeIdentity=(identity,now)=>{assertVerifiedIdentity(identity);ensure(Number.isSafeInteger(now)&&now>=identity.authenticatedAt&&identity.expiresAt>now,'IDENTITY_EXPIRED','Active verified identity is required');};
const hash=value=>createHash('sha256').update(value).digest('hex');

function normalizeAttributes(attributes,allowed){
 ensure(attributes&&Object.getPrototypeOf(attributes)===Object.prototype,'INVALID_AUDIT_RECORD','Audit attributes must be a plain object');
 const keys=Object.keys(attributes).sort();ensure(keys.length<=32,'INVALID_AUDIT_RECORD','Audit attributes exceed the configured bound');
 const normalized=Object.create(null);
 for(const key of keys){
  ensure(!SENSITIVE.test(key),'SENSITIVE_AUDIT_DATA','Sensitive audit fields are prohibited');
  ensure(allowed.includes(key),'INVALID_AUDIT_RECORD','Audit attribute is not allowlisted');
  const value=attributes[key];
  ensure(typeof value==='boolean'||Number.isSafeInteger(value)||(typeof value==='string'&&ID.test(value)),'INVALID_AUDIT_RECORD','Audit attribute values must be bounded scalars');
  normalized[key]=value;
 }
 return Object.freeze(normalized);
}

export function createAuditSinkContract({version,actions,attributeKeys=[]}){
 bounded(version,'Audit contract version');
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,'INVALID_AUDIT_CONTRACT','Audit actions are required');
 const normalizedActions=Object.freeze({read:bounded(actions.read,'Read action'),write:bounded(actions.write,'Write action')});
 ensure(normalizedActions.read!==normalizedActions.write,'INVALID_AUDIT_CONTRACT','Read and write actions must differ');
 ensure(Array.isArray(attributeKeys)&&attributeKeys.length<=32,'INVALID_AUDIT_CONTRACT','Audit attribute allowlist is invalid');
 const allowed=[...new Set(attributeKeys.map(key=>bounded(key,'Audit attribute')))];
 ensure(allowed.length===attributeKeys.length&&allowed.every(key=>!SENSITIVE.test(key)),'INVALID_AUDIT_CONTRACT','Audit attribute keys must be unique and non-sensitive');
 const contract=Object.freeze({version,actions:normalizedActions,attributeKeys:Object.freeze(allowed.sort()),category:'operational_metadata',syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}

export class TenantAuditSink {
 #contract;#gateway;#records=new Map();#requests=new Map();#heads=new Map();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),'INVALID_AUDIT_CONTRACT','Compiled audit sink contract is required');
  ensure(gateway instanceof PolicyGateway,'INVALID_AUDIT_CONTRACT','Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }

 #authorize(identity,action,{assignments,now}){
  activeIdentity(identity,now);
  const decision=PolicyGateway.prototype.decide.call(this.#gateway,{identity,action,resourceTenantId:identity.tenantId,assignments,now});
  ensure(decision?.allow===true&&decision.action===action&&decision.tenantId===identity.tenantId&&decision.subject===identity.subject,'AUDIT_DENIED','Exact policy authorization is required');
 }

 append(request){
  const {identity,requestId,recordId,eventType,outcome,correlationId,attributes,occurredAt,assignments,now=Date.now()}=request??{};
  this.#authorize(identity,this.#contract.actions.write,{assignments,now});
  for(const key of Object.keys(request??{}))ensure(!SENSITIVE.test(key),'SENSITIVE_AUDIT_DATA','Sensitive audit fields are prohibited');
  bounded(requestId,'Request ID');bounded(recordId,'Record ID');bounded(eventType,'Event type');bounded(outcome,'Outcome');bounded(correlationId,'Correlation ID');
  ensure(Number.isSafeInteger(occurredAt)&&occurredAt>=0&&occurredAt<=now,'INVALID_AUDIT_RECORD','Occurred time must be a nonnegative time no later than now');
  authorizeDataUse({category:this.#contract.category,tenantId:identity.tenantId,operation:'log'});
  const normalized=normalizeAttributes(attributes,this.#contract.attributeKeys);
  const requestKey=`${identity.tenantId}:${requestId}`,recordKey=`${identity.tenantId}:${recordId}`;
  const digest=JSON.stringify([identity.issuer,identity.subject,this.#contract.version,recordId,eventType,outcome,correlationId,occurredAt,normalized]);
  const replay=this.#requests.get(requestKey);if(replay){ensure(replay.digest===digest,'REPLAY_MISMATCH','Audit request replay has different terms');return this.#records.get(replay.recordKey);}
  ensure(!this.#records.has(recordKey),'AUDIT_CONFLICT','Audit record ID already exists');
  const head=this.#heads.get(identity.tenantId)??{sequence:0,recordHash:null};
  const sequence=head.sequence+1,previousHash=head.recordHash;
  const recordHash=hash(JSON.stringify([identity.tenantId,sequence,previousHash,this.#contract.version,recordId,eventType,outcome,correlationId,occurredAt,normalized,identity.issuer,identity.subject]));
  const record=Object.freeze({recordId,tenantId:identity.tenantId,sequence,previousHash,recordHash,eventType,outcome,correlationId,occurredAt,recordedAt:now,attributes:normalized,producer:Object.freeze({issuer:identity.issuer,subject:identity.subject}),contractVersion:this.#contract.version,syntheticOnly:true});
  this.#records.set(recordKey,record);this.#requests.set(requestKey,{digest,recordKey});this.#heads.set(identity.tenantId,{sequence,recordHash});return record;
 }

 list({identity,assignments,eventType=null,afterSequence=0,limit=100,now=Date.now()}){
  this.#authorize(identity,this.#contract.actions.read,{assignments,now});
  ensure(eventType===null||(typeof eventType==='string'&&ID.test(eventType)),'INVALID_AUDIT_QUERY','Event type filter is invalid');
  ensure(Number.isSafeInteger(afterSequence)&&afterSequence>=0&&Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_AUDIT_QUERY','Audit query bounds are invalid');
  return Object.freeze([...this.#records.values()].filter(record=>record.tenantId===identity.tenantId&&record.sequence>afterSequence&&(eventType===null||record.eventType===eventType)).slice(0,limit));
 }
}
