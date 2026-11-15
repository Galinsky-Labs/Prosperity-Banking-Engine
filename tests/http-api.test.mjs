import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngineServer} from '../src/http/server.mjs';
import {createEngineRuntime} from '../src/runtime/engine-runtime.mjs';
import {MemoryEngineStore} from '../src/runtime/memory-store.mjs';
import {createSyntheticDirectory} from '../src/synthetic/directory.mjs';
import {createSyntheticSessionIssuer} from '../src/synthetic/session-tokens.mjs';
import {main} from '../bin/start.mjs';

const SECRET='test-secret-'.padEnd(40,'x');
const quiet={info(){},error(){}};

async function startEngine({rateLimit}={}){
 let time=1_800_000_000_000;
 const clock=()=>time;
 const runtime=await createEngineRuntime({store:new MemoryEngineStore(),sessionSecret:SECRET,clock});
 const server=createEngineServer({runtime,version:'test',logger:quiet,rateLimit});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(method,path,{token,body,headers={}}={})=>{
  const response=await fetch(base+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,headers:response.headers,body:text?JSON.parse(text):null};
 };
 const session=async(tenantId,subject)=>(await call('POST','/v1/synthetic/sessions',{body:{tenantId,subject}})).body.token;
 return {server,call,session,advance:ms=>{time+=ms;},close:()=>new Promise(resolve=>server.close(resolve))};
}

test('health and banner are public and clearly non-production synthetic',async t=>{
 const engine=await startEngine();t.after(engine.close);
 const health=await engine.call('GET','/health');
 assert.equal(health.status,200);assert.equal(health.body.status,'ok');assert.equal(health.body.dataMode,'synthetic');assert.equal(health.body.nonProduction,true);assert.equal(health.body.storage.kind,'memory');
 assert.equal(health.headers.get('x-data-mode'),'synthetic');assert.equal(health.headers.get('cache-control'),'no-store');
 const banner=await engine.call('GET','/');
 assert.match(banner.body.notice,/Non-production/);assert.match(banner.body.notice,/not a bank-branded application/);
 const directory=await engine.call('GET','/v1/synthetic/directory');
 assert.deepEqual(directory.body.tenants.map(tenant=>tenant.tenantId),['tenant_demo_alpha','tenant_demo_beta']);
});

test('requires a verifier-issued synthetic session and rejects forged tokens',async t=>{
 const engine=await startEngine();t.after(engine.close);
 assert.equal((await engine.call('GET','/v1/me')).status,401);
 const token=await engine.session('tenant_demo_alpha','customer-1');
 const [prefix,body,signature]=token.split('.');
 const forgedBody=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body,'base64url')),tid:'tenant_demo_beta'})).toString('base64url');
 assert.equal((await engine.call('GET','/v1/me',{token:`${prefix}.${forgedBody}.${signature}`})).status,401);
 assert.equal((await engine.call('POST','/v1/synthetic/sessions',{body:{tenantId:'tenant_demo_alpha',subject:'nobody'}})).status,404);
 const me=await engine.call('GET','/v1/me',{token});
 assert.equal(me.status,200);assert.equal(me.body.tenantId,'tenant_demo_alpha');assert.deepEqual(me.body.roles,['customer']);
 engine.advance(16*60_000);
 assert.equal((await engine.call('GET','/v1/me',{token})).status,401);
});

test('customer reads home, normalized transactions and a bounded forecast',async t=>{
 const engine=await startEngine();t.after(engine.close);
 const token=await engine.session('tenant_demo_alpha','customer-1');
 const home=await engine.call('GET','/v1/home',{token});
 assert.equal(home.status,200);assert.equal(home.body.totalsByCurrency.USD,1_575_000);assert.deepEqual({...home.body.freshnessCounts},{fresh:1,stale:1,unknown:0});assert.equal(home.body.syntheticOnly,true);
 const transactions=await engine.call('GET','/v1/accounts/checking/transactions?limit=500',{token});
 assert.equal(transactions.status,200);assert.ok(transactions.body.transactions.length>10);
 assert.ok(transactions.body.transactions.every(item=>item.status==='posted'&&Number.isSafeInteger(item.signedAmountMinor)));
 const forecast=await engine.call('POST','/v1/accounts/checking/forecast',{token,body:{currency:'USD',horizonDays:7,lookbackDays:30}});
 assert.equal(forecast.status,200);assert.equal(forecast.body.buckets.length,7);assert.equal(forecast.body.methodology,'truncated-daily-history-plus-explicit-schedule');
 assert.equal((await engine.call('GET','/v1/accounts/missing',{token})).status,404);
 assert.equal((await engine.call('GET','/v1/audit',{token})).status,403);
});

test('only a fresh-MFA synthetic operator can post, with exact replay and an outbox event',async t=>{
 const engine=await startEngine();t.after(engine.close);
 const customer=await engine.session('tenant_demo_alpha','customer-1'),operator=await engine.session('tenant_demo_alpha','operator-1');
 const entry={requestId:'req-1',entryId:'entry-1',direction:'debit',amountMinor:1_250,currency:'USD',expectedVersion:0,descriptionCode:'synthetic-coffee'};
 assert.equal((await engine.call('POST','/v1/accounts/checking/entries',{token:customer,body:entry})).status,403);
 const posted=await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:entry});
 assert.equal(posted.status,201);assert.equal(posted.body.account.balanceMinor,323_750);assert.equal(posted.body.account.version,1);
 assert.deepEqual((await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:entry})).body,posted.body);
 const mismatch=await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:{...entry,amountMinor:1}});
 assert.equal(mismatch.status,409);assert.equal(mismatch.body.error.code,'REPLAY_MISMATCH');
 assert.equal((await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:{...entry,requestId:'req-2',entryId:'entry-2',expectedVersion:1,amountMinor:999_999_999}})).body.error.code,'INSUFFICIENT_FUNDS');
 const events=await engine.call('GET','/v1/outbox/events',{token:operator});
 assert.equal(events.body.events.length,1);assert.equal(events.body.events[0].type,'ledger.entry.posted');
 const beta=await engine.session('tenant_demo_beta','operator-1');
 assert.equal((await engine.call('GET','/v1/accounts/checking',{token:beta})).body.balanceMinor,650_000);
 assert.equal((await engine.call('GET','/v1/outbox/events',{token:beta})).body.events.length,0);
 engine.advance(6*60_000);
 assert.equal((await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:{...entry,requestId:'req-3',entryId:'entry-3',expectedVersion:1}})).status,403);
});

test('outbox claim and completion, evidence metadata and audit are tenant-scoped',async t=>{
 const engine=await startEngine();t.after(engine.close);
 const operator=await engine.session('tenant_demo_alpha','operator-1');
 assert.equal((await engine.call('POST','/v1/outbox/notes',{token:operator,body:{eventId:'note-1',aggregateId:'agg-1',noteCode:'hello',idempotencyKey:'idem-1'}})).status,201);
 const claimed=await engine.call('POST','/v1/outbox/claims',{token:operator,body:{workerId:'worker-1',limit:5,leaseMs:10_000}});
 assert.equal(claimed.body.events.length,1);
 const done=await engine.call('POST','/v1/outbox/events/note-1/complete',{token:operator,body:{workerId:'worker-1',leaseVersion:1}});
 assert.equal(done.status,200);assert.equal(done.body.state,'PUBLISHED');
 const evidence={requestId:'ev-req',evidenceId:'ev-1',category:'customer_document',contentDigest:'b'.repeat(64),keyReference:'object/ev-1',mediaType:'application/pdf',sizeBytes:10,capturedAt:1_800_000_000_000-1,source:'synthetic-upload'};
 assert.equal((await engine.call('POST','/v1/evidence',{token:operator,body:{...evidence,content:'raw bytes'}})).status,422);
 const stored=await engine.call('POST','/v1/evidence',{token:operator,body:evidence});
 assert.equal(stored.status,201);assert.equal(stored.body.classification,'RESTRICTED');
 assert.equal((await engine.call('GET','/v1/evidence/ev-1',{token:operator})).body.evidenceId,'ev-1');
 const beta=await engine.session('tenant_demo_beta','operator-1');
 assert.equal((await engine.call('GET','/v1/evidence/ev-1',{token:beta})).status,404);
 const audit=await engine.call('POST','/v1/audit',{token:operator,body:{requestId:'audit-req',recordId:'audit-1',eventType:'synthetic.review',outcome:'recorded',correlationId:'corr-1',attributes:{channel:'api'},occurredAt:1_800_000_000_000}});
 assert.equal(audit.status,201);assert.equal(audit.body.sequence,1);
 assert.equal((await engine.call('POST','/v1/audit',{token:operator,body:{requestId:'audit-req-2',recordId:'audit-2',eventType:'synthetic.review',outcome:'recorded',correlationId:'corr-2',attributes:{customerEmail:'x'},occurredAt:1_800_000_000_000}})).status,422);
 assert.equal((await engine.call('GET','/v1/audit',{token:operator})).body.records.length,1);
});

test('fails closed on malformed transport input and rate limits clients',async t=>{
 const engine=await startEngine({rateLimit:{limit:8,windowMs:60_000}});t.after(engine.close);
 assert.equal((await engine.call('GET','/nope')).status,404);
 assert.equal((await engine.call('DELETE','/health')).status,405);
 assert.equal((await engine.call('POST','/v1/synthetic/sessions',{body:'{"tenantId":',headers:{'content-type':'application/json'}})).status,400);
 assert.equal((await engine.call('POST','/v1/synthetic/sessions',{body:'x',headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await engine.call('POST','/v1/synthetic/sessions',{body:JSON.stringify({pad:'x'.repeat(70_000)})})).status,413);
 assert.equal((await engine.call('GET','/v1/me',{headers:{authorization:'Basic abc'}})).status,401);
 let last;for(let index=0;index<5;index+=1)last=await engine.call('GET','/health');
 assert.equal(last.status,429);
});

test('refuses to start outside synthetic data mode',async()=>{
 await assert.rejects(createEngineRuntime({store:new MemoryEngineStore(),sessionSecret:SECRET,dataMode:'live'}),{code:'DATA_MODE_DENIED'});
 const lines=[];const original=console.log;console.log=line=>lines.push(line);
 try{assert.equal(await main({DATA_MODE:'production'}),null);}finally{console.log=original;process.exitCode=0;}
 assert.match(lines.join('\n'),/Refusing to start: DATA_MODE must be/);
 assert.throws(()=>createSyntheticSessionIssuer({secret:'short',directory:createSyntheticDirectory()}),{code:'INVALID_SESSION_SECRET'});
});

test('banker chat is grounded in synthetic engine data and labelled simulated without a key',async t=>{
 const engine=await startEngine();t.after(engine.close);
 assert.equal((await engine.call('GET','/health')).body.chat.kind,'simulated');
 const token=await engine.session('tenant_demo_alpha','customer-1');
 const reply=await engine.call('POST','/v1/chat',{token,body:{question:'What is my balance?'}});
 assert.equal(reply.status,200);assert.equal(reply.body.responder.kind,'simulated');assert.match(reply.body.answer,/USD 3250\.00/);
 assert.equal((await engine.call('POST','/v1/chat',{token,body:{question:'Send USD 100 to my brother'}})).body.handoff.reason,'ACTION_REQUEST');
 const operator=await engine.session('tenant_demo_alpha','operator-1');
 assert.equal((await engine.call('POST','/v1/chat',{token:operator,body:{question:'balance?'}})).status,403);
});
