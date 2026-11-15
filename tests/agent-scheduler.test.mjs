import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {AgentScheduler,createAgentSchedulerContract} from '../src/agent-scheduler.mjs';

const H=3_600_000,now=100*H;
const identityFor=async(subject='staff-1',tenantId='tenant_alpha')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+100*H,authenticationMethods:['passkey']}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'agents-v1',rules:[{action:'agents.manage',permission:'agents:manage'},{action:'agents.run',permission:'agents:run'}]}),rolePolicy:createRolePolicy([{name:'staff',permissions:['agents:manage','agents:run']},{name:'worker',permissions:['agents:run']}])});
const as=(identity,role)=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+200*H,revoked:false}];
const contract=createAgentSchedulerContract({version:'sched-v1',actions:{manage:'agents.manage',run:'agents.run'},allowedCapabilities:['bank.home.read','bank.cashflow.forecast','chat.draft'],maxAgentsPerTenant:2});
const definition=(identity,overrides={})=>({identity,agentId:'forecast-digest',purposeCode:'weekly-forecast-digest',capabilities:['bank.cashflow.forecast'],intervalMs:H,maxRunMs:60_000,budget:{windowMs:24*H,maxRuns:3,maxCostUnits:200,maxCostPerRun:100},assignments:as(identity,'staff'),now,...overrides});

test('contracts and registrations can never grant money-moving or self-approval capabilities',async()=>{
 assert.throws(()=>createAgentSchedulerContract({version:'v',actions:{manage:'a',run:'b'},allowedCapabilities:['bank.entries.post']}),{code:'FORBIDDEN_AGENT_CAPABILITY'});
 const staff=await identityFor(),scheduler=new AgentScheduler({contract,gateway});
 for(const capability of ['payments.send','fees.assess','step-up.approve','credit.approve','ledger.write'])assert.throws(()=>scheduler.register(definition(staff,{capabilities:[capability]})),{code:'FORBIDDEN_AGENT_CAPABILITY'},capability);
 assert.throws(()=>scheduler.register(definition(staff,{capabilities:['bank.accounts.read']})),{code:'CAPABILITY_NOT_ALLOWED'});
 const worker=await identityFor('worker-1');
 assert.throws(()=>scheduler.register(definition(worker,{assignments:as(worker,'worker')})),{code:'AGENT_SCHEDULER_DENIED'});
 assert.throws(()=>scheduler.register(definition(staff,{budget:{windowMs:24*H,maxRuns:1,maxCostUnits:10,maxCostPerRun:11}})),/Per-run cost/);
 scheduler.register(definition(staff));scheduler.register(definition(staff,{agentId:'second'}));
 assert.throws(()=>scheduler.register(definition(staff,{agentId:'third'})),{code:'AGENT_LIMIT'});
 assert.throws(()=>scheduler.register(definition(staff)),{code:'AGENT_CONFLICT'});
});

test('schedules due agents, single-flights runs and enforces windowed budgets',async()=>{
 const staff=await identityFor(),worker=await identityFor('worker-1'),scheduler=new AgentScheduler({contract,gateway});
 scheduler.register(definition(staff));const w=as(worker,'worker');
 assert.deepEqual(scheduler.due({identity:worker,assignments:w,now}).map(agent=>agent.agentId),['forecast-digest']);
 const run=scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-1',assignments:w,now});
 assert.equal(run.reservedCostUnits,100);assert.equal(Object.isFrozen(run),true);
 assert.throws(()=>scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-2',assignments:w,now}),{code:'AGENT_BUSY'});
 assert.equal(scheduler.finishRun({identity:worker,agentId:'forecast-digest',runId:'run-1',costUnits:40,outcomeCode:'digest-ready',assignments:w,now:now+1_000}).state,'SUCCEEDED');
 assert.throws(()=>scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-2',assignments:w,now:now+2_000}),{code:'AGENT_NOT_DUE'});
 scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-2',assignments:w,now:now+H});
 scheduler.finishRun({identity:worker,agentId:'forecast-digest',runId:'run-2',costUnits:100,outcomeCode:'ok',assignments:w,now:now+H+1});
 const status=scheduler.budgetStatus({identity:worker,agentId:'forecast-digest',assignments:w,now:now+2*H});
 assert.deepEqual([status.runsUsed,status.costUsed,status.costRemaining],[2,140,60]);
 assert.throws(()=>scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-3',assignments:w,now:now+2*H}),{code:'BUDGET_EXHAUSTED'});
 assert.equal(scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-3',assignments:w,now:now+25*H}).state,'RUNNING');
 const beta=await identityFor('worker-1','tenant_beta');
 assert.deepEqual(scheduler.due({identity:beta,assignments:as(beta,'worker'),now}),[]);
 assert.throws(()=>scheduler.startRun({identity:beta,agentId:'forecast-digest',runId:'x',assignments:as(beta,'worker'),now}),{code:'AGENT_NOT_FOUND'});
});

test('timeouts consume the reserved budget and overruns pause the agent',async()=>{
 const staff=await identityFor(),worker=await identityFor('worker-1'),scheduler=new AgentScheduler({contract,gateway}),w=as(worker,'worker');
 scheduler.register(definition(staff));
 scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-1',assignments:w,now});
 assert.throws(()=>scheduler.finishRun({identity:worker,agentId:'forecast-digest',runId:'run-1',costUnits:1,outcomeCode:'late',assignments:w,now:now+60_000}),{code:'RUN_TIMED_OUT'});
 assert.equal(scheduler.runs({identity:worker,agentId:'forecast-digest',assignments:w,now:now+60_000})[0].state,'TIMED_OUT');
 assert.equal(scheduler.budgetStatus({identity:worker,agentId:'forecast-digest',assignments:w,now:now+60_000}).costUsed,100);
 scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-2',assignments:w,now:now+H});
 const other=await identityFor('worker-2');
 assert.throws(()=>scheduler.finishRun({identity:other,agentId:'forecast-digest',runId:'run-2',costUnits:1,outcomeCode:'x',assignments:as(other,'worker'),now:now+H+1}),{code:'RUN_DENIED'});
 assert.equal(scheduler.finishRun({identity:worker,agentId:'forecast-digest',runId:'run-2',costUnits:101,outcomeCode:'overran',assignments:w,now:now+H+1}).state,'BUDGET_OVERRUN');
 const [agent]=[scheduler.pause({identity:staff,agentId:'forecast-digest',reasonCode:'review',assignments:as(staff,'staff'),now:now+H+2})];
 assert.equal(agent.state,'PAUSED');
 assert.throws(()=>scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-3',assignments:w,now:now+3*H}),{code:'AGENT_PAUSED'});
 assert.throws(()=>scheduler.resume({identity:staff,agentId:'forecast-digest',expectedVersion:1,assignments:as(staff,'staff'),now:now+3*H}),{code:'STALE_AGENT'});
 assert.equal(scheduler.resume({identity:staff,agentId:'forecast-digest',expectedVersion:agent.version,assignments:as(staff,'staff'),now:now+3*H}).state,'ACTIVE');
 scheduler.setTenantPause({identity:staff,paused:true,assignments:as(staff,'staff'),now:now+3*H});
 assert.deepEqual(scheduler.due({identity:worker,assignments:w,now:now+3*H}),[]);
 assert.throws(()=>scheduler.startRun({identity:worker,agentId:'forecast-digest',runId:'run-4',assignments:w,now:now+3*H}),{code:'AGENT_PAUSED'});
});
