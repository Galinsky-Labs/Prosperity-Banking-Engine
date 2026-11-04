import {EngineError} from './index.mjs';
import {assertVerifiedIdentity} from './identity.mjs';
import {PolicyGateway} from './policy-gateway.mjs';
import {TransactionNormalizer} from './transaction-normalizer.mjs';

const ensure=(condition,code,message)=>{if(!condition)throw new EngineError(code,message);};
const ID=/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const CURRENCY=/^[A-Z]{3}$/;
const DAY_MS=86_400_000;
const compiledContracts=new WeakSet();
const bounded=(value,label)=>{ensure(typeof value==='string'&&ID.test(value),'INVALID_CASH_FLOW_FORECAST',`${label} is required`);return value;};
const activeIdentity=(identity,now)=>{assertVerifiedIdentity(identity);ensure(Number.isSafeInteger(now)&&now>=identity.authenticatedAt&&identity.expiresAt>now,'IDENTITY_EXPIRED','Active verified identity is required');};
const add=(left,right,message)=>{const value=left+right;ensure(Number.isSafeInteger(value),'AMOUNT_OVERFLOW',message);return value;};

export function createCashFlowForecastContract({version,action,maxTransactions,maxScheduledItems,maxHorizonDays,maxLookbackDays}){
 bounded(version,'Forecast version');bounded(action,'Forecast action');
 ensure(Number.isInteger(maxTransactions)&&maxTransactions>=1&&maxTransactions<=500,'INVALID_CASH_FLOW_FORECAST','Transaction bound is invalid');
 ensure(Number.isInteger(maxScheduledItems)&&maxScheduledItems>=0&&maxScheduledItems<=200,'INVALID_CASH_FLOW_FORECAST','Scheduled item bound is invalid');
 ensure(Number.isInteger(maxHorizonDays)&&maxHorizonDays>=1&&maxHorizonDays<=90,'INVALID_CASH_FLOW_FORECAST','Forecast horizon is invalid');
 ensure(Number.isInteger(maxLookbackDays)&&maxLookbackDays>=1&&maxLookbackDays<=365,'INVALID_CASH_FLOW_FORECAST','Forecast lookback is invalid');
 const contract=Object.freeze({version,action,maxTransactions,maxScheduledItems,maxHorizonDays,maxLookbackDays,syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}

export class CashFlowForecastService {
 #contract;#gateway;#normalizer;
 constructor({contract,gateway,normalizer}){
  ensure(compiledContracts.has(contract),'INVALID_CASH_FLOW_FORECAST','Compiled cash-flow forecast contract is required');
  ensure(gateway instanceof PolicyGateway,'INVALID_CASH_FLOW_FORECAST','Policy gateway is required');
  ensure(normalizer instanceof TransactionNormalizer,'INVALID_CASH_FLOW_FORECAST','Transaction normalizer is required');
  this.#contract=contract;this.#gateway=gateway;this.#normalizer=normalizer;
 }

 #authorize(identity,assignments,now){
  activeIdentity(identity,now);
  const decision=PolicyGateway.prototype.decide.call(this.#gateway,{identity,action:this.#contract.action,resourceTenantId:identity.tenantId,assignments,now});
  ensure(decision?.allow===true&&decision.action===this.#contract.action&&decision.tenantId===identity.tenantId&&decision.subject===identity.subject,'CASH_FLOW_FORECAST_DENIED','Exact cash-flow forecast authorization is required');
 }

 forecast({identity,accountId,currency,assignments,consentLedger=null,consentId=null,scheduledItems=[],horizonDays,lookbackDays,now=Date.now()}){
  this.#authorize(identity,assignments,now);bounded(accountId,'Account ID');
  ensure(typeof currency==='string'&&CURRENCY.test(currency),'INVALID_CASH_FLOW_FORECAST','Currency is invalid');
  ensure(Number.isInteger(horizonDays)&&horizonDays>=1&&horizonDays<=this.#contract.maxHorizonDays,'INVALID_CASH_FLOW_FORECAST','Forecast horizon is invalid');
  ensure(Number.isInteger(lookbackDays)&&lookbackDays>=1&&lookbackDays<=this.#contract.maxLookbackDays,'INVALID_CASH_FLOW_FORECAST','Forecast lookback is invalid');
  ensure(Array.isArray(scheduledItems)&&scheduledItems.length<=this.#contract.maxScheduledItems,'INVALID_CASH_FLOW_FORECAST','Scheduled items exceed the configured bound');
  const horizonMs=horizonDays*DAY_MS,lookbackMs=lookbackDays*DAY_MS,horizonEnd=now+horizonMs,historyStart=now-lookbackMs;
  ensure(Number.isSafeInteger(horizonEnd)&&Number.isSafeInteger(historyStart)&&historyStart>=0,'INVALID_CASH_FLOW_FORECAST','Forecast time range is invalid');

  const transactions=TransactionNormalizer.prototype.list.call(this.#normalizer,{identity,accountId,assignments,consentLedger,consentId,limit:this.#contract.maxTransactions,now})
   .filter(item=>item.currency===currency&&item.bookedAt>=historyStart);
  let historicalNetMinor=0;
  for(const item of transactions)historicalNetMinor=add(historicalNetMinor,item.signedAmountMinor,'Historical cash flow exceeds safe integer bounds');
  const baselineDailyMinor=Math.trunc(historicalNetMinor/lookbackDays);
  ensure(Number.isSafeInteger(baselineDailyMinor),'AMOUNT_OVERFLOW','Forecast baseline exceeds safe integer bounds');

  const seen=new Set();
  const normalizedScheduled=scheduledItems.map(item=>{
   const scheduleId=bounded(item?.scheduleId,'Schedule ID');
   ensure(!seen.has(scheduleId),'INVALID_CASH_FLOW_FORECAST','Schedule IDs must be unique');seen.add(scheduleId);
   ensure(item.currency===currency,'INVALID_CASH_FLOW_FORECAST','Scheduled item currency must match the forecast currency');
   ensure(Number.isSafeInteger(item.signedAmountMinor)&&item.signedAmountMinor!==0,'INVALID_CASH_FLOW_FORECAST','Scheduled amount must be a nonzero safe integer');
   ensure(Number.isSafeInteger(item.expectedAt)&&item.expectedAt>now&&item.expectedAt<=horizonEnd,'INVALID_CASH_FLOW_FORECAST','Scheduled time must fall inside the forecast horizon');
   return Object.freeze({scheduleId,currency,signedAmountMinor:item.signedAmountMinor,expectedAt:item.expectedAt});
  }).sort((left,right)=>left.expectedAt-right.expectedAt||(left.scheduleId<right.scheduleId?-1:left.scheduleId>right.scheduleId?1:0));

  const scheduledByBucket=Array.from({length:horizonDays},()=>({total:0,items:[]}));
  for(const item of normalizedScheduled){
   const index=Math.floor((item.expectedAt-now-1)/DAY_MS);
   const bucket=scheduledByBucket[index];
   bucket.total=add(bucket.total,item.signedAmountMinor,'Scheduled cash flow exceeds safe integer bounds');
   bucket.items.push(item);
  }

  let cumulativeNetMinor=0;
  const buckets=scheduledByBucket.map((scheduled,index)=>{
   const projectedNetMinor=add(baselineDailyMinor,scheduled.total,'Projected cash flow exceeds safe integer bounds');
   cumulativeNetMinor=add(cumulativeNetMinor,projectedNetMinor,'Cumulative cash flow exceeds safe integer bounds');
   return Object.freeze({bucket:index+1,startAt:now+index*DAY_MS,endAt:now+(index+1)*DAY_MS,baselineNetMinor:baselineDailyMinor,scheduledNetMinor:scheduled.total,projectedNetMinor,cumulativeNetMinor,scheduledItems:Object.freeze(scheduled.items)});
  });
  return Object.freeze({
   tenantId:identity.tenantId,accountId,currency,generatedAt:now,horizonDays,lookbackDays,
   history:Object.freeze({startAt:historyStart,endAt:now,transactionCount:transactions.length,historicalNetMinor,baselineDailyMinor}),
   buckets:Object.freeze(buckets),contractVersion:this.#contract.version,
   methodology:'truncated-daily-history-plus-explicit-schedule',uncertainty:Object.freeze(['history-may-not-repeat','scheduled-items-may-change','pending-and-external-events-excluded']),
   syntheticOnly:true
  });
 }
}
