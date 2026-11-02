import {EngineError} from './index.mjs';
import {assertVerifiedIdentity} from './identity.mjs';
import {PolicyGateway} from './policy-gateway.mjs';

const ensure=(condition,code,message)=>{if(!condition)throw new EngineError(code,message);};
const ID=/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const CURRENCY=/^[A-Z]{3}$/;
const compiledContracts=new WeakSet();
const bounded=(value,label)=>{ensure(typeof value==='string'&&ID.test(value),'INVALID_ADAPTER',`${label} is required`);return value;};
const activeIdentity=(identity,now)=>{assertVerifiedIdentity(identity);ensure(Number.isSafeInteger(now)&&now>=identity.authenticatedAt&&identity.expiresAt>now,'IDENTITY_EXPIRED','Active verified identity is required');};

export function createBankAdapterContract({adapterId,version,currencies,actions}){
 bounded(adapterId,'Adapter ID');bounded(version,'Adapter version');
 ensure(Array.isArray(currencies)&&currencies.length>0&&currencies.length<=32,'INVALID_ADAPTER','Supported currencies are required');
 const normalizedCurrencies=[...new Set(currencies.map(currency=>{ensure(typeof currency==='string'&&CURRENCY.test(currency),'INVALID_ADAPTER','Currency must be a three-letter uppercase code');return currency;}))].sort();
 ensure(normalizedCurrencies.length===currencies.length,'INVALID_ADAPTER','Supported currencies must be unique');
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,'INVALID_ADAPTER','Adapter actions are required');
 const normalizedActions=Object.freeze({read:bounded(actions.read,'Read action'),post:bounded(actions.post,'Post action')});
 ensure(normalizedActions.read!==normalizedActions.post,'INVALID_ADAPTER','Read and post actions must differ');
 const contract=Object.freeze({adapterId,version,currencies:Object.freeze(normalizedCurrencies),actions:normalizedActions,syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}

function freezeEntry(entry){return Object.freeze({...entry});}

export class FakeBankLedger {
 #contract;#gateway;#accounts=new Map();#requests=new Map();#entries=new Map();#entryIds=new Set();
 constructor({contract,gateway,accounts=[]}){
  ensure(compiledContracts.has(contract),'INVALID_ADAPTER','Compiled bank adapter contract is required');
  ensure(gateway instanceof PolicyGateway,'INVALID_ADAPTER','Policy gateway is required');
  ensure(Array.isArray(accounts)&&accounts.length<=1000,'INVALID_ACCOUNT','Bounded synthetic accounts are required');
  this.#contract=contract;this.#gateway=gateway;
  for(const candidate of accounts){
   const tenantId=bounded(candidate?.tenantId,'Tenant ID'),accountId=bounded(candidate?.accountId,'Account ID'),currency=candidate?.currency;
   ensure(/^tenant_[a-z0-9_-]+$/.test(tenantId),'INVALID_ACCOUNT','Valid tenant is required');
   ensure(contract.currencies.includes(currency),'INVALID_ACCOUNT','Account currency is unsupported');
   ensure(Number.isSafeInteger(candidate.balanceMinor),'INVALID_ACCOUNT','Balance must use safe integer minor units');
   const balanceAsOf=candidate.balanceAsOf??null;ensure(balanceAsOf===null||(Number.isSafeInteger(balanceAsOf)&&balanceAsOf>=0),'INVALID_ACCOUNT','Balance observation time must be a nonnegative integer');
   const key=`${tenantId}:${accountId}`;ensure(!this.#accounts.has(key),'INVALID_ACCOUNT','Synthetic account IDs must be tenant-unique');
   this.#accounts.set(key,Object.freeze({tenantId,accountId,currency,balanceMinor:candidate.balanceMinor,balanceAsOf,version:0,syntheticOnly:true}));this.#entries.set(key,[]);
  }
 }

 #authorize(identity,action,{assignments,consentLedger=null,consentId=null,now}){
  activeIdentity(identity,now);
  const decision=PolicyGateway.prototype.decide.call(this.#gateway,{identity,action,resourceTenantId:identity.tenantId,assignments,consentLedger,consentId,now});
  ensure(decision?.allow===true&&decision.action===action&&decision.tenantId===identity.tenantId&&decision.subject===identity.subject,'ADAPTER_DENIED','Exact policy authorization is required');
 }

 #account(identity,accountId){bounded(accountId,'Account ID');const key=`${identity.tenantId}:${accountId}`,account=this.#accounts.get(key);ensure(account,'ACCOUNT_NOT_FOUND','Synthetic account does not exist');return [key,account];}

 readAccount({identity,accountId,assignments,consentLedger=null,consentId=null,now=Date.now()}){
  this.#authorize(identity,this.#contract.actions.read,{assignments,consentLedger,consentId,now});return this.#account(identity,accountId)[1];
 }

 postEntry({identity,requestId,entryId,accountId,direction,amountMinor,currency,expectedVersion,descriptionCode,assignments,consentLedger=null,consentId=null,now=Date.now()}){
  this.#authorize(identity,this.#contract.actions.post,{assignments,consentLedger,consentId,now});
  bounded(requestId,'Request ID');bounded(entryId,'Entry ID');bounded(descriptionCode,'Description code');
  ensure(direction==='credit'||direction==='debit','INVALID_ENTRY','Entry direction must be credit or debit');
  ensure(Number.isSafeInteger(amountMinor)&&amountMinor>0,'INVALID_ENTRY','Amount must be positive safe integer minor units');
  ensure(Number.isSafeInteger(expectedVersion)&&expectedVersion>=0,'INVALID_ENTRY','Expected account version is required');
  const [accountKey,account]=this.#account(identity,accountId);ensure(currency===account.currency,'INVALID_ENTRY','Entry currency must match the account');
  const requestKey=`${identity.tenantId}:${this.#contract.adapterId}:${requestId}`;
  const digest=JSON.stringify([identity.issuer,identity.subject,this.#contract.version,entryId,accountId,direction,amountMinor,currency,expectedVersion,descriptionCode]);
  const replay=this.#requests.get(requestKey);if(replay){ensure(replay.digest===digest,'REPLAY_MISMATCH','Adapter request replay has different terms');return replay.result;}
  ensure(account.version===expectedVersion,'VERSION_CONFLICT','Synthetic account version changed');
  const entryKey=`${identity.tenantId}:${this.#contract.adapterId}:${entryId}`;ensure(!this.#entryIds.has(entryKey),'ENTRY_CONFLICT','Synthetic entry ID already exists');
  const delta=direction==='credit'?amountMinor:-amountMinor,nextBalance=account.balanceMinor+delta;
  ensure(Number.isSafeInteger(nextBalance),'AMOUNT_OVERFLOW','Synthetic balance exceeds safe integer bounds');ensure(nextBalance>=0,'INSUFFICIENT_FUNDS','Synthetic account cannot be overdrawn');
  const entry=freezeEntry({entryKey,entryId,tenantId:identity.tenantId,accountId,direction,amountMinor,currency,descriptionCode,postedAt:now,actor:Object.freeze({issuer:identity.issuer,subject:identity.subject}),syntheticOnly:true});
  const updated=Object.freeze({...account,balanceMinor:nextBalance,balanceAsOf:now,version:account.version+1});
  const result=Object.freeze({account:updated,entry,adapterId:this.#contract.adapterId,adapterVersion:this.#contract.version,syntheticOnly:true});
  this.#accounts.set(accountKey,updated);this.#entries.get(accountKey).push(entry);this.#entryIds.add(entryKey);this.#requests.set(requestKey,{digest,result});return result;
 }

 listEntries({identity,accountId,assignments,consentLedger=null,consentId=null,limit=1000,now=Date.now()}){
  this.#authorize(identity,this.#contract.actions.read,{assignments,consentLedger,consentId,now});ensure(Number.isInteger(limit)&&limit>=1&&limit<=1000,'INVALID_ENTRY_QUERY','Entry limit is invalid');const [key]=this.#account(identity,accountId);return Object.freeze(this.#entries.get(key).slice(0,limit));
 }
}

