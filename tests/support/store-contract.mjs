import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../../src/policy-gateway.mjs';
import {createBankAdapterContract} from '../../src/bank-adapter.mjs';
import {createEventSchema} from '../../src/event-outbox.mjs';
import {createEvidenceVaultContract} from '../../src/evidence-vault.mjs';
import {DurableEventOutbox,DurableEvidenceVault,DurableLedger} from '../../src/runtime/durable-services.mjs';

export const now=50_000_000;
const issuer='https://identity.example';
export const identityFor=async(tenantId='tenant_alpha',subject='operator-1')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer,subject,authenticatedAt:now-1_000,expiresAt:now+600_000,authenticationMethods:['passkey','device']}));
const rolePolicy=createRolePolicy([{name:'operator',permissions:['bank:read','bank:post','evidence:read','evidence:write']},{name:'viewer',permissions:['bank:read']}]);
const policy=createGatewayPolicy({version:'durable-v1',rules:[{action:'bank.accounts.read',permission:'bank:read'},{action:'bank.entries.post',permission:'bank:post',requiresMfa:true},{action:'evidence.read',permission:'evidence:read'},{action:'evidence.write',permission:'evidence:write'}]});
const gateway=new PolicyGateway({policy,rolePolicy});
const adapterContract=createBankAdapterContract({adapterId:'durable-ledger',version:'v1',currencies:['USD'],actions:{read:'bank.accounts.read',post:'bank.entries.post'}});
const eventSchema=createEventSchema({type:'ledger.entry.posted',version:'v1',requiredFields:['entryId']});
const noteSchema=createEventSchema({type:'synthetic.note',version:'v1',requiredFields:['noteCode']});
const vaultContract=createEvidenceVaultContract({version:'vault-v1',actions:{read:'evidence.read',write:'evidence.write'}});
export const assignmentFor=(tenantId='tenant_alpha',subject='operator-1',role='operator')=>[{tenantId,issuer,subject,role,validFrom:0,validUntil:now+1_000_000,revoked:false}];

export const seed={accounts:[
 {tenantId:'tenant_alpha',accountId:'acct-1',currency:'USD',balanceMinor:10_000,balanceAsOf:now-10,version:0},
 {tenantId:'tenant_beta',accountId:'acct-1',currency:'USD',balanceMinor:7_000,balanceAsOf:now-10,version:0}
],entries:[{entryKey:'tenant_alpha:durable-ledger:hist-1',entryId:'hist-1',tenantId:'tenant_alpha',accountId:'acct-1',direction:'credit',amountMinor:10_000,currency:'USD',descriptionCode:'opening',postedAt:now-100,actor:{issuer,subject:'seed'}}]};

const post=(identity,overrides={})=>({identity,requestId:'request-1',entryId:'entry-1',accountId:'acct-1',direction:'debit',amountMinor:2_500,currency:'USD',expectedVersion:0,descriptionCode:'synthetic-purchase',assignments:assignmentFor(identity.tenantId,identity.subject),now,...overrides});

/** Shared behavioural contract run against every engine store implementation. */
export function storeContract(test,label,makeStore){
 const services=async()=>{const store=await makeStore();await store.seed(seed);return {store,ledger:new DurableLedger({contract:adapterContract,gateway,store,eventSchema}),outbox:new DurableEventOutbox({store}),vault:new DurableEvidenceVault({contract:vaultContract,gateway,store})};};

 test(`${label}: seeding is idempotent and snapshots carry history`,async()=>{
  const {store,ledger}=await services();await store.seed(seed);
  const identity=await identityFor(),snapshot=await ledger.snapshot({identity,now});
  assert.equal(snapshot.readAccount({identity,accountId:'acct-1',assignments:assignmentFor(),now}).balanceMinor,10_000);
  assert.equal((await ledger.listEntries({identity,accountId:'acct-1',assignments:assignmentFor(),now})).length,1);
  await store.close();
 });

 test(`${label}: posts atomically with a transactional outbox event and exact replay`,async()=>{
  const {store,ledger,outbox}=await services(),identity=await identityFor();
  const first=await ledger.postEntry(post(identity));
  assert.equal(first.account.balanceMinor,7_500);assert.equal(first.account.version,1);assert.equal(first.entry.syntheticOnly,true);
  const replay=await ledger.postEntry(post(identity,{now:now+1}));assert.deepEqual(replay,first);
  await assert.rejects(ledger.postEntry(post(identity,{amountMinor:1})),{code:'REPLAY_MISMATCH'});
  await assert.rejects(ledger.postEntry(post(identity,{requestId:'request-2'})),{code:'VERSION_CONFLICT'});
  await assert.rejects(ledger.postEntry(post(identity,{requestId:'request-3',expectedVersion:1})),{code:'ENTRY_CONFLICT'});
  await assert.rejects(ledger.postEntry(post(identity,{requestId:'request-4',entryId:'entry-4',expectedVersion:1,amountMinor:999_999})),{code:'INSUFFICIENT_FUNDS'});
  const account=await ledger.readAccount({identity,accountId:'acct-1',assignments:assignmentFor(),now});
  assert.equal(account.balanceMinor,7_500);assert.equal(account.version,1);
  const events=await outbox.list(identity,{now});
  assert.equal(events.length,1);assert.equal(events[0].type,'ledger.entry.posted');assert.equal(events[0].payload.entryId,'entry-1');assert.equal(events[0].state,'PENDING');
  await store.close();
 });

 test(`${label}: enforces exact policy, MFA and tenant isolation before storage`,async()=>{
  const {store,ledger}=await services(),alpha=await identityFor(),beta=await identityFor('tenant_beta');
  await ledger.postEntry(post(alpha));
  assert.equal((await ledger.readAccount({identity:beta,accountId:'acct-1',assignments:assignmentFor('tenant_beta'),now})).balanceMinor,7_000);
  await assert.rejects(ledger.postEntry(post(alpha,{requestId:'r-viewer',entryId:'e-viewer',expectedVersion:1,assignments:assignmentFor('tenant_alpha','operator-1','viewer')})),{code:'ADAPTER_DENIED'});
  await assert.rejects(ledger.postEntry(post(alpha,{requestId:'r-stale',entryId:'e-stale',expectedVersion:1,now:now+400_000})),{code:'ADAPTER_DENIED'});
  await assert.rejects(ledger.postEntry(post({...alpha},{requestId:'r-forged'})),/Verified identity/);
  await assert.rejects(ledger.readAccount({identity:alpha,accountId:'missing',assignments:assignmentFor(),now}),{code:'ACCOUNT_NOT_FOUND'});
  await store.close();
 });

 test(`${label}: outbox idempotency, leases and completion`,async()=>{
  const {store,outbox}=await services(),identity=await identityFor(),beta=await identityFor('tenant_beta');
  const command={eventId:'note-1',aggregateId:'agg-1',payload:{noteCode:'n1'},idempotencyKey:'idem-1',occurredAt:now,now};
  const first=await outbox.enqueue(identity,noteSchema,command);
  assert.deepEqual(await outbox.enqueue(identity,noteSchema,command),first);
  await assert.rejects(outbox.enqueue(identity,noteSchema,{...command,payload:{noteCode:'n2'}}),{code:'REPLAY_MISMATCH'});
  await assert.rejects(outbox.enqueue(identity,noteSchema,{...command,idempotencyKey:'idem-2'}),{code:'EVENT_CONFLICT'});
  assert.equal((await outbox.claim(beta,{workerId:'w',now})).length,0);
  const [claimed]=await outbox.claim(identity,{workerId:'worker-a',leaseMs:1_000,now});
  assert.equal(claimed.state,'CLAIMED');assert.equal(claimed.lease.version,1);
  assert.equal((await outbox.claim(identity,{workerId:'worker-b',now:now+10})).length,0);
  await assert.rejects(outbox.complete(identity,{eventId:'note-1',workerId:'worker-b',leaseVersion:1,now:now+10}),{code:'LEASE_DENIED'});
  await assert.rejects(outbox.complete(identity,{eventId:'note-1',workerId:'worker-a',leaseVersion:1,now:now+1_000}),{code:'LEASE_EXPIRED'});
  const [reclaimed]=await outbox.claim(identity,{workerId:'worker-b',now:now+1_001});assert.equal(reclaimed.lease.version,2);
  const published=await outbox.complete(identity,{eventId:'note-1',workerId:'worker-b',leaseVersion:2,now:now+1_002});
  assert.equal(published.state,'PUBLISHED');assert.equal(published.publishedAt,now+1_002);
  assert.equal((await outbox.claim(identity,{workerId:'worker-c',now:now+60_000})).length,0);
  await assert.rejects(outbox.complete(identity,{eventId:'missing',workerId:'w',leaseVersion:1,now}),{code:'EVENT_NOT_FOUND'});
  await store.close();
 });

 test(`${label}: evidence vault stores metadata only with replay and isolation`,async()=>{
  const {store,vault}=await services(),identity=await identityFor(),beta=await identityFor('tenant_beta');
  const request={identity,requestId:'ev-req-1',evidenceId:'ev-1',category:'consent_or_audit_evidence',contentDigest:'a'.repeat(64),keyReference:'object/ev-1',mediaType:'application/pdf',sizeBytes:100,capturedAt:now-5,source:'synthetic-test',assignments:assignmentFor(),now};
  const record=await vault.store(request);
  assert.equal(record.classification,'RESTRICTED');assert.deepEqual(await vault.store(request),record);
  await assert.rejects(vault.store({...request,sizeBytes:101}),{code:'REPLAY_MISMATCH'});
  await assert.rejects(vault.store({...request,requestId:'ev-req-2'}),{code:'EVIDENCE_CONFLICT'});
  await assert.rejects(vault.store({...request,requestId:'ev-req-3',evidenceId:'ev-3',content:'raw'}),{code:'RAW_EVIDENCE_DENIED'});
  assert.deepEqual(await vault.get({identity,evidenceId:'ev-1',assignments:assignmentFor(),now}),record);
  await assert.rejects(vault.get({identity:beta,evidenceId:'ev-1',assignments:assignmentFor('tenant_beta'),now}),{code:'EVIDENCE_NOT_FOUND'});
  assert.equal((await vault.list({identity,assignments:assignmentFor(),now})).length,1);
  await store.close();
 });
}
