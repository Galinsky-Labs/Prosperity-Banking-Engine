import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {createBankAdapterContract,FakeBankLedger} from '../src/bank-adapter.mjs';
import {BankingHomeService,createBankingHomeContract} from '../src/banking-home.mjs';

const now=11_000_000;
const identityFor=async(tenantId='tenant_alpha',subject='customer-1')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+60_000,authenticationMethods:['passkey']}));
const rolePolicy=createRolePolicy([{name:'customer',permissions:['bank:read','bank:home']}]);
const policy=createGatewayPolicy({version:'home-policy-v1',rules:[{action:'bank.accounts.read',permission:'bank:read'},{action:'bank.home.read',permission:'bank:home'}]});
const gateway=()=>new PolicyGateway({policy,rolePolicy});
const adapterContract=createBankAdapterContract({adapterId:'fake-ledger',version:'v1',currencies:['EUR','USD'],actions:{read:'bank.accounts.read',post:'bank.entries.post'}});
const homeContract=createBankingHomeContract({version:'home-v1',action:'bank.home.read',maxBalanceAgeMs:60_000,maxAccounts:10});
const assignmentFor=(tenantId='tenant_alpha',subject='customer-1')=>({tenantId,issuer:'https://identity.example',subject,role:'customer',validFrom:now-10_000,validUntil:now+10_000,revoked:false});
const adapter=(accounts=[{tenantId:'tenant_alpha',accountId:'checking',currency:'USD',balanceMinor:10_000,balanceAsOf:now-1_000},{tenantId:'tenant_alpha',accountId:'savings',currency:'USD',balanceMinor:20_000,balanceAsOf:now-90_000},{tenantId:'tenant_alpha',accountId:'euro',currency:'EUR',balanceMinor:5_000},{tenantId:'tenant_beta',accountId:'checking',currency:'USD',balanceMinor:7_000,balanceAsOf:now}])=>new FakeBankLedger({contract:adapterContract,gateway:gateway(),accounts});
const service=(accounts)=>new BankingHomeService({contract:homeContract,gateway:gateway(),adapter:adapter(accounts)});

test('projects immutable currency-safe balances with explicit freshness',async()=>{
 const identity=await identityFor(),home=service().getHome({identity,accountIds:['checking','savings','euro'],assignments:[assignmentFor()],now});
 assert.deepEqual(home.accounts.map(account=>account.freshness),['fresh','stale','unknown']);
 assert.deepEqual({...home.totalsByCurrency},{EUR:5_000,USD:30_000});assert.deepEqual(home.freshnessCounts,{fresh:1,stale:1,unknown:1});
 assert.equal(Object.isFrozen(home),true);assert.equal(Object.isFrozen(home.accounts),true);assert.equal(home.tenantId,'tenant_alpha');
});

test('enforces tenant isolation and both exact authorization layers',async()=>{
 const alpha=await identityFor(),beta=await identityFor('tenant_beta'),bankingHome=service();
 assert.equal(bankingHome.getHome({identity:beta,accountIds:['checking'],assignments:[assignmentFor('tenant_beta')],now}).accounts[0].balanceMinor,7_000);
 assert.throws(()=>bankingHome.getHome({identity:alpha,accountIds:['checking'],assignments:[],now}),/authorization/);
 assert.throws(()=>bankingHome.getHome({identity:{...alpha},accountIds:['checking'],assignments:[assignmentFor()],now}),/Verified identity/);
});

test('rejects ambiguous account sets and invalid freshness evidence',async()=>{
 const identity=await identityFor(),assignments=[assignmentFor()];
 assert.throws(()=>service().getHome({identity,accountIds:['checking','checking'],assignments,now}),/unique/);
 assert.throws(()=>service().getHome({identity,accountIds:[],assignments,now}),/Bounded/);
 assert.throws(()=>service([{tenantId:'tenant_alpha',accountId:'future',currency:'USD',balanceMinor:1,balanceAsOf:now+1}]).getHome({identity,accountIds:['future'],assignments,now}),/observation time/);
});

test('fails closed when per-currency totals overflow',async()=>{
 const identity=await identityFor(),accounts=[{tenantId:'tenant_alpha',accountId:'large',currency:'USD',balanceMinor:Number.MAX_SAFE_INTEGER,balanceAsOf:now},{tenantId:'tenant_alpha',accountId:'extra',currency:'USD',balanceMinor:1,balanceAsOf:now}];
 assert.throws(()=>service(accounts).getHome({identity,accountIds:['large','extra'],assignments:[assignmentFor()],now}),/safe integer/);
});

test('requires compiled contracts and bounded configuration',()=>{
 assert.throws(()=>createBankingHomeContract({version:'v1',action:'bank.home.read',maxBalanceAgeMs:0,maxAccounts:10}),/freshness/);
 assert.throws(()=>new BankingHomeService({contract:Object.freeze({...homeContract}),gateway:gateway(),adapter:adapter()}),/Compiled/);
});
