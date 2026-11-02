import {EngineError} from './index.mjs';
import {FakeBankLedger} from './bank-adapter.mjs';
import {assertVerifiedIdentity} from './identity.mjs';
import {PolicyGateway} from './policy-gateway.mjs';

const ensure=(condition,code,message)=>{if(!condition)throw new EngineError(code,message);};
const ID=/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const CURRENCY=/^[A-Z]{3}$/;
const compiledContracts=new WeakSet();
const bounded=(value,label)=>{ensure(typeof value==='string'&&ID.test(value),'INVALID_TRANSACTION_QUERY',`${label} is required`);return value;};
const activeIdentity=(identity,now)=>{assertVerifiedIdentity(identity);ensure(Number.isSafeInteger(now)&&now>=identity.authenticatedAt&&identity.expiresAt>now,'IDENTITY_EXPIRED','Active verified identity is required');};

export function createTransactionNormalizerContract({version,action,maxTransactions}){
 bounded(version,'Normalizer version');bounded(action,'Normalizer action');
 ensure(Number.isInteger(maxTransactions)&&maxTransactions>=1&&maxTransactions<=500,'INVALID_TRANSACTION_CONTRACT','Transaction bound is invalid');
 const contract=Object.freeze({version,action,maxTransactions,sourceStatuses:Object.freeze(['posted']),syntheticOnly:true});compiledContracts.add(contract);return contract;
}

export class TransactionNormalizer {
 #contract;#gateway;#adapter;
 constructor({contract,gateway,adapter}){
  ensure(compiledContracts.has(contract),'INVALID_TRANSACTION_CONTRACT','Compiled transaction normalizer contract is required');
  ensure(gateway instanceof PolicyGateway,'INVALID_TRANSACTION_CONTRACT','Policy gateway is required');
  ensure(adapter instanceof FakeBankLedger,'INVALID_TRANSACTION_CONTRACT','Bank adapter is required');
  this.#contract=contract;this.#gateway=gateway;this.#adapter=adapter;
 }

 #authorize(identity,assignments,now){
  activeIdentity(identity,now);
  const decision=PolicyGateway.prototype.decide.call(this.#gateway,{identity,action:this.#contract.action,resourceTenantId:identity.tenantId,assignments,now});
  ensure(decision?.allow===true&&decision.action===this.#contract.action&&decision.tenantId===identity.tenantId&&decision.subject===identity.subject,'TRANSACTION_DENIED','Exact transaction authorization is required');
 }

 list({identity,accountId,assignments,consentLedger=null,consentId=null,limit=this.#contract.maxTransactions,now=Date.now()}){
  this.#authorize(identity,assignments,now);bounded(accountId,'Account ID');
  ensure(Number.isInteger(limit)&&limit>=1&&limit<=this.#contract.maxTransactions,'INVALID_TRANSACTION_QUERY','Transaction limit is invalid');
  const entries=FakeBankLedger.prototype.listEntries.call(this.#adapter,{identity,accountId,assignments,consentLedger,consentId,limit:this.#contract.maxTransactions,now});
  const normalized=entries.map(entry=>{
   ensure(entry.tenantId===identity.tenantId&&entry.accountId===accountId,'INVALID_TRANSACTION_EVIDENCE','Adapter entry boundary is invalid');
   ensure((entry.direction==='credit'||entry.direction==='debit')&&Number.isSafeInteger(entry.amountMinor)&&entry.amountMinor>0,'INVALID_TRANSACTION_EVIDENCE','Adapter amount evidence is invalid');
   ensure(typeof entry.currency==='string'&&CURRENCY.test(entry.currency),'INVALID_TRANSACTION_EVIDENCE','Adapter currency evidence is invalid');
   ensure(Number.isSafeInteger(entry.postedAt)&&entry.postedAt>=0&&entry.postedAt<=now,'INVALID_TRANSACTION_EVIDENCE','Adapter posting time is invalid');
   const signedAmountMinor=entry.direction==='credit'?entry.amountMinor:-entry.amountMinor;
   ensure(Number.isSafeInteger(signedAmountMinor),'AMOUNT_OVERFLOW','Normalized amount exceeds safe integer bounds');
   return Object.freeze({transactionId:entry.entryId,accountId:entry.accountId,currency:entry.currency,signedAmountMinor,direction:entry.direction,descriptionCode:entry.descriptionCode,bookedAt:entry.postedAt,status:'posted',sourceReference:entry.entryKey,normalizerVersion:this.#contract.version,syntheticOnly:true});
  }).sort((left,right)=>left.bookedAt-right.bookedAt||(left.transactionId<right.transactionId?-1:left.transactionId>right.transactionId?1:0));
  return Object.freeze(normalized.slice(0,limit));
 }
}
