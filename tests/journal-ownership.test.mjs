import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryEngineStore} from '../src/runtime/memory-store.mjs';
import {startEngine} from './support/runtime-harness.mjs';

/** Memory store whose close() is a no-op so a second runtime can reuse it like a restarted process. */
const reusable=()=>{const store=new MemoryEngineStore();store.close=async()=>{};return store;};

test('customers see only accounts they hold; staff see tenant accounts',async t=>{
 const engine=await startEngine({store:reusable()});t.after(engine.close);
 const one=await engine.session('tenant_demo_alpha','customer-1'),two=await engine.session('tenant_demo_alpha','customer-2'),operator=await engine.session('tenant_demo_alpha','operator-1');
 assert.deepEqual((await engine.call('GET','/v1/me/accounts',{token:two})).body.accountIds,['checking-2','savings']);
 const home=await engine.call('GET','/v1/home',{token:two});
 assert.deepEqual(home.body.accounts.map(account=>account.accountId),['checking-2','savings']);
 assert.equal((await engine.call('GET','/v1/accounts/checking',{token:two})).status,404);
 assert.equal((await engine.call('GET','/v1/accounts/checking/transactions',{token:two})).status,404);
 assert.equal((await engine.call('GET','/v1/home?accountIds=checking',{token:two})).status,404);
 assert.equal((await engine.call('GET','/v1/accounts/savings',{token:two})).status,200);
 assert.equal((await engine.call('GET','/v1/accounts/checking-2',{token:one})).status,404);
 assert.equal((await engine.call('GET','/v1/accounts/checking-2',{token:operator})).status,200);
 assert.equal((await engine.call('GET','/v1/me/accounts',{token:operator})).body.accountIds,null);
 const chat=await engine.call('POST','/v1/chat',{token:two,body:{question:'What is my balance?'}});
 assert.match(chat.body.answer,/checking-2/);assert.doesNotMatch(chat.body.answer,/checking balance/);
});

test('consents and the audit chain are journaled and survive a restart',async()=>{
 const store=reusable();
 const first=await startEngine({store});
 const customer=await first.session('tenant_demo_alpha','customer-1'),operator=await first.session('tenant_demo_alpha','operator-1');
 const granted=await first.op(customer,'consents.grant',{consentId:'od-fees',scopes:['overdraft:fees'],purpose:'overdraft-coverage',policyVersion:'p1',expiresAt:1_800_000_000_000+86_400_000,requestId:'c-1'});
 assert.equal(granted.status,200);assert.equal(granted.body.version,1);
 assert.equal((await first.op(customer,'consents.grant',{consentId:'od-fees',scopes:['overdraft:fees'],purpose:'overdraft-coverage',policyVersion:'p1',expiresAt:1_800_000_000_000+86_400_000,requestId:'c-1'})).body.sequence,1);
 assert.equal((await first.call('POST','/v1/audit',{token:operator,body:{requestId:'a-1',recordId:'rec-1',eventType:'synthetic.review',outcome:'ok',correlationId:'c',attributes:{channel:'api'},occurredAt:1_800_000_000_000}})).status,201);
 assert.equal((await first.op(operator,'consents.grant',{consentId:'x',scopes:['a'],purpose:'p',policyVersion:'p',expiresAt:1_900_000_000_000,requestId:'r'})).status,403);
 assert.equal((await first.op(customer,'nonexistent.op',{})).status,404);
 assert.equal(first.runtime.journalStatus().sequence,3);
 await first.close();

 const second=await startEngine({store,time:1_800_000_100_000});
 assert.deepEqual({...second.runtime.journalStatus()},{sequence:3,replayErrors:0,fatal:null});
 const customerAgain=await second.session('tenant_demo_alpha','customer-1'),operatorAgain=await second.session('tenant_demo_alpha','operator-1');
 assert.equal((await second.op(customerAgain,'consents.check',{consentId:'od-fees',scope:'overdraft:fees'})).body.permitted,true);
 const records=(await second.call('GET','/v1/audit',{token:operatorAgain})).body.records;
 assert.equal(records.length,1);assert.equal(records[0].sequence,1);
 const next=await second.call('POST','/v1/audit',{token:operatorAgain,body:{requestId:'a-2',recordId:'rec-2',eventType:'synthetic.review',outcome:'ok',correlationId:'c',attributes:{},occurredAt:1_800_000_100_000}});
 assert.equal(next.body.previousHash,records[0].recordHash);
 const revoked=await second.op(customerAgain,'consents.revoke',{consentId:'od-fees',expectedVersion:1,reason:'customer-request',requestId:'c-2'});
 assert.equal(revoked.body.type,'REVOKED');
 const health=await second.call('GET','/health');assert.equal(health.body.journal.sequence,5);
 await second.close();
});

test('a second writer forces a fail-stop instead of divergent state',async()=>{
 const store=reusable(),fatal=[];
 const a=await startEngine({store,onFatal:error=>fatal.push(error.code)});
 const b=await startEngine({store});
 const ca=await a.session('tenant_demo_alpha','customer-1'),cb=await b.session('tenant_demo_alpha','customer-1');
 assert.equal((await b.op(cb,'consents.grant',{consentId:'b',scopes:['s'],purpose:'p',policyVersion:'v',expiresAt:1_900_000_000_000,requestId:'rb'})).status,200);
 const conflicted=await a.op(ca,'consents.grant',{consentId:'a',scopes:['s'],purpose:'p',policyVersion:'v',expiresAt:1_900_000_000_000,requestId:'ra'});
 assert.equal(conflicted.status,503);assert.deepEqual(fatal,['JOURNAL_CONFLICT']);
 assert.equal((await a.call('GET','/health')).status,503);
 assert.equal((await a.op(ca,'consents.check',{consentId:'b',scope:'s'})).status,503);
 await a.close();await b.close();
});
