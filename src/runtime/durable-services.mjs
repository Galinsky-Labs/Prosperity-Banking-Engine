import {createHash} from 'node:crypto';
import {FakeBankLedger} from '../bank-adapter.mjs';
import {EventOutbox} from '../event-outbox.mjs';
import {TenantEvidenceVault} from '../evidence-vault.mjs';
import {PolicyGateway} from '../policy-gateway.mjs';
import {activeIdentity,bounded,ensure,requireDecision} from './guards.mjs';

const shortHash=value=>createHash('sha256').update(value).digest('hex').slice(0,40);
const requireStore=(store,methods)=>ensure(store&&methods.every(method=>typeof store[method]==='function'),'INVALID_STORE','A complete engine store is required');
const eventDigest=(identity,schema,event)=>JSON.stringify([identity.issuer,identity.subject,schema.type,schema.version,event.eventId,event.aggregateId,event.occurredAt,event.payload]);

/**
 * Store-backed synthetic ledger. Every write loads the account under the store's lock, re-runs the
 * unchanged BNK-008 domain checks on that snapshot, then persists the entry, account version and a
 * transactional outbox event atomically. Reads build a tenant snapshot for the existing read services.
 */
export class DurableLedger {
 #contract;#gateway;#store;#eventSchema;
 constructor({contract,gateway,store,eventSchema}){
  ensure(gateway instanceof PolicyGateway,'INVALID_ADAPTER','Policy gateway is required');
  requireStore(store,['ledgerSnapshot','ledgerPost']);
  ensure(eventSchema?.type&&eventSchema?.version,'INVALID_EVENT_SCHEMA','Ledger event schema is required');
  this.#contract=contract;this.#gateway=gateway;this.#store=store;this.#eventSchema=eventSchema;
  new FakeBankLedger({contract,gateway});
 }

 get contract(){return this.#contract;}

 /** Build an in-memory FakeBankLedger snapshot of one tenant's accounts for the read services. */
 async snapshot({identity,accountIds=null,now}){
  activeIdentity(identity,now);
  if(accountIds!==null){ensure(Array.isArray(accountIds)&&accountIds.length>=1&&accountIds.length<=100,'INVALID_ACCOUNT','Bounded account IDs are required');accountIds.forEach(id=>bounded(id,'Account ID','INVALID_ACCOUNT'));}
  const {accounts,entries}=await this.#store.ledgerSnapshot({tenantId:identity.tenantId,accountIds,entryLimit:1000});
  return new FakeBankLedger({contract:this.#contract,gateway:this.#gateway,accounts,entries});
 }

 async readAccount({identity,accountId,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'ADAPTER_DENIED');
  bounded(accountId,'Account ID','INVALID_ADAPTER');
  return (await this.snapshot({identity,accountIds:[accountId],now})).readAccount({identity,accountId,assignments,now});
 }

 async listEntries({identity,accountId,assignments,limit=1000,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'ADAPTER_DENIED');
  bounded(accountId,'Account ID','INVALID_ADAPTER');
  return (await this.snapshot({identity,accountIds:[accountId],now})).listEntries({identity,accountId,assignments,limit,now});
 }

 async postEntry(command){
  const {identity,requestId,entryId,accountId,direction,amountMinor,currency,expectedVersion,descriptionCode,assignments,now}=command??{};
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.post,assignments,now},'ADAPTER_DENIED');
  bounded(requestId,'Request ID','INVALID_ADAPTER');bounded(accountId,'Account ID','INVALID_ADAPTER');bounded(entryId,'Entry ID','INVALID_ADAPTER');
  const requestKey=`${identity.tenantId}:${this.#contract.adapterId}:${requestId}`;
  const digest=JSON.stringify([identity.issuer,identity.subject,this.#contract.version,entryId,accountId,direction,amountMinor,currency,expectedVersion,descriptionCode]);
  return this.#store.ledgerPost({tenantId:identity.tenantId,accountId,requestKey,compute:({account,replay})=>{
   if(replay){ensure(replay.digest===digest,'REPLAY_MISMATCH','Adapter request replay has different terms');return {replay:replay.result};}
   const ledger=new FakeBankLedger({contract:this.#contract,gateway:this.#gateway,accounts:account?[account]:[]});
   const result=ledger.postEntry({identity,requestId,entryId,accountId,direction,amountMinor,currency,expectedVersion,descriptionCode,assignments,now});
   const record=new EventOutbox().enqueue(identity,this.#eventSchema,{eventId:`ledger-entry-${shortHash(result.entry.entryKey)}`,aggregateId:accountId,payload:{entryId,accountId,direction,amountMinor,currency,accountVersion:result.account.version},idempotencyKey:`ledger-request-${shortHash(requestKey)}`,occurredAt:now,now});
   return {result,digest,event:{record,requestKey:`${identity.tenantId}:ledger-request-${shortHash(requestKey)}`,digest:eventDigest(identity,this.#eventSchema,record)}};
  }});
 }
}

/** Store-backed BNK-007 outbox: domain validation per command, durable idempotency and leases in the store. */
export class DurableEventOutbox {
 #store;
 constructor({store}){requireStore(store,['outboxEnqueue','outboxClaim','outboxComplete','outboxList']);this.#store=store;}

 async enqueue(identity,schema,command){
  const event=new EventOutbox().enqueue(identity,schema,command);
  return this.#store.outboxEnqueue({requestKey:`${identity.tenantId}:${command.idempotencyKey}`,eventKey:`${identity.tenantId}:${event.eventId}`,digest:eventDigest(identity,schema,event),event});
 }

 async claim(identity,{workerId,limit=10,leaseMs=30_000,now}){
  activeIdentity(identity,now);bounded(workerId,'Worker ID','INVALID_EVENT');
  ensure(Number.isInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(leaseMs)&&leaseMs>=1&&leaseMs<=300_000,'INVALID_LEASE','Outbox lease parameters are invalid');
  return this.#store.outboxClaim({tenantId:identity.tenantId,workerId,limit,leaseMs,now});
 }

 async complete(identity,{eventId,workerId,leaseVersion,now}){
  activeIdentity(identity,now);bounded(eventId,'Event ID','INVALID_EVENT');bounded(workerId,'Worker ID','INVALID_EVENT');
  ensure(Number.isSafeInteger(leaseVersion)&&leaseVersion>=1,'INVALID_LEASE','Outbox completion parameters are invalid');
  return this.#store.outboxComplete({tenantId:identity.tenantId,eventId,workerId,leaseVersion,now});
 }

 async list(identity,{limit=100,now}){
  activeIdentity(identity,now);ensure(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_EVENT','List limit must be between 1 and 100');
  return this.#store.outboxList({tenantId:identity.tenantId,limit});
 }
}

/** Store-backed BNK-009 metadata vault: exact policy and domain validation before durable idempotent storage. */
export class DurableEvidenceVault {
 #contract;#gateway;#store;
 constructor({contract,gateway,store}){
  requireStore(store,['vaultStore','vaultGet','vaultList']);
  new TenantEvidenceVault({contract,gateway});
  this.#contract=contract;this.#gateway=gateway;this.#store=store;
 }

 async store(request){
  const record=new TenantEvidenceVault({contract:this.#contract,gateway:this.#gateway}).store(request);
  const {identity,requestId,evidenceId,category,contentDigest,keyReference,mediaType,sizeBytes,capturedAt,source}=request;
  const digest=JSON.stringify([identity.issuer,identity.subject,this.#contract.version,evidenceId,category,contentDigest,keyReference,mediaType,sizeBytes,capturedAt,source]);
  return this.#store.vaultStore({requestKey:`${identity.tenantId}:${requestId}`,recordKey:`${identity.tenantId}:${evidenceId}`,digest,record});
 }

 async get({identity,evidenceId,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'EVIDENCE_DENIED');bounded(evidenceId,'Evidence ID','INVALID_EVIDENCE');
  const record=await this.#store.vaultGet({tenantId:identity.tenantId,evidenceId});ensure(record,'EVIDENCE_NOT_FOUND','Evidence does not exist');return record;
 }

 async list({identity,assignments,limit=100,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'EVIDENCE_DENIED');
  ensure(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_EVIDENCE','List limit must be between 1 and 100');
  return this.#store.vaultList({tenantId:identity.tenantId,limit});
 }
}
