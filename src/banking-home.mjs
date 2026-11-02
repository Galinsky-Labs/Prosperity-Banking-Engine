import {EngineError} from './index.mjs';
import {FakeBankLedger} from './bank-adapter.mjs';
import {assertVerifiedIdentity} from './identity.mjs';
import {PolicyGateway} from './policy-gateway.mjs';

const ensure=(condition,code,message)=>{if(!condition)throw new EngineError(code,message);};
const ID=/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const compiledContracts=new WeakSet();
const bounded=(value,label)=>{ensure(typeof value==='string'&&ID.test(value),'INVALID_BANKING_HOME',`${label} is required`);return value;};
const activeIdentity=(identity,now)=>{assertVerifiedIdentity(identity);ensure(Number.isSafeInteger(now)&&now>=identity.authenticatedAt&&identity.expiresAt>now,'IDENTITY_EXPIRED','Active verified identity is required');};

export function createBankingHomeContract({version,action,maxBalanceAgeMs,maxAccounts}){
 bounded(version,'Banking home version');bounded(action,'Banking home action');
 ensure(Number.isSafeInteger(maxBalanceAgeMs)&&maxBalanceAgeMs>=1&&maxBalanceAgeMs<=86_400_000,'INVALID_BANKING_HOME','Balance freshness window is invalid');
 ensure(Number.isInteger(maxAccounts)&&maxAccounts>=1&&maxAccounts<=100,'INVALID_BANKING_HOME','Account bound is invalid');
 const contract=Object.freeze({version,action,maxBalanceAgeMs,maxAccounts,syntheticOnly:true});compiledContracts.add(contract);return contract;
}

export class BankingHomeService {
 #contract;#gateway;#adapter;
 constructor({contract,gateway,adapter}){
  ensure(compiledContracts.has(contract),'INVALID_BANKING_HOME','Compiled banking home contract is required');
  ensure(gateway instanceof PolicyGateway,'INVALID_BANKING_HOME','Policy gateway is required');
  ensure(adapter instanceof FakeBankLedger,'INVALID_BANKING_HOME','Bank adapter is required');
  this.#contract=contract;this.#gateway=gateway;this.#adapter=adapter;
 }

 #authorize(identity,assignments,now){
  activeIdentity(identity,now);
  const decision=PolicyGateway.prototype.decide.call(this.#gateway,{identity,action:this.#contract.action,resourceTenantId:identity.tenantId,assignments,now});
  ensure(decision?.allow===true&&decision.action===this.#contract.action&&decision.tenantId===identity.tenantId&&decision.subject===identity.subject,'BANKING_HOME_DENIED','Exact banking home authorization is required');
 }

 getHome({identity,accountIds,assignments,consentLedger=null,consentId=null,now=Date.now()}){
  this.#authorize(identity,assignments,now);
  ensure(Array.isArray(accountIds)&&accountIds.length>=1&&accountIds.length<=this.#contract.maxAccounts,'INVALID_BANKING_HOME','Bounded account IDs are required');
  const normalized=accountIds.map(accountId=>bounded(accountId,'Account ID'));
  ensure(new Set(normalized).size===normalized.length,'INVALID_BANKING_HOME','Account IDs must be unique');
  const totals=Object.create(null),counts={fresh:0,stale:0,unknown:0};
  const accounts=normalized.map(accountId=>{
   const account=FakeBankLedger.prototype.readAccount.call(this.#adapter,{identity,accountId,assignments,consentLedger,consentId,now});
   const asOf=account.balanceAsOf;
   ensure(asOf===null||(Number.isSafeInteger(asOf)&&asOf>=0&&asOf<=now),'INVALID_BALANCE_EVIDENCE','Balance observation time is invalid');
   const ageMs=asOf===null?null:now-asOf,freshness=asOf===null?'unknown':ageMs<=this.#contract.maxBalanceAgeMs?'fresh':'stale';
   const total=(totals[account.currency]??0)+account.balanceMinor;
   ensure(Number.isSafeInteger(total),'AMOUNT_OVERFLOW','Currency total exceeds safe integer bounds');totals[account.currency]=total;counts[freshness]+=1;
   return Object.freeze({accountId:account.accountId,currency:account.currency,balanceMinor:account.balanceMinor,balanceAsOf:asOf,balanceAgeMs:ageMs,freshness,version:account.version,syntheticOnly:true});
  });
  return Object.freeze({tenantId:identity.tenantId,generatedAt:now,contractVersion:this.#contract.version,accounts:Object.freeze(accounts),totalsByCurrency:Object.freeze(totals),freshnessCounts:Object.freeze(counts),syntheticOnly:true});
 }
}
