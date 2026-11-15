import pg from 'pg';
import {EngineError} from '../index.mjs';

const fail=(code,message)=>{throw new EngineError(code,message);};
const IDENT=/^[a-z_][a-z0-9_]{0,62}$/;
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;};
const safeInt=value=>{if(value===null)return null;const number=Number(value);if(!Number.isSafeInteger(number))throw new EngineError('AMOUNT_OVERFLOW','Stored integer exceeds safe bounds');return number;};
const types={getTypeParser:(oid,format)=>oid===20?safeInt:pg.types.getTypeParser(oid,format)};

const UNIQUE_CODES=new Map([
 ['ledger_entries_entry_key_key',['ENTRY_CONFLICT','Synthetic entry ID already exists']],
 ['ledger_requests_pkey',['REQUEST_CONFLICT','A concurrent request used the same request ID']],
 ['outbox_events_pkey',['EVENT_CONFLICT','Event ID already exists']],
 ['outbox_requests_pkey',['REQUEST_CONFLICT','A concurrent request used the same idempotency key']],
 ['evidence_records_pkey',['EVIDENCE_CONFLICT','Evidence ID already exists']],
 ['evidence_requests_pkey',['REQUEST_CONFLICT','A concurrent request used the same request ID']]
]);
const mapError=error=>{
 if(error instanceof EngineError)return error;
 if(error?.code==='23505'&&UNIQUE_CODES.has(error.constraint)){const [code,message]=UNIQUE_CODES.get(error.constraint);return new EngineError(code,message);}
 return error;
};

const accountFromRow=row=>({tenantId:row.tenant_id,accountId:row.account_id,currency:row.currency,balanceMinor:row.balance_minor,balanceAsOf:row.balance_as_of,version:row.version,syntheticOnly:true});
const entryFromRow=row=>({entryKey:row.entry_key,entryId:row.entry_id,tenantId:row.tenant_id,accountId:row.account_id,direction:row.direction,amountMinor:row.amount_minor,currency:row.currency,descriptionCode:row.description_code,postedAt:row.posted_at,actor:{issuer:row.actor_issuer,subject:row.actor_subject},syntheticOnly:true});
const eventFromRow=row=>deepFreeze({...row.envelope,state:row.state,deliveryVersion:row.delivery_version,lease:row.state==='CLAIMED'?{workerId:row.lease_worker,version:row.lease_version,expiresAt:row.lease_expires_at}:null,publishedAt:row.published_at});
const ENVELOPE_KEYS=['eventId','tenantId','type','schemaVersion','aggregateId','occurredAt','payload','producer','syntheticOnly'];
const envelopeOf=event=>Object.fromEntries(ENVELOPE_KEYS.map(key=>[key,event[key]]));

const INSERT_ENTRY='INSERT INTO ledger_entries (entry_key,tenant_id,account_id,entry_id,direction,amount_minor,currency,description_code,posted_at,actor_issuer,actor_subject) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)';
const entryParams=entry=>[entry.entryKey,entry.tenantId,entry.accountId,entry.entryId,entry.direction,entry.amountMinor,entry.currency,entry.descriptionCode,entry.postedAt,entry.actor.issuer,entry.actor.subject];
const INSERT_EVENT='INSERT INTO outbox_events (event_key,tenant_id,event_id,envelope,state,delivery_version) VALUES ($1,$2,$3,$4,$5,$6)';

/** Postgres engine store. Each operation is one database transaction with row locks where state is read-modify-write. */
export class PostgresEngineStore {
 kind='postgres';
 #pool;
 constructor({connectionString,searchPath=null,max=5,ssl}={}){
  if(typeof connectionString!=='string'||!connectionString)fail('INVALID_STORE','A Postgres connection string is required');
  if(searchPath!==null&&!IDENT.test(searchPath))fail('INVALID_STORE','Search path must be a simple identifier');
  this.#pool=new pg.Pool({connectionString,max,types,ssl,idleTimeoutMillis:30_000,connectionTimeoutMillis:10_000,application_name:'prosperity-banking-engine'});
  this.#pool.on('error',()=>{});
  if(searchPath)this.#pool.on('connect',client=>{client.query(`SET search_path TO ${searchPath}`);});
 }

 async #transaction(work){
  const client=await this.#pool.connect();
  try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw mapError(error);}
  finally{client.release();}
 }

 async seed({accounts=[],entries=[],holders=[]}){
  return this.#transaction(async client=>{
   let inserted=0;
   for(const account of accounts){const {rowCount}=await client.query('INSERT INTO ledger_accounts (tenant_id,account_id,currency,balance_minor,balance_as_of,version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[account.tenantId,account.accountId,account.currency,account.balanceMinor,account.balanceAsOf??null,account.version??0]);inserted+=rowCount;}
   for(const entry of entries){const {rowCount}=await client.query(INSERT_ENTRY+' ON CONFLICT (entry_key) DO NOTHING',entryParams(entry));inserted+=rowCount;}
   for(const holder of holders){const {rowCount}=await client.query('INSERT INTO ledger_account_holders (tenant_id,account_id,holder_issuer,holder_subject,relationship) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[holder.tenantId,holder.accountId,holder.issuer,holder.subject,holder.relationship]);inserted+=rowCount;}
   return {inserted};
  });
 }

 async ledgerSnapshot({tenantId,accountIds=null,entryLimit=1000}){
  const accounts=(await this.#pool.query('SELECT * FROM ledger_accounts WHERE tenant_id=$1 AND ($2::text[] IS NULL OR account_id=ANY($2)) ORDER BY account_id',[tenantId,accountIds])).rows.map(accountFromRow);
  if(!accounts.length)return {accounts,entries:[]};
  const entries=(await this.#pool.query('SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY account_id ORDER BY seq DESC) AS recent FROM ledger_entries WHERE tenant_id=$1 AND account_id=ANY($2)) ranked WHERE recent<=$3 ORDER BY seq',[tenantId,accounts.map(account=>account.accountId),entryLimit])).rows.map(entryFromRow);
  return {accounts,entries};
 }

 async ledgerPost({tenantId,accountId,requestKey,compute}){
  return this.#transaction(async client=>{
   const account=(await client.query('SELECT * FROM ledger_accounts WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE',[tenantId,accountId])).rows.map(accountFromRow)[0]??null;
   const stored=(await client.query('SELECT digest,result FROM ledger_requests WHERE request_key=$1',[requestKey])).rows[0];
   const outcome=compute({account,replay:stored?{digest:stored.digest,result:deepFreeze(stored.result)}:null});
   if(outcome.replay)return outcome.replay;
   const {result,digest,event}=outcome;
   await client.query(INSERT_ENTRY,entryParams(result.entry));
   const updated=await client.query('UPDATE ledger_accounts SET balance_minor=$3,balance_as_of=$4,version=$5 WHERE tenant_id=$1 AND account_id=$2 AND version=$6',[tenantId,accountId,result.account.balanceMinor,result.account.balanceAsOf,result.account.version,account.version]);
   if(updated.rowCount!==1)fail('VERSION_CONFLICT','Synthetic account version changed');
   await client.query('INSERT INTO ledger_requests (request_key,tenant_id,digest,result) VALUES ($1,$2,$3,$4)',[requestKey,tenantId,digest,JSON.stringify(result)]);
   const eventKey=`${tenantId}:${event.record.eventId}`;
   await client.query(INSERT_EVENT,[eventKey,tenantId,event.record.eventId,JSON.stringify(envelopeOf(event.record)),event.record.state,event.record.deliveryVersion]);
   await client.query('INSERT INTO outbox_requests (request_key,tenant_id,digest,event_key) VALUES ($1,$2,$3,$4)',[event.requestKey,tenantId,event.digest,eventKey]);
   return deepFreeze(JSON.parse(JSON.stringify(result)));
  });
 }

 async outboxEnqueue({requestKey,eventKey,digest,event}){
  return this.#transaction(async client=>{
   const replay=(await client.query('SELECT r.digest, e.* FROM outbox_requests r JOIN outbox_events e ON e.event_key=r.event_key WHERE r.request_key=$1',[requestKey])).rows[0];
   if(replay){if(replay.digest!==digest)fail('REPLAY_MISMATCH','Outbox request replay has different terms');return eventFromRow(replay);}
   const row=(await client.query(INSERT_EVENT+' RETURNING *',[eventKey,event.tenantId,event.eventId,JSON.stringify(envelopeOf(event)),event.state,event.deliveryVersion])).rows[0];
   await client.query('INSERT INTO outbox_requests (request_key,tenant_id,digest,event_key) VALUES ($1,$2,$3,$4)',[requestKey,event.tenantId,digest,eventKey]);
   return eventFromRow(row);
  });
 }

 async outboxClaim({tenantId,workerId,limit,leaseMs,now}){
  const {rows}=await this.#pool.query(`WITH candidates AS (
    SELECT event_key FROM outbox_events
    WHERE tenant_id=$1 AND (state='PENDING' OR (state='CLAIMED' AND lease_expires_at<=$2))
    ORDER BY seq LIMIT $3 FOR UPDATE SKIP LOCKED)
   UPDATE outbox_events e SET state='CLAIMED',delivery_version=e.delivery_version+1,lease_worker=$4,lease_version=e.delivery_version+1,lease_expires_at=$2::bigint+$5::bigint
   FROM candidates c WHERE e.event_key=c.event_key RETURNING e.*`,[tenantId,now,limit,workerId,leaseMs]);
  return rows.sort((left,right)=>left.seq-right.seq).map(eventFromRow);
 }

 async outboxComplete({tenantId,eventId,workerId,leaseVersion,now}){
  return this.#transaction(async client=>{
   const key=`${tenantId}:${eventId}`,row=(await client.query('SELECT * FROM outbox_events WHERE event_key=$1 FOR UPDATE',[key])).rows[0];
   if(!row)fail('EVENT_NOT_FOUND','Outbox event does not exist');
   if(!(row.state==='CLAIMED'&&row.lease_worker===workerId&&row.lease_version===leaseVersion))fail('LEASE_DENIED','Exact active outbox lease is required');
   if(now>=row.lease_expires_at)fail('LEASE_EXPIRED','Outbox lease expired');
   return eventFromRow((await client.query("UPDATE outbox_events SET state='PUBLISHED',lease_worker=NULL,lease_version=NULL,lease_expires_at=NULL,published_at=$2 WHERE event_key=$1 RETURNING *",[key,now])).rows[0]);
  });
 }

 async outboxList({tenantId,limit}){return (await this.#pool.query('SELECT * FROM outbox_events WHERE tenant_id=$1 ORDER BY seq LIMIT $2',[tenantId,limit])).rows.map(eventFromRow);}

 async vaultStore({requestKey,recordKey,digest,record}){
  return this.#transaction(async client=>{
   const replay=(await client.query('SELECT r.digest, e.record FROM evidence_requests r JOIN evidence_records e ON e.record_key=r.record_key WHERE r.request_key=$1',[requestKey])).rows[0];
   if(replay){if(replay.digest!==digest)fail('REPLAY_MISMATCH','Evidence request replay has different terms');return deepFreeze(replay.record);}
   await client.query('INSERT INTO evidence_records (record_key,tenant_id,evidence_id,record) VALUES ($1,$2,$3,$4)',[recordKey,record.tenantId,record.evidenceId,JSON.stringify(record)]);
   await client.query('INSERT INTO evidence_requests (request_key,tenant_id,digest,record_key) VALUES ($1,$2,$3,$4)',[requestKey,record.tenantId,digest,recordKey]);
   return deepFreeze(JSON.parse(JSON.stringify(record)));
  });
 }

 async vaultGet({tenantId,evidenceId}){const row=(await this.#pool.query('SELECT record FROM evidence_records WHERE record_key=$1',[`${tenantId}:${evidenceId}`])).rows[0];return row?deepFreeze(row.record):null;}
 async vaultList({tenantId,limit}){return (await this.#pool.query('SELECT record FROM evidence_records WHERE tenant_id=$1 ORDER BY seq LIMIT $2',[tenantId,limit])).rows.map(row=>deepFreeze(row.record));}

 async accountsHeldBy({tenantId,issuer,subject}){return (await this.#pool.query('SELECT account_id FROM ledger_account_holders WHERE tenant_id=$1 AND holder_issuer=$2 AND holder_subject=$3 ORDER BY account_id',[tenantId,issuer,subject])).rows.map(row=>row.account_id);}

 async journalAppend({seq,tenantId,op,actor,body,at}){
  try{await this.#pool.query('INSERT INTO module_journal (seq,tenant_id,op,actor,body,at) VALUES ($1,$2,$3,$4,$5,$6)',[seq,tenantId,op,JSON.stringify(actor),JSON.stringify(body),at]);}
  catch(error){if(error?.code==='23505')fail('JOURNAL_CONFLICT','The module journal was advanced by another writer');throw error;}
 }
 async journalLoad(){return (await this.#pool.query('SELECT seq,tenant_id,op,actor,body,at FROM module_journal ORDER BY seq')).rows.map(row=>deepFreeze({seq:row.seq,tenantId:row.tenant_id,op:row.op,actor:row.actor,body:row.body,at:row.at}));}

 async health(){try{await this.#pool.query('SELECT 1');return {ok:true,kind:this.kind};}catch{return {ok:false,kind:this.kind};}}
 async close(){await this.#pool.end();}
}
