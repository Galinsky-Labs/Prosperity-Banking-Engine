import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {DisputeService,createDisputeContract} from '../src/disputes.mjs';

const DAY=86_400_000,now=500*DAY;
const identityFor=async(subject,{methods=['passkey','device'],tenantId='tenant_alpha'}={})=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+200*DAY,authenticationMethods:methods}));
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'disputes-v1',rules:[{action:'disputes.file',permission:'disputes:file'},{action:'disputes.work',permission:'disputes:work'},{action:'disputes.decide',permission:'disputes:decide'}]}),rolePolicy:createRolePolicy([{name:'customer',permissions:['disputes:file']},{name:'agent',permissions:['disputes:work','disputes:decide']},{name:'banker',permissions:['disputes:work','disputes:decide','disputes:file']}])});
const as=(identity,role)=>[{tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,role,validFrom:0,validUntil:now+300*DAY,revoked:false}];
const contract=createDisputeContract({version:'disputes-v1',actions:{file:'disputes.file',work:'disputes.work',decide:'disputes.decide'},reasonCodes:['unauthorized','not-received','duplicate'],acknowledgeDays:2,provisionalDecisionDays:10,resolveDays:45,filingWindowDays:60});
const txn={transactionId:'txn-9',accountId:'checking',currency:'USD',signedAmountMinor:-4_200,direction:'debit',descriptionCode:'synthetic-merchant',bookedAt:now-5*DAY,status:'posted',syntheticOnly:true};
const setup=async()=>({service:new DisputeService({contract,gateway}),customer:await identityFor('customer-1'),agent:await identityFor('agent-1',{methods:['workload','device']}),banker:await identityFor('banker-1')});

test('a filed dispute becomes a human-acknowledged, human-resolved case with deadlines',async()=>{
 const {service,customer,agent,banker}=await setup();
 const filed=service.file({identity:customer,requestId:'r1',disputeId:'d-1',reasonCode:'not-received',transaction:txn,assignments:as(customer,'customer'),now});
 assert.equal(filed.amountMinor,4_200);assert.equal(filed.deadlines.acknowledgeBy,now+2*DAY);
 assert.equal(service.file({identity:customer,requestId:'r1',disputeId:'d-1',reasonCode:'not-received',transaction:txn,assignments:as(customer,'customer'),now}),filed);
 const [ticket]=service.queue({identity:banker,assignments:as(banker,'banker'),now});assert.equal(ticket.kind,'dispute');assert.equal(ticket.overdue,false);
 assert.throws(()=>service.claim({identity:agent,ticketId:ticket.ticketId,assignments:as(agent,'agent'),now}),{code:'HUMAN_REQUIRED'});
 service.claim({identity:banker,ticketId:ticket.ticketId,assignments:as(banker,'banker'),now:now+3*DAY});
 let dispute=service.get({identity:customer,disputeId:'d-1',assignments:as(customer,'customer'),now});
 assert.equal(dispute.state,'ACKNOWLEDGED');assert.equal(dispute.acknowledgedLate,true);
 dispute=service.addDraftNote({identity:agent,disputeId:'d-1',noteCode:'merchant-evidence-summary',expectedVersion:dispute.version,assignments:as(agent,'agent'),now});
 assert.equal(dispute.notes[0].draft,true);
 assert.throws(()=>service.decideProvisionalCredit({identity:agent,disputeId:'d-1',grant:true,expectedVersion:dispute.version,assignments:as(agent,'agent'),now}),{code:'HUMAN_REQUIRED'});
 dispute=service.decideProvisionalCredit({identity:banker,disputeId:'d-1',grant:true,expectedVersion:dispute.version,assignments:as(banker,'banker'),now:now+4*DAY});
 assert.equal(dispute.provisionalCredit.amountMinor,4_200);assert.equal(dispute.provisionalCredit.requiresAdapterExecution,true);
 assert.throws(()=>service.resolve({identity:agent,disputeId:'d-1',outcome:'customer-favor',expectedVersion:dispute.version,assignments:as(agent,'agent'),now}),{code:'HUMAN_REQUIRED'});
 dispute=service.resolve({identity:banker,disputeId:'d-1',outcome:'merchant-favor',expectedVersion:dispute.version,assignments:as(banker,'banker'),now:now+20*DAY});
 assert.equal(dispute.outcome.reverseProvisionalCredit,true);assert.equal(dispute.state,'RESOLVED');
 assert.deepEqual(service.queue({identity:banker,assignments:as(banker,'banker'),now}),[]);
 assert.deepEqual(dispute.history.map(event=>event.event),['FILED','ACKNOWLEDGED','NOTE_ADDED','PROVISIONAL_DECIDED','RESOLVED']);
});

test('validates evidence, windows, duplicates, separation of duties and visibility',async()=>{
 const {service,customer,banker}=await setup();
 const base={identity:customer,requestId:'r1',disputeId:'d-1',reasonCode:'unauthorized',transaction:txn,assignments:as(customer,'customer'),now};
 assert.throws(()=>service.file({...base,transaction:{...txn,signedAmountMinor:500}}),/Only debits/);
 assert.throws(()=>service.file({...base,transaction:{...txn,status:'pending'}}),{code:'INVALID_DISPUTE_EVIDENCE'});
 assert.throws(()=>service.file({...base,transaction:{...txn,bookedAt:now-61*DAY}}),{code:'DISPUTE_WINDOW_CLOSED'});
 assert.throws(()=>service.file({...base,reasonCode:'changed-mind'}),/reason code/);
 service.file(base);
 assert.throws(()=>service.file({...base,requestId:'r2',disputeId:'d-2'}),{code:'DISPUTE_CONFLICT'});
 assert.throws(()=>service.file({...base,reasonCode:'duplicate'}),{code:'REPLAY_MISMATCH'});
 const selfFiled=service.file({...base,identity:banker,requestId:'r3',disputeId:'d-3',transaction:{...txn,transactionId:'txn-10'},assignments:as(banker,'banker')});
 service.claim({identity:banker,ticketId:'dispute-d-3',assignments:as(banker,'banker'),now});
 assert.throws(()=>service.resolve({identity:banker,disputeId:'d-3',outcome:'customer-favor',expectedVersion:selfFiled.version+1,assignments:as(banker,'banker'),now}),{code:'SEPARATION_OF_DUTIES'});
 const other=await identityFor('customer-2');
 assert.throws(()=>service.get({identity:other,disputeId:'d-1',assignments:as(other,'customer'),now}),{code:'DISPUTE_DENIED'});
 const beta=await identityFor('banker-1',{tenantId:'tenant_beta'});
 assert.deepEqual(service.queue({identity:beta,assignments:as(beta,'banker'),now}),[]);
 assert.throws(()=>service.resolve({identity:banker,disputeId:'d-1',outcome:'customer-favor',expectedVersion:1,assignments:as(banker,'banker'),now}),{code:'DISPUTE_STATE'});
});

test('chat and agent escalations queue for humans with urgent items first',async()=>{
 const {service,agent,banker}=await setup();
 service.handoff({identity:agent,ticketId:'chat-1',kind:'chat',refId:'conversation-1',reasonCode:'ACTION_REQUEST',assignments:as(agent,'agent'),now});
 service.handoff({identity:agent,ticketId:'fraud-1',kind:'fraud-suspicion',refId:'txn-1',reasonCode:'pattern',priority:'urgent',assignments:as(agent,'agent'),now});
 assert.throws(()=>service.handoff({identity:agent,ticketId:'x',kind:'self-approve',refId:'r',reasonCode:'c',assignments:as(agent,'agent'),now}),/kind/);
 const queue=service.queue({identity:banker,assignments:as(banker,'banker'),now:now+5*3_600_000});
 assert.deepEqual(queue.map(ticket=>ticket.ticketId),['fraud-1','chat-1']);assert.equal(queue[0].overdue,true);
 assert.equal(service.claim({identity:banker,ticketId:'fraud-1',assignments:as(banker,'banker'),now}).assignee,'banker-1');
 assert.throws(()=>service.claim({identity:banker,ticketId:'fraud-1',assignments:as(banker,'banker'),now}),{code:'TICKET_STATE'});
});
