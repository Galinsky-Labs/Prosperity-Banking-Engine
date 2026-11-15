import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcile,depositAvailability} from '../src/reconciliation.mjs';
import {SandboxPaymentLifecycle} from '../src/payments.mjs';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {StepUpApprovals,createStepUpContract} from '../src/step-up.mjs';

const DAY=86_400_000,now=300*DAY;

test('reconciliation matches, reports breaks and never auto-corrects',()=>{
 const statement={openingMinor:10_000,closingMinor:7_000,lines:[{reference:'e-1',signedAmountMinor:-2_000,at:now},{reference:'BANK-77',signedAmountMinor:-500,at:now+DAY},{reference:'e-3',signedAmountMinor:-400,at:now},{reference:'fee-9',signedAmountMinor:-100,at:now}]};
 const engine=[{reference:'e-1',signedAmountMinor:-2_000,at:now},{reference:'e-2',signedAmountMinor:-500,at:now},{reference:'e-3',signedAmountMinor:-450,at:now},{reference:'e-4',signedAmountMinor:-75,at:now}];
 const result=reconcile({currency:'USD',engineEntries:engine,statement});
 assert.equal(result.matched.length,2);assert.equal(result.matched[1].needsConfirmation,true);
 assert.deepEqual(result.amountMismatches.map(item=>item.reference),['e-3']);
 assert.deepEqual(result.unmatchedEngine.map(item=>item.reference),['e-4']);assert.deepEqual(result.unmatchedBank.map(item=>item.reference),['fee-9']);
 assert.equal(result.balanceContinuous,true);assert.equal(result.status,'breaks-require-review');assert.equal(result.autoCorrected,false);
 assert.equal(reconcile({currency:'USD',engineEntries:[],statement:{openingMinor:1,closingMinor:5,lines:[]}}).balanceContinuous,false);
 assert.equal(reconcile({currency:'USD',engineEntries:[{reference:'a',signedAmountMinor:5,at:now}],statement:{openingMinor:0,closingMinor:5,lines:[{reference:'a',signedAmountMinor:5,at:now}]}}).status,'reconciled');
});

test('deposit availability follows the hold policy and covers the full amount',()=>{
 const policy={nextDayMinor:22_500,standardHoldDays:2,newAccountHoldDays:9,newAccountAgeDays:30,largeDepositMinor:550_000,largeDepositHoldDays:7};
 assert.equal(depositAvailability({amountMinor:100_000,channel:'electronic',accountAgeDays:1,depositedAt:now,policy}).schedule[0].availableAt,now);
 const check=depositAvailability({amountMinor:100_000,channel:'check',accountAgeDays:400,depositedAt:now,policy});
 assert.deepEqual(check.schedule.map(item=>[item.amountMinor,item.reason]),[[22_500,'NEXT_DAY_PORTION'],[77_500,'STANDARD_HOLD']]);assert.equal(check.noticeRequired,true);
 const large=depositAvailability({amountMinor:1_000_000,channel:'mobile-check',accountAgeDays:5,depositedAt:now,policy});
 assert.deepEqual(large.schedule.map(item=>[item.amountMinor,item.reason,(item.availableAt-now)/DAY]),[[22_500,'NEXT_DAY_PORTION',1],[527_500,'NEW_ACCOUNT_HOLD',9],[450_000,'LARGE_DEPOSIT_HOLD',9]]);
});

const terms={amountMinor:12_500,currency:'USD',fromAccount:'checking',toPayee:'payee-7'};
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'pay-v1',rules:[{action:'stepup.request',permission:'stepup:request'},{action:'stepup.approve',permission:'stepup:approve',requiresMfa:true}]}),rolePolicy:createRolePolicy([{name:'customer',permissions:['stepup:request','stepup:approve']}])});
const stepUpContract=createStepUpContract({version:'stepup-v1',actions:{request:'stepup.request',approve:'stepup.approve'},actionTypes:[{actionType:'synthetic-payment',requiresSecondApprover:false,maxAmountMinor:500_000}]});
const setup=async()=>{
 const customer=await authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId:'tenant_alpha',issuer:'https://identity.example',subject:'customer-1',authenticatedAt:now-1_000,expiresAt:now+DAY,authenticationMethods:['passkey','device']}));
 const assignments=[{tenantId:'tenant_alpha',issuer:customer.issuer,subject:customer.subject,role:'customer',validFrom:0,validUntil:now+10*DAY,revoked:false}];
 const stepUp=new StepUpApprovals({contract:stepUpContract,gateway});
 const approve=(challengeId,approvedTerms=terms)=>{const challenge=stepUp.request({identity:customer,requestId:`req-${challengeId}`,challengeId,actionType:'synthetic-payment',terms:approvedTerms,assignments,now});stepUp.approve({identity:customer,challengeId,digest:challenge.digest,assignments,now});};
 return {customer,stepUp,approve};
};
const create=(lifecycle,overrides={})=>lifecycle.create({tenantId:'tenant_alpha',requestId:'r1',paymentId:'pay-1',...terms,initiator:{issuer:'https://identity.example',subject:'customer-1'},now,...overrides});

test('payments consume a step-up approval bound to their exact terms and follow the lifecycle',async()=>{
 const {customer,stepUp,approve}=await setup();
 assert.throws(()=>new SandboxPaymentLifecycle({rail:'ach'}),{code:'LIVE_RAIL_DENIED'});
 const lifecycle=new SandboxPaymentLifecycle({});const payment=create(lifecycle);
 assert.equal(payment.realFundsMoved,false);assert.equal(create(lifecycle),payment);
 assert.throws(()=>create(lifecycle,{amountMinor:1}),{code:'REPLAY_MISMATCH'});
 assert.throws(()=>create(lifecycle,{requestId:'r2',paymentId:'pay-2',amountMinor:2_000_000}),{code:'PAYMENT_LIMIT'});
 assert.throws(()=>lifecycle.submit({tenantId:'tenant_alpha',paymentId:'pay-1',now}),{code:'PAYMENT_TRANSITION'});
 approve('ch-other',{...terms,toPayee:'payee-8'});
 assert.throws(()=>lifecycle.authorize({tenantId:'tenant_alpha',paymentId:'pay-1',stepUp,identity:customer,challengeId:'ch-other',now}),{code:'DIGEST_MISMATCH'});
 assert.throws(()=>lifecycle.authorize({tenantId:'tenant_alpha',paymentId:'pay-1',stepUp,identity:customer,challengeId:'ch-missing',now}),{code:'CHALLENGE_NOT_FOUND'});
 approve('ch-1');
 lifecycle.authorize({tenantId:'tenant_alpha',paymentId:'pay-1',stepUp,identity:customer,challengeId:'ch-1',now});
 create(lifecycle,{requestId:'r3',paymentId:'pay-3'});
 assert.throws(()=>lifecycle.authorize({tenantId:'tenant_alpha',paymentId:'pay-3',stepUp,identity:customer,challengeId:'ch-1',now}),{code:'CHALLENGE_STATE'});
 lifecycle.submit({tenantId:'tenant_alpha',paymentId:'pay-1',now});
 assert.throws(()=>lifecycle.receiveReturn({tenantId:'tenant_alpha',paymentId:'pay-1',returnCode:'R01-insufficient-funds',now}),{code:'PAYMENT_TRANSITION'});
 lifecycle.settle({tenantId:'tenant_alpha',paymentId:'pay-1',now});
 const returned=lifecycle.receiveReturn({tenantId:'tenant_alpha',paymentId:'pay-1',returnCode:'R10-unauthorized',now:now+5*DAY});
 assert.equal(returned.state,'RETURNED');assert.equal(returned.returnInfo.reversal.amountMinor,12_500);assert.equal(returned.returnInfo.unauthorizedClaim,true);
 assert.deepEqual(returned.history.map(item=>item.state),['CREATED','AUTHORIZED','SUBMITTED','SETTLED','RETURNED']);
});

test('late returns and cross-tenant access are refused',async()=>{
 const {customer,stepUp,approve}=await setup();approve('ch-1');
 const lifecycle=new SandboxPaymentLifecycle({returnWindowDays:2});create(lifecycle);
 lifecycle.authorize({tenantId:'tenant_alpha',paymentId:'pay-1',stepUp,identity:customer,challengeId:'ch-1',now});lifecycle.submit({tenantId:'tenant_alpha',paymentId:'pay-1',now});lifecycle.settle({tenantId:'tenant_alpha',paymentId:'pay-1',now});
 assert.throws(()=>lifecycle.receiveReturn({tenantId:'tenant_alpha',paymentId:'pay-1',returnCode:'R01-insufficient-funds',now:now+3*DAY}),{code:'RETURN_WINDOW_CLOSED'});
 assert.throws(()=>lifecycle.get({tenantId:'tenant_beta',paymentId:'pay-1'}),{code:'PAYMENT_NOT_FOUND'});
 assert.throws(()=>lifecycle.receiveReturn({tenantId:'tenant_alpha',paymentId:'pay-1',returnCode:'R99-made-up',now}),/Return code/);
});
