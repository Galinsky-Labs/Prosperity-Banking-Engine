import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {ClaimsLedger,createClaimsContract} from '../src/studio/claims-ledger.mjs';
import {mintAttestation} from '../src/studio/attestations.mjs';
import {SpecialistToolRouter} from '../src/studio/specialist-agents.mjs';

const now=40_000_000;
const identityFor=async(subject,tenantId='tenant_alpha')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+600_000,authenticationMethods:['passkey']}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'claims-v1',rules:[{action:'claims.write',permission:'claims:write'},{action:'claims.read',permission:'claims:read'}]}),rolePolicy:createRolePolicy([{name:'founder',permissions:['claims:write','claims:read']},{name:'verifier',permissions:['claims:read']}])});
const as=(identity,role='founder')=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+999_999,revoked:false}];
const contract=createClaimsContract({version:'claims-v1',actions:{write:'claims.write',read:'claims.read'}});
const claim=(identity,overrides={})=>({identity,requestId:'req-1',projectId:'p-1',claimId:'c-1',claimType:'customer-interviews',metric:{name:'interviews-completed',value:24,unit:'count'},evidence:[{evidenceId:'ev-1',contentDigest:'a'.repeat(64)}],assignments:as(identity),now,...overrides});

test('claims are append-only, hash-chained, evidence-backed and start unverified',async()=>{
 const ledger=new ClaimsLedger({contract,gateway}),founder=await identityFor('founder-1');
 assert.throws(()=>ledger.submit(claim(founder,{evidence:[]})),{code:'EVIDENCE_REQUIRED'});
 assert.throws(()=>ledger.submit(claim(founder,{metric:{name:'revenue',value:10.5,unit:'usd-minor'}})),/safe integers/);
 assert.throws(()=>ledger.submit(claim(founder,{aiDrafted:true})),{code:'HUMAN_ADOPTION_REQUIRED'});
 const entry=ledger.submit(claim(founder));
 assert.equal(entry.sequence,1);assert.equal(entry.previousHash,null);assert.match(entry.entryHash,/^[a-f0-9]{64}$/);
 assert.equal(ledger.submit(claim(founder)),entry);
 assert.throws(()=>ledger.submit(claim(founder,{metric:{name:'interviews-completed',value:99,unit:'count'}})),{code:'REPLAY_MISMATCH'});
 assert.throws(()=>ledger.submit(claim(founder,{requestId:'req-2'})),{code:'CLAIM_CONFLICT'});
 const second=ledger.submit(claim(founder,{requestId:'req-3',claimId:'c-2',aiDrafted:true,humanAdopted:true}));
 assert.equal(second.previousHash,entry.entryHash);assert.equal(second.aiDrafted,true);
 assert.equal(ledger.status({identity:founder,projectId:'p-1',claimId:'c-1',assignments:as(founder),now}).state,'UNVERIFIED');
 assert.equal(ledger.verifyChain({identity:founder,projectId:'p-1',assignments:as(founder),now}),true);
 const other=await identityFor('founder-2');
 assert.throws(()=>ledger.retract({identity:other,projectId:'p-1',claimId:'c-1',reasonCode:'x',assignments:as(other),now}),{code:'CLAIM_DENIED'});
 ledger.retract({identity:founder,projectId:'p-1',claimId:'c-2',reasonCode:'overstated',assignments:as(founder),now});
 assert.equal(ledger.status({identity:founder,projectId:'p-1',claimId:'c-2',assignments:as(founder),now}).state,'RETRACTED');
 const beta=await identityFor('founder-1','tenant_beta');
 assert.throws(()=>ledger.status({identity:beta,projectId:'p-1',claimId:'c-1',assignments:as(beta),now}),{code:'CLAIM_NOT_FOUND'});
});

test('only minted, matching, independent attestations change claim state',async()=>{
 const ledger=new ClaimsLedger({contract,gateway}),founder=await identityFor('founder-1'),entry=ledger.submit(claim(founder));
 const attestation={tenantId:'tenant_alpha',projectId:'p-1',claimId:'c-1',claimHash:entry.entryHash,verdict:'verified',verificationId:'v-1',verifier:{issuer:'https://identity.example',subject:'verifier-1'},decidedAt:now};
 assert.throws(()=>ledger.recordAttestation(Object.freeze({...attestation})),{code:'ATTESTATION_FORGED'});
 assert.throws(()=>ledger.recordAttestation(mintAttestation({...attestation,claimHash:'0'.repeat(64)})),{code:'ATTESTATION_STALE'});
 assert.throws(()=>ledger.recordAttestation(mintAttestation({...attestation,verifier:{issuer:founder.issuer,subject:founder.subject}})),{code:'SEPARATION_OF_DUTIES'});
 ledger.recordAttestation(mintAttestation(attestation));
 const status=ledger.status({identity:founder,projectId:'p-1',claimId:'c-1',assignments:as(founder),now});
 assert.equal(status.state,'VERIFIED');assert.equal(status.attestations.length,1);
});

const router=()=>{
 const tools=new SpecialistToolRouter({projectAccess:async({projectId,agentId})=>projectId==='p-1'&&agentId==='market-agent'});
 tools.registerTool({name:'market.segment-sizer',dataCategory:'synthetic_test_data',run:async({segments})=>({segmentCount:segments.length})});
 tools.registerTool({name:'market.customer-records',dataCategory:'customer_financial_data',run:async()=>({})});
 tools.registerSpecialist({agentId:'market-agent',specialty:'market-research',tools:['market.segment-sizer','market.customer-records']});
 return tools;
};
const run={tenantId:'tenant_alpha',agentId:'market-agent',runId:'run-1',state:'RUNNING',deadline:now+60_000,capabilities:['tool:market.segment-sizer','tool:market.customer-records']};

test('specialists call only allowlisted tools in an active run, on accessible projects, with eligible data',async()=>{
 const tools=router();
 const result=await tools.invoke({run,projectId:'p-1',tool:'market.segment-sizer',input:{segments:['a','b']},now});
 assert.equal(result.output.segmentCount,2);assert.equal(result.aiDraft,true);assert.equal(result.requiresHumanAdoption,true);
 await assert.rejects(tools.invoke({run:{...run,state:'TIMED_OUT'},projectId:'p-1',tool:'market.segment-sizer',input:{segments:[]},now}),{code:'RUN_REQUIRED'});
 await assert.rejects(tools.invoke({run:{...run,capabilities:[]},projectId:'p-1',tool:'market.segment-sizer',input:{segments:[]},now}),{code:'TOOL_NOT_ALLOWED'});
 await assert.rejects(tools.invoke({run,projectId:'p-2',tool:'market.segment-sizer',input:{segments:[]},now}),{code:'PROJECT_DENIED'});
 await assert.rejects(tools.invoke({run,projectId:'p-1',tool:'market.customer-records',input:{},now}),{code:'DATA_USE_DENIED'});
 await assert.rejects(tools.invoke({run,projectId:'p-1',tool:'market.segment-sizer',input:{segments:['x'.repeat(9_000)]},now}),{code:'TOOL_INPUT_TOO_LARGE'});
 assert.throws(()=>tools.registerTool({name:'payments.send',dataCategory:'synthetic_test_data',run:()=>{}}),{code:'FORBIDDEN_TOOL'});
 assert.throws(()=>tools.registerSpecialist({agentId:'rogue',specialty:'trading',tools:['market.segment-sizer']}),/Specialty/);
 assert.equal(tools.callLog({tenantId:'tenant_alpha'}).length,1);assert.equal(tools.callLog({tenantId:'tenant_beta'}).length,0);
});
