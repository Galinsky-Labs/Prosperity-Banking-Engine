import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {FounderRegistry,createFounderContract,studioUsePermitted,termsDigestOf} from '../src/studio/founders.mjs';
import {ProjectWorkspace,createProjectContract} from '../src/studio/projects.mjs';

const DAY=86_400_000,now=900*DAY;
const identityFor=async(subject,tenantId='tenant_alpha')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+100*DAY,authenticationMethods:['passkey']}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'studio-v1',rules:[{action:'studio.founder',permission:'studio:founder'},{action:'studio.review',permission:'studio:review'},{action:'studio.projects',permission:'studio:projects'}]}),rolePolicy:createRolePolicy([{name:'founder',permissions:['studio:founder','studio:projects']},{name:'staff',permissions:['studio:review','studio:projects']}])});
const as=(identity,role='founder')=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+200*DAY,revoked:false}];
const TERMS='Synthetic studio terms v2: founders keep their IP.';
const founderContract=createFounderContract({version:'founders-v1',actions:{onboard:'studio.founder',review:'studio.review'},termsVersion:'studio-terms-v2',termsDigest:termsDigestOf(TERMS)});
const projectContract=createProjectContract({version:'projects-v1',action:'studio.projects',maxProjectsPerFounder:2});

test('founders onboard on exact terms, keep IP ownership and control any licence',async()=>{
 const registry=new FounderRegistry({contract:founderContract,gateway}),founder=await identityFor('founder-1');
 const base={identity:founder,founderId:'f-1',affirmative:true,termsVersion:'studio-terms-v2',termsDigest:termsDigestOf(TERMS),assignments:as(founder),now};
 assert.throws(()=>registry.onboard({...base,affirmative:undefined}),{code:'AFFIRMATIVE_CONSENT_REQUIRED'});
 assert.throws(()=>registry.onboard({...base,termsDigest:termsDigestOf('older terms')}),{code:'TERMS_MISMATCH'});
 assert.throws(()=>registry.onboard({...base,ipPosture:'studio-owned'}),/posture/);
 const record=registry.onboard(base);assert.equal(record.ipOwner,'founder');assert.equal(record.ipPosture,'founder-owned-no-license');
 assert.throws(()=>registry.onboard(base),{code:'FOUNDER_CONFLICT'});
 assert.throws(()=>registry.declarePriorIp({identity:founder,assetId:'repo-1',assetKind:'code',contentDigest:'source code text',expectedVersion:1,assignments:as(founder),now}),/digest/);
 const declared=registry.declarePriorIp({identity:founder,assetId:'repo-1',assetKind:'code',contentDigest:'c'.repeat(64),expectedVersion:1,assignments:as(founder),now});
 assert.equal(declared.priorIp[0].owner,'founder');
 const licensed=registry.changeLicense({identity:founder,ipPosture:'founder-owned-evaluation-license',expectedVersion:2,assignments:as(founder),now});
 const staff=await identityFor('staff-1');
 assert.deepEqual({...registry.lookup({identity:staff,founderId:'f-1',assignments:as(staff,'staff'),now})},{founderId:'f-1',ipOwner:'founder',ipPosture:'founder-owned-evaluation-license',priorIpCount:1,syntheticOnly:true});
 assert.throws(()=>registry.lookup({identity:founder,founderId:'f-1',assignments:as(founder),now}),{code:'FOUNDER_DENIED'});
 assert.throws(()=>registry.changeLicense({identity:founder,ipPosture:'founder-owned-no-license',expectedVersion:licensed.version-1,assignments:as(founder),now}),{code:'STALE_FOUNDER'});
 const beta=await identityFor('staff-1','tenant_beta');
 assert.throws(()=>registry.lookup({identity:beta,founderId:'f-1',assignments:as(beta,'staff'),now}),{code:'FOUNDER_NOT_FOUND'});
});

test('studio use is limited by posture and never covers commercialization, training or publishing',()=>{
 assert.equal(studioUsePermitted('founder-owned-no-license','evaluate'),false);
 assert.equal(studioUsePermitted('founder-owned-evaluation-license','evaluate'),true);
 assert.equal(studioUsePermitted('founder-owned-evaluation-license','collaborate'),false);
 assert.equal(studioUsePermitted('founder-owned-collaboration-license','collaborate'),true);
 for(const purpose of ['commercialize','train-models','publish'])assert.equal(studioUsePermitted('founder-owned-collaboration-license',purpose),false);
});

test('project workspaces isolate members and enforce milestone flow with evidence',async()=>{
 const workspace=new ProjectWorkspace({contract:projectContract,gateway}),owner=await identityFor('founder-1'),mentor=await identityFor('mentor-1'),outsider=await identityFor('founder-2');
 let project=workspace.create({identity:owner,projectId:'p-1',founderId:'f-1',titleCode:'synthetic-invoicing-tool',assignments:as(owner),now});
 assert.throws(()=>workspace.get({identity:outsider,projectId:'p-1',assignments:as(outsider),now}),{code:'PROJECT_NOT_FOUND'});
 project=workspace.addMember({identity:owner,projectId:'p-1',member:{issuer:mentor.issuer,subject:mentor.subject,role:'mentor'},expectedVersion:1,assignments:as(owner),now});
 assert.equal(workspace.get({identity:mentor,projectId:'p-1',assignments:as(mentor),now}).projectId,'p-1');
 assert.throws(()=>workspace.addMilestone({identity:mentor,projectId:'p-1',milestoneId:'m-1',outcomeCode:'mvp',dueAt:now+DAY,expectedVersion:project.version,assignments:as(mentor),now}),{code:'PROJECT_DENIED'});
 assert.throws(()=>workspace.addMember({identity:owner,projectId:'p-1',member:{issuer:outsider.issuer,subject:outsider.subject,role:'owner'},expectedVersion:project.version,assignments:as(owner),now}),/collaborator or mentor/);
 project=workspace.addMilestone({identity:owner,projectId:'p-1',milestoneId:'m-1',outcomeCode:'ten-customer-interviews',dueAt:now+10*DAY,expectedVersion:project.version,assignments:as(owner),now});
 const move=(state,extra={})=>workspace.moveMilestone({identity:owner,projectId:'p-1',milestoneId:'m-1',state,expectedVersion:project.version,assignments:as(owner),now:now+DAY,...extra});
 assert.throws(()=>move('SUBMITTED'),{code:'MILESTONE_TRANSITION'});
 project=move('IN_PROGRESS');
 assert.throws(()=>move('SUBMITTED'),{code:'EVIDENCE_REQUIRED'});
 assert.throws(()=>move('VERIFIED',{evidenceRefs:['ev-1']}),{code:'VERIFICATION_RESERVED'});
 project=move('SUBMITTED',{evidenceRefs:['claim-1','ev-1']});
 assert.deepEqual([...project.milestones[0].evidenceRefs],['claim-1','ev-1']);assert.equal(project.milestones[0].state,'SUBMITTED');
 project=workspace.removeMember({identity:owner,projectId:'p-1',subject:'mentor-1',expectedVersion:project.version,assignments:as(owner),now});
 assert.throws(()=>workspace.get({identity:mentor,projectId:'p-1',assignments:as(mentor),now}),{code:'PROJECT_NOT_FOUND'});
 workspace.create({identity:owner,projectId:'p-2',founderId:'f-1',titleCode:'b',assignments:as(owner),now});
 assert.throws(()=>workspace.create({identity:owner,projectId:'p-3',founderId:'f-1',titleCode:'c',assignments:as(owner),now}),{code:'PROJECT_LIMIT'});
 assert.equal(workspace.list({identity:owner,assignments:as(owner),now}).length,2);
 const beta=await identityFor('founder-1','tenant_beta');assert.equal(workspace.list({identity:beta,assignments:as(beta),now}).length,0);
});
