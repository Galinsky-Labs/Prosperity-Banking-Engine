import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {createBankAdapterContract,FakeBankLedger} from '../src/bank-adapter.mjs';
import {createTransactionNormalizerContract,TransactionNormalizer} from '../src/transaction-normalizer.mjs';

const now=12_000_000;
const identityFor=async(tenantId='tenant_alpha',subject='customer-2')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+60_000,authenticationMethods:['passkey']}));
const rolePolicy=createRolePolicy([{name:'customer',permissions:['bank:read','bank:post','transactions:read']}]);
const policy=createGatewayPolicy({version:'transactions-v1',rules:[{action:'bank.accounts.read',permission:'bank:read'},{action:'bank.entries.post',permission:'bank:post'},{action:'bank.transactions.read',permission:'transactions:read'}]});
const gateway=()=>new PolicyGateway({policy,rolePolicy});
const adapterContract=createBankAdapterContract({adapterId:'fake-ledger',version:'v1',currencies:['USD'],actions:{read:'bank.accounts.read',post:'bank.entries.post'}});
const normalizerContract=createTransactionNormalizerContract({version:'normalizer-v1',action:'bank.transactions.read',maxTransactions:100});
const assignmentFor=(tenantId='tenant_alpha',subject='customer-2')=>({tenantId,issuer:'https://identity.example',subject,role:'customer',validFrom:now-10_000,validUntil:now+10_000,revoked:false});
const adapter=()=>new FakeBankLedger({contract:adapterContract,gateway:gateway(),accounts:[{tenantId:'tenant_alpha',accountId:'checking',currency:'USD',balanceMinor:10_000},{tenantId:'tenant_beta',accountId:'checking',currency:'USD',balanceMinor:10_000}]});
const post=(bank,identity,{requestId,entryId,direction,amountMinor,postedAt})=>bank.postEntry({identity,requestId,entryId,accountId:'checking',direction,amountMinor,currency:'USD',expectedVersion:entryId==='credit-1'?1:0,descriptionCode:'synthetic-entry',assignments:[assignmentFor(identity.tenantId,identity.subject)],now:postedAt});

test('normalizes posted entries deterministically with signed minor units',async()=>{
 const identity=await identityFor(),bank=adapter();post(bank,identity,{requestId:'r-debit',entryId:'debit-1',direction:'debit',amountMinor:2_000,postedAt:now-100});post(bank,identity,{requestId:'r-credit',entryId:'credit-1',direction:'credit',amountMinor:500,postedAt:now-100});
 const transactions=new TransactionNormalizer({contract:normalizerContract,gateway:gateway(),adapter:bank}).list({identity,accountId:'checking',assignments:[assignmentFor()],now});
 assert.deepEqual(transactions.map(item=>item.transactionId),['credit-1','debit-1']);assert.deepEqual(transactions.map(item=>item.signedAmountMinor),[500,-2_000]);assert.deepEqual(transactions.map(item=>item.status),['posted','posted']);
 assert.equal(transactions[0].currency,'USD');assert.equal(Object.isFrozen(transactions),true);assert.equal(Object.isFrozen(transactions[0]),true);
});

test('enforces tenant isolation and both authorization boundaries',async()=>{
 const alpha=await identityFor(),beta=await identityFor('tenant_beta'),bank=adapter();post(bank,alpha,{requestId:'r1',entryId:'entry-1',direction:'debit',amountMinor:100,postedAt:now-1});
 const normalizer=new TransactionNormalizer({contract:normalizerContract,gateway:gateway(),adapter:bank});
 assert.deepEqual(normalizer.list({identity:beta,accountId:'checking',assignments:[assignmentFor('tenant_beta')],now}),[]);
 assert.throws(()=>normalizer.list({identity:alpha,accountId:'checking',assignments:[],now}),/authorization/);
 assert.throws(()=>normalizer.list({identity:{...alpha},accountId:'checking',assignments:[assignmentFor()],now}),/Verified identity/);
});

test('bounds output and rejects future source evidence',async()=>{
 const identity=await identityFor(),bank=adapter();post(bank,identity,{requestId:'r1',entryId:'entry-1',direction:'debit',amountMinor:100,postedAt:now-1});
 const normalizer=new TransactionNormalizer({contract:normalizerContract,gateway:gateway(),adapter:bank});
 assert.equal(normalizer.list({identity,accountId:'checking',assignments:[assignmentFor()],limit:1,now}).length,1);
 assert.throws(()=>normalizer.list({identity,accountId:'checking',assignments:[assignmentFor()],limit:0,now}),/limit/);
 const future=adapter();post(future,identity,{requestId:'future-r',entryId:'future-entry',direction:'debit',amountMinor:1,postedAt:now+1});
 assert.throws(()=>new TransactionNormalizer({contract:normalizerContract,gateway:gateway(),adapter:future}).list({identity,accountId:'checking',assignments:[assignmentFor()],now}),/posting time/);
});

test('requires compiled bounded contracts and the canonical adapter',()=>{
 assert.throws(()=>createTransactionNormalizerContract({version:'v1',action:'read',maxTransactions:0}),/bound/);
 assert.throws(()=>new TransactionNormalizer({contract:Object.freeze({...normalizerContract}),gateway:gateway(),adapter:adapter()}),/Compiled/);
});
