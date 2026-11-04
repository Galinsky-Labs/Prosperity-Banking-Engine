import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {createBankAdapterContract,FakeBankLedger} from '../src/bank-adapter.mjs';
import {createTransactionNormalizerContract,TransactionNormalizer} from '../src/transaction-normalizer.mjs';
import {CashFlowForecastService,createCashFlowForecastContract} from '../src/cash-flow-forecast.mjs';

const DAY=86_400_000,now=20_000_000;
const identityFor=async(tenantId='tenant_alpha',subject='customer-3')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-10_000,expiresAt:now+10*DAY,authenticationMethods:['passkey']}));
const rolePolicy=createRolePolicy([{name:'customer',permissions:['bank:read','bank:post','transactions:read','cashflow:forecast']}]);
const policy=createGatewayPolicy({version:'forecast-policy-v1',rules:[{action:'bank.accounts.read',permission:'bank:read'},{action:'bank.entries.post',permission:'bank:post'},{action:'bank.transactions.read',permission:'transactions:read'},{action:'bank.cashflow.forecast',permission:'cashflow:forecast'}]});
const gateway=()=>new PolicyGateway({policy,rolePolicy});
const adapterContract=createBankAdapterContract({adapterId:'fake-ledger',version:'v1',currencies:['EUR','USD'],actions:{read:'bank.accounts.read',post:'bank.entries.post'}});
const normalizerContract=createTransactionNormalizerContract({version:'normalizer-v1',action:'bank.transactions.read',maxTransactions:100});
const forecastContract=createCashFlowForecastContract({version:'forecast-v1',action:'bank.cashflow.forecast',maxTransactions:100,maxScheduledItems:10,maxHorizonDays:30,maxLookbackDays:90});
const assignmentFor=(tenantId='tenant_alpha',subject='customer-3')=>({tenantId,issuer:'https://identity.example',subject,role:'customer',validFrom:now-20_000,validUntil:now+DAY,revoked:false});
const setup=()=>{const bank=new FakeBankLedger({contract:adapterContract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'checking',currency:'USD',balanceMinor:10_000},{tenantId:'tenant_beta',accountId:'checking',currency:'USD',balanceMinor:5_000}]});const normalizer=new TransactionNormalizer({contract:normalizerContract,gateway:gateway(),adapter:bank});return {bank,service:new CashFlowForecastService({contract:forecastContract,gateway:gateway(),normalizer})};};
const post=(bank,identity,{requestId,entryId,direction,amountMinor,expectedVersion,postedAt})=>bank.postEntry({identity,requestId,entryId,accountId:'checking',direction,amountMinor,currency:'USD',expectedVersion,descriptionCode:'synthetic-entry',assignments:[assignmentFor(identity.tenantId,identity.subject)],now:postedAt});

test('projects deterministic net change from posted history and explicit schedules',async()=>{
 const identity=await identityFor(),{bank,service}=setup();
 post(bank,identity,{requestId:'debit-request',entryId:'debit-1',direction:'debit',amountMinor:900,expectedVersion:0,postedAt:now-2_000});
 post(bank,identity,{requestId:'credit-request',entryId:'credit-1',direction:'credit',amountMinor:300,expectedVersion:1,postedAt:now-1_000});
 const forecast=service.forecast({identity,accountId:'checking',currency:'USD',assignments:[assignmentFor()],lookbackDays:3,horizonDays:2,scheduledItems:[{scheduleId:'income-1',currency:'USD',signedAmountMinor:100,expectedAt:now+1},{scheduleId:'bill-1',currency:'USD',signedAmountMinor:-50,expectedAt:now+DAY+1}],now});
 assert.equal(forecast.history.historicalNetMinor,-600);assert.equal(forecast.history.baselineDailyMinor,-200);
 assert.deepEqual(forecast.buckets.map(bucket=>bucket.projectedNetMinor),[-100,-250]);assert.deepEqual(forecast.buckets.map(bucket=>bucket.cumulativeNetMinor),[-100,-350]);
 assert.equal(Object.isFrozen(forecast),true);assert.equal(Object.isFrozen(forecast.buckets[0].scheduledItems),true);
});

test('keeps tenant and exact policy boundaries independent',async()=>{
 const alpha=await identityFor(),beta=await identityFor('tenant_beta'),{service}=setup();
 const empty=service.forecast({identity:beta,accountId:'checking',currency:'USD',assignments:[assignmentFor('tenant_beta')],lookbackDays:1,horizonDays:1,now});
 assert.equal(empty.history.transactionCount,0);
 assert.throws(()=>service.forecast({identity:alpha,accountId:'checking',currency:'USD',assignments:[],lookbackDays:1,horizonDays:1,now}),/authorization/);
 assert.throws(()=>service.forecast({identity:{...alpha},accountId:'checking',currency:'USD',assignments:[assignmentFor()],lookbackDays:1,horizonDays:1,now}),/Verified identity/);
});

test('bounds the horizon and rejects ambiguous scheduled evidence',async()=>{
 const identity=await identityFor(),{service}=setup(),base={identity,accountId:'checking',currency:'USD',assignments:[assignmentFor()],lookbackDays:1,horizonDays:2,now};
 assert.throws(()=>service.forecast({...base,horizonDays:31}),/horizon/);
 assert.throws(()=>service.forecast({...base,scheduledItems:[{scheduleId:'x',currency:'EUR',signedAmountMinor:1,expectedAt:now+1}]}),/currency/);
 assert.throws(()=>service.forecast({...base,scheduledItems:[{scheduleId:'x',currency:'USD',signedAmountMinor:1,expectedAt:now+1},{scheduleId:'x',currency:'USD',signedAmountMinor:2,expectedAt:now+2}]}),/unique/);
 assert.throws(()=>service.forecast({...base,scheduledItems:[{scheduleId:'late',currency:'USD',signedAmountMinor:1,expectedAt:now+3*DAY}]}),/horizon/);
});

test('fails closed on arithmetic overflow',async()=>{
 const identity=await identityFor(),{bank,service}=setup();
 post(bank,identity,{requestId:'large-request',entryId:'large',direction:'credit',amountMinor:Number.MAX_SAFE_INTEGER,expectedVersion:0,postedAt:now-1});
 assert.throws(()=>service.forecast({identity,accountId:'checking',currency:'USD',assignments:[assignmentFor()],lookbackDays:1,horizonDays:2,now}),/safe integer/);
});

test('requires canonical collaborators and bounded compiled contracts',()=>{
 assert.throws(()=>createCashFlowForecastContract({version:'v1',action:'forecast',maxTransactions:0,maxScheduledItems:1,maxHorizonDays:1,maxLookbackDays:1}),/Transaction bound/);
 const {service}=setup();assert.ok(service);
 assert.throws(()=>new CashFlowForecastService({contract:Object.freeze({...forecastContract}),gateway:gateway(),normalizer:{}}),/Compiled/);
});
