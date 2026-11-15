import {StepUpApprovals} from './step-up.mjs';
import {bounded,ensure} from './runtime/guards.mjs';

const code='INVALID_PAYMENT';
const DAY=86_400_000;
const FLOW=Object.freeze({CREATED:['AUTHORIZED','CANCELLED'],AUTHORIZED:['SUBMITTED','CANCELLED'],SUBMITTED:['SETTLED','FAILED'],SETTLED:['RETURNED'],FAILED:[],CANCELLED:[],RETURNED:[]});
const RETURN_CODES=new Set(['R01-insufficient-funds','R02-account-closed','R03-no-account','R10-unauthorized','R29-corporate-unauthorized']);

/**
 * BNK-035 payment lifecycle and returns on a sandbox rail. Authorization consumes a BNK-019 step-up approval bound to
 * the payment's exact terms and initiator; states follow a fixed machine; returns
 * are accepted only after settlement within the return window and produce a reversal instruction. The rail is
 * simulated: nothing reaches a real payment network.
 */
export class SandboxPaymentLifecycle {
 #rail;#returnWindowDays;#maxAmountMinor;#payments=new Map();#requests=new Map();
 constructor({rail='sandbox-ach',returnWindowDays=60,maxAmountMinor=1_000_000}){
  ensure(rail.startsWith('sandbox-'),'LIVE_RAIL_DENIED','Only sandbox rails are available in this engine build');
  ensure(Number.isInteger(returnWindowDays)&&returnWindowDays>=1&&returnWindowDays<=120&&Number.isSafeInteger(maxAmountMinor)&&maxAmountMinor>0,code,'Lifecycle bounds are invalid');
  this.#rail=rail;this.#returnWindowDays=returnWindowDays;this.#maxAmountMinor=maxAmountMinor;
 }
 #key(tenantId,paymentId){return `${tenantId}:${paymentId}`;}
 #get(tenantId,paymentId){const payment=this.#payments.get(this.#key(tenantId,bounded(paymentId,'Payment ID',code)));ensure(payment,'PAYMENT_NOT_FOUND','Payment does not exist');return payment;}
 #move(payment,state,changes,now){
  ensure(FLOW[payment.state].includes(state),'PAYMENT_TRANSITION',`Cannot move from ${payment.state} to ${state}`);
  const next=Object.freeze({...payment,...changes,state,version:payment.version+1,history:Object.freeze([...payment.history,Object.freeze({state,at:now})])});
  this.#payments.set(this.#key(payment.tenantId,payment.paymentId),next);return next;
 }

 create({tenantId,requestId,paymentId,fromAccount,toPayee,amountMinor,currency,initiator,now}){
  ensure(/^tenant_[a-z0-9_-]+$/.test(tenantId??''),code,'Tenant is required');bounded(requestId,'Request ID',code);bounded(paymentId,'Payment ID',code);bounded(fromAccount,'From account',code);bounded(toPayee,'Payee',code);
  ensure(Number.isSafeInteger(amountMinor)&&amountMinor>0&&amountMinor<=this.#maxAmountMinor,'PAYMENT_LIMIT','Amount must be positive and within the sandbox limit');
  ensure(typeof currency==='string'&&/^[A-Z]{3}$/.test(currency),code,'Currency is required');bounded(initiator?.issuer,'Initiator issuer',code);bounded(initiator?.subject,'Initiator subject',code);
  const terms={amountMinor,currency,fromAccount,toPayee},digest=JSON.stringify([paymentId,terms,initiator]);
  const replay=this.#requests.get(`${tenantId}:${requestId}`);if(replay){ensure(replay.digest===digest,'REPLAY_MISMATCH','Payment request replay has different terms');return this.#payments.get(replay.key);}
  ensure(!this.#payments.has(this.#key(tenantId,paymentId)),'PAYMENT_CONFLICT','Payment already exists');
  const payment=Object.freeze({tenantId,paymentId,rail:this.#rail,terms:Object.freeze(terms),initiator:Object.freeze({...initiator}),state:'CREATED',version:1,approval:null,settledAt:null,returnInfo:null,history:Object.freeze([Object.freeze({state:'CREATED',at:now})]),realFundsMoved:false,syntheticOnly:true});
  this.#payments.set(this.#key(tenantId,paymentId),payment);this.#requests.set(`${tenantId}:${requestId}`,{digest,key:this.#key(tenantId,paymentId)});return payment;
 }

 /** Consumes the BNK-019 approval bound to this payment's exact terms and initiator; single use, then authorizes. */
 authorize({tenantId,paymentId,stepUp,identity,challengeId,now}){
  const payment=this.#get(tenantId,paymentId);
  ensure(stepUp instanceof StepUpApprovals,'STEP_UP_REQUIRED','The step-up approval service is required');
  ensure(identity?.tenantId===tenantId,'STEP_UP_REQUIRED','Step-up evidence must come from the payment tenant');
  ensure(payment.state==='CREATED','PAYMENT_TRANSITION',`Cannot authorize from ${payment.state}`);
  const evidence=StepUpApprovals.prototype.consume.call(stepUp,{identity,challengeId,actionType:'synthetic-payment',terms:payment.terms,initiator:payment.initiator,now});
  return this.#move(payment,'AUTHORIZED',{approval:Object.freeze({challengeId:evidence.challengeId,digest:evidence.digest,approvedBy:evidence.approvedBy,consumedAt:evidence.consumedAt})},now);
 }
 submit({tenantId,paymentId,now}){return this.#move(this.#get(tenantId,paymentId),'SUBMITTED',{},now);}
 settle({tenantId,paymentId,now}){return this.#move(this.#get(tenantId,paymentId),'SETTLED',{settledAt:now},now);}
 fail({tenantId,paymentId,reasonCode,now}){bounded(reasonCode,'Reason code',code);return this.#move(this.#get(tenantId,paymentId),'FAILED',{failure:reasonCode},now);}
 cancel({tenantId,paymentId,now}){return this.#move(this.#get(tenantId,paymentId),'CANCELLED',{},now);}

 receiveReturn({tenantId,paymentId,returnCode,now}){
  const payment=this.#get(tenantId,paymentId);ensure(RETURN_CODES.has(returnCode),code,'Return code is unsupported');
  ensure(payment.state==='SETTLED','PAYMENT_TRANSITION','Only settled payments can be returned');
  ensure(now-payment.settledAt<=this.#returnWindowDays*DAY,'RETURN_WINDOW_CLOSED','Return arrived after the return window');
  const reversal=Object.freeze({direction:'credit',account:payment.terms.fromAccount,amountMinor:payment.terms.amountMinor,currency:payment.terms.currency,requiresAdapterExecution:true});
  return this.#move(payment,'RETURNED',{returnInfo:Object.freeze({returnCode,receivedAt:now,reversal,unauthorizedClaim:returnCode.startsWith('R10')||returnCode.startsWith('R29')})},now);
 }
 get({tenantId,paymentId}){return this.#get(tenantId,paymentId);}
}
