import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {ConsentLedger} from '../src/consent-ledger.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {SyntheticOnboarding,createCallbackVerifier,createIdentityScreeningAdapter} from '../src/partners/identity-screening.mjs';

const now=90_000_000;
const identityFor=async(subject,methods=['passkey'])=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId:'tenant_alpha',issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+600_000,authenticationMethods:methods}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'kyc-v1',rules:[{action:'onboarding.review',permission:'onboarding:review'}]}),rolePolicy:createRolePolicy([{name:'analyst',permissions:['onboarding:review']}])});
const as=identity=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role:'analyst',validFrom:0,validUntil:now+999_999,revoked:false}];
const setup=async()=>{
 const applicant=await identityFor('applicant-1'),consents=new ConsentLedger();
 consents.grant(applicant,{consentId:'kyc',scopes:['identity:verify'],purpose:'onboarding',policyVersion:'p1',expiresAt:now+100_000,requestId:'c1',now});
 return {applicant,consents,onboarding:new SyntheticOnboarding({adapter:createIdentityScreeningAdapter(),gateway,action:'onboarding.review'})};
};
const person=(overrides={})=>({applicantId:'app-1',fullName:'Ada Example',dateOfBirth:'1990-01-01',documentNumber:'SYN-123',...overrides});

test('live partners are refused until a regulated partner is approved',()=>{
 assert.throws(()=>createIdentityScreeningAdapter({mode:'live'}),{code:'PARTNER_APPROVAL_REQUIRED'});
 assert.equal(createIdentityScreeningAdapter().live,false);
});

test('clean synthetic applicants pass; results keep references, not raw identity data',async()=>{
 const {applicant,consents,onboarding}=await setup();
 await assert.rejects(onboarding.start({identity:applicant,applicant:person(),consentLedger:consents,consentId:'missing',now}),{code:'CONSENT_REQUIRED'});
 const record=await onboarding.start({identity:applicant,applicant:person(),consentLedger:consents,consentId:'kyc',now});
 assert.equal(record.decision,'approved-synthetic');assert.equal(record.liveAccountOpened,false);assert.match(record.identityReference,/^idv_[a-f0-9]{24}$/);
 assert.doesNotMatch(JSON.stringify(record),/Ada|1990|SYN-123/);
});

test('potential matches and inconclusive checks go to a human; failures get reason codes',async()=>{
 const {applicant,consents,onboarding}=await setup();
 const match=await onboarding.start({identity:applicant,applicant:person({applicantId:'app-2',fullName:'Synthetic Watchlist Persson'}),consentLedger:consents,consentId:'kyc',now});
 assert.equal(match.decision,'manual-review');assert.deepEqual([...match.reasons],['SCREENING_POTENTIAL_MATCH']);
 const failed=await onboarding.start({identity:applicant,applicant:person({applicantId:'app-3',documentNumber:'REAL-999'}),consentLedger:consents,consentId:'kyc',now});
 assert.equal(failed.decision,'declined');assert.deepEqual([...failed.reasons],['IDV_DOCUMENT_FAILED']);
 const bot=await identityFor('bot',['workload']);
 assert.throws(()=>onboarding.review({identity:bot,applicantId:'app-2',outcome:'approved-synthetic',reasonCode:'false-positive',assignments:as(bot),now}),{code:'HUMAN_REQUIRED'});
 const analyst=await identityFor('analyst-1');
 const reviewed=onboarding.review({identity:analyst,applicantId:'app-2',outcome:'approved-synthetic',reasonCode:'false-positive-dob-differs',assignments:as(analyst),now});
 assert.equal(reviewed.reviewedBy,'analyst-1');
 assert.throws(()=>onboarding.review({identity:analyst,applicantId:'app-3',outcome:'approved-synthetic',reasonCode:'x',assignments:as(analyst),now}),{code:'ONBOARDING_STATE'});
});

test('partner callbacks need a fresh valid signature and are processed once',()=>{
 const secret='s'.repeat(40),verifier=createCallbackVerifier({secret}),body=JSON.stringify({applicantId:'app-1',status:'verified'});
 const sign=(timestamp,text=body)=>createHmac('sha256',secret).update(`${timestamp}.${text}`).digest('hex');
 assert.deepEqual(verifier.verify({signature:sign(now),timestamp:now,eventId:'evt-1',body,now}),{applicantId:'app-1',status:'verified'});
 assert.throws(()=>verifier.verify({signature:sign(now),timestamp:now,eventId:'evt-1',body,now}),{code:'CALLBACK_REPLAY'});
 assert.throws(()=>verifier.verify({signature:sign(now,'{}'),timestamp:now,eventId:'evt-2',body,now}),{code:'CALLBACK_FORGED'});
 assert.throws(()=>verifier.verify({signature:sign(now-400_000),timestamp:now-400_000,eventId:'evt-3',body,now}),{code:'CALLBACK_STALE'});
});
