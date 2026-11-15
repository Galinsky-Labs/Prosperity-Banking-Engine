import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {createBankAdapterContract,FakeBankLedger} from '../src/bank-adapter.mjs';

const now=8_000_000;
const identityFor=async(tenantId='tenant_alpha',subject='operator-7')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+60_000,authenticationMethods:['workload']}));
const contract=createBankAdapterContract({adapterId:'fake-ledger',version:'v1',currencies:['USD'],actions:{read:'bank.accounts.read',post:'bank.entries.post'}});
const rolePolicy=createRolePolicy([{name:'operator',permissions:['bank:read','bank:post']}]);
const policy=createGatewayPolicy({version:'bank-v1',rules:[{action:'bank.accounts.read',permission:'bank:read'},{action:'bank.entries.post',permission:'bank:post'}]});
const gateway=()=>new PolicyGateway({policy,rolePolicy});
const assignmentFor=(tenantId='tenant_alpha',subject='operator-7')=>({tenantId,issuer:'https://identity.example',subject,role:'operator',validFrom:now-10_000,validUntil:now+10_000,revoked:false});
const ledger=()=>new FakeBankLedger({contract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:10_000},{tenantId:'tenant_alpha',accountId:'acct-2',currency:'USD',balanceMinor:3_000},{tenantId:'tenant_beta',accountId:'acct-1',currency:'USD',balanceMinor:7_000}]});
const post=(identity,overrides={})=>({identity,requestId:'request-1',entryId:'entry-1',accountId:'acct-1',direction:'debit',amountMinor:2_500,currency:'USD',expectedVersion:0,descriptionCode:'synthetic-purchase',assignments:[assignmentFor(identity.tenantId,identity.subject)],now,...overrides});

test('posts immutable integer-minor entries and replays exact requests',async()=>{
 const identity=await identityFor(),bank=ledger(),first=bank.postEntry(post(identity)),replay=bank.postEntry(post(identity,{now:now+1}));
 assert.strictEqual(replay,first);assert.equal(first.account.balanceMinor,7_500);assert.equal(first.account.version,1);assert.equal(first.entry.syntheticOnly,true);assert.equal(Object.isFrozen(first.entry),true);
 assert.deepEqual(bank.listEntries({identity,accountId:'acct-1',assignments:[assignmentFor()],now}),[first.entry]);assert.throws(()=>{first.account.balanceMinor=0;},TypeError);
 assert.throws(()=>bank.postEntry(post(identity,{amountMinor:2_499})),/different terms/);
});

test('enforces tenant isolation and active verifier-produced identity',async()=>{
 const alpha=await identityFor(),beta=await identityFor('tenant_beta'),bank=ledger();bank.postEntry(post(alpha));
 assert.equal(bank.readAccount({identity:beta,accountId:'acct-1',assignments:[assignmentFor('tenant_beta')],now}).balanceMinor,7_000);
 assert.deepEqual(bank.listEntries({identity:beta,accountId:'acct-1',assignments:[assignmentFor('tenant_beta')],now}),[]);
 assert.throws(()=>bank.readAccount({identity:{...alpha},accountId:'acct-1',assignments:[assignmentFor()],now}),/Verified identity|Active verified|authorization/);
 assert.throws(()=>bank.readAccount({identity:alpha,accountId:'acct-1',assignments:[assignmentFor()],now:now+60_000}),/Active verified/);
});

test('requires exact gateway authorization and ignores subclass overrides',async()=>{
 const identity=await identityFor();
 class ForgedAllowGateway extends PolicyGateway {decide(){return {allow:true,tenantId:'tenant_alpha',subject:'operator-7',action:'bank.accounts.read'};}}
 const denyPolicy=createGatewayPolicy({version:'deny-v1',rules:[{action:'bank.accounts.read',permission:'bank:read'},{action:'bank.entries.post',permission:'bank:post'}]});
 const forged=new ForgedAllowGateway({policy:denyPolicy,rolePolicy});
 assert.throws(()=>new FakeBankLedger({contract,gateway:forged,accounts:[{tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:1}]}).readAccount({identity,accountId:'acct-1',assignments:[],now}),/authorization/);
});

test('rejects stale versions, duplicate entries, insufficient funds and unsafe balances',async()=>{
 const identity=await identityFor(),bank=ledger();bank.postEntry(post(identity));
 assert.throws(()=>bank.postEntry(post(identity,{requestId:'request-2',entryId:'entry-2',expectedVersion:0})),/version changed/);
 assert.throws(()=>bank.postEntry(post(identity,{requestId:'request-3',expectedVersion:1})),/entry ID/);
 assert.throws(()=>bank.postEntry(post(identity,{requestId:'request-cross-account',accountId:'acct-2'})),/entry ID/);
 assert.throws(()=>bank.postEntry(post(identity,{requestId:'request-4',entryId:'entry-4',expectedVersion:1,amountMinor:7_501})),/overdrawn/);
 const huge=new FakeBankLedger({contract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:Number.MAX_SAFE_INTEGER}]});
 assert.throws(()=>huge.postEntry(post(identity,{direction:'credit',amountMinor:1})),/safe integer/);
});

test('validates compiled contracts, supported currencies and synthetic seed accounts',()=>{
 assert.throws(()=>createBankAdapterContract({adapterId:'fake',version:'v1',currencies:['usd'],actions:{read:'read',post:'post'}}),/Currency/);
 assert.throws(()=>createBankAdapterContract({adapterId:'fake',version:'v1',currencies:['USD','USD'],actions:{read:'read',post:'post'}}),/unique/);
 assert.throws(()=>new FakeBankLedger({contract:Object.freeze({...contract}),gateway:gateway()}),/Compiled/);
 assert.throws(()=>new FakeBankLedger({contract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'acct',currency:'EUR',balanceMinor:0}]}),/unsupported/);
});

test('accepts validated durable snapshots with account versions and historical entries',async()=>{
 const identity=await identityFor();
 const entry={tenantId:'tenant_alpha',accountId:'acct-1',entryId:'hist-1',direction:'credit',amountMinor:500,currency:'USD',descriptionCode:'opening',postedAt:now-10,actor:{issuer:'https://identity.example',subject:'seed'}};
 const bank=new FakeBankLedger({contract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:500,version:4}],entries:[entry]});
 assert.equal(bank.readAccount({identity,accountId:'acct-1',assignments:[assignmentFor()],now}).version,4);
 assert.equal(bank.listEntries({identity,accountId:'acct-1',assignments:[assignmentFor()],now})[0].entryKey,'tenant_alpha:fake-ledger:hist-1');
 assert.throws(()=>bank.postEntry(post(identity)),/version changed/);
 assert.equal(bank.postEntry(post(identity,{expectedVersion:4,amountMinor:100})).account.version,5);
 assert.throws(()=>new FakeBankLedger({contract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:1,version:-1}]}),/version/);
 assert.throws(()=>new FakeBankLedger({contract,gateway:gateway(),accounts:[],entries:[entry]}),/account does not exist/);
 assert.throws(()=>new FakeBankLedger({contract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:1}],entries:[entry,entry]}),/already exists/);
 assert.throws(()=>new FakeBankLedger({contract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:1}],entries:[{...entry,currency:'EUR'}]}),/currency/);
});
