import {EngineError} from '../index.mjs';
import {authenticateIdentity} from '../identity.mjs';
import {bounded,ensure} from './guards.mjs';

const actorOf=identity=>({tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,authenticatedAt:identity.authenticatedAt,expiresAt:identity.expiresAt,authenticationMethods:[...identity.authenticationMethods]});

/**
 * Durable command journal for the in-memory engine modules (BNK-014 onward, the audit chain and consents).
 *
 * Each write operation is split into an async `prepare` (reads the store, resolves server-side evidence) and a
 * synchronous, deterministic `apply` against the domain modules. After a successful apply the resolved command
 * is appended with the next global sequence number. On start-up the journal is replayed through `apply` with the
 * recorded verified actor and time, rebuilding identical module state.
 *
 * Single writer: a sequence conflict means another process appended first, so this process fails stop and is
 * restarted to rebuild from the journal. A failed append also fails stop, because memory would be ahead of storage.
 */
export class CommandJournal {
 #store;#operations;#contextFor;#onFatal;#seq=0;#fatal=null;#replayErrors=[];#pending=new Set();
 constructor({store,operations,contextFor,onFatal}){
  ensure(store&&typeof store.journalAppend==='function'&&typeof store.journalLoad==='function',"INVALID_JOURNAL",'A store with journal support is required');
  ensure(typeof contextFor==='function'&&typeof onFatal==='function',"INVALID_JOURNAL",'Context and fatal handlers are required');
  this.#store=store;this.#operations=operations;this.#contextFor=contextFor;this.#onFatal=onFatal;
 }

 get status(){return Object.freeze({sequence:this.#seq,replayErrors:this.#replayErrors.length,fatal:this.#fatal?this.#fatal.code??'JOURNAL_FATAL':null});}

 async replay(){
  const entries=await this.#store.journalLoad();
  for(const entry of entries){
   ensure(entry.seq===this.#seq+1,'JOURNAL_GAP','Journal sequence has a gap');this.#seq=entry.seq;
   const operation=this.#operations[entry.op];
   try{
    ensure(operation?.write===true,'JOURNAL_UNKNOWN_OP','Journal references an unknown write operation');
    const identity=await authenticateIdentity({credential:'journal-replay',now:entry.at},async()=>({verified:true,...entry.actor}));
    operation.apply(this.#contextFor(identity,entry.at),entry.body);
   }catch(error){this.#replayErrors.push({seq:entry.seq,op:entry.op,code:error?.code??'REPLAY_ERROR'});}
  }
  return this.status;
 }

 async execute(opName,identity,body,now){
  if(this.#fatal)throw new EngineError('ENGINE_UNAVAILABLE','The engine is restarting to recover durable state');
  bounded(opName,'Operation',"UNKNOWN_OPERATION");
  const operation=Object.hasOwn(this.#operations,opName)?this.#operations[opName]:null;
  ensure(operation,'UNKNOWN_OPERATION','Operation does not exist');
  ensure(body&&typeof body==='object'&&!Array.isArray(body),'INVALID_REQUEST','Operation body must be an object');
  const context=this.#contextFor(identity,now);
  const resolved=operation.prepare?await operation.prepare(context,body):body;
  if(!operation.write)return await operation.apply(context,resolved);
  if(this.#fatal)throw new EngineError('ENGINE_UNAVAILABLE','The engine is restarting to recover durable state');
  const result=operation.apply(context,resolved);
  ensure(typeof result?.then!=='function','INVALID_OPERATION','Write operations must apply synchronously');
  if(operation.journal===false||(operation.journalIf&&!operation.journalIf(result)))return result;
  this.#seq+=1;
  const append=this.#store.journalAppend({seq:this.#seq,tenantId:identity.tenantId,op:opName,actor:actorOf(identity),body:JSON.parse(JSON.stringify(resolved)),at:now});
  this.#pending.add(append);
  try{await append;}
  catch(error){this.#fatal=error instanceof EngineError?error:new EngineError('JOURNAL_FATAL','Journal append failed');this.#onFatal(this.#fatal);throw new EngineError('ENGINE_UNAVAILABLE','The change could not be made durable; the engine is restarting');}
  finally{this.#pending.delete(append);}
  return result;
 }

 async drain(){await Promise.allSettled([...this.#pending]);}
}
