import test from 'node:test';
import assert from 'node:assert/strict';
import {createOverdraftPolicy} from '../src/overdraft.mjs';
import {runOverdraftConformance} from '../src/overdraft-conformance.mjs';
import {explainCreditDecision} from '../src/credit-explanations.mjs';

test('overdraft conformance produces self-test evidence and never claims certification',()=>{
 const policy=createOverdraftPolicy({version:'p1',currency:'USD',rails:{atm:'cover-with-opt-in','one-time-debit':'cover-with-opt-in','recurring-debit':'cover-with-opt-in',ach:'cover-no-fee',check:'decline'},feeMinor:1_500,deMinimisMinor:500,maxFeesPerDay:2,maxOverdraftMinor:50_000});
 const report=runOverdraftConformance(policy);
 assert.equal(report.engineSelfTest,'passed');assert.equal(report.failed,0);assert.ok(report.cases.length>=15);
 assert.equal(report.networkCertification,'not-obtained');assert.equal(report.certifiedBy,null);
 const permissive=createOverdraftPolicy({version:'p2',currency:'USD',rails:{atm:'cover-no-fee'},feeMinor:1_500,deMinimisMinor:0,maxFeesPerDay:0,maxOverdraftMinor:100});
 assert.equal(runOverdraftConformance(permissive).networkCertification,'not-obtained');
});

const catalog={'utilization-high':'Balances on revolving accounts are high compared with limits.','short-history':'The length of credit history is limited.','recent-delinquency':'There is a recent late payment.','income-verified':'Income was verified.'};
const factors=[{code:'utilization-high',contribution:-40,customerActionable:true},{code:'short-history',contribution:-25,customerActionable:false},{code:'recent-delinquency',contribution:-60,customerActionable:true},{code:'income-verified',contribution:30,customerActionable:false}];

test('credit explanations reconcile, rank principal reasons and refuse prohibited factors',()=>{
 const explained=explainCreditDecision({decisionId:'d-1',decision:'decline',score:505,baselineScore:600,approvalThreshold:620,modelVersion:'synthetic-scorecard-v1',factors,reasonCatalog:catalog});
 assert.deepEqual(explained.principalReasons.map(reason=>reason.code),['recent-delinquency','utilization-high','short-history']);
 assert.equal(explained.pointsToThreshold,115);assert.deepEqual(explained.actionableHints.map(hint=>hint.code),['recent-delinquency','utilization-high']);
 assert.equal(explained.engineMadeDecision,false);
 assert.throws(()=>explainCreditDecision({decisionId:'d-2',decision:'decline',score:504,baselineScore:600,approvalThreshold:620,modelVersion:'v',factors,reasonCatalog:catalog}),{code:'UNRECONCILED_EXPLANATION'});
 assert.throws(()=>explainCreditDecision({decisionId:'d-3',decision:'decline',score:590,baselineScore:600,approvalThreshold:620,modelVersion:'v',factors:[{code:'age',contribution:-10,customerActionable:false}],reasonCatalog:{age:'Applicant age was considered.'}}),{code:'PROHIBITED_FACTOR'});
 assert.throws(()=>explainCreditDecision({decisionId:'d-4',decision:'approve',score:505,baselineScore:600,approvalThreshold:620,modelVersion:'v',factors,reasonCatalog:catalog}),{code:'DECISION_SCORE_MISMATCH'});
 assert.throws(()=>explainCreditDecision({decisionId:'d-5',decision:'decline',score:505,baselineScore:600,approvalThreshold:620,modelVersion:'v',factors,reasonCatalog:{}}),{code:'MISSING_REASON_TEXT'});
 assert.equal(explainCreditDecision({decisionId:'d-6',decision:'approve',score:630,baselineScore:600,approvalThreshold:620,modelVersion:'v',factors:[{code:'income-verified',contribution:30,customerActionable:false}],reasonCatalog:catalog}).principalReasons.length,0);
});
