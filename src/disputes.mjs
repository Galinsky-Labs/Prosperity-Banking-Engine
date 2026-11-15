import {PolicyGateway} from './policy-gateway.mjs';
import {isNonHumanIdentity} from './step-up.mjs';
import {bounded,ensure,requireDecision} from './runtime/guards.mjs';

const code='INVALID_DISPUTE';
const DAY=86_400_000;
const compiledContracts=new WeakSet();
const OUTCOMES=new Set(['customer-favor','merchant-favor','withdrawn']);

export function createDisputeContract({version,actions,reasonCodes,acknowledgeDays,provisionalDecisionDays,resolveDays,filingWindowDays}){
 bounded(version,'Dispute version',code);
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,code,'Dispute actions are required');
 const normalizedActions=Object.freeze(Object.fromEntries(['file','work','decide'].map(key=>[key,bounded(actions[key],`${key} action`,code)])));
 ensure(new Set(Object.values(normalizedActions)).size===3,code,'Dispute actions must differ');
 ensure(Array.isArray(reasonCodes)&&reasonCodes.length>=1&&reasonCodes.length<=32,code,'Reason codes are required');
 for(const [value,label] of [[acknowledgeDays,'Acknowledgement'],[provisionalDecisionDays,'Provisional decision'],[resolveDays,'Resolution'],[filingWindowDays,'Filing window']])ensure(Number.isInteger(value)&&value>=1&&value<=365,code,`${label} days are invalid`);
 ensure(acknowledgeDays<=provisionalDecisionDays&&provisionalDecisionDays<=resolveDays,code,'Deadlines must be ordered');
 const contract=Object.freeze({version,actions:normalizedActions,reasonCodes:Object.freeze([...new Set(reasonCodes.map(reason=>bounded(reason,'Reason code',code)))]),acknowledgeDays,provisionalDecisionDays,resolveDays,filingWindowDays,syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}

/**
 * BNK-020 disputes with human handoff. Customers dispute their own posted debits using normalized
 * transaction evidence. Every dispute and every escalation from chat or agents becomes a human handoff
 * ticket with deadlines. Agents may add draft notes only; claiming, provisional-credit decisions and
 * resolution need a human, and the resolver cannot be the filer. Nothing here moves money.
 */
export class DisputeService {
 #contract;#gateway;#disputes=new Map();#tickets=new Map();#requests=new Map();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),code,'Compiled dispute contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }

 #authorize(identity,action,assignments,now){requireDecision(this.#gateway,{identity,action,assignments,now},'DISPUTE_DENIED');}
 #human(identity){ensure(!isNonHumanIdentity(identity),'HUMAN_REQUIRED','A human staff member is required');}
 #dispute(identity,disputeId){bounded(disputeId,'Dispute ID',code);const dispute=this.#disputes.get(`${identity.tenantId}:${disputeId}`);ensure(dispute,'DISPUTE_NOT_FOUND','Dispute does not exist');return dispute;}
 #update(dispute,expectedVersion,changes,event,actor,now){
  ensure(expectedVersion===dispute.version,'STALE_DISPUTE','Dispute version changed');
  const next=Object.freeze({...dispute,...changes,version:dispute.version+1,history:Object.freeze([...dispute.history,Object.freeze({event,actor,at:now,version:dispute.version+1})])});
  this.#disputes.set(`${dispute.tenantId}:${dispute.disputeId}`,next);return next;
 }
 #ticket({tenantId,ticketId,kind,refId,reasonCode,priority,dueAt,now}){
  const ticket=Object.freeze({tenantId,ticketId,kind,refId,reasonCode,priority,state:'QUEUED',assignee:null,createdAt:now,dueAt,syntheticOnly:true});
  this.#tickets.set(`${tenantId}:${ticketId}`,ticket);return ticket;
 }

 file({identity,requestId,disputeId,reasonCode,transaction,assignments,now}){
  this.#authorize(identity,this.#contract.actions.file,assignments,now);bounded(requestId,'Request ID',code);bounded(disputeId,'Dispute ID',code);
  ensure(this.#contract.reasonCodes.includes(reasonCode),code,'Known reason code is required');
  ensure(transaction?.status==='posted'&&transaction.syntheticOnly===true,'INVALID_DISPUTE_EVIDENCE','Normalized posted transaction evidence is required');
  bounded(transaction.transactionId,'Transaction ID',code);bounded(transaction.accountId,'Account ID',code);
  ensure(Number.isSafeInteger(transaction.signedAmountMinor)&&transaction.signedAmountMinor<0,'INVALID_DISPUTE_EVIDENCE','Only debits can be disputed');
  ensure(Number.isSafeInteger(transaction.bookedAt)&&transaction.bookedAt<=now,'INVALID_DISPUTE_EVIDENCE','Booking time is invalid');
  ensure(now-transaction.bookedAt<=this.#contract.filingWindowDays*DAY,'DISPUTE_WINDOW_CLOSED','The filing window for this transaction has closed');
  const requestKey=`${identity.tenantId}:${requestId}`,digest=JSON.stringify([identity.issuer,identity.subject,disputeId,reasonCode,transaction.transactionId,transaction.signedAmountMinor]);
  const replay=this.#requests.get(requestKey);if(replay){ensure(replay.digest===digest,'REPLAY_MISMATCH','Dispute request replay has different terms');return this.#disputes.get(replay.key);}
  const key=`${identity.tenantId}:${disputeId}`;ensure(!this.#disputes.has(key),'DISPUTE_CONFLICT','Dispute already exists');
  ensure(![...this.#disputes.values()].some(other=>other.tenantId===identity.tenantId&&other.transactionId===transaction.transactionId&&other.state!=='RESOLVED'),'DISPUTE_CONFLICT','This transaction already has an open dispute');
  const deadlines=Object.freeze({acknowledgeBy:now+this.#contract.acknowledgeDays*DAY,provisionalDecisionBy:now+this.#contract.provisionalDecisionDays*DAY,resolveBy:now+this.#contract.resolveDays*DAY});
  const dispute=Object.freeze({tenantId:identity.tenantId,disputeId,filer:Object.freeze({issuer:identity.issuer,subject:identity.subject}),reasonCode,transactionId:transaction.transactionId,accountId:transaction.accountId,currency:transaction.currency,amountMinor:-transaction.signedAmountMinor,state:'FILED',deadlines,provisionalCredit:null,outcome:null,notes:Object.freeze([]),version:1,filedAt:now,history:Object.freeze([Object.freeze({event:'FILED',actor:identity.subject,at:now,version:1})]),syntheticOnly:true});
  this.#disputes.set(key,dispute);this.#requests.set(requestKey,{digest,key});
  this.#ticket({tenantId:identity.tenantId,ticketId:`dispute-${disputeId}`,kind:'dispute',refId:disputeId,reasonCode,priority:'standard',dueAt:deadlines.acknowledgeBy,now});
  return dispute;
 }

 /** Escalation path for chat (BNK-014), hardship and agents: always lands with a human. */
 handoff({identity,ticketId,kind,refId,reasonCode,priority='standard',assignments,now}){
  this.#authorize(identity,this.#contract.actions.work,assignments,now);bounded(ticketId,'Ticket ID',code);bounded(refId,'Reference ID',code);bounded(reasonCode,'Reason code',code);
  ensure(['chat','agent','hardship','fraud-suspicion','complaint'].includes(kind),code,'Handoff kind is unsupported');
  ensure(priority==='standard'||priority==='urgent',code,'Priority is invalid');
  ensure(!this.#tickets.has(`${identity.tenantId}:${ticketId}`),'TICKET_CONFLICT','Ticket already exists');
  return this.#ticket({tenantId:identity.tenantId,ticketId,kind,refId,reasonCode,priority,dueAt:now+(priority==='urgent'?4*3_600_000:DAY),now});
 }

 queue({identity,assignments,now}){
  this.#authorize(identity,this.#contract.actions.work,assignments,now);
  return Object.freeze([...this.#tickets.values()].filter(ticket=>ticket.tenantId===identity.tenantId&&ticket.state!=='CLOSED').map(ticket=>Object.freeze({...ticket,overdue:now>ticket.dueAt})).sort((left,right)=>(left.priority===right.priority?0:left.priority==='urgent'?-1:1)||left.dueAt-right.dueAt));
 }

 claim({identity,ticketId,assignments,now}){
  this.#authorize(identity,this.#contract.actions.work,assignments,now);this.#human(identity);
  const key=`${identity.tenantId}:${bounded(ticketId,'Ticket ID',code)}`,ticket=this.#tickets.get(key);ensure(ticket,'TICKET_NOT_FOUND','Ticket does not exist');
  ensure(ticket.state==='QUEUED','TICKET_STATE','Ticket is already claimed');
  const claimed=Object.freeze({...ticket,state:'CLAIMED',assignee:identity.subject,claimedAt:now});this.#tickets.set(key,claimed);
  if(ticket.kind==='dispute'){const dispute=this.#dispute(identity,ticket.refId);if(dispute.state==='FILED')this.#update(dispute,dispute.version,{state:'ACKNOWLEDGED',acknowledgedLate:now>dispute.deadlines.acknowledgeBy},'ACKNOWLEDGED',identity.subject,now);}
  return claimed;
 }

 addDraftNote({identity,disputeId,noteCode,expectedVersion,assignments,now}){
  this.#authorize(identity,this.#contract.actions.work,assignments,now);bounded(noteCode,'Note code',code);
  const dispute=this.#dispute(identity,disputeId);ensure(dispute.state!=='RESOLVED','DISPUTE_STATE','Dispute is resolved');
  ensure(dispute.notes.length<50,code,'Note limit reached');
  return this.#update(dispute,expectedVersion,{notes:Object.freeze([...dispute.notes,Object.freeze({noteCode,author:identity.subject,draft:isNonHumanIdentity(identity),at:now})])},'NOTE_ADDED',identity.subject,now);
 }

 decideProvisionalCredit({identity,disputeId,grant,expectedVersion,assignments,now}){
  this.#authorize(identity,this.#contract.actions.decide,assignments,now);this.#human(identity);
  const dispute=this.#dispute(identity,disputeId);ensure(dispute.state==='ACKNOWLEDGED','DISPUTE_STATE','Dispute must be acknowledged by a human first');
  ensure(dispute.provisionalCredit===null,'DISPUTE_STATE','Provisional credit was already decided');ensure(typeof grant==='boolean',code,'Grant decision must be boolean');
  const provisionalCredit=Object.freeze({granted:grant,amountMinor:grant?dispute.amountMinor:0,currency:dispute.currency,decidedBy:identity.subject,decidedAt:now,late:now>dispute.deadlines.provisionalDecisionBy,requiresAdapterExecution:grant});
  return this.#update(dispute,expectedVersion,{provisionalCredit},'PROVISIONAL_DECIDED',identity.subject,now);
 }

 resolve({identity,disputeId,outcome,expectedVersion,assignments,now}){
  this.#authorize(identity,this.#contract.actions.decide,assignments,now);this.#human(identity);
  const dispute=this.#dispute(identity,disputeId);ensure(dispute.state==='ACKNOWLEDGED','DISPUTE_STATE','Only acknowledged disputes can be resolved');
  ensure(!(dispute.filer.issuer===identity.issuer&&dispute.filer.subject===identity.subject),'SEPARATION_OF_DUTIES','The filer cannot resolve their own dispute');
  ensure(OUTCOMES.has(outcome),code,'Outcome is invalid');
  const resolved=this.#update(dispute,expectedVersion,{state:'RESOLVED',outcome:Object.freeze({outcome,resolvedBy:identity.subject,resolvedAt:now,late:now>dispute.deadlines.resolveBy,reverseProvisionalCredit:outcome==='merchant-favor'&&dispute.provisionalCredit?.granted===true,requiresAdapterExecution:true})},'RESOLVED',identity.subject,now);
  const ticketKey=`${identity.tenantId}:dispute-${disputeId}`,ticket=this.#tickets.get(ticketKey);if(ticket)this.#tickets.set(ticketKey,Object.freeze({...ticket,state:'CLOSED',closedAt:now}));
  return resolved;
 }

 get({identity,disputeId,assignments,now}){
  const dispute=this.#dispute(identity,disputeId);
  try{this.#authorize(identity,this.#contract.actions.work,assignments,now);return dispute;}catch{}
  this.#authorize(identity,this.#contract.actions.file,assignments,now);
  ensure(dispute.filer.issuer===identity.issuer&&dispute.filer.subject===identity.subject,'DISPUTE_DENIED','Only the filer or staff can view this dispute');return dispute;
 }
}
