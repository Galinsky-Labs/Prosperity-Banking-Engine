import {bounded,ensure} from '../runtime/guards.mjs';

const code='INVALID_ALLOCATION';

/**
 * BNK-032 allocation fairness. Weighted max-min fair ("water-filling") allocation of integer capacity units
 * across project demands: no project gets more than it asked for, and spare capacity is redistributed by weight.
 * Remainders go to the largest fractional shares, ties broken by project ID, so results are deterministic.
 */
export function allocateFairly({capacityUnits,demands}){
 ensure(Number.isSafeInteger(capacityUnits)&&capacityUnits>=0,code,'Capacity must be a nonnegative integer');
 ensure(Array.isArray(demands)&&demands.length>=1&&demands.length<=1_000,code,'Bounded demands are required');
 const items=demands.map(demand=>{bounded(demand?.projectId,'Project ID',code);ensure(Number.isSafeInteger(demand.demandUnits)&&demand.demandUnits>=0&&Number.isInteger(demand.weight)&&demand.weight>=1&&demand.weight<=100,code,'Demand and weight are invalid');return {projectId:demand.projectId,demand:demand.demandUnits,weight:demand.weight,allocated:0};});
 ensure(new Set(items.map(item=>item.projectId)).size===items.length,code,'Project IDs must be unique');
 let remaining=capacityUnits,active=items.filter(item=>item.demand>0);
 while(remaining>0&&active.length){
  const totalWeight=active.reduce((sum,item)=>sum+item.weight,0);
  const shares=active.map(item=>({item,exact:remaining*item.weight/totalWeight}));
  const saturated=shares.filter(({item,exact})=>item.demand-item.allocated<=exact);
  if(saturated.length){for(const {item} of saturated){remaining-=item.demand-item.allocated;item.allocated=item.demand;}active=active.filter(item=>item.allocated<item.demand);continue;}
  let given=0;for(const share of shares){const whole=Math.floor(share.exact);share.item.allocated+=whole;given+=whole;}
  let leftover=remaining-given;remaining=0;
  for(const share of shares.sort((left,right)=>(right.exact%1)-(left.exact%1)||(left.item.projectId<right.item.projectId?-1:1))){if(leftover===0)break;if(share.item.allocated<share.item.demand){share.item.allocated+=1;leftover-=1;}}
  remaining=leftover;active=active.filter(item=>item.allocated<item.demand);
 }
 const allocations=items.map(item=>Object.freeze({projectId:item.projectId,demandUnits:item.demand,weight:item.weight,allocatedUnits:item.allocated,satisfiedBps:item.demand===0?10_000:Math.floor(item.allocated*10_000/item.demand)}));
 const normalized=allocations.filter(item=>item.demandUnits>0).map(item=>item.allocatedUnits/item.weight);
 const sum=normalized.reduce((total,value)=>total+value,0),squares=normalized.reduce((total,value)=>total+value*value,0);
 return Object.freeze({capacityUnits,allocatedUnits:allocations.reduce((total,item)=>total+item.allocatedUnits,0),unusedUnits:remaining,allocations:Object.freeze(allocations),jainIndexX1000:normalized.length&&squares>0?Math.round(sum*sum/(normalized.length*squares)*1_000):1_000,method:'weighted-max-min',syntheticOnly:true});
}

/** Tenant-scoped cost report by project and agent for a time window, with each project's share of spend. */
export function costReport({tenantId,usage,from,to}){
 ensure(/^tenant_[a-z0-9_-]+$/.test(tenantId??''),code,'Tenant is required');ensure(Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&from<to,code,'Window is invalid');
 ensure(Array.isArray(usage)&&usage.length<=100_000,code,'Usage is bounded');
 const projects=new Map();let total=0;
 for(const record of usage){
  if(record.tenantId!==tenantId||record.at<from||record.at>=to)continue;
  ensure(Number.isSafeInteger(record.costUnits)&&record.costUnits>=0,code,'Cost units must be nonnegative integers');bounded(record.projectId,'Project ID',code);bounded(record.agentId,'Agent ID',code);
  const project=projects.get(record.projectId)??{projectId:record.projectId,costUnits:0,runs:0,agents:new Map()};
  project.costUnits+=record.costUnits;project.runs+=1;project.agents.set(record.agentId,(project.agents.get(record.agentId)??0)+record.costUnits);total+=record.costUnits;projects.set(record.projectId,project);
 }
 const rows=[...projects.values()].sort((left,right)=>right.costUnits-left.costUnits||(left.projectId<right.projectId?-1:1)).map(project=>Object.freeze({projectId:project.projectId,costUnits:project.costUnits,runs:project.runs,shareBps:total?Math.round(project.costUnits*10_000/total):0,byAgent:Object.freeze(Object.fromEntries([...project.agents].sort()))}));
 return Object.freeze({tenantId,from,to,totalCostUnits:total,projects:Object.freeze(rows),syntheticOnly:true});
}
