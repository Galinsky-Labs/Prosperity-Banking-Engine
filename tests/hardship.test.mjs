import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {HardshipCaseService,createHardshipContract} from '../src/hardship.mjs';

const DAY=86_400_000,now=1_000*DAY;
const identityFor=async(subject,{tenantId='tenant_alpha',methods=['passkey','device'],authAt=now-1_000}={})=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:authAt,expiresAt:now+400*DAY,authenticationMethods:methods}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'hardship-v1',rules:[{action:'hardship.request',permission:'hardship:request'},{action:'hardship.draft',permission:'hardship:draft'},{action:'hardship.decide',permission:'hardship:decide',requiresMfa:true}]}),rolePolicy:createRolePolicy([{name:'customer',permissions:['hardship:request']},{name:'agent',permissions:['hardship:draft']},{name:'banker',permissions:['hardship:draft','hardship:decide']}])});
const as=(identity,role)=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+500*DAY,revoked:false}];
const contract=createHardshipContract({version:'hardship-v1',actions:{request:'hardship.request',draft:'hardship.draft',decide:'hardship.decide'},reasonCodes:['job-loss','medical','disaster'],options:[{optionCode:'defer-90',kind:'payment-deferral',maxDurationDays:90},{optionCode:'waive-od-fees',kind:'fee-waiver',maxDurationDays:60},{optionCode:'counselling',kind:'referral',maxDurationDays:30}],disclosureVersion:'hardship-disclosure-v3'});
const setup=async()=>({service:new HardshipCaseService({contract,gateway}),customer:await identityFor('customer-1'),agent:await identityFor('agent-1'),banker:await identityFor('banker-1'),banker2:await identityFor('banker-2')});

test('agent drafts, a different fresh-MFA banker approves, customer affirmatively accepts',async()=>{
 const {service,customer,agent,banker}=await setup();
 const opened=service.openCase({identity:customer,requestId:'r1',caseId:'case-1',reasonCodes:['job-loss'],accountIds:['checking','card'],assignments:as(customer,'customer'),now});
 assert.equal(opened.state,'OPEN');assert.deepEqual([...opened.accountIds],['card','checking']);
 assert.equal(service.openCase({identity:customer,requestId:'r1',caseId:'case-1',reasonCodes:['job-loss'],accountIds:['card','checking'],assignments:as(customer,'customer'),now}),opened);
 assert.equal(service.collectionsPaused({identity:agent,accountId:'card',assignments:as(agent,'agent'),now}),true);
 const drafted=service.draftProposals({identity:agent,caseId:'case-1',proposals:[{optionCode:'defer-90',durationDays:60},{optionCode:'counselling',durationDays:30}],expectedVersion:1,assignments:as(agent,'agent'),now});
 assert.throws(()=>service.approveOffer({identity:agent,caseId:'case-1',optionCodes:['defer-90'],expectedVersion:2,assignments:as(agent,'agent'),now}),{code:'HARDSHIP_DENIED'});
 const offered=service.approveOffer({identity:banker,caseId:'case-1',optionCodes:['defer-90'],expectedVersion:drafted.version,assignments:as(banker,'banker'),now});
 assert.equal(offered.state,'OFFERED');assert.equal(offered.offer.disclosureVersion,'hardship-disclosure-v3');
 const base={identity:customer,caseId:'case-1',decision:'accept',optionCode:'defer-90',disclosureVersion:'hardship-disclosure-v3',expectedVersion:offered.version,assignments:as(customer,'customer'),now:now+DAY};
 assert.throws(()=>service.respond({...base,affirmative:'yes'}),{code:'AFFIRMATIVE_CONSENT_REQUIRED'});
 assert.throws(()=>service.respond({...base,affirmative:true,disclosureVersion:'v2'}),{code:'DISCLOSURE_MISMATCH'});
 assert.throws(()=>service.respond({...base,affirmative:true,optionCode:'counselling'}),/must be offered/);
 const accepted=service.respond({...base,affirmative:true});
 assert.equal(accepted.state,'ACCEPTED');assert.equal(accepted.arrangement.endsAt,now+DAY+60*DAY);assert.equal(accepted.arrangement.requiresAdapterExecution,true);
 assert.deepEqual(accepted.history.map(event=>event.event),['OPENED','DRAFTED','OFFER_APPROVED','ACCEPTED']);
 assert.equal(service.collectionsPaused({identity:agent,accountId:'card',assignments:as(agent,'agent'),now}),false);
});

test('enforces separation of duties, fresh MFA, catalog bounds and versions',async()=>{
 const {service,customer,banker,banker2}=await setup();
 service.openCase({identity:customer,requestId:'r1',caseId:'case-1',reasonCodes:['medical'],accountIds:['checking'],assignments:as(customer,'customer'),now});
 assert.throws(()=>service.openCase({identity:customer,requestId:'r2',caseId:'case-2',reasonCodes:['bored'],accountIds:['checking'],assignments:as(customer,'customer'),now}),/reason codes/);
 assert.throws(()=>service.draftProposals({identity:banker,caseId:'case-1',proposals:[{optionCode:'defer-90',durationDays:91}],expectedVersion:1,assignments:as(banker,'banker'),now}),/duration/);
 assert.throws(()=>service.draftProposals({identity:banker,caseId:'case-1',proposals:[{optionCode:'forgive-all',durationDays:1}],expectedVersion:1,assignments:as(banker,'banker'),now}),{code:'UNKNOWN_HARDSHIP_OPTION'});
 assert.throws(()=>service.draftProposals({identity:banker,caseId:'case-1',proposals:[{optionCode:'defer-90',durationDays:30}],expectedVersion:9,assignments:as(banker,'banker'),now}),{code:'STALE_HARDSHIP'});
 const drafted=service.draftProposals({identity:banker,caseId:'case-1',proposals:[{optionCode:'waive-od-fees',durationDays:30}],expectedVersion:1,assignments:as(banker,'banker'),now});
 assert.throws(()=>service.approveOffer({identity:banker,caseId:'case-1',optionCodes:['waive-od-fees'],expectedVersion:drafted.version,assignments:as(banker,'banker'),now}),{code:'SEPARATION_OF_DUTIES'});
 const stale=await identityFor('banker-3',{authAt:now-600_000});
 assert.throws(()=>service.approveOffer({identity:stale,caseId:'case-1',optionCodes:['waive-od-fees'],expectedVersion:drafted.version,assignments:as(stale,'banker'),now}),{code:'HARDSHIP_DENIED'});
 const offered=service.approveOffer({identity:banker2,caseId:'case-1',optionCodes:['waive-od-fees'],expectedVersion:drafted.version,assignments:as(banker2,'banker'),now});
 const other=await identityFor('customer-2');
 assert.throws(()=>service.respond({identity:other,caseId:'case-1',decision:'decline',expectedVersion:offered.version,assignments:as(other,'customer'),now}),{code:'HARDSHIP_DENIED'});
 const expired=service.respond({identity:customer,caseId:'case-1',decision:'accept',optionCode:'waive-od-fees',affirmative:true,disclosureVersion:'hardship-disclosure-v3',expectedVersion:offered.version,assignments:as(customer,'customer'),now:now+15*DAY});
 assert.equal(expired.state,'OPEN');assert.equal(expired.history.at(-1).event,'OFFER_EXPIRED');
 const beta=await identityFor('customer-1',{tenantId:'tenant_beta'});
 assert.throws(()=>service.get({identity:beta,caseId:'case-1',assignments:as(beta,'customer'),now}),{code:'HARDSHIP_NOT_FOUND'});
});
