import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {ConsentLedger} from '../src/consent-ledger.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {OverdraftEnrollment,createOverdraftEnrollmentContract,createOverdraftPolicy,disclosureDigest,evaluateOverdraft} from '../src/overdraft.mjs';

const now=7_000_000;
const identityFor=async(subject='customer-1',tenantId='tenant_alpha')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+600_000,authenticationMethods:['passkey','device']}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'od-v1',rules:[{action:'overdraft.read',permission:'overdraft:read'},{action:'overdraft.change',permission:'overdraft:change',requiresMfa:true}]}),rolePolicy:createRolePolicy([{name:'customer',permissions:['overdraft:read','overdraft:change']},{name:'viewer',permissions:['overdraft:read']}])});
const as=(identity,role='customer')=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+1_000_000,revoked:false}];
const TEXT='Synthetic overdraft disclosure v4: fees apply only to rails you choose.';
const contract=createOverdraftEnrollmentContract({version:'enroll-v1',actions:{read:'overdraft.read',change:'overdraft.change'},disclosure:{version:'od-disclosure-v4',digest:disclosureDigest(TEXT)}});
const setup=async()=>{const identity=await identityFor(),consents=new ConsentLedger();consents.grant(identity,{consentId:'od-consent',scopes:['overdraft:fees'],purpose:'overdraft-coverage',policyVersion:'p1',expiresAt:now+500_000,requestId:'c1',now});return {identity,consents,enrollment:new OverdraftEnrollment({contract,gateway})};};
const optIn=(identity,consents,overrides={})=>({identity,requestId:'opt-1',accountId:'checking',rails:['one-time-debit'],affirmative:true,disclosureVersion:'od-disclosure-v4',disclosureDigest:disclosureDigest(TEXT),consentLedger:consents,consentId:'od-consent',expectedVersion:0,assignments:as(identity),now,...overrides});

test('coverage is off by default and needs affirmative, disclosed, consented per-rail opt-in',async()=>{
 const {identity,consents,enrollment}=await setup();
 assert.deepEqual([...enrollment.status({identity,accountId:'checking',assignments:as(identity),now}).optedInRails],[]);
 assert.equal(enrollment.feeBearingCoverage({identity,accountId:'checking',rail:'atm',consentLedger:consents,now}),false);
 assert.throws(()=>enrollment.optIn(optIn(identity,consents,{affirmative:'checked-by-default'})),{code:'AFFIRMATIVE_CONSENT_REQUIRED'});
 assert.throws(()=>enrollment.optIn(optIn(identity,consents,{requestId:'o2',disclosureDigest:disclosureDigest(TEXT+' ')})),{code:'DISCLOSURE_MISMATCH'});
 assert.throws(()=>enrollment.optIn(optIn(identity,consents,{requestId:'o3',consentId:'missing'})),{code:'CONSENT_REQUIRED'});
 const viewer=await identityFor('customer-9');
 assert.throws(()=>enrollment.optIn(optIn(viewer,consents,{requestId:'o4',assignments:as(viewer,'viewer')})),{code:'OVERDRAFT_DENIED'});
 const enrolled=enrollment.optIn(optIn(identity,consents));
 assert.deepEqual([...enrolled.optedInRails],['one-time-debit']);assert.equal(enrolled.version,1);
 assert.equal(enrollment.optIn(optIn(identity,consents)),enrolled);
 assert.throws(()=>enrollment.optIn(optIn(identity,consents,{rails:['atm']})),{code:'REPLAY_MISMATCH'});
 assert.equal(enrollment.feeBearingCoverage({identity,accountId:'checking',rail:'one-time-debit',consentLedger:consents,now}),true);
 assert.equal(enrollment.feeBearingCoverage({identity,accountId:'checking',rail:'atm',consentLedger:consents,now}),false);
 const other=await identityFor('customer-2');
 assert.equal(enrollment.feeBearingCoverage({identity:other,accountId:'checking',rail:'one-time-debit',consentLedger:consents,now}),false);
});

test('revocation of the rail or the consent turns fee-bearing coverage off immediately',async()=>{
 const {identity,consents,enrollment}=await setup();
 enrollment.optIn(optIn(identity,consents,{rails:['atm','one-time-debit']}));
 const partial=enrollment.revoke({identity,accountId:'checking',rails:['atm'],assignments:as(identity),now:now+1});
 assert.deepEqual([...partial.optedInRails],['one-time-debit']);assert.deepEqual(partial.history.map(event=>event.event),['OPTED_IN','REVOKED']);
 consents.revoke(identity,{consentId:'od-consent',expectedVersion:1,reason:'customer-request',requestId:'c2',now:now+2});
 assert.equal(enrollment.feeBearingCoverage({identity,accountId:'checking',rail:'one-time-debit',consentLedger:consents,now:now+3}),false);
 assert.deepEqual([...enrollment.revoke({identity,accountId:'checking',assignments:as(identity),now:now+4}).optedInRails],[]);
});

const policy=createOverdraftPolicy({version:'od-policy-v1',currency:'USD',rails:{atm:'cover-with-opt-in','one-time-debit':'cover-with-opt-in','recurring-debit':'cover-with-opt-in',ach:'cover-no-fee',check:'decline'},feeMinor:1_500,deMinimisMinor:500,maxFeesPerDay:2,maxOverdraftMinor:50_000});
const decide=overrides=>evaluateOverdraft(policy,{rail:'one-time-debit',currency:'USD',amountMinor:5_000,availableMinor:1_000,feeBearingCoverage:true,feesChargedToday:0,...overrides});

test('rail rules decide coverage and fees deterministically without executing anything',()=>{
 assert.deepEqual([...decide({availableMinor:9_000}).reasons],['SUFFICIENT_FUNDS']);
 const covered=decide({});assert.equal(covered.decision,'approve');assert.equal(covered.overdraftMinor,4_000);assert.equal(covered.feeMinor,1_500);assert.equal(covered.executesNothing,true);
 const noOptIn=decide({feeBearingCoverage:false});assert.equal(noOptIn.decision,'decline');assert.deepEqual([...noOptIn.reasons],['OPT_IN_REQUIRED']);assert.equal(noOptIn.feeMinor,0);
 assert.equal(decide({rail:'atm',feeBearingCoverage:false}).reasons[0],'OPT_IN_REQUIRED');
 assert.equal(decide({rail:'recurring-debit',feeBearingCoverage:false}).reasons[0],'NO_FEE_BEARING_COVERAGE');
 const ach=decide({rail:'ach',feeBearingCoverage:true});assert.equal(ach.decision,'approve');assert.equal(ach.feeMinor,0);
 assert.equal(decide({rail:'check'}).decision,'decline');
 assert.equal(decide({amountMinor:60_000,availableMinor:0}).reasons[0],'OVER_LIMIT');
 assert.deepEqual([...decide({amountMinor:1_400}).reasons],['COVERED_WITH_OPT_IN','DE_MINIMIS_NO_FEE']);
 assert.equal(decide({feesChargedToday:2}).feeMinor,0);
 assert.equal(decide({amountMinor:1_600,availableMinor:0}).feeMinor,1_500);
 assert.equal(decide({amountMinor:700,availableMinor:0,feesChargedToday:0}).feeMinor,700);
});

test('force-posted items are covered but never create a fee without opt-in',()=>{
 const forced=decide({forcePost:true,feeBearingCoverage:false,rail:'one-time-debit'});
 assert.equal(forced.decision,'approve');assert.equal(forced.feeMinor,0);assert.deepEqual([...forced.reasons],['FORCE_POSTED','NO_FEE']);
 assert.equal(decide({forcePost:true,rail:'check',feeBearingCoverage:true}).feeMinor,0);
 assert.throws(()=>evaluateOverdraft({...policy},{rail:'atm',currency:'USD',amountMinor:1,availableMinor:0,feeBearingCoverage:false,feesChargedToday:0}),/Compiled overdraft policy/);
 assert.throws(()=>decide({currency:'EUR'}),/Currency/);assert.throws(()=>decide({rail:'crypto'}),/Known rail/);
 assert.throws(()=>createOverdraftPolicy({version:'v',currency:'USD',rails:{atm:'always-fee'},feeMinor:1,deMinimisMinor:0,maxFeesPerDay:1,maxOverdraftMinor:1}),/Rail rule/);
});
