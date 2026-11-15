import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {ClaimsLedger,createClaimsContract} from '../src/studio/claims-ledger.mjs';
import {IndependentVerification} from '../src/studio/verification.mjs';

const now=70_000_000;
const identityFor=async(subject,methods=['passkey'])=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId:'tenant_alpha',issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+600_000,authenticationMethods:methods}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'verify-v1',rules:[{action:'claims.write',permission:'claims:write'},{action:'claims.read',permission:'claims:read'},{action:'verification.decide',permission:'verification:decide'}]}),rolePolicy:createRolePolicy([{name:'founder',permissions:['claims:write','claims:read']},{name:'verifier',permissions:['claims:read','verification:decide']}])});
const as=(identity,role)=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+999_999,revoked:false}];
const A='a'.repeat(64),B='b'.repeat(64);
const setup=async()=>{
 const ledger=new ClaimsLedger({contract:createClaimsContract({version:'claims-v1',actions:{write:'claims.write',read:'claims.read'}}),gateway});
 const service=new IndependentVerification({gateway,ledger,action:'verification.decide'});
 const founder=await identityFor('founder-1'),v1=await identityFor('verifier-1'),v2=await identityFor('verifier-2'),v3=await identityFor('verifier-3');
 ledger.submit({identity:founder,requestId:'r1',projectId:'p-1',claimId:'c-1',claimType:'revenue',metric:{name:'mrr',value:120_000,unit:'usd-minor'},evidence:[{evidenceId:'ev-1',contentDigest:A},{evidenceId:'ev-2',contentDigest:B}],assignments:as(founder,'founder'),now});
 service.enroll({identity:v1,conflicts:{projectIds:['p-1'],founderIds:[]},assignments:as(v1,'verifier'),now});
 service.enroll({identity:v2,conflicts:{projectIds:[],founderIds:[]},assignments:as(v2,'verifier'),now});
 service.enroll({identity:v3,conflicts:{projectIds:[],founderIds:['f-1']},assignments:as(v3,'verifier'),now});
 const assign=(verificationId,projectMembers=[{issuer:founder.issuer,subject:'founder-1'}])=>service.assign({identity:founder,verificationId,projectId:'p-1',founderId:'f-1',claimId:'c-1',projectMembers,readerAssignments:as(founder,'founder'),now});
 return {ledger,service,founder,v1,v2,v3,assign};
};

test('assigns only an unconflicted, non-member verifier and records a bound attestation',async()=>{
 const {ledger,service,founder,v1,v2,assign}=await setup();
 const assignment=assign('ver-1');assert.equal(assignment.verifier.subject,'verifier-2');
 assert.throws(()=>service.decide({identity:v1,verificationId:'ver-1',observedDigests:{'ev-1':A,'ev-2':B},verdict:'verified',reasonCode:'ok',assignments:as(v1,'verifier'),now}),{code:'VERIFICATION_DENIED'});
 const decision=service.decide({identity:v2,verificationId:'ver-1',observedDigests:{'ev-1':A,'ev-2':B},verdict:'verified',reasonCode:'bank-statement-matches',assignments:as(v2,'verifier'),now});
 assert.equal(decision.verdict,'verified');assert.equal(decision.ledgerEntry.kind,'ATTESTATION');
 assert.equal(ledger.status({identity:founder,projectId:'p-1',claimId:'c-1',assignments:as(founder,'founder'),now}).state,'VERIFIED');
 assert.throws(()=>service.decide({identity:v2,verificationId:'ver-1',observedDigests:{},verdict:'rejected',reasonCode:'x',assignments:as(v2,'verifier'),now}),{code:'VERIFICATION_STATE'});
 assert.equal(ledger.verifyChain({identity:founder,projectId:'p-1',assignments:as(founder,'founder'),now}),true);
});

test('digest mismatch forces rejection and unreviewed evidence cannot be verified',async()=>{
 const {ledger,service,founder,v2,assign}=await setup();
 assign('ver-1');
 const partial=service.decide({identity:v2,verificationId:'ver-1',observedDigests:{'ev-1':A},verdict:'verified',reasonCode:'looks-fine',assignments:as(v2,'verifier'),now});
 assert.equal(partial.verdict,'inconclusive');assert.equal(partial.reasonCode,'EVIDENCE_NOT_REVIEWED');
 assign('ver-2');
 const mismatch=service.decide({identity:v2,verificationId:'ver-2',observedDigests:{'ev-1':A,'ev-2':'c'.repeat(64)},verdict:'verified',reasonCode:'ok',assignments:as(v2,'verifier'),now});
 assert.equal(mismatch.verdict,'rejected');assert.equal(mismatch.reasonCode,'EVIDENCE_DIGEST_MISMATCH');
 assert.equal(ledger.status({identity:founder,projectId:'p-1',claimId:'c-1',assignments:as(founder,'founder'),now}).state,'REJECTED');
});

test('no independent verifier means no verification, and agents cannot verify',async()=>{
 const {service,founder,assign}=await setup();
 assert.throws(()=>assign('ver-1',[{issuer:founder.issuer,subject:'founder-1'},{issuer:founder.issuer,subject:'verifier-2'}]),{code:'NO_INDEPENDENT_VERIFIER'});
 const agent=await identityFor('verifier-bot',['workload']);
 assert.throws(()=>service.enroll({identity:agent,conflicts:{projectIds:[],founderIds:[]},assignments:as(agent,'verifier'),now}),{code:'HUMAN_REQUIRED'});
});
