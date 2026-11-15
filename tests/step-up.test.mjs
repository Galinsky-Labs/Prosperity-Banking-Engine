import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {StepUpApprovals,createStepUpContract} from '../src/step-up.mjs';

const now=9_000_000;
const identityFor=async(subject,{methods=['passkey','device'],authAt=now-1_000,tenantId='tenant_alpha'}={})=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:authAt,expiresAt:now+3_600_000,authenticationMethods:methods}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'stepup-v1',rules:[{action:'stepup.request',permission:'stepup:request'},{action:'stepup.approve',permission:'stepup:approve',requiresMfa:true}]}),rolePolicy:createRolePolicy([{name:'customer',permissions:['stepup:request','stepup:approve']},{name:'agent',permissions:['stepup:request','stepup:approve']},{name:'banker',permissions:['stepup:approve']}])});
const as=(identity,role)=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+9_999_999,revoked:false}];
const contract=createStepUpContract({version:'stepup-v1',actions:{request:'stepup.request',approve:'stepup.approve'},actionTypes:[{actionType:'synthetic-payment',requiresSecondApprover:false,maxAmountMinor:500_000},{actionType:'synthetic-large-payment',requiresSecondApprover:true,maxAmountMinor:5_000_000},{actionType:'hardship-arrangement',requiresSecondApprover:true,maxAmountMinor:null}]});
const terms={amountMinor:12_500,currency:'USD',fromAccount:'checking',toPayee:'payee-7'};

test('approval is bound to exact terms, fresh MFA and single use',async()=>{
 const approvals=new StepUpApprovals({contract,gateway}),customer=await identityFor('customer-1');
 const challenge=approvals.request({identity:customer,requestId:'r1',challengeId:'ch-1',actionType:'synthetic-payment',terms,assignments:as(customer,'customer'),now});
 assert.match(challenge.digest,/^[a-f0-9]{64}$/);assert.equal(challenge.state,'PENDING');
 assert.equal(approvals.request({identity:customer,requestId:'r1',challengeId:'ch-1',actionType:'synthetic-payment',terms:{toPayee:'payee-7',currency:'USD',fromAccount:'checking',amountMinor:12_500},assignments:as(customer,'customer'),now}),challenge);
 assert.throws(()=>approvals.approve({identity:customer,challengeId:'ch-1',digest:'0'.repeat(64),assignments:as(customer,'customer'),now}),{code:'DIGEST_MISMATCH'});
 const stale=await identityFor('customer-1',{authAt:now-400_000});
 assert.throws(()=>approvals.approve({identity:stale,challengeId:'ch-1',digest:challenge.digest,assignments:as(stale,'customer'),now}),{code:'STEP_UP_DENIED'});
 const single=await identityFor('customer-1',{methods:['password']});
 assert.throws(()=>approvals.approve({identity:single,challengeId:'ch-1',digest:challenge.digest,assignments:as(single,'customer'),now}),{code:'STEP_UP_DENIED'});
 approvals.approve({identity:customer,challengeId:'ch-1',digest:challenge.digest,assignments:as(customer,'customer'),now:now+10});
 const initiator={issuer:customer.issuer,subject:customer.subject};
 assert.throws(()=>approvals.consume({identity:customer,challengeId:'ch-1',actionType:'synthetic-payment',terms:{...terms,toPayee:'attacker'},initiator,now:now+20}),{code:'DIGEST_MISMATCH'});
 const evidence=approvals.consume({identity:customer,challengeId:'ch-1',actionType:'synthetic-payment',terms,initiator,now:now+20});
 assert.equal(evidence.approvedBy.subject,'customer-1');
 assert.throws(()=>approvals.consume({identity:customer,challengeId:'ch-1',actionType:'synthetic-payment',terms,initiator,now:now+21}),{code:'CHALLENGE_STATE'});
 const beta=await identityFor('customer-1',{tenantId:'tenant_beta'});
 assert.throws(()=>approvals.consume({identity:beta,challengeId:'ch-1',actionType:'synthetic-payment',terms,initiator,now:now+21}),{code:'CHALLENGE_NOT_FOUND'});
});

test('agents can request but never approve, and second-approver actions need another human',async()=>{
 const approvals=new StepUpApprovals({contract,gateway}),agent=await identityFor('agent-1',{methods:['workload','device']}),customer=await identityFor('customer-1'),banker=await identityFor('banker-1');
 const agentChallenge=approvals.request({identity:agent,requestId:'a1',challengeId:'ch-agent',actionType:'synthetic-payment',terms,assignments:as(agent,'agent'),now});
 assert.equal(agentChallenge.initiatorIsAgent,true);
 assert.throws(()=>approvals.approve({identity:agent,challengeId:'ch-agent',digest:agentChallenge.digest,assignments:as(agent,'agent'),now}),{code:'NON_HUMAN_APPROVER'});
 assert.equal(approvals.approve({identity:customer,challengeId:'ch-agent',digest:agentChallenge.digest,assignments:as(customer,'customer'),now}).state,'APPROVED');
 const large=approvals.request({identity:customer,requestId:'r2',challengeId:'ch-large',actionType:'synthetic-large-payment',terms:{...terms,amountMinor:1_000_000},assignments:as(customer,'customer'),now});
 assert.throws(()=>approvals.approve({identity:customer,challengeId:'ch-large',digest:large.digest,assignments:as(customer,'customer'),now}),{code:'SEPARATION_OF_DUTIES'});
 assert.equal(approvals.approve({identity:banker,challengeId:'ch-large',digest:large.digest,assignments:as(banker,'banker'),now}).approvedBy.subject,'banker-1');
 assert.throws(()=>approvals.request({identity:customer,requestId:'r3',challengeId:'ch-3',actionType:'synthetic-payment',terms:{...terms,amountMinor:500_001},assignments:as(customer,'customer'),now}),{code:'STEP_UP_LIMIT'});
 assert.throws(()=>approvals.request({identity:customer,requestId:'r4',challengeId:'ch-4',actionType:'wire-everything',terms,assignments:as(customer,'customer'),now}),{code:'UNKNOWN_STEP_UP_ACTION'});
 assert.throws(()=>approvals.request({identity:customer,requestId:'r5',challengeId:'ch-5',actionType:'synthetic-payment',terms:{...terms,amountMinor:1.5},assignments:as(customer,'customer'),now}),{code:'STEP_UP_LIMIT'});
});

test('challenges expire and replays with changed terms fail closed',async()=>{
 const shortLived=createStepUpContract({version:'stepup-v1',actions:{request:'stepup.request',approve:'stepup.approve'},actionTypes:[{actionType:'synthetic-payment',requiresSecondApprover:false,maxAmountMinor:500_000}],challengeTtlMs:10_000});
 const approvals=new StepUpApprovals({contract:shortLived,gateway}),customer=await identityFor('customer-1');
 const challenge=approvals.request({identity:customer,requestId:'r1',challengeId:'ch-1',actionType:'synthetic-payment',terms,assignments:as(customer,'customer'),now});
 assert.throws(()=>approvals.request({identity:customer,requestId:'r1',challengeId:'ch-1',actionType:'synthetic-payment',terms:{...terms,amountMinor:1},assignments:as(customer,'customer'),now}),{code:'REPLAY_MISMATCH'});
 assert.throws(()=>approvals.approve({identity:customer,challengeId:'ch-1',digest:challenge.digest,assignments:as(customer,'customer'),now:now+10_000}),{code:'CHALLENGE_EXPIRED'});
 assert.throws(()=>approvals.approve({identity:customer,challengeId:'ch-1',digest:challenge.digest,assignments:as(customer,'customer'),now:now+1}),{code:'CHALLENGE_STATE'});
 assert.throws(()=>approvals.consume({identity:customer,challengeId:'ch-1',actionType:'synthetic-payment',terms,initiator:{issuer:customer.issuer,subject:customer.subject},now:now+2}),{code:'CHALLENGE_STATE'});
});
