import {PolicyGateway} from './policy-gateway.mjs';
import {bounded,ensure,requireDecision} from './runtime/guards.mjs';

const compiledContracts=new WeakSet();
const code='INVALID_AGENT_SCHEDULE';
/** Capabilities no scheduled agent may hold, whatever a tenant configures. */
const FORBIDDEN=/^(bank\.entries\.post|payments?\.|transfers?\.|ledger\.|credit\.(approve|decide|grant)|fees?\.|overdraft\.(enable|fee)|step-up\.approve|disputes?\.resolve)/;
const int=(value,min,max,label)=>{ensure(Number.isSafeInteger(value)&&value>=min&&value<=max,code,`${label} is out of bounds`);return value;};

export function createAgentSchedulerContract({version,actions,allowedCapabilities,maxAgentsPerTenant=20}){
 bounded(version,'Scheduler version',code);
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,code,'Scheduler actions are required');
 const normalizedActions=Object.freeze({manage:bounded(actions.manage,'Manage action',code),run:bounded(actions.run,'Run action',code)});
 ensure(normalizedActions.manage!==normalizedActions.run,code,'Manage and run actions must differ');
 ensure(Array.isArray(allowedCapabilities)&&allowedCapabilities.length>=1&&allowedCapabilities.length<=64,code,'Capability allowlist is required');
 const capabilities=[...new Set(allowedCapabilities.map(capability=>bounded(capability,'Capability',code)))].sort();
 ensure(capabilities.every(capability=>!FORBIDDEN.test(capability)),'FORBIDDEN_AGENT_CAPABILITY','Agents cannot be allowed to move money, post ledger entries, decide credit, set fees or approve their own actions');
 int(maxAgentsPerTenant,1,200,'Agent bound');
 const contract=Object.freeze({version,actions:normalizedActions,allowedCapabilities:Object.freeze(capabilities),maxAgentsPerTenant,syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}

/**
 * BNK-015 tenant-scoped agent scheduler. Staff register bounded agents; workers start runs only when an
 * agent is due, unpaused and within its windowed run and cost budgets. Each run reserves its maximum
 * cost up front, so a crashed or timed-out run still consumes budget. Overruns pause the agent.
 */
export class AgentScheduler {
 #contract;#gateway;#agents=new Map();#runs=new Map();#paused=new Set();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),code,'Compiled scheduler contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }

 #manage(identity,assignments,now){requireDecision(this.#gateway,{identity,action:this.#contract.actions.manage,assignments,now},'AGENT_SCHEDULER_DENIED');}
 #worker(identity,assignments,now){requireDecision(this.#gateway,{identity,action:this.#contract.actions.run,assignments,now},'AGENT_SCHEDULER_DENIED');}
 #agent(identity,agentId){bounded(agentId,'Agent ID',code);const agent=this.#agents.get(`${identity.tenantId}:${agentId}`);ensure(agent,'AGENT_NOT_FOUND','Agent does not exist');return agent;}
 #view(agent){return Object.freeze({...agent,capabilities:Object.freeze([...agent.capabilities]),budget:Object.freeze({...agent.budget}),tenantPaused:this.#paused.has(agent.tenantId),syntheticOnly:true});}

 register({identity,agentId,purposeCode,capabilities,intervalMs,maxRunMs,budget,assignments,now}){
  this.#manage(identity,assignments,now);bounded(agentId,'Agent ID',code);bounded(purposeCode,'Purpose code',code);
  ensure(Array.isArray(capabilities)&&capabilities.length>=1&&capabilities.length<=16,code,'Bounded capabilities are required');
  const normalized=[...new Set(capabilities.map(capability=>bounded(capability,'Capability',code)))].sort();
  ensure(normalized.every(capability=>!FORBIDDEN.test(capability)),'FORBIDDEN_AGENT_CAPABILITY','Agents cannot move money, post ledger entries, decide credit, set fees or approve their own actions');
  ensure(normalized.every(capability=>this.#contract.allowedCapabilities.includes(capability)),'CAPABILITY_NOT_ALLOWED','Capability is not in the tenant allowlist');
  int(intervalMs,60_000,30*86_400_000,'Interval');int(maxRunMs,1_000,3_600_000,'Run time limit');
  ensure(budget&&typeof budget==='object',code,'Budget is required');
  const normalizedBudget={windowMs:int(budget.windowMs,3_600_000,31*86_400_000,'Budget window'),maxRuns:int(budget.maxRuns,1,10_000,'Run budget'),maxCostUnits:int(budget.maxCostUnits,1,100_000_000,'Cost budget'),maxCostPerRun:int(budget.maxCostPerRun,1,1_000_000,'Per-run cost')};
  ensure(normalizedBudget.maxCostPerRun<=normalizedBudget.maxCostUnits,code,'Per-run cost cannot exceed the window budget');
  const key=`${identity.tenantId}:${agentId}`;ensure(!this.#agents.has(key),'AGENT_CONFLICT','Agent already exists');
  ensure([...this.#agents.values()].filter(agent=>agent.tenantId===identity.tenantId).length<this.#contract.maxAgentsPerTenant,'AGENT_LIMIT','Tenant agent limit reached');
  const agent={tenantId:identity.tenantId,agentId,purposeCode,capabilities:normalized,intervalMs,maxRunMs,budget:normalizedBudget,nextRunAt:now,state:'ACTIVE',pauseReason:null,activeRunId:null,registeredBy:identity.subject,version:1};
  this.#agents.set(key,agent);return this.#view(agent);
 }

 #history(agent,now){return [...this.#runs.values()].filter(run=>run.tenantId===agent.tenantId&&run.agentId===agent.agentId&&run.startedAt>now-agent.budget.windowMs);}
 #expire(agent,now){
  if(!agent.activeRunId)return;
  const run=this.#runs.get(`${agent.tenantId}:${agent.activeRunId}`);
  if(run.state==='RUNNING'&&run.deadline<=now){this.#runs.set(`${agent.tenantId}:${run.runId}`,Object.freeze({...run,state:'TIMED_OUT',finishedAt:run.deadline,costUnits:run.reservedCostUnits}));agent.activeRunId=null;}
 }

 budgetStatus({identity,agentId,assignments,now}){
  this.#worker(identity,assignments,now);const agent=this.#agent(identity,agentId);this.#expire(agent,now);
  const history=this.#history(agent,now),spent=history.reduce((sum,run)=>sum+(run.state==='RUNNING'?run.reservedCostUnits:run.costUnits),0);
  return Object.freeze({agentId,windowMs:agent.budget.windowMs,runsUsed:history.length,runsRemaining:Math.max(0,agent.budget.maxRuns-history.length),costUsed:spent,costRemaining:Math.max(0,agent.budget.maxCostUnits-spent),syntheticOnly:true});
 }

 due({identity,assignments,now}){
  this.#worker(identity,assignments,now);if(this.#paused.has(identity.tenantId))return Object.freeze([]);
  return Object.freeze([...this.#agents.values()].filter(agent=>agent.tenantId===identity.tenantId).filter(agent=>{this.#expire(agent,now);return agent.state==='ACTIVE'&&!agent.activeRunId&&agent.nextRunAt<=now;}).map(agent=>this.#view(agent)));
 }

 startRun({identity,agentId,runId,projectId=null,assignments,now}){
  this.#worker(identity,assignments,now);bounded(runId,'Run ID',code);
  const agent=this.#agent(identity,agentId);this.#expire(agent,now);
  ensure(!this.#paused.has(identity.tenantId),'AGENT_PAUSED','Tenant agents are paused');
  ensure(agent.state==='ACTIVE','AGENT_PAUSED','Agent is paused');
  ensure(!agent.activeRunId,'AGENT_BUSY','Agent already has an active run');
  ensure(agent.nextRunAt<=now,'AGENT_NOT_DUE','Agent is not due');
  ensure(!this.#runs.has(`${identity.tenantId}:${runId}`),'RUN_CONFLICT','Run ID already exists');
  const status=this.budgetStatus({identity,agentId,assignments,now});
  ensure(status.runsRemaining>=1,'BUDGET_EXHAUSTED','Run budget for the window is exhausted');
  ensure(status.costRemaining>=agent.budget.maxCostPerRun,'BUDGET_EXHAUSTED','Cost budget cannot cover a full run');
  if(projectId!==null)bounded(projectId,'Project ID',code);
  const run=Object.freeze({tenantId:identity.tenantId,agentId,runId,projectId,state:'RUNNING',startedAt:now,deadline:now+agent.maxRunMs,reservedCostUnits:agent.budget.maxCostPerRun,costUnits:null,outcomeCode:null,worker:identity.subject,capabilities:Object.freeze([...agent.capabilities]),syntheticOnly:true});
  this.#runs.set(`${identity.tenantId}:${runId}`,run);agent.activeRunId=runId;agent.nextRunAt=Math.max(now,agent.nextRunAt+agent.intervalMs);return run;
 }

 finishRun({identity,agentId,runId,costUnits,outcomeCode,assignments,now}){
  this.#worker(identity,assignments,now);bounded(outcomeCode,'Outcome code',code);
  const agent=this.#agent(identity,agentId),key=`${identity.tenantId}:${runId}`,run=this.#runs.get(key);
  ensure(run&&run.agentId===agentId,'RUN_NOT_FOUND','Run does not exist');
  ensure(run.state==='RUNNING'&&run.worker===identity.subject,'RUN_DENIED','Only the active run worker may finish it');
  ensure(now<run.deadline,'RUN_TIMED_OUT','Run exceeded its time limit');
  int(costUnits,0,Number.MAX_SAFE_INTEGER,'Cost');
  let state='SUCCEEDED';
  if(costUnits>run.reservedCostUnits){state='BUDGET_OVERRUN';agent.state='PAUSED';agent.pauseReason='BUDGET_OVERRUN';agent.version+=1;}
  const finished=Object.freeze({...run,state,finishedAt:now,costUnits,outcomeCode});
  this.#runs.set(key,finished);agent.activeRunId=null;return finished;
 }

 pause({identity,agentId,reasonCode,assignments,now}){this.#manage(identity,assignments,now);bounded(reasonCode,'Reason code',code);const agent=this.#agent(identity,agentId);agent.state='PAUSED';agent.pauseReason=reasonCode;agent.version+=1;return this.#view(agent);}
 resume({identity,agentId,expectedVersion,assignments,now}){
  this.#manage(identity,assignments,now);const agent=this.#agent(identity,agentId);
  ensure(expectedVersion===agent.version,'STALE_AGENT','Agent version changed');ensure(agent.state==='PAUSED','AGENT_ACTIVE','Agent is not paused');
  agent.state='ACTIVE';agent.pauseReason=null;agent.version+=1;agent.nextRunAt=Math.max(agent.nextRunAt,now);return this.#view(agent);
 }
 /** Tenant-wide kill switch: blocks every new run until lifted. */
 setTenantPause({identity,paused,assignments,now}){this.#manage(identity,assignments,now);ensure(typeof paused==='boolean',code,'Pause flag must be boolean');if(paused)this.#paused.add(identity.tenantId);else this.#paused.delete(identity.tenantId);return Object.freeze({tenantId:identity.tenantId,paused});}
 /** Tenant-wide run history for cost reporting (BNK-032). */
 usage({identity,assignments,now}){this.#worker(identity,assignments,now);for(const agent of this.#agents.values())if(agent.tenantId===identity.tenantId)this.#expire(agent,now);return Object.freeze([...this.#runs.values()].filter(run=>run.tenantId===identity.tenantId));}
 /** Internal lookup for the tool router: the run record, or null. */
 runRecord({tenantId,runId}){return this.#runs.get(`${tenantId}:${runId}`)??null;}
 runs({identity,agentId,assignments,now}){this.#worker(identity,assignments,now);const agent=this.#agent(identity,agentId);this.#expire(agent,now);return Object.freeze([...this.#runs.values()].filter(run=>run.tenantId===identity.tenantId&&run.agentId===agentId));}
}
