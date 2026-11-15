import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {FundingReferrals,createFundingCatalog} from '../src/studio/funding.mjs';
import {allocateFairly,costReport} from '../src/studio/fairness.mjs';

const now=80_000_000;
const identityFor=async(subject,methods=['passkey'])=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId:'tenant_alpha',issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+600_000,authenticationMethods:methods}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'funding-v1',rules:[{action:'funding.refer',permission:'funding:refer'}]}),rolePolicy:createRolePolicy([{name:'founder',permissions:['funding:refer']}])});
const as=identity=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role:'founder',validFrom:0,validUntil:now+999_999,revoked:false}];
const catalog=createFundingCatalog([
 {programId:'micro-grant',kind:'grant',criteria:{stages:['idea','pre-revenue'],sectors:['any'],regions:['any'],minVerifiedClaims:1,maxMonthlyRevenueMinor:500_000},referralCompensation:{type:'none',disclosure:'The engine receives no compensation.'}},
 {programId:'angel-network',kind:'investor-referral',criteria:{stages:['pre-revenue','revenue'],sectors:['fintech','saas'],regions:['us'],minVerifiedClaims:3,maxMonthlyRevenueMinor:null},referralCompensation:{type:'fixed',disclosure:'The tenant may receive a fixed synthetic referral fee.'}},
 {programId:'small-loan',kind:'loan-referral',criteria:{stages:['revenue'],sectors:['any'],regions:['us'],minVerifiedClaims:2,maxMonthlyRevenueMinor:null},referralCompensation:{type:'percentage',disclosure:'The tenant may receive a percentage of origination fees.'}}
]);
const profile={stage:'pre-revenue',sector:'saas',region:'us',verifiedClaimCount:3,monthlyRevenueMinor:0,projectSummary:'synthetic invoicing',contactEmail:'founder@example.invalid'};

test('matches are explainable and carry compensation and separation notices',()=>{
 const service=new FundingReferrals({catalog,gateway,action:'funding.refer'}),matches=service.match({profile});
 assert.deepEqual(matches.map(match=>[match.programId,match.eligible]),[['angel-network',true],['micro-grant',true],['small-loan',false]]);
 assert.deepEqual([...matches[2].unmetCriteria],['stage']);
 assert.match(matches[0].notices[0],/not deposits, are not insured/);assert.match(matches[0].notices[1],/fixed synthetic referral fee/);
 assert.equal(service.match({profile:{...profile,verifiedClaimCount:0}}).find(match=>match.programId==='micro-grant').unmetCriteria[0],'verified-claims');
 assert.throws(()=>createFundingCatalog([{programId:'x',kind:'equity-crowdfund',criteria:{},referralCompensation:{type:'none',disclosure:'none at all'}}]),/kind/);
});

test('referrals need the founder, affirmative consent, acknowledged notices and minimal sharing',async()=>{
 const service=new FundingReferrals({catalog,gateway,action:'funding.refer'}),founder=await identityFor('founder-1');
 const base={identity:founder,referralId:'ref-1',programId:'angel-network',profile,sharedFields:['projectSummary','stage'],affirmative:true,acknowledgedNotices:true,assignments:as(founder),now};
 assert.throws(()=>service.refer({...base,affirmative:false}),{code:'AFFIRMATIVE_CONSENT_REQUIRED'});
 assert.throws(()=>service.refer({...base,acknowledgedNotices:false}),{code:'NOTICES_REQUIRED'});
 assert.throws(()=>service.refer({...base,sharedFields:['bankBalance']}),/allowed list/);
 assert.throws(()=>service.refer({...base,programId:'small-loan'}),{code:'NOT_ELIGIBLE'});
 const agent=await identityFor('agent-1',['workload']);
 assert.throws(()=>service.refer({...base,identity:agent,assignments:as(agent)}),{code:'HUMAN_REQUIRED'});
 const referral=service.refer(base);
 assert.deepEqual({...referral.sharedData},{projectSummary:'synthetic invoicing',stage:'pre-revenue'});
 assert.equal(referral.acceptsInvestment,false);assert.equal(referral.arrangesCredit,false);
 assert.throws(()=>service.refer(base),{code:'REFERRAL_CONFLICT'});
});

test('weighted max-min allocation is capped by demand, deterministic and reports fairness',()=>{
 const result=allocateFairly({capacityUnits:100,demands:[{projectId:'a',demandUnits:10,weight:1},{projectId:'b',demandUnits:100,weight:1},{projectId:'c',demandUnits:100,weight:2}]});
 assert.deepEqual(result.allocations.map(item=>item.allocatedUnits),[10,30,60]);assert.equal(result.unusedUnits,0);
 const odd=allocateFairly({capacityUnits:10,demands:[{projectId:'x',demandUnits:50,weight:1},{projectId:'y',demandUnits:50,weight:1},{projectId:'z',demandUnits:50,weight:1}]});
 assert.deepEqual(odd.allocations.map(item=>item.allocatedUnits),[4,3,3]);assert.equal(odd.allocatedUnits,10);
 const spare=allocateFairly({capacityUnits:50,demands:[{projectId:'a',demandUnits:5,weight:1},{projectId:'b',demandUnits:10,weight:3}]});
 assert.equal(spare.unusedUnits,35);assert.equal(spare.allocations[1].satisfiedBps,10_000);
 assert.equal(allocateFairly({capacityUnits:90,demands:[{projectId:'a',demandUnits:100,weight:1},{projectId:'b',demandUnits:100,weight:2}]}).jainIndexX1000,1_000);
 assert.throws(()=>allocateFairly({capacityUnits:10,demands:[{projectId:'a',demandUnits:1,weight:1},{projectId:'a',demandUnits:1,weight:1}]}),/unique/);
});

test('cost reports are tenant-scoped, windowed and attribute spend',()=>{
 const usage=[{tenantId:'tenant_alpha',projectId:'p-1',agentId:'pricing',costUnits:30,at:10},{tenantId:'tenant_alpha',projectId:'p-1',agentId:'market',costUnits:10,at:11},{tenantId:'tenant_alpha',projectId:'p-2',agentId:'market',costUnits:60,at:12},{tenantId:'tenant_beta',projectId:'p-1',agentId:'x',costUnits:999,at:12},{tenantId:'tenant_alpha',projectId:'p-3',agentId:'x',costUnits:5,at:99}];
 const report=costReport({tenantId:'tenant_alpha',usage,from:0,to:50});
 assert.equal(report.totalCostUnits,100);assert.deepEqual(report.projects.map(project=>[project.projectId,project.shareBps]),[['p-2',6000],['p-1',4000]]);
 assert.deepEqual({...report.projects[1].byAgent},{market:10,pricing:30});
});
