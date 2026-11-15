import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MemoryEngineStore} from '../src/runtime/memory-store.mjs';
import {OVERDRAFT_DISCLOSURE_TEXT,STUDIO_TERMS_TEXT} from '../src/runtime/module-operations.mjs';
import {startEngine} from './support/runtime-harness.mjs';

const T0=1_800_000_000_000,DAY=86_400_000;
const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');
const reusable=()=>{const store=new MemoryEngineStore();store.close=async()=>{};return store;};
const ok=(response,status=200)=>{assert.equal(response.status,status,JSON.stringify(response.body));return response.body;};
const sessions=async(engine,tenant='tenant_demo_alpha')=>{const out={};for(const subject of ['customer-1','customer-2','operator-1','banker-1','banker-2','agent-1','founder-1','founder-2','verifier-1','verifier-2'])out[subject]=await engine.session(tenant,subject);return out;};

test('every BNK-015..035 module is reachable over HTTP with role and ownership checks',async t=>{
 const engine=await startEngine({store:reusable(),time:T0});t.after(engine.close);
 const s=await sessions(engine);
 const listed=ok(await engine.call('GET','/v1/modules',{token:s['customer-1']})).operations;
 for(const prefix of ['agents.','hardship.','overdraft.','stepup.','disputes.','founders.','projects.','claims.','tools.','feasibility.','market.','economics.','issues.','sprints.','verification.','funding.','fairness.','onboarding.','reconcile.','deposits.','payments.'])assert.ok(listed.some(name=>name.startsWith(prefix)),prefix);
 assert.equal((await engine.call('POST','/v1/modules/hardship/open',{body:{}})).status,401);

 // BNK-015 agents
 ok(await engine.op(s['operator-1'],'agents.register',{agentId:'market-agent',purposeCode:'market-digest',capabilities:['tool:market.segment-sizer'],intervalMs:3_600_000,maxRunMs:600_000,budget:{windowMs:86_400_000,maxRuns:5,maxCostUnits:500,maxCostPerRun:100}}));
 assert.equal((await engine.op(s['operator-1'],'agents.register',{agentId:'bad',purposeCode:'x',capabilities:['payments.send'],intervalMs:3_600_000,maxRunMs:60_000,budget:{windowMs:86_400_000,maxRuns:1,maxCostUnits:1,maxCostPerRun:1}})).status,422);
 assert.equal((await engine.op(s['customer-1'],'agents.due')).status,403);

 // BNK-016 hardship
 assert.equal((await engine.op(s['customer-2'],'hardship.open',{requestId:'h0',caseId:'case-0',reasonCodes:['job-loss'],accountIds:['checking']})).status,404);
 let hardshipCase=ok(await engine.op(s['customer-1'],'hardship.open',{requestId:'h1',caseId:'case-1',reasonCodes:['job-loss'],accountIds:['checking']}));
 hardshipCase=ok(await engine.op(s['agent-1'],'hardship.draft',{caseId:'case-1',proposals:[{optionCode:'defer-90',durationDays:60}],expectedVersion:hardshipCase.version}));
 assert.equal((await engine.op(s['agent-1'],'hardship.approve',{caseId:'case-1',optionCodes:['defer-90'],expectedVersion:hardshipCase.version})).status,403);
 hardshipCase=ok(await engine.op(s['banker-1'],'hardship.approve',{caseId:'case-1',optionCodes:['defer-90'],expectedVersion:hardshipCase.version}));
 hardshipCase=ok(await engine.op(s['customer-1'],'hardship.respond',{caseId:'case-1',decision:'accept',optionCode:'defer-90',affirmative:true,disclosureVersion:'hardship-disclosure-v1',expectedVersion:hardshipCase.version}));
 assert.equal(hardshipCase.state,'ACCEPTED');

 // BNK-017/018 overdraft
 const disclosure=ok(await engine.op(s['customer-1'],'overdraft.disclosure'));assert.equal(disclosure.digest,sha(OVERDRAFT_DISCLOSURE_TEXT));
 ok(await engine.op(s['customer-1'],'consents.grant',{consentId:'od',scopes:['overdraft:fees'],purpose:'overdraft',policyVersion:'p1',expiresAt:T0+30*DAY,requestId:'c-od'}));
 assert.equal((await engine.op(s['customer-1'],'overdraft.opt-in',{requestId:'o1',accountId:'checking',rails:['one-time-debit'],affirmative:false,disclosureVersion:disclosure.version,disclosureDigest:disclosure.digest,consentId:'od',expectedVersion:0})).status,422);
 ok(await engine.op(s['customer-1'],'overdraft.opt-in',{requestId:'o2',accountId:'checking',rails:['one-time-debit'],affirmative:true,disclosureVersion:disclosure.version,disclosureDigest:disclosure.digest,consentId:'od',expectedVersion:0}));
 const covered=ok(await engine.op(s['customer-1'],'overdraft.evaluate',{accountId:'checking',rail:'one-time-debit',amountMinor:330_000}));
 assert.equal(covered.decision,'approve');assert.equal(covered.feeMinor,1_500);assert.equal(covered.executesNothing,true);
 assert.equal(ok(await engine.op(s['customer-1'],'overdraft.evaluate',{accountId:'checking',rail:'atm',amountMinor:330_000})).reasons[0],'OPT_IN_REQUIRED');

 // BNK-019 + BNK-035 step-up and payments
 const terms={amountMinor:12_500,currency:'USD',fromAccount:'checking',toPayee:'payee-7'};
 ok(await engine.op(s['customer-1'],'payments.create',{requestId:'p1',paymentId:'pay-1',...terms}));
 assert.equal((await engine.op(s['customer-2'],'payments.create',{requestId:'p2',paymentId:'pay-2',...terms})).status,404);
 const challenge=ok(await engine.op(s['customer-1'],'stepup.request',{requestId:'s1',challengeId:'ch-1',actionType:'synthetic-payment',terms}));
 assert.equal((await engine.op(s['agent-1'],'stepup.approve',{challengeId:'ch-1',digest:challenge.digest})).status,403);
 ok(await engine.op(s['customer-1'],'stepup.approve',{challengeId:'ch-1',digest:challenge.digest}));
 assert.equal((await engine.op(s['customer-1'],'payments.submit',{paymentId:'pay-1'})).status,403);
 ok(await engine.op(s['customer-1'],'payments.authorize',{paymentId:'pay-1',challengeId:'ch-1'}));
 ok(await engine.op(s['operator-1'],'payments.submit',{paymentId:'pay-1'}));ok(await engine.op(s['operator-1'],'payments.settle',{paymentId:'pay-1'}));
 const returned=ok(await engine.op(s['operator-1'],'payments.return',{paymentId:'pay-1',returnCode:'R01-insufficient-funds'}));
 assert.equal(returned.state,'RETURNED');assert.equal(returned.realFundsMoved,false);
 assert.equal((await engine.op(s['customer-2'],'payments.get',{paymentId:'pay-1'})).status,404);

 // BNK-020 disputes: evidence is fetched server-side
 const txn=ok(await engine.call('GET','/v1/accounts/checking/transactions?limit=500',{token:s['customer-1']})).transactions.find(item=>item.signedAmountMinor<0);
 assert.equal((await engine.op(s['customer-2'],'disputes.file',{requestId:'d0',disputeId:'d-0',reasonCode:'not-received',accountId:'checking',transactionId:txn.transactionId})).status,404);
 const dispute=ok(await engine.op(s['customer-1'],'disputes.file',{requestId:'d1',disputeId:'d-1',reasonCode:'not-received',accountId:'checking',transactionId:txn.transactionId}));
 assert.equal(dispute.amountMinor,-txn.signedAmountMinor);
 assert.equal((await engine.op(s['agent-1'],'disputes.claim',{ticketId:'dispute-d-1'})).status,403);
 ok(await engine.op(s['banker-1'],'disputes.claim',{ticketId:'dispute-d-1'}));
 let current=ok(await engine.op(s['customer-1'],'disputes.get',{disputeId:'d-1'}));
 current=ok(await engine.op(s['banker-1'],'disputes.resolve',{disputeId:'d-1',outcome:'customer-favor',expectedVersion:current.version}));
 assert.equal(current.state,'RESOLVED');

 // BNK-021..024 studio
 const terms2=ok(await engine.op(s['founder-1'],'founders.terms'));assert.equal(terms2.termsDigest,sha(STUDIO_TERMS_TEXT));
 ok(await engine.op(s['founder-1'],'founders.onboard',{founderId:'f-1',affirmative:true,termsVersion:terms2.termsVersion,termsDigest:terms2.termsDigest,ipPosture:'founder-owned-evaluation-license'}));
 let project=ok(await engine.op(s['founder-1'],'projects.create',{projectId:'p-1',titleCode:'synthetic-invoicing'}));
 assert.equal((await engine.op(s['founder-2'],'projects.get',{projectId:'p-1'})).status,404);
 ok(await engine.op(s['founder-1'],'claims.submit',{requestId:'cl1',projectId:'p-1',claimId:'c-1',claimType:'customer-interviews',metric:{name:'interviews',value:30,unit:'count'},evidence:[{evidenceId:'ev-1',contentDigest:'a'.repeat(64)}]}));
 const run=ok(await engine.op(s['agent-1'],'agents.start-run',{agentId:'market-agent',runId:'run-1',projectId:'p-1'}));assert.equal(run.state,'RUNNING');
 const responses=Array.from({length:40},(_,index)=>({respondentId:`r${index}`,segment:'freelancers',outcome:index<20?'yes':'no',source:index%2?'interview':'survey',incentivized:false}));
 const toolResult=ok(await engine.op(s['agent-1'],'tools.invoke',{runId:'run-1',projectId:'p-1',tool:'market.segment-sizer',input:{responses}}));
 assert.equal(toolResult.aiDraft,true);assert.equal(toolResult.output.segments[0].signal,true);
 assert.equal((await engine.op(s['agent-1'],'tools.invoke',{runId:'run-1',projectId:'p-9',tool:'market.segment-sizer',input:{responses}})).status,403);
 ok(await engine.op(s['agent-1'],'agents.finish-run',{agentId:'market-agent',runId:'run-1',costUnits:40,outcomeCode:'digest'}));

 // BNK-025..029 analysis and sprints
 assert.equal(ok(await engine.op(s['founder-1'],'feasibility.run',{experimentId:'e1',expression:'input.a+input.b',inputs:{a:2,b:3}})).result,5);
 assert.equal((await engine.op(s['founder-1'],'feasibility.run',{experimentId:'e2',expression:'process.exit(1)',inputs:{}})).status,422);
 assert.equal(ok(await engine.op(s['founder-1'],'economics.compute',{currency:'USD',priceMinor:4_900,variableCostMinor:900,paymentFeeBps:300,cacMinor:12_000,monthlyChurnBps:500})).paybackMonths,4);
 assert.equal(ok(await engine.op(s['founder-1'],'issues.spot',{projectId:'p-1',profile:{handlesPersonalData:true,handlesFundsOrPayments:false,offersCreditOrLending:false,offersSecuritiesOrInvestments:false,handlesHealthData:false,targetsChildren:false,operatesCrossBorder:false,automatedDecisionsAboutPeople:false,collectsBiometrics:false,usesThirdPartyBrandNames:false,sendsMarketingMessages:false}})).notLegalAdvice,true);
 ok(await engine.op(s['founder-1'],'sprints.plan',{projectId:'p-1',sprintId:'s-1',startsAt:T0,days:5,capacityPoints:10,items:[{itemId:'a',points:5}]}));
 assert.equal((await engine.op(s['founder-2'],'sprints.plan',{projectId:'p-1',sprintId:'s-x',startsAt:T0,days:5,capacityPoints:10,items:[{itemId:'a',points:5}]})).status,404);

 // BNK-030 verification
 ok(await engine.op(s['verifier-1'],'verification.enroll',{conflicts:{projectIds:[],founderIds:[]}}));
 const assignment=ok(await engine.op(s['founder-1'],'verification.assign',{verificationId:'v-1',projectId:'p-1',claimId:'c-1'}));
 assert.equal(assignment.verifier.subject,'verifier-1');
 assert.equal(ok(await engine.op(s['verifier-1'],'verification.decide',{verificationId:'v-1',observedDigests:{'ev-1':'a'.repeat(64)},verdict:'verified',reasonCode:'ok'})).verdict,'verified');

 // BNK-031/032 funding and fairness
 const matches=ok(await engine.op(s['founder-1'],'funding.match',{projectId:'p-1',profile:{stage:'pre-revenue',sector:'saas',region:'us',monthlyRevenueMinor:0}})).matches;
 assert.equal(matches.find(match=>match.programId==='synthetic-micro-grant').eligible,true);
 const referral=ok(await engine.op(s['founder-1'],'funding.refer',{projectId:'p-1',referralId:'ref-1',programId:'synthetic-micro-grant',sharedFields:['stage'],affirmative:true,acknowledgedNotices:true,profile:{stage:'pre-revenue',sector:'saas',region:'us',monthlyRevenueMinor:0,contactEmail:'x@example.invalid'}}));
 assert.deepEqual(Object.keys(referral.sharedData),['stage']);
 const report=ok(await engine.op(s['operator-1'],'fairness.cost-report',{}));assert.deepEqual(report.projects.map(row=>[row.projectId,row.costUnits]),[['p-1',40]]);
 assert.deepEqual(ok(await engine.op(s['operator-1'],'fairness.allocate',{capacityUnits:10,demands:[{projectId:'a',demandUnits:4,weight:1},{projectId:'b',demandUnits:20,weight:1}]})).allocations.map(item=>item.allocatedUnits),[4,6]);

 // BNK-033 onboarding stores no raw identity data
 ok(await engine.op(s['customer-2'],'consents.grant',{consentId:'kyc',scopes:['identity:verify'],purpose:'onboarding',policyVersion:'p1',expiresAt:T0+DAY,requestId:'c-kyc'}));
 const onboarded=ok(await engine.op(s['customer-2'],'onboarding.start',{consentId:'kyc',applicant:{applicantId:'app-1',fullName:'Synthetic Watchlist Person',dateOfBirth:'1990-01-01',documentNumber:'SYN-1'}}));
 assert.equal(onboarded.decision,'manual-review');assert.doesNotMatch(JSON.stringify(onboarded),/1990|SYN-1|Watchlist/);
 assert.equal(ok(await engine.op(s['banker-1'],'onboarding.review',{applicantId:'app-1',outcome:'approved-synthetic',reasonCode:'false-positive'})).decision,'approved-synthetic');

 // BNK-034 reconciliation uses server-side ledger entries
 const recon=ok(await engine.op(s['operator-1'],'reconcile.run',{accountId:'checking',statement:{openingMinor:0,closingMinor:0,lines:[]}}));
 assert.equal(recon.status,'breaks-require-review');assert.ok(recon.unmatchedEngine.length>0);
 assert.equal((await engine.op(s['customer-1'],'reconcile.run',{accountId:'checking',statement:{openingMinor:0,closingMinor:0,lines:[]}})).status,403);
 assert.equal(ok(await engine.op(s['customer-1'],'deposits.availability',{amountMinor:100_000,channel:'check',accountAgeDays:400})).schedule.length,2);
});

test('journaled module state is rebuilt identically after a restart',async()=>{
 const store=reusable(),first=await startEngine({store,time:T0}),s=await sessions(first);
 ok(await first.op(s['founder-1'],'founders.onboard',{founderId:'f-1',affirmative:true,termsVersion:'studio-terms-v1',termsDigest:sha(STUDIO_TERMS_TEXT)}));
 ok(await first.op(s['founder-1'],'projects.create',{projectId:'p-1',titleCode:'t'}));
 ok(await first.op(s['founder-1'],'claims.submit',{requestId:'cl1',projectId:'p-1',claimId:'c-1',claimType:'revenue',metric:{name:'mrr',value:1,unit:'usd-minor'},evidence:[{evidenceId:'ev-1',contentDigest:'b'.repeat(64)}]}));
 const opened=ok(await first.op(s['customer-1'],'hardship.open',{requestId:'h1',caseId:'case-1',reasonCodes:['medical'],accountIds:['checking']}));
 ok(await first.op(s['customer-1'],'payments.create',{requestId:'p1',paymentId:'pay-1',amountMinor:500,currency:'USD',fromAccount:'checking',toPayee:'payee'}));
 ok(await first.op(s['customer-2'],'consents.grant',{consentId:'kyc',scopes:['identity:verify'],purpose:'onboarding',policyVersion:'p1',expiresAt:T0+DAY,requestId:'c-kyc'}));
 ok(await first.op(s['customer-2'],'onboarding.start',{consentId:'kyc',applicant:{applicantId:'app-1',fullName:'Ada Example',dateOfBirth:'1990-01-01',documentNumber:'SYN-1'}}));
 const sequence=first.runtime.journalStatus().sequence;
 const journal=await store.journalLoad();assert.doesNotMatch(JSON.stringify(journal),/Ada Example|1990-01-01|SYN-1/);
 await first.close();

 const second=await startEngine({store,time:T0+60_000}),t=await sessions(second);
 assert.deepEqual({...second.runtime.journalStatus()},{sequence,replayErrors:0,fatal:null});
 assert.equal(ok(await second.op(t['founder-1'],'claims.status',{projectId:'p-1',claimId:'c-1'})).state,'UNVERIFIED');
 assert.equal(ok(await second.op(t['customer-1'],'hardship.get',{caseId:'case-1'})).version,opened.version);
 assert.equal(ok(await second.op(t['customer-1'],'payments.get',{paymentId:'pay-1'})).state,'CREATED');
 assert.equal((await second.op(t['customer-2'],'onboarding.start',{consentId:'kyc',applicant:{applicantId:'app-1',fullName:'Ada Example',dateOfBirth:'1990-01-01',documentNumber:'SYN-1'}})).status,409);
 await second.close();
});
