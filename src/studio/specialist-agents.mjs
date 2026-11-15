import {authorizeDataUse} from '../data-classification.mjs';
import {bounded,ensure} from '../runtime/guards.mjs';

const code='INVALID_SPECIALIST';
const FORBIDDEN=/^(payments?|transfer|ledger|bank|credit|fees?|overdraft|step-up|invest|equity|disputes?)[.:-]/;
const SPECIALTIES=Object.freeze(['market-research','pricing','technical-feasibility','ip-spotting','sprint-planning','funding-readiness']);

/**
 * BNK-024 specialist agents and tools. Tools are pure, registered functions with declared input data categories.
 * A specialist may call only tools in its profile, only inside a running BNK-015 scheduler run that grants the
 * tool, only for a project it can access, and only with model-eligible data. Outputs are AI drafts that a human
 * must adopt before they become claims or decisions.
 */
export class SpecialistToolRouter {
 #tools=new Map();#profiles=new Map();#projectAccess;#calls=[];
 constructor({projectAccess}){ensure(typeof projectAccess==='function',code,'A project access check is required');this.#projectAccess=projectAccess;}

 registerTool({name,dataCategory,maxInputBytes=8_192,run}){
  bounded(name,'Tool name',code);ensure(!FORBIDDEN.test(name),'FORBIDDEN_TOOL','Specialist tools cannot move money, touch ledgers, credit, fees, overdraft, approvals, investments or disputes');
  ensure(typeof run==='function'&&!this.#tools.has(name),code,'Tool must be new and runnable');
  ensure(Number.isInteger(maxInputBytes)&&maxInputBytes>=1&&maxInputBytes<=65_536,code,'Input bound is invalid');
  this.#tools.set(name,Object.freeze({name,dataCategory,maxInputBytes,run}));
 }

 registerSpecialist({agentId,specialty,tools}){
  bounded(agentId,'Agent ID',code);ensure(SPECIALTIES.includes(specialty),code,'Specialty is unsupported');
  ensure(Array.isArray(tools)&&tools.length>=1&&tools.length<=16&&tools.every(tool=>this.#tools.has(tool)),code,'Specialists use registered tools only');
  ensure(!this.#profiles.has(agentId),code,'Specialist already exists');
  const profile=Object.freeze({agentId,specialty,tools:Object.freeze([...new Set(tools)].sort())});this.#profiles.set(agentId,profile);return profile;
 }

 async invoke({run,projectId,tool,input,now}){
  ensure(run&&run.state==='RUNNING'&&Number.isSafeInteger(run.deadline)&&now<run.deadline,'RUN_REQUIRED','An active scheduler run is required');
  const profile=this.#profiles.get(run.agentId);ensure(profile,'SPECIALIST_NOT_FOUND','Specialist is not registered');
  ensure(profile.tools.includes(tool),'TOOL_NOT_ALLOWED','Tool is not in the specialist profile');
  ensure(Array.isArray(run.capabilities)&&run.capabilities.includes(`tool:${tool}`),'TOOL_NOT_ALLOWED','The scheduler run does not grant this tool');
  bounded(projectId,'Project ID',code);
  ensure(await this.#projectAccess({tenantId:run.tenantId,projectId,agentId:run.agentId})===true,'PROJECT_DENIED','Specialist has no access to this project');
  const definition=this.#tools.get(tool);
  authorizeDataUse({category:definition.dataCategory,tenantId:run.tenantId,operation:'model_input'});
  const serialized=JSON.stringify(input??null);ensure(Buffer.byteLength(serialized)<=definition.maxInputBytes,'TOOL_INPUT_TOO_LARGE','Tool input exceeds its bound');
  const output=await definition.run(JSON.parse(serialized));
  const record=Object.freeze({tenantId:run.tenantId,projectId,agentId:run.agentId,runId:run.runId,tool,at:now,aiDraft:true,requiresHumanAdoption:true,output:Object.freeze(output),syntheticOnly:true});
  this.#calls.push(Object.freeze({tenantId:run.tenantId,projectId,agentId:run.agentId,runId:run.runId,tool,at:now}));return record;
 }

 callLog({tenantId}){return Object.freeze(this.#calls.filter(call=>call.tenantId===tenantId));}
}
