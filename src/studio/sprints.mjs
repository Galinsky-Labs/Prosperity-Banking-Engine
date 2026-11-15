import {bounded,ensure} from '../runtime/guards.mjs';

const code='INVALID_SPRINT';
const DAY=86_400_000;
const FLOW=Object.freeze({TODO:['DOING'],DOING:['TODO','DONE'],DONE:[]});

/**
 * BNK-029 development sprints. A bounded sprint board per project: capacity-checked commitments, a WIP limit,
 * a fixed item flow, a daily burndown and velocity history. Scope added mid-sprint is tracked separately so
 * velocity is not inflated.
 */
export class SprintBoard {
 #projectId;#wipLimit;#sprints=new Map();
 constructor({projectId,wipLimit=3}){bounded(projectId,'Project ID',code);ensure(Number.isInteger(wipLimit)&&wipLimit>=1&&wipLimit<=20,code,'WIP limit is invalid');this.#projectId=projectId;this.#wipLimit=wipLimit;}
 #sprint(sprintId){const sprint=this.#sprints.get(bounded(sprintId,'Sprint ID',code));ensure(sprint,'SPRINT_NOT_FOUND','Sprint does not exist');return sprint;}

 plan({sprintId,startsAt,days,capacityPoints,items}){
  bounded(sprintId,'Sprint ID',code);ensure(!this.#sprints.has(sprintId),code,'Sprint already exists');
  ensure(Number.isSafeInteger(startsAt)&&Number.isInteger(days)&&days>=1&&days<=30&&Number.isInteger(capacityPoints)&&capacityPoints>=1&&capacityPoints<=500,code,'Sprint bounds are invalid');
  ensure([...this.#sprints.values()].every(sprint=>sprint.state==='CLOSED'),'SPRINT_ACTIVE','Close the current sprint first');
  ensure(Array.isArray(items)&&items.length>=1&&items.length<=100,code,'Sprint items are required');
  const normalized=items.map(item=>{bounded(item?.itemId,'Item ID',code);ensure(Number.isInteger(item.points)&&item.points>=1&&item.points<=40,code,'Item points must be 1 to 40');return {itemId:item.itemId,points:item.points,state:'TODO',addedMidSprint:false,doneAt:null};});
  ensure(new Set(normalized.map(item=>item.itemId)).size===normalized.length,code,'Item IDs must be unique');
  const committed=normalized.reduce((sum,item)=>sum+item.points,0);ensure(committed<=capacityPoints,'OVERCOMMITTED',`Committed ${committed} points exceeds capacity ${capacityPoints}`);
  this.#sprints.set(sprintId,{projectId:this.#projectId,sprintId,startsAt,endsAt:startsAt+days*DAY,days,capacityPoints,committedPoints:committed,items:normalized,state:'ACTIVE'});
  return this.view(sprintId);
 }

 addItem({sprintId,itemId,points,now}){
  const sprint=this.#sprint(sprintId);ensure(sprint.state==='ACTIVE','SPRINT_STATE','Sprint is closed');bounded(itemId,'Item ID',code);
  ensure(Number.isInteger(points)&&points>=1&&points<=40&&!sprint.items.some(item=>item.itemId===itemId),code,'Item must be new with 1 to 40 points');
  ensure(now>=sprint.startsAt&&now<sprint.endsAt,code,'Mid-sprint additions must happen during the sprint');
  sprint.items.push({itemId,points,state:'TODO',addedMidSprint:true,doneAt:null});return this.view(sprintId);
 }

 move({sprintId,itemId,state,now}){
  const sprint=this.#sprint(sprintId);ensure(sprint.state==='ACTIVE','SPRINT_STATE','Sprint is closed');
  const item=sprint.items.find(candidate=>candidate.itemId===itemId);ensure(item,'ITEM_NOT_FOUND','Item does not exist');
  ensure(FLOW[item.state].includes(state),'ITEM_TRANSITION',`Cannot move from ${item.state} to ${state}`);
  if(state==='DOING')ensure(sprint.items.filter(candidate=>candidate.state==='DOING').length<this.#wipLimit,'WIP_LIMIT','Work-in-progress limit reached');
  ensure(Number.isSafeInteger(now)&&now>=sprint.startsAt,code,'Time must be within the sprint');
  item.state=state;item.doneAt=state==='DONE'?now:null;return this.view(sprintId);
 }

 burndown({sprintId}){
  const sprint=this.#sprint(sprintId),total=sprint.items.reduce((sum,item)=>sum+item.points,0);
  return Object.freeze(Array.from({length:sprint.days+1},(_,day)=>{
   const at=sprint.startsAt+day*DAY,done=sprint.items.filter(item=>item.doneAt!==null&&item.doneAt<=at).reduce((sum,item)=>sum+item.points,0);
   return Object.freeze({day,remainingPoints:total-done,idealPoints:Math.round(sprint.committedPoints*(sprint.days-day)/sprint.days)});
  }));
 }

 close({sprintId,now}){
  const sprint=this.#sprint(sprintId);ensure(sprint.state==='ACTIVE','SPRINT_STATE','Sprint is already closed');ensure(now>=sprint.endsAt,'SPRINT_NOT_OVER','Sprint has not ended');
  sprint.state='CLOSED';
  for(const item of sprint.items)if(item.state!=='DONE')item.carriedOver=true;
  return this.view(sprintId);
 }

 velocity(){
  const closed=[...this.#sprints.values()].filter(sprint=>sprint.state==='CLOSED');
  const points=closed.map(sprint=>sprint.items.filter(item=>item.state==='DONE'&&!item.addedMidSprint).reduce((sum,item)=>sum+item.points,0));
  return Object.freeze({sprints:closed.length,committedDonePoints:Object.freeze(points),averagePoints:points.length?Math.round(points.reduce((sum,value)=>sum+value,0)/points.length):null});
 }

 view(sprintId){const sprint=this.#sprint(sprintId);return Object.freeze({...sprint,items:Object.freeze(sprint.items.map(item=>Object.freeze({...item}))),syntheticOnly:true});}
}
