import {EngineError} from '../index.mjs';

const fail=(code,message)=>{throw new EngineError(code,message);};
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;};
const fromStore=value=>deepFreeze(clone(value));

/**
 * Process-local engine store. It implements the same atomic operations as the Postgres store so the
 * durable services can be tested without a database. Every operation completes synchronously inside
 * one microtask, which makes each call atomic in a single Node.js process.
 */
export class MemoryEngineStore {
 kind='memory';
 #accounts=new Map();#entries=new Map();#entryKeys=new Set();#ledgerRequests=new Map();
 #events=new Map();#eventRequests=new Map();
 #evidence=new Map();#evidenceRequests=new Map();

 async seed({accounts=[],entries=[]}){
  let inserted=0;
  for(const account of accounts){const key=`${account.tenantId}:${account.accountId}`;if(this.#accounts.has(key))continue;this.#accounts.set(key,clone({...account,version:account.version??0}));this.#entries.set(key,[]);inserted+=1;}
  for(const entry of entries){if(this.#entryKeys.has(entry.entryKey))continue;const key=`${entry.tenantId}:${entry.accountId}`;if(!this.#entries.has(key))fail('INVALID_SEED','Seed entry account is missing');this.#entries.get(key).push(clone(entry));this.#entryKeys.add(entry.entryKey);inserted+=1;}
  return {inserted};
 }

 async ledgerSnapshot({tenantId,accountIds=null,entryLimit=1000}){
  const accounts=[],entries=[];
  for(const [key,account] of this.#accounts){
   if(account.tenantId!==tenantId||(accountIds&&!accountIds.includes(account.accountId)))continue;
   accounts.push(clone(account));entries.push(...this.#entries.get(key).slice(-entryLimit).map(clone));
  }
  return {accounts,entries};
 }

 async ledgerPost({tenantId,accountId,requestKey,compute}){
  const accountKey=`${tenantId}:${accountId}`,stored=this.#ledgerRequests.get(requestKey);
  const outcome=compute({account:clone(this.#accounts.get(accountKey))??null,replay:stored?{digest:stored.digest,result:fromStore(stored.result)}:null});
  if(outcome.replay)return outcome.replay;
  const {result,digest,event}=outcome;
  if(this.#entryKeys.has(result.entry.entryKey))fail('ENTRY_CONFLICT','Synthetic entry ID already exists');
  const eventKey=`${tenantId}:${event.record.eventId}`;
  if(this.#events.has(eventKey)||this.#eventRequests.has(event.requestKey))fail('EVENT_CONFLICT','Ledger event already exists');
  this.#accounts.set(accountKey,clone(result.account));this.#entries.get(accountKey).push(clone(result.entry));this.#entryKeys.add(result.entry.entryKey);
  this.#ledgerRequests.set(requestKey,{digest,result:clone(result)});
  this.#events.set(eventKey,clone(event.record));this.#eventRequests.set(event.requestKey,{digest:event.digest,eventKey});
  return fromStore(result);
 }

 async outboxEnqueue({requestKey,eventKey,digest,event}){
  const replay=this.#eventRequests.get(requestKey);
  if(replay){if(replay.digest!==digest)fail('REPLAY_MISMATCH','Outbox request replay has different terms');return fromStore(this.#events.get(replay.eventKey));}
  if(this.#events.has(eventKey))fail('EVENT_CONFLICT','Event ID already exists');
  this.#events.set(eventKey,clone(event));this.#eventRequests.set(requestKey,{digest,eventKey});return fromStore(event);
 }

 async outboxClaim({tenantId,workerId,limit,leaseMs,now}){
  const claimed=[];
  for(const [key,event] of this.#events){
   if(claimed.length===limit)break;
   if(event.tenantId!==tenantId||event.state==='PUBLISHED'||(event.state==='CLAIMED'&&event.lease.expiresAt>now))continue;
   const next={...event,state:'CLAIMED',deliveryVersion:event.deliveryVersion+1,lease:{workerId,version:event.deliveryVersion+1,expiresAt:now+leaseMs}};
   this.#events.set(key,next);claimed.push(fromStore(next));
  }
  return claimed;
 }

 async outboxComplete({tenantId,eventId,workerId,leaseVersion,now}){
  const key=`${tenantId}:${eventId}`,event=this.#events.get(key);
  if(!event)fail('EVENT_NOT_FOUND','Outbox event does not exist');
  if(!(event.state==='CLAIMED'&&event.lease.workerId===workerId&&event.lease.version===leaseVersion))fail('LEASE_DENIED','Exact active outbox lease is required');
  if(now>=event.lease.expiresAt)fail('LEASE_EXPIRED','Outbox lease expired');
  const published={...event,state:'PUBLISHED',lease:null,publishedAt:now};this.#events.set(key,published);return fromStore(published);
 }

 async outboxList({tenantId,limit}){return [...this.#events.values()].filter(event=>event.tenantId===tenantId).slice(0,limit).map(fromStore);}

 async vaultStore({requestKey,recordKey,digest,record}){
  const replay=this.#evidenceRequests.get(requestKey);
  if(replay){if(replay.digest!==digest)fail('REPLAY_MISMATCH','Evidence request replay has different terms');return fromStore(this.#evidence.get(replay.recordKey));}
  if(this.#evidence.has(recordKey))fail('EVIDENCE_CONFLICT','Evidence ID already exists');
  this.#evidence.set(recordKey,clone(record));this.#evidenceRequests.set(requestKey,{digest,recordKey});return fromStore(record);
 }

 async vaultGet({tenantId,evidenceId}){const record=this.#evidence.get(`${tenantId}:${evidenceId}`);return record?fromStore(record):null;}
 async vaultList({tenantId,limit}){return [...this.#evidence.values()].filter(record=>record.tenantId===tenantId).slice(0,limit).map(fromStore);}

 async health(){return {ok:true,kind:this.kind};}
 async close(){}
}
