import {PolicyGateway} from '../policy-gateway.mjs';
import {bounded,ensure,requireDecision} from '../runtime/guards.mjs';

const code='INVALID_PROJECT';
const compiledContracts=new WeakSet();
const MEMBER_ROLES=Object.freeze({owner:['read','write','manage'],collaborator:['read','write'],mentor:['read']});
const MILESTONE_FLOW=Object.freeze({PLANNED:['IN_PROGRESS','CANCELLED'],IN_PROGRESS:['SUBMITTED','CANCELLED'],SUBMITTED:['IN_PROGRESS'],CANCELLED:[]});

export function createProjectContract({version,action,maxProjectsPerFounder=10,maxMembers=12,maxMilestones=50}){
 bounded(version,'Project version',code);bounded(action,'Project action',code);
 for(const [value,max] of [[maxProjectsPerFounder,100],[maxMembers,50],[maxMilestones,200]])ensure(Number.isInteger(value)&&value>=1&&value<=max,code,'Project bounds are invalid');
 const contract=Object.freeze({version,action,maxProjectsPerFounder,maxMembers,maxMilestones,syntheticOnly:true});compiledContracts.add(contract);return contract;
}

/**
 * BNK-022 project workspaces and milestones. Every project is isolated by tenant and project; access comes only
 * from explicit membership. Milestones follow a fixed state machine. Submission needs evidence references, and
 * verification is deliberately absent: only BNK-030 independent verifiers can verify outcomes.
 */
export class ProjectWorkspace {
 #contract;#gateway;#projects=new Map();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),code,'Compiled project contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }
 #auth(identity,assignments,now){requireDecision(this.#gateway,{identity,action:this.#contract.action,assignments,now},'PROJECT_DENIED');}
 #project(identity,projectId,permission){
  bounded(projectId,'Project ID',code);const project=this.#projects.get(`${identity.tenantId}:${projectId}`);
  const member=project?.members.find(candidate=>candidate.issuer===identity.issuer&&candidate.subject===identity.subject);
  ensure(project&&member,'PROJECT_NOT_FOUND','Project does not exist or is not shared with you');
  ensure(MEMBER_ROLES[member.role].includes(permission),'PROJECT_DENIED','Project role does not allow this');
  return project;
 }
 #save(project,expectedVersion,changes){ensure(expectedVersion===project.version,'STALE_PROJECT','Project version changed');const next=Object.freeze({...project,...changes,version:project.version+1});this.#projects.set(`${project.tenantId}:${project.projectId}`,next);return next;}

 create({identity,projectId,founderId,titleCode,assignments,now}){
  this.#auth(identity,assignments,now);bounded(projectId,'Project ID',code);bounded(founderId,'Founder ID',code);bounded(titleCode,'Title code',code);
  const key=`${identity.tenantId}:${projectId}`;ensure(!this.#projects.has(key),'PROJECT_CONFLICT','Project already exists');
  ensure([...this.#projects.values()].filter(project=>project.tenantId===identity.tenantId&&project.founderId===founderId).length<this.#contract.maxProjectsPerFounder,'PROJECT_LIMIT','Founder project limit reached');
  const project=Object.freeze({tenantId:identity.tenantId,projectId,founderId,titleCode,members:Object.freeze([Object.freeze({issuer:identity.issuer,subject:identity.subject,role:'owner'})]),milestones:Object.freeze([]),ipOwner:'founder',version:1,createdAt:now,syntheticOnly:true});
  this.#projects.set(key,project);return project;
 }

 addMember({identity,projectId,member,expectedVersion,assignments,now}){
  this.#auth(identity,assignments,now);const project=this.#project(identity,projectId,'manage');
  ensure(member&&Object.hasOwn(MEMBER_ROLES,member.role)&&member.role!=='owner',code,'Member role must be collaborator or mentor');
  bounded(member.issuer,'Member issuer',code);bounded(member.subject,'Member subject',code);
  ensure(project.members.length<this.#contract.maxMembers&&!project.members.some(existing=>existing.issuer===member.issuer&&existing.subject===member.subject),code,'Member must be new and within the bound');
  return this.#save(project,expectedVersion,{members:Object.freeze([...project.members,Object.freeze({issuer:member.issuer,subject:member.subject,role:member.role})])});
 }

 removeMember({identity,projectId,subject,expectedVersion,assignments,now}){
  this.#auth(identity,assignments,now);const project=this.#project(identity,projectId,'manage');
  const remaining=project.members.filter(member=>!(member.subject===subject&&member.role!=='owner'));ensure(remaining.length<project.members.length,code,'Only existing non-owner members can be removed');
  return this.#save(project,expectedVersion,{members:Object.freeze(remaining)});
 }

 addMilestone({identity,projectId,milestoneId,outcomeCode,dueAt,expectedVersion,assignments,now}){
  this.#auth(identity,assignments,now);const project=this.#project(identity,projectId,'write');
  bounded(milestoneId,'Milestone ID',code);bounded(outcomeCode,'Outcome code',code);ensure(Number.isSafeInteger(dueAt)&&dueAt>now,code,'Due date must be in the future');
  ensure(project.milestones.length<this.#contract.maxMilestones&&!project.milestones.some(milestone=>milestone.milestoneId===milestoneId),code,'Milestone IDs must be unique and bounded');
  return this.#save(project,expectedVersion,{milestones:Object.freeze([...project.milestones,Object.freeze({milestoneId,outcomeCode,dueAt,state:'PLANNED',evidenceRefs:Object.freeze([]),updatedAt:now,updatedBy:identity.subject})])});
 }

 moveMilestone({identity,projectId,milestoneId,state,evidenceRefs=[],expectedVersion,assignments,now}){
  this.#auth(identity,assignments,now);const project=this.#project(identity,projectId,'write');
  const milestone=project.milestones.find(candidate=>candidate.milestoneId===milestoneId);ensure(milestone,'MILESTONE_NOT_FOUND','Milestone does not exist');
  ensure(state!=='VERIFIED','VERIFICATION_RESERVED','Only independent verification (BNK-030) can verify milestones');
  ensure((MILESTONE_FLOW[milestone.state]??[]).includes(state),'MILESTONE_TRANSITION',`Cannot move from ${milestone.state} to ${state}`);
  ensure(Array.isArray(evidenceRefs)&&evidenceRefs.length<=20,code,'Evidence references are bounded');
  const refs=evidenceRefs.map(ref=>bounded(ref,'Evidence reference',code));
  if(state==='SUBMITTED')ensure(refs.length>=1,'EVIDENCE_REQUIRED','Submission requires at least one evidence reference');
  const updated=Object.freeze({...milestone,state,evidenceRefs:Object.freeze(state==='SUBMITTED'?refs:milestone.evidenceRefs),overdueAtUpdate:now>milestone.dueAt,updatedAt:now,updatedBy:identity.subject});
  return this.#save(project,expectedVersion,{milestones:Object.freeze(project.milestones.map(candidate=>candidate.milestoneId===milestoneId?updated:candidate))});
 }

 /** Internal lookup for system components (tool router, verification): founder of a project, or null. */
 founderOf({tenantId,projectId}){return this.#projects.get(`${tenantId}:${projectId}`)?.founderId??null;}
 get({identity,projectId,assignments,now}){this.#auth(identity,assignments,now);return this.#project(identity,projectId,'read');}
 list({identity,assignments,now}){this.#auth(identity,assignments,now);return Object.freeze([...this.#projects.values()].filter(project=>project.tenantId===identity.tenantId&&project.members.some(member=>member.issuer===identity.issuer&&member.subject===identity.subject)));}
}
