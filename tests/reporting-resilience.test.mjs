import test from 'node:test';
import assert from 'node:assert/strict';
import {REPORT_WATERMARK,generateSyntheticReport,renderReportCsv} from '../src/regulatory-reporting.mjs';
import {MemoryEngineStore} from '../src/runtime/memory-store.mjs';
import {createFaultInjectingStore} from '../src/runtime/fault-injection.mjs';
import {startEngine} from './support/runtime-harness.mjs';

const T0=1_800_000_000_000;

test('synthetic reports reconcile, are checksummed, watermarked and never filed',()=>{
 const report=generateSyntheticReport({kind:'deposit-balances',tenantId:'tenant_demo_alpha',periodStart:0,periodEnd:10,generatedAt:11,data:{accounts:[{accountId:'checking',balanceMinor:100},{accountId:'checking-2',balanceMinor:50},{accountId:'savings',balanceMinor:7}]}});
 assert.deepEqual(report.rows.map(row=>[row.accountType,row.accounts,row.balanceMinor]),[['checking',2,150],['savings',1,7]]);
 assert.equal(report.totals.balanceMinor,157);assert.equal(report.filingStatus,'not-filed');assert.equal(report.header.watermark,REPORT_WATERMARK);
 assert.equal(generateSyntheticReport({kind:'deposit-balances',tenantId:'tenant_demo_alpha',periodStart:0,periodEnd:10,generatedAt:99,data:{accounts:[{accountId:'savings',balanceMinor:7},{accountId:'checking',balanceMinor:100},{accountId:'checking-2',balanceMinor:50}]}}).checksum,report.checksum);
 const csv=renderReportCsv(report);assert.match(csv.split('\n')[0],/NOT FOR REGULATORY FILING/);
 const fees=generateSyntheticReport({kind:'overdraft-fee-summary',tenantId:'tenant_demo_alpha',periodStart:0,periodEnd:10,generatedAt:11,data:{decisions:[{rail:'atm',decision:'decline',feeMinor:0},{rail:'one-time-debit',decision:'approve',feeMinor:1_500}]}});
 assert.deepEqual({...fees.totals},{approved:1,declined:1,feeMinor:1_500});
 assert.throws(()=>generateSyntheticReport({kind:'call-report-official',tenantId:'tenant_demo_alpha',periodStart:0,periodEnd:1,generatedAt:1,data:{}}),/unsupported/);
 assert.throws(()=>renderReportCsv({...report,header:{...report.header,watermark:'OFFICIAL'}}),/watermarked/);
});

test('an injected fault before a ledger post leaves no partial state',async t=>{
 const {store}=createFaultInjectingStore(new MemoryEngineStore(),{ledgerPost:[{call:1,when:'before'}]});
 const engine=await startEngine({store,time:T0});t.after(engine.close);
 const operator=await engine.session('tenant_demo_alpha','operator-1');
 const entry={requestId:'r1',entryId:'e1',direction:'debit',amountMinor:100,currency:'USD',expectedVersion:0,descriptionCode:'x'};
 assert.equal((await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:entry})).status,503);
 assert.equal((await engine.call('GET','/v1/accounts/checking',{token:operator})).body.version,0);
 assert.equal((await engine.call('GET','/v1/outbox/events',{token:operator})).body.events.length,0);
 assert.equal((await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:entry})).status,201);
 assert.equal((await engine.call('GET','/v1/outbox/events',{token:operator})).body.events.length,1);
});

test('a lost acknowledgement is recovered by exact idempotent retry',async t=>{
 const {store}=createFaultInjectingStore(new MemoryEngineStore(),{ledgerPost:[{call:1,when:'after'}]});
 const engine=await startEngine({store,time:T0});t.after(engine.close);
 const operator=await engine.session('tenant_demo_alpha','operator-1');
 const entry={requestId:'r1',entryId:'e1',direction:'debit',amountMinor:100,currency:'USD',expectedVersion:0,descriptionCode:'x'};
 assert.equal((await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:entry})).status,503);
 const retry=await engine.call('POST','/v1/accounts/checking/entries',{token:operator,body:entry});
 assert.equal(retry.status,201);assert.equal(retry.body.account.version,1);
 assert.equal((await engine.call('GET','/v1/outbox/events',{token:operator})).body.events.length,1);
});

test('a journal append failure fails stop and a restart rebuilds consistent module state',async()=>{
 const base=new MemoryEngineStore();base.close=async()=>{};
 const {store,log}=createFaultInjectingStore(base,{journalAppend:[{call:2,when:'before'}]});
 const fatal=[];
 const first=await startEngine({store,time:T0,onFatal:error=>fatal.push(error.code)});
 const customer=await first.session('tenant_demo_alpha','customer-1');
 const grant=id=>first.op(customer,'consents.grant',{consentId:id,scopes:['s'],purpose:'p',policyVersion:'v',expiresAt:T0+1_000_000,requestId:`r-${id}`});
 assert.equal((await grant('a')).status,200);
 assert.equal((await grant('b')).status,503);
 assert.deepEqual(fatal,['INJECTED_FAULT']);assert.equal(log.length,1);
 assert.equal((await grant('c')).status,503);
 await first.close();
 const second=await startEngine({store:base,time:T0+1_000});
 const again=await second.session('tenant_demo_alpha','customer-1');
 assert.equal((await second.op(again,'consents.check',{consentId:'a',scope:'s'})).body.permitted,true);
 assert.equal((await second.op(again,'consents.check',{consentId:'b',scope:'s'})).body.permitted,false);
 assert.equal((await second.op(again,'consents.grant',{consentId:'b',scopes:['s'],purpose:'p',policyVersion:'v',expiresAt:T0+1_000_000,requestId:'r-b'})).status,200);
 await second.close();
});
