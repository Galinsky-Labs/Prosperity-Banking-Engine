import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity} from '../src/identity.mjs';
import {FinancialCrimeCaseQueue,monitorTransactions} from '../src/fraud-aml.mjs';
import {VendorRegistry} from '../src/vendor-controls.mjs';

const DAY=86_400_000,now=400*DAY;
const who=async(subject,methods=['passkey'])=>authenticateIdentity({credential:'v',now},async()=>({verified:true,tenantId:'tenant_alpha',issuer:'https://identity.example',subject,authenticatedAt:now-1,expiresAt:now+DAY*900,authenticationMethods:methods}));
const rules={reportingThresholdMinor:1_000_000,structuringBandMinor:100_000,structuringCount:3,velocityCount:4,velocityWindowMs:3_600_000,largeDebitMinor:500_000};
const txn=(id,amount,at)=>({transactionId:id,signedAmountMinor:amount,bookedAt:at});

test('monitoring raises deterministic alerts and humans dispose cases without tipping off',async()=>{
 const alerts=monitorTransactions({accountId:'checking',rules,transactions:[txn('d1',950_000,now-3*DAY),txn('d2',960_000,now-2*DAY),txn('d3',990_000,now-DAY),txn('d4',1_200_000,now),txn('w1',-600_000,now),txn('w2',-100,now+1),txn('w3',-100,now+2),txn('w4',-100,now+3)]});
 assert.deepEqual(alerts.map(alert=>alert.ruleId),['possible-structuring','threshold-credit','debit-velocity','large-debit']);
 assert.deepEqual(monitorTransactions({accountId:'checking',rules,transactions:[txn('ok',5_000,now)]}),[]);
 const queue=new FinancialCrimeCaseQueue(),analyst=await who('analyst-1'),bot=await who('bot',['workload']);
 queue.open({tenantId:'tenant_alpha',caseId:'fc-1',alerts,now});
 assert.throws(()=>queue.dispose({identity:bot,caseId:'fc-1',disposition:'escalated',rationaleCode:'x',now}),{code:'HUMAN_REQUIRED'});
 assert.throws(()=>queue.draftReport({identity:analyst,caseId:'fc-1',now}),{code:'CASE_STATE'});
 queue.dispose({identity:analyst,caseId:'fc-1',disposition:'escalated',rationaleCode:'pattern-consistent',now});
 const drafted=queue.draftReport({identity:analyst,caseId:'fc-1',now});
 assert.equal(drafted.sarDraft.filed,false);assert.equal(drafted.sarDraft.filingChannel,'none-sandbox');
 assert.doesNotMatch(JSON.stringify(queue.customerStatus()),/aml|suspicious|structuring|report|fraud/i);
});

test('vendors need tiered due diligence, separate human approval and scoped, current access',async()=>{
 const registry=new VendorRegistry(),owner=await who('vendor-owner'),approver=await who('risk-officer');
 assert.throws(()=>registry.register({identity:owner,vendorId:'kyc-co',services:['kyc'],dataScopes:['customer_identity'],riskTier:'medium',affiliated:false,contractEndsAt:now+DAY*400,now}),{code:'TIER_TOO_LOW'});
 registry.register({identity:owner,vendorId:'kyc-co',services:['kyc'],dataScopes:['customer_identity'],riskTier:'high',affiliated:true,contractEndsAt:now+DAY*400,now});
 assert.equal(registry.authorizeAccess({identity:owner,vendorId:'kyc-co',dataCategory:'customer_identity',now}).allow,false);
 for(const item of ['contract-signed','security-review','privacy-review','business-continuity','financial-condition','subcontractor-list'])registry.addEvidence({identity:owner,vendorId:'kyc-co',item,contentDigest:'e'.repeat(64),now});
 assert.throws(()=>registry.approve({identity:approver,vendorId:'kyc-co',affiliateDisclosure:'We are affiliated with this synthetic vendor.',now}),{code:'DUE_DILIGENCE_INCOMPLETE'});
 registry.addEvidence({identity:owner,vendorId:'kyc-co',item:'independent-audit-report',contentDigest:'f'.repeat(64),now});
 assert.throws(()=>registry.approve({identity:owner,vendorId:'kyc-co',affiliateDisclosure:'We are affiliated with this synthetic vendor.',now}),{code:'SEPARATION_OF_DUTIES'});
 assert.throws(()=>registry.approve({identity:approver,vendorId:'kyc-co',now}),{code:'AFFILIATE_DISCLOSURE_REQUIRED'});
 registry.approve({identity:approver,vendorId:'kyc-co',affiliateDisclosure:'We are affiliated with this synthetic vendor.',now});
 assert.equal(registry.authorizeAccess({identity:owner,vendorId:'kyc-co',dataCategory:'customer_identity',now}).allow,true);
 assert.deepEqual([...registry.authorizeAccess({identity:owner,vendorId:'kyc-co',dataCategory:'customer_document',now}).reasons],['OUT_OF_SCOPE']);
 assert.deepEqual([...registry.authorizeAccess({identity:owner,vendorId:'kyc-co',dataCategory:'customer_identity',now:now+DAY*401}).reasons],['CONTRACT_EXPIRED','REVIEW_OVERDUE']);
});
