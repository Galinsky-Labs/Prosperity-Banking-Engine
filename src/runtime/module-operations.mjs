import {ConsentLedger} from '../consent-ledger.mjs';
import {TenantAuditSink,createAuditSinkContract} from '../audit-sink.mjs';
import {AgentScheduler,createAgentSchedulerContract} from '../agent-scheduler.mjs';
import {HardshipCaseService,createHardshipContract} from '../hardship.mjs';
import {OverdraftEnrollment,createOverdraftEnrollmentContract,createOverdraftPolicy,disclosureDigest,evaluateOverdraft} from '../overdraft.mjs';
import {StepUpApprovals,createStepUpContract} from '../step-up.mjs';
import {DisputeService,createDisputeContract} from '../disputes.mjs';
import {FounderRegistry,createFounderContract,studioUsePermitted,termsDigestOf} from '../studio/founders.mjs';
import {ProjectWorkspace,createProjectContract} from '../studio/projects.mjs';
import {ClaimsLedger,createClaimsContract} from '../studio/claims-ledger.mjs';
import {SpecialistToolRouter} from '../studio/specialist-agents.mjs';
import {assessFeasibility,runFeasibilityExperiment} from '../studio/feasibility.mjs';
import {summarizeMarketValidation} from '../studio/market-validation.mjs';
import {computeUnitEconomics,unitEconomicsSensitivity} from '../studio/unit-economics.mjs';
import {spotIssues} from '../studio/issue-spotting.mjs';
import {SprintBoard} from '../studio/sprints.mjs';
import {IndependentVerification} from '../studio/verification.mjs';
import {FundingReferrals,createFundingCatalog} from '../studio/funding.mjs';
import {allocateFairly,costReport} from '../studio/fairness.mjs';
import {SyntheticOnboarding,createIdentityScreeningAdapter} from '../partners/identity-screening.mjs';
import {depositAvailability,reconcile} from '../reconciliation.mjs';
import {SandboxPaymentLifecycle} from '../payments.mjs';
import {bounded,ensure,requireDecision} from './guards.mjs';

const pick=(body,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]));
const DAY=86_400_000;
export const OVERDRAFT_DISCLOSURE_TEXT='SYNTHETIC DEMO DISCLOSURE v1. Overdraft coverage is off unless you turn it on for each payment type. If you turn it on, a synthetic fee may apply when a covered item overdraws your account. You can turn coverage off at any time. Not a real bank disclosure.';
export const STUDIO_TERMS_TEXT='SYNTHETIC DEMO STUDIO TERMS v1. You keep ownership of your ideas, code and other work. The studio uses your work only as your chosen licence allows and never to commercialize, publish or train models. Not reviewed legal terms.';

export const MODULE_GATEWAY_RULES=Object.freeze([
 {action:'agents.manage',permission:'agents:manage'},{action:'agents.run',permission:'agents:run'},
 {action:'hardship.request',permission:'hardship:request'},{action:'hardship.draft',permission:'hardship:draft'},{action:'hardship.decide',permission:'hardship:decide',requiresMfa:true},
 {action:'overdraft.read',permission:'overdraft:read'},{action:'overdraft.change',permission:'overdraft:change',requiresMfa:true},
 {action:'stepup.request',permission:'stepup:request'},{action:'stepup.approve',permission:'stepup:approve',requiresMfa:true},
 {action:'disputes.file',permission:'disputes:file'},{action:'disputes.work',permission:'disputes:work'},{action:'disputes.decide',permission:'disputes:decide'},
 {action:'studio.founder',permission:'studio:founder'},{action:'studio.review',permission:'studio:review'},{action:'studio.projects',permission:'studio:projects'},{action:'studio.tools',permission:'studio:tools'},
 {action:'claims.write',permission:'claims:write'},{action:'claims.read',permission:'claims:read'},{action:'verification.decide',permission:'verification:decide'},
 {action:'funding.refer',permission:'funding:refer'},{action:'onboarding.apply',permission:'onboarding:apply'},{action:'onboarding.review',permission:'onboarding:review'},
 {action:'payments.initiate',permission:'payments:initiate'},{action:'payments.operate',permission:'payments:operate'},
 {action:'reconcile.run',permission:'reconcile:run'},{action:'reports.read',permission:'reports:read'}
]);

/**
 * Build the engine's journaled module operations. `write` operations are journaled and replayed; `apply` must be
 * synchronous and deterministic given (verified actor, time, resolved body, module state). `prepare` may read the
 * store and resolve server-side evidence, which is then journaled in place of caller input.
 * `services` gives prepare steps read access to ledger snapshots and account ownership.
 */
export function createModuleOperations({gateway,services=null}){
 const guard=(ctx,action,code='MODULE_DENIED')=>requireDecision(gateway,{identity:ctx.identity,action,assignments:ctx.assignments,now:ctx.now},code);
 const base=ctx=>({identity:ctx.identity,assignments:ctx.assignments,now:ctx.now});

 const consents=new ConsentLedger();
 const audit=new TenantAuditSink({contract:createAuditSinkContract({version:'audit-v1',actions:{read:'audit.read',write:'audit.write'},attributeKeys:['accountRef','amountMinor','channel','reasonCode']}),gateway});
 const scheduler=new AgentScheduler({contract:createAgentSchedulerContract({version:'sched-v1',actions:{manage:'agents.manage',run:'agents.run'},allowedCapabilities:['bank.home.read','bank.cashflow.forecast','chat.draft','tool:market.segment-sizer','tool:pricing.unit-economics','tool:ip.issue-spotter']}),gateway});
 const hardship=new HardshipCaseService({contract:createHardshipContract({version:'hardship-v1',actions:{request:'hardship.request',draft:'hardship.draft',decide:'hardship.decide'},reasonCodes:['job-loss','medical','disaster','income-reduction','other'],options:[{optionCode:'defer-90',kind:'payment-deferral',maxDurationDays:90},{optionCode:'waive-od-fees',kind:'fee-waiver',maxDurationDays:90},{optionCode:'payment-plan-6m',kind:'payment-plan',maxDurationDays:180},{optionCode:'counselling-referral',kind:'referral',maxDurationDays:30}],disclosureVersion:'hardship-disclosure-v1'}),gateway});
 const overdraftContract=createOverdraftEnrollmentContract({version:'enroll-v1',actions:{read:'overdraft.read',change:'overdraft.change'},disclosure:{version:'od-disclosure-v1',digest:disclosureDigest(OVERDRAFT_DISCLOSURE_TEXT)}});
 const overdraft=new OverdraftEnrollment({contract:overdraftContract,gateway});
 const overdraftPolicy=createOverdraftPolicy({version:'od-policy-v1',currency:'USD',rails:{atm:'cover-with-opt-in','one-time-debit':'cover-with-opt-in','recurring-debit':'cover-with-opt-in',ach:'cover-no-fee',check:'decline'},feeMinor:1_500,deMinimisMinor:500,maxFeesPerDay:2,maxOverdraftMinor:50_000});
 const stepUp=new StepUpApprovals({contract:createStepUpContract({version:'stepup-v1',actions:{request:'stepup.request',approve:'stepup.approve'},actionTypes:[{actionType:'synthetic-payment',requiresSecondApprover:false,maxAmountMinor:500_000},{actionType:'synthetic-large-payment',requiresSecondApprover:true,maxAmountMinor:5_000_000}]}),gateway});
 const disputes=new DisputeService({contract:createDisputeContract({version:'disputes-v1',actions:{file:'disputes.file',work:'disputes.work',decide:'disputes.decide'},reasonCodes:['unauthorized','not-received','duplicate','incorrect-amount'],acknowledgeDays:2,provisionalDecisionDays:10,resolveDays:45,filingWindowDays:60}),gateway});
 const founders=new FounderRegistry({contract:createFounderContract({version:'founders-v1',actions:{onboard:'studio.founder',review:'studio.review'},termsVersion:'studio-terms-v1',termsDigest:termsDigestOf(STUDIO_TERMS_TEXT)}),gateway});
 const projects=new ProjectWorkspace({contract:createProjectContract({version:'projects-v1',action:'studio.projects'}),gateway});
 const claims=new ClaimsLedger({contract:createClaimsContract({version:'claims-v1',actions:{write:'claims.write',read:'claims.read'}}),gateway});
 const verification=new IndependentVerification({gateway,ledger:claims,action:'verification.decide'});
 const tools=new SpecialistToolRouter({projectAccess:async({tenantId,projectId})=>{const founderId=projects.founderOf({tenantId,projectId});const posture=founderId&&founders.postureOf({tenantId,founderId});return Boolean(posture)&&studioUsePermitted(posture,'evaluate');}});
 tools.registerTool({name:'market.segment-sizer',dataCategory:'synthetic_test_data',run:async input=>summarizeMarketValidation(input)});
 tools.registerTool({name:'pricing.unit-economics',dataCategory:'synthetic_test_data',run:async input=>computeUnitEconomics(input)});
 tools.registerTool({name:'ip.issue-spotter',dataCategory:'synthetic_test_data',run:async input=>spotIssues(input)});
 tools.registerSpecialist({agentId:'market-agent',specialty:'market-research',tools:['market.segment-sizer']});
 tools.registerSpecialist({agentId:'pricing-agent',specialty:'pricing',tools:['pricing.unit-economics']});
 tools.registerSpecialist({agentId:'ip-agent',specialty:'ip-spotting',tools:['ip.issue-spotter']});
 const sprintBoards=new Map();
 const funding=new FundingReferrals({catalog:createFundingCatalog([
  {programId:'synthetic-micro-grant',kind:'grant',criteria:{stages:['idea','pre-revenue'],sectors:['any'],regions:['any'],minVerifiedClaims:1,maxMonthlyRevenueMinor:500_000},referralCompensation:{type:'none',disclosure:'The engine receives no compensation for this synthetic referral.'}},
  {programId:'synthetic-accelerator',kind:'accelerator',criteria:{stages:['pre-revenue','revenue'],sectors:['any'],regions:['any'],minVerifiedClaims:2,maxMonthlyRevenueMinor:null},referralCompensation:{type:'none',disclosure:'The engine receives no compensation for this synthetic referral.'}},
  {programId:'synthetic-angel-network',kind:'investor-referral',criteria:{stages:['revenue'],sectors:['any'],regions:['any'],minVerifiedClaims:3,maxMonthlyRevenueMinor:null},referralCompensation:{type:'fixed',disclosure:'The tenant may receive a fixed synthetic referral fee.'}}
 ]),gateway,action:'funding.refer'});
 const onboarding=new SyntheticOnboarding({adapter:createIdentityScreeningAdapter(),gateway,action:'onboarding.review'});
 const payments=new SandboxPaymentLifecycle({rail:'sandbox-ach',returnWindowDays:60,maxAmountMinor:1_000_000});

 const heldOrStaff=async(ctx,accountIds)=>{if(!services)return;const held=await services.heldAccounts(ctx.identity);if(held!==null)for(const accountId of accountIds)ensure(held.includes(accountId),'ACCOUNT_NOT_FOUND','Synthetic account does not exist');};
 const projectWriter=(ctx,projectId)=>{const project=projects.get({...base(ctx),projectId});const member=project.members.find(item=>item.issuer===ctx.identity.issuer&&item.subject===ctx.identity.subject);ensure(member&&member.role!=='mentor','PROJECT_DENIED','Project role does not allow this');return project;};
 const board=(ctx,projectId)=>{const key=`${ctx.identity.tenantId}:${projectId}`;if(!sprintBoards.has(key))sprintBoards.set(key,new SprintBoard({projectId,wipLimit:3}));return sprintBoards.get(key);};
 const verifiedClaims=(ctx,projectId)=>claims.entries({...base(ctx),projectId}).filter(entry=>entry.kind==='CLAIM').filter(entry=>claims.status({...base(ctx),projectId,claimId:entry.claimId}).state==='VERIFIED').length;
 const paymentOf=(ctx,paymentId)=>{const payment=payments.get({tenantId:ctx.identity.tenantId,paymentId});return payment;};
 const ownPayment=(ctx,paymentId)=>{const payment=paymentOf(ctx,paymentId);ensure(payment.initiator.issuer===ctx.identity.issuer&&payment.initiator.subject===ctx.identity.subject,'PAYMENT_NOT_FOUND','Payment does not exist');return payment;};

 const W=(apply,prepare)=>({write:true,apply,...(prepare?{prepare}:{})});
 const R=(apply,prepare)=>({write:false,apply,...(prepare?{prepare}:{})});
 const operations={
  'consents.grant':W((ctx,body)=>{guard(ctx,'consents.manage','CONSENT_DENIED');return consents.grant(ctx.identity,{...pick(body,['consentId','scopes','purpose','policyVersion','expiresAt','requestId']),now:ctx.now});}),
  'consents.revoke':W((ctx,body)=>{guard(ctx,'consents.manage','CONSENT_DENIED');return consents.revoke(ctx.identity,{...pick(body,['consentId','expectedVersion','reason','requestId']),now:ctx.now});}),
  'consents.history':R((ctx,body)=>{guard(ctx,'consents.manage','CONSENT_DENIED');return {events:consents.history(ctx.identity,body.consentId),syntheticOnly:true};}),
  'consents.check':R((ctx,body)=>{guard(ctx,'consents.manage','CONSENT_DENIED');return {permitted:consents.permits(ctx.identity,{consentId:body.consentId,scope:body.scope,now:ctx.now}),syntheticOnly:true};}),
  'audit.append':W((ctx,body)=>audit.append({...pick(body,['requestId','recordId','eventType','outcome','correlationId','attributes','occurredAt']),...base(ctx)})),
  'audit.list':R((ctx,body)=>({records:audit.list({...pick(body,['eventType','afterSequence','limit']),...base(ctx)}),syntheticOnly:true})),

  'agents.register':W((ctx,body)=>scheduler.register({...pick(body,['agentId','purposeCode','capabilities','intervalMs','maxRunMs','budget']),...base(ctx)})),
  'agents.pause':W((ctx,body)=>scheduler.pause({...pick(body,['agentId','reasonCode']),...base(ctx)})),
  'agents.resume':W((ctx,body)=>scheduler.resume({...pick(body,['agentId','expectedVersion']),...base(ctx)})),
  'agents.tenant-pause':W((ctx,body)=>scheduler.setTenantPause({...pick(body,['paused']),...base(ctx)})),
  'agents.due':R(ctx=>({agents:scheduler.due(base(ctx)),syntheticOnly:true})),
  'agents.start-run':W((ctx,body)=>scheduler.startRun({...pick(body,['agentId','runId','projectId']),...base(ctx)})),
  'agents.finish-run':W((ctx,body)=>scheduler.finishRun({...pick(body,['agentId','runId','costUnits','outcomeCode']),...base(ctx)})),
  'agents.budget':R((ctx,body)=>scheduler.budgetStatus({...pick(body,['agentId']),...base(ctx)})),
  'agents.runs':R((ctx,body)=>({runs:scheduler.runs({...pick(body,['agentId']),...base(ctx)}),syntheticOnly:true})),

  'hardship.open':W((ctx,body)=>hardship.openCase({...pick(body,['requestId','caseId','reasonCodes','accountIds']),...base(ctx)}),async(ctx,body)=>{await heldOrStaff(ctx,Array.isArray(body.accountIds)?body.accountIds:[]);return body;}),
  'hardship.draft':W((ctx,body)=>hardship.draftProposals({...pick(body,['caseId','proposals','expectedVersion']),...base(ctx)})),
  'hardship.approve':W((ctx,body)=>hardship.approveOffer({...pick(body,['caseId','optionCodes','expectedVersion']),...base(ctx)})),
  'hardship.respond':W((ctx,body)=>hardship.respond({...pick(body,['caseId','decision','optionCode','affirmative','disclosureVersion','expectedVersion']),...base(ctx)})),
  'hardship.get':R((ctx,body)=>hardship.get({...pick(body,['caseId']),...base(ctx)})),
  'hardship.collections-paused':R((ctx,body)=>({paused:hardship.collectionsPaused({...pick(body,['accountId']),...base(ctx)}),syntheticOnly:true})),

  'overdraft.disclosure':R(()=>({version:overdraftContract.disclosure.version,digest:overdraftContract.disclosure.digest,text:OVERDRAFT_DISCLOSURE_TEXT,syntheticOnly:true})),
  'overdraft.status':R((ctx,body)=>overdraft.status({...pick(body,['accountId']),...base(ctx)}),async(ctx,body)=>{await heldOrStaff(ctx,[body.accountId]);return body;}),
  'overdraft.opt-in':W((ctx,body)=>overdraft.optIn({...pick(body,['requestId','accountId','rails','affirmative','disclosureVersion','disclosureDigest','consentId','expectedVersion']),consentLedger:consents,...base(ctx)}),async(ctx,body)=>{await heldOrStaff(ctx,[body.accountId]);return body;}),
  'overdraft.revoke':W((ctx,body)=>overdraft.revoke({...pick(body,['accountId','rails']),rails:body.rails??null,...base(ctx)})),
  'overdraft.evaluate':R((ctx,body)=>{guard(ctx,'overdraft.read','OVERDRAFT_DENIED');return evaluateOverdraft(overdraftPolicy,{rail:body.rail,currency:'USD',amountMinor:body.amountMinor,availableMinor:body.availableMinor,feeBearingCoverage:overdraft.feeBearingCoverage({identity:ctx.identity,accountId:body.accountId,rail:body.rail,consentLedger:consents,now:ctx.now}),feesChargedToday:0,forcePost:body.forcePost===true});},
   async(ctx,body)=>{await heldOrStaff(ctx,[body.accountId]);const account=await services.readAccount(ctx.identity,{accountId:body.accountId});return {...pick(body,['accountId','rail','amountMinor','forcePost']),availableMinor:account.balanceMinor};}),

  'stepup.request':W((ctx,body)=>stepUp.request({...pick(body,['requestId','challengeId','actionType','terms']),...base(ctx)})),
  'stepup.approve':W((ctx,body)=>stepUp.approve({...pick(body,['challengeId','digest']),...base(ctx)})),

  'disputes.file':W((ctx,body)=>disputes.file({...pick(body,['requestId','disputeId','reasonCode','transaction']),...base(ctx)}),
   async(ctx,body)=>{bounded(body.accountId,'Account ID');await heldOrStaff(ctx,[body.accountId]);const transaction=(await services.transactions(ctx.identity,{accountId:body.accountId,limit:500})).find(item=>item.transactionId===body.transactionId);ensure(transaction,'TRANSACTION_NOT_FOUND','Transaction does not exist');return {...pick(body,['requestId','disputeId','reasonCode']),transaction};}),
  'disputes.handoff':W((ctx,body)=>disputes.handoff({...pick(body,['ticketId','kind','refId','reasonCode','priority']),...base(ctx)})),
  'disputes.queue':R(ctx=>({tickets:disputes.queue(base(ctx)),syntheticOnly:true})),
  'disputes.claim':W((ctx,body)=>disputes.claim({...pick(body,['ticketId']),...base(ctx)})),
  'disputes.note':W((ctx,body)=>disputes.addDraftNote({...pick(body,['disputeId','noteCode','expectedVersion']),...base(ctx)})),
  'disputes.provisional':W((ctx,body)=>disputes.decideProvisionalCredit({...pick(body,['disputeId','grant','expectedVersion']),...base(ctx)})),
  'disputes.resolve':W((ctx,body)=>disputes.resolve({...pick(body,['disputeId','outcome','expectedVersion']),...base(ctx)})),
  'disputes.get':R((ctx,body)=>disputes.get({...pick(body,['disputeId']),...base(ctx)})),

  'founders.terms':R(()=>({termsVersion:'studio-terms-v1',termsDigest:termsDigestOf(STUDIO_TERMS_TEXT),text:STUDIO_TERMS_TEXT,syntheticOnly:true})),
  'founders.onboard':W((ctx,body)=>founders.onboard({...pick(body,['founderId','affirmative','termsVersion','termsDigest','ipPosture']),...base(ctx)})),
  'founders.declare-ip':W((ctx,body)=>founders.declarePriorIp({...pick(body,['assetId','assetKind','contentDigest','expectedVersion']),...base(ctx)})),
  'founders.license':W((ctx,body)=>founders.changeLicense({...pick(body,['ipPosture','expectedVersion']),...base(ctx)})),
  'founders.profile':R(ctx=>founders.profile(base(ctx))),
  'founders.lookup':R((ctx,body)=>founders.lookup({...pick(body,['founderId']),...base(ctx)})),

  'projects.create':W((ctx,body)=>{const founder=founders.profile(base(ctx));return projects.create({...pick(body,['projectId','titleCode']),founderId:founder.founderId,...base(ctx)});}),
  'projects.add-member':W((ctx,body)=>projects.addMember({...pick(body,['projectId','member','expectedVersion']),...base(ctx)})),
  'projects.remove-member':W((ctx,body)=>projects.removeMember({...pick(body,['projectId','subject','expectedVersion']),...base(ctx)})),
  'projects.add-milestone':W((ctx,body)=>projects.addMilestone({...pick(body,['projectId','milestoneId','outcomeCode','dueAt','expectedVersion']),...base(ctx)})),
  'projects.move-milestone':W((ctx,body)=>projects.moveMilestone({...pick(body,['projectId','milestoneId','state','evidenceRefs','expectedVersion']),...base(ctx)})),
  'projects.get':R((ctx,body)=>projects.get({...pick(body,['projectId']),...base(ctx)})),
  'projects.list':R(ctx=>({projects:projects.list(base(ctx)),syntheticOnly:true})),

  'claims.submit':W((ctx,body)=>{projectWriter(ctx,body.projectId);return claims.submit({...pick(body,['requestId','projectId','claimId','claimType','metric','evidence','aiDrafted','humanAdopted']),...base(ctx)});}),
  'claims.retract':W((ctx,body)=>claims.retract({...pick(body,['projectId','claimId','reasonCode']),...base(ctx)})),
  'claims.status':R((ctx,body)=>{projects.get({...base(ctx),projectId:body.projectId});return claims.status({...pick(body,['projectId','claimId']),...base(ctx)});}),
  'claims.entries':R((ctx,body)=>{projects.get({...base(ctx),projectId:body.projectId});return {entries:claims.entries({...pick(body,['projectId']),...base(ctx)}),chainValid:claims.verifyChain({...pick(body,['projectId']),...base(ctx)}),syntheticOnly:true};}),

  'verification.enroll':W((ctx,body)=>verification.enroll({...pick(body,['conflicts']),...base(ctx)})),
  'verification.assign':W((ctx,body)=>{const project=projectWriter(ctx,body.projectId);return verification.assign({identity:ctx.identity,verificationId:body.verificationId,projectId:project.projectId,founderId:project.founderId,claimId:body.claimId,projectMembers:project.members,readerAssignments:ctx.assignments,now:ctx.now});}),
  'verification.decide':W((ctx,body)=>verification.decide({...pick(body,['verificationId','observedDigests','verdict','reasonCode']),...base(ctx)})),

  'tools.invoke':R(async(ctx,body)=>{guard(ctx,'studio.tools','TOOL_DENIED');guard(ctx,'agents.run','TOOL_DENIED');const run=scheduler.runRecord({tenantId:ctx.identity.tenantId,runId:body.runId});ensure(run&&run.worker===ctx.identity.subject,'RUN_REQUIRED','An active run started by this agent is required');ensure(run.projectId===body.projectId,'PROJECT_DENIED','The run is bound to a different project');return tools.invoke({run,projectId:body.projectId,tool:body.tool,input:body.input,now:ctx.now});}),
  'feasibility.run':R((ctx,body)=>{guard(ctx,'studio.projects');return runFeasibilityExperiment(pick(body,['experimentId','expression','inputs','timeoutMs']));}),
  'feasibility.assess':R((ctx,body)=>{guard(ctx,'studio.projects');return assessFeasibility(pick(body,['criteria','experiments']));}),
  'market.summarize':R((ctx,body)=>{guard(ctx,'studio.projects');return summarizeMarketValidation(pick(body,['responses','signalThresholdBps','minSample']));}),
  'economics.compute':R((ctx,body)=>{guard(ctx,'studio.projects');return computeUnitEconomics(pick(body,['currency','priceMinor','variableCostMinor','paymentFeeBps','cacMinor','monthlyChurnBps']));}),
  'economics.sensitivity':R((ctx,body)=>{guard(ctx,'studio.projects');return {rows:unitEconomicsSensitivity(pick(body.base??{},['currency','priceMinor','variableCostMinor','paymentFeeBps','cacMinor','monthlyChurnBps'])),syntheticOnly:true};}),
  'issues.spot':R((ctx,body)=>{guard(ctx,'studio.projects');projects.get({...base(ctx),projectId:body.projectId});return spotIssues(pick(body,['projectId','profile','dependencies','distribution']));}),

  'sprints.plan':W((ctx,body)=>{projectWriter(ctx,body.projectId);return board(ctx,body.projectId).plan(pick(body,['sprintId','startsAt','days','capacityPoints','items']));}),
  'sprints.add-item':W((ctx,body)=>{projectWriter(ctx,body.projectId);return board(ctx,body.projectId).addItem({...pick(body,['sprintId','itemId','points']),now:ctx.now});}),
  'sprints.move':W((ctx,body)=>{projectWriter(ctx,body.projectId);return board(ctx,body.projectId).move({...pick(body,['sprintId','itemId','state']),now:ctx.now});}),
  'sprints.close':W((ctx,body)=>{projectWriter(ctx,body.projectId);return board(ctx,body.projectId).close({...pick(body,['sprintId']),now:ctx.now});}),
  'sprints.burndown':R((ctx,body)=>{projects.get({...base(ctx),projectId:body.projectId});return {points:board(ctx,body.projectId).burndown(pick(body,['sprintId'])),syntheticOnly:true};}),
  'sprints.velocity':R((ctx,body)=>{projects.get({...base(ctx),projectId:body.projectId});return board(ctx,body.projectId).velocity();}),

  'funding.match':R((ctx,body)=>{const project=projects.get({...base(ctx),projectId:body.projectId});return {matches:funding.match({profile:{...pick(body.profile??{},['stage','sector','region','monthlyRevenueMinor']),verifiedClaimCount:verifiedClaims(ctx,project.projectId)}}),syntheticOnly:true};}),
  'funding.refer':W((ctx,body)=>{const project=projectWriter(ctx,body.projectId);return funding.refer({...pick(body,['referralId','programId','sharedFields','affirmative','acknowledgedNotices']),profile:{...pick(body.profile??{},['stage','sector','region','monthlyRevenueMinor','projectSummary','contactEmail']),verifiedClaimCount:verifiedClaims(ctx,project.projectId)},...base(ctx)});}),
  'fairness.allocate':R((ctx,body)=>{guard(ctx,'agents.manage');return allocateFairly(pick(body,['capacityUnits','demands']));}),
  'fairness.cost-report':R((ctx,body)=>{guard(ctx,'agents.manage');const usage=scheduler.usage(base(ctx)).filter(run=>run.costUnits!==null).map(run=>({tenantId:run.tenantId,projectId:run.projectId??'unassigned',agentId:run.agentId,costUnits:run.costUnits,at:run.startedAt}));return costReport({tenantId:ctx.identity.tenantId,usage,from:body.from??0,to:body.to??ctx.now+1});}),

  'onboarding.start':W((ctx,body)=>{guard(ctx,'onboarding.apply','ONBOARDING_DENIED');return onboarding.recordOutcome({identity:ctx.identity,applicantId:body.applicantId,idv:body.idv,screening:body.screening,consentLedger:consents,consentId:body.consentId,now:ctx.now});},
   async(ctx,body)=>{guard(ctx,'onboarding.apply','ONBOARDING_DENIED');ensure(consents.permits(ctx.identity,{consentId:body.consentId,scope:'identity:verify',now:ctx.now}),'CONSENT_REQUIRED','Applicant consent for identity verification is required');const outcome=await onboarding.screenApplicant(pick(body.applicant??{},['applicantId','fullName','dateOfBirth','documentNumber']));return {applicantId:outcome.applicantId,idv:outcome.idv,screening:outcome.screening,consentId:body.consentId};}),
  'onboarding.review':W((ctx,body)=>onboarding.review({...pick(body,['applicantId','outcome','reasonCode']),...base(ctx)})),

  'reconcile.run':R((ctx,body)=>{guard(ctx,'reconcile.run','RECONCILE_DENIED');return reconcile({currency:'USD',engineEntries:body.engineEntries,statement:body.statement});},
   async(ctx,body)=>{guard(ctx,'reconcile.run','RECONCILE_DENIED');const entries=await services.transactions(ctx.identity,{accountId:body.accountId,limit:500});return {engineEntries:entries.map(item=>({reference:item.transactionId,signedAmountMinor:item.signedAmountMinor,at:item.bookedAt})),statement:body.statement};}),
  'deposits.availability':R((ctx,body)=>{guard(ctx,'bank.accounts.read');return depositAvailability({...pick(body,['amountMinor','channel','accountAgeDays']),depositedAt:ctx.now,policy:{nextDayMinor:22_500,standardHoldDays:2,newAccountHoldDays:9,newAccountAgeDays:30,largeDepositMinor:550_000,largeDepositHoldDays:7}});}),

  'payments.create':W((ctx,body)=>{guard(ctx,'payments.initiate','PAYMENT_DENIED');return payments.create({...pick(body,['requestId','paymentId','fromAccount','toPayee','amountMinor','currency']),tenantId:ctx.identity.tenantId,initiator:{issuer:ctx.identity.issuer,subject:ctx.identity.subject},now:ctx.now});},async(ctx,body)=>{await heldOrStaff(ctx,[body.fromAccount]);return body;}),
  'payments.authorize':W((ctx,body)=>{guard(ctx,'payments.initiate','PAYMENT_DENIED');ownPayment(ctx,body.paymentId);return payments.authorize({tenantId:ctx.identity.tenantId,paymentId:body.paymentId,stepUp,identity:ctx.identity,challengeId:body.challengeId,now:ctx.now});}),
  'payments.cancel':W((ctx,body)=>{guard(ctx,'payments.initiate','PAYMENT_DENIED');ownPayment(ctx,body.paymentId);return payments.cancel({tenantId:ctx.identity.tenantId,paymentId:body.paymentId,now:ctx.now});}),
  'payments.submit':W((ctx,body)=>{guard(ctx,'payments.operate','PAYMENT_DENIED');return payments.submit({tenantId:ctx.identity.tenantId,paymentId:body.paymentId,now:ctx.now});}),
  'payments.settle':W((ctx,body)=>{guard(ctx,'payments.operate','PAYMENT_DENIED');return payments.settle({tenantId:ctx.identity.tenantId,paymentId:body.paymentId,now:ctx.now});}),
  'payments.fail':W((ctx,body)=>{guard(ctx,'payments.operate','PAYMENT_DENIED');return payments.fail({tenantId:ctx.identity.tenantId,paymentId:body.paymentId,reasonCode:body.reasonCode,now:ctx.now});}),
  'payments.return':W((ctx,body)=>{guard(ctx,'payments.operate','PAYMENT_DENIED');return payments.receiveReturn({tenantId:ctx.identity.tenantId,paymentId:body.paymentId,returnCode:body.returnCode,now:ctx.now});}),
  'payments.get':R((ctx,body)=>{try{guard(ctx,'payments.operate','PAYMENT_DENIED');return paymentOf(ctx,body.paymentId);}catch(error){if(error.code!=='PAYMENT_DENIED')throw error;}guard(ctx,'payments.initiate','PAYMENT_DENIED');return ownPayment(ctx,body.paymentId);})
 };
 for(const operation of Object.values(operations))ensure(typeof operation.apply==='function','INVALID_OPERATION','Operations need apply');
 return {operations:Object.freeze(operations),modules:{consents,audit,scheduler,hardship,overdraft,stepUp,disputes,founders,projects,claims,verification,tools,funding,onboarding,payments,sprintBoards}};
}
