import {randomBytes} from 'node:crypto';
import {ensure} from '../runtime/guards.mjs';

/**
 * BNK-043 studio IP leakage evaluation. Plants unique canary strings in one founder's studio records, then
 * probes every studio read path as other founders, other tenants, mentors-turned-outsiders and agents without a
 * licence. Any canary appearing in a probe response counts as a leak. `op(subject, tenant, name, body)` must call
 * the engine API as that synthetic subject and return {status, body}.
 */
export async function runStudioLeakageEvaluation({op,canaryPrefix=`CANARY${randomBytes(4).toString('hex').toUpperCase()}`}){
 ensure(typeof op==='function','INVALID_EVALUATION','An operation caller is required');
 const canary=suffix=>`${canaryPrefix}-${suffix}`.toLowerCase();
 const owner=['founder-1','tenant_demo_alpha'],setup=[];
 const must=async(subject,tenant,name,body)=>{const response=await op(subject,tenant,name,body);setup.push([name,response.status]);ensure(response.status===200,'EVALUATION_SETUP_FAILED',`Setup ${name} failed with ${response.status}`);return response.body;};
 const terms=await must(...owner,'founders.terms',{});
 const profile=await op(...owner,'founders.profile',{});
 if(profile.status!==200)await must(...owner,'founders.onboard',{founderId:'f-1',affirmative:true,termsVersion:terms.termsVersion,termsDigest:terms.termsDigest,ipPosture:'founder-owned-no-license'});
 const projectId=canary('project');
 await must(...owner,'projects.create',{projectId,titleCode:canary('title')});
 await must(...owner,'claims.submit',{requestId:canary('req'),projectId,claimId:canary('claim'),claimType:'technical',metric:{name:canary('metric'),value:7,unit:'count'},evidence:[{evidenceId:canary('evidence'),contentDigest:'c'.repeat(64)}]});
 await must(...owner,'sprints.plan',{projectId,sprintId:canary('sprint'),startsAt:0,days:5,capacityPoints:10,items:[{itemId:canary('item'),points:3}]});
 const probes=[
  ['founder-2','tenant_demo_alpha','projects.get',{projectId}],['founder-2','tenant_demo_alpha','projects.list',{}],['founder-2','tenant_demo_alpha','claims.entries',{projectId}],['founder-2','tenant_demo_alpha','claims.status',{projectId,claimId:canary('claim')}],
  ['founder-2','tenant_demo_alpha','sprints.burndown',{projectId,sprintId:canary('sprint')}],['founder-2','tenant_demo_alpha','funding.match',{projectId,profile:{stage:'idea',sector:'any',region:'any',monthlyRevenueMinor:0}}],['founder-2','tenant_demo_alpha','issues.spot',{projectId,profile:{}}],
  ['founder-1','tenant_demo_beta','projects.get',{projectId}],['founder-1','tenant_demo_beta','claims.entries',{projectId}],
  ['verifier-2','tenant_demo_alpha','claims.entries',{projectId}],['banker-1','tenant_demo_alpha','claims.entries',{projectId}],
  ['agent-1','tenant_demo_alpha','tools.invoke',{runId:'no-run',projectId,tool:'ip.issue-spotter',input:{}}],
  ['customer-1','tenant_demo_alpha','projects.get',{projectId}]
 ];
 const results=[];
 for(const [subject,tenant,name,body] of probes){const response=await op(subject,tenant,name,body);const text=JSON.stringify(response.body??'').toLowerCase();results.push(Object.freeze({subject,tenant,operation:name,status:response.status,leaked:text.includes(canaryPrefix.toLowerCase())}));}
 const leaks=results.filter(result=>result.leaked);
 const ownerView=JSON.stringify((await op(...owner,'claims.entries',{projectId})).body).toLowerCase().includes(canaryPrefix.toLowerCase());
 return Object.freeze({probes:Object.freeze(results),leaks:leaks.length,ownerCanSeeOwnData:ownerView,passed:leaks.length===0&&ownerView,independentAcceptance:'not-obtained',syntheticOnly:true});
}
