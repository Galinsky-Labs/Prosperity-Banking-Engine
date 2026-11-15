import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {loadMigrations} from '../src/runtime/migrate.mjs';
import {storeContract} from './support/store-contract.mjs';

// Runs only when a disposable test database is supplied. DATABASE_URL is deliberately not used here.
const url=process.env.ENGINE_TEST_DATABASE_URL;

test('migrations are ordered, checksummed and synthetic-only',()=>{
 const migrations=loadMigrations();
 assert.ok(migrations.length>=1);
 assert.deepEqual(migrations.map(migration=>migration.version),[...migrations.map(migration=>migration.version)].sort());
 for(const migration of migrations){assert.match(migration.checksum,/^[a-f0-9]{64}$/);}
 assert.match(migrations[0].sql,/CHECK \(synthetic_only\)/);
});

if(!url){
 test('postgres store contract',{skip:'ENGINE_TEST_DATABASE_URL is not set'},()=>{});
}else{
 const pg=(await import('pg')).default;
 const {PostgresEngineStore}=await import('../src/runtime/postgres-store.mjs');
 const {migrate}=await import('../src/runtime/migrate.mjs');
 const admin=new pg.Client({connectionString:url});await admin.connect();
 const schemas=[];
 const freshSchema=async()=>{
  const schema=`engine_test_${randomBytes(6).toString('hex')}`;schemas.push(schema);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const client=new pg.Client({connectionString:url});await client.connect();
  try{await client.query(`SET search_path TO ${schema}`);await migrate(client);}finally{await client.end();}
  return schema;
 };
 test.after(async()=>{for(const schema of schemas)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

 storeContract(test,'postgres store',async()=>new PostgresEngineStore({connectionString:url,searchPath:await freshSchema()}));

 test('migrations are idempotent and reject edited applied files',async()=>{
  const schema=await freshSchema(),client=new pg.Client({connectionString:url});await client.connect();
  try{
   await client.query(`SET search_path TO ${schema}`);
   assert.deepEqual((await migrate(client)).applied,[]);
   const edited=loadMigrations().map(migration=>({...migration,checksum:'0'.repeat(64)}));
   await assert.rejects(migrate(client,{migrations:edited}),/has been modified/);
  }finally{await client.end();}
 });

 test('database constraints keep entries append-only and rows synthetic',async()=>{
  const schema=await freshSchema(),store=new PostgresEngineStore({connectionString:url,searchPath:schema});
  const {seed}=await import('./support/store-contract.mjs');await store.seed(seed);await store.close();
  const client=new pg.Client({connectionString:url});await client.connect();
  try{
   await client.query(`SET search_path TO ${schema}`);
   await assert.rejects(client.query('UPDATE ledger_entries SET amount_minor=1'),/append-only/);
   await assert.rejects(client.query('DELETE FROM ledger_entries'),/append-only/);
   await assert.rejects(client.query("INSERT INTO ledger_accounts (tenant_id,account_id,currency,balance_minor,synthetic_only) VALUES ('tenant_x','a','USD',1,false)"),/synthetic_only/);
   await assert.rejects(client.query("INSERT INTO ledger_accounts (tenant_id,account_id,currency,balance_minor) VALUES ('tenant_x','a','USD',-1)"),/balance_minor/);
  }finally{await client.end();}
 });

 test('concurrent posts against one account serialize on the row lock',async()=>{
  const store=new PostgresEngineStore({connectionString:url,searchPath:await freshSchema()});
  const {DurableLedger}=await import('../src/runtime/durable-services.mjs');
  const support=await import('./support/store-contract.mjs');
  await store.seed(support.seed);
  const {createBankAdapterContract}=await import('../src/bank-adapter.mjs');
  const {createEventSchema}=await import('../src/event-outbox.mjs');
  const {PolicyGateway,createGatewayPolicy}=await import('../src/policy-gateway.mjs');
  const {createRolePolicy}=await import('../src/identity.mjs');
  const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'v1',rules:[{action:'bank.accounts.read',permission:'bank:read'},{action:'bank.entries.post',permission:'bank:post'}]}),rolePolicy:createRolePolicy([{name:'operator',permissions:['bank:read','bank:post']}])});
  const ledger=new DurableLedger({contract:createBankAdapterContract({adapterId:'durable-ledger',version:'v1',currencies:['USD'],actions:{read:'bank.accounts.read',post:'bank.entries.post'}}),gateway,store,eventSchema:createEventSchema({type:'ledger.entry.posted',version:'v1'})});
  const identity=await support.identityFor();
  const attempts=await Promise.allSettled(Array.from({length:6},(_,index)=>ledger.postEntry({identity,requestId:`race-${index}`,entryId:`race-entry-${index}`,accountId:'acct-1',direction:'debit',amountMinor:100,currency:'USD',expectedVersion:0,descriptionCode:'race',assignments:support.assignmentFor(),now:support.now})));
  assert.equal(attempts.filter(attempt=>attempt.status==='fulfilled').length,1);
  assert.ok(attempts.filter(attempt=>attempt.status==='rejected').every(attempt=>attempt.reason.code==='VERSION_CONFLICT'));
  assert.equal((await ledger.readAccount({identity,accountId:'acct-1',assignments:support.assignmentFor(),now:support.now})).balanceMinor,9_900);
  await store.close();
 });
}

if(url){
 test('start-up migrates and serves the synthetic API from Postgres',async()=>{
  const {createStoreFromEnvironment}=await import('../bin/start.mjs');
  const {createEngineRuntime}=await import('../src/runtime/engine-runtime.mjs');
  const lines=[];const original=console.log;console.log=line=>lines.push(line);
  let store;try{store=await createStoreFromEnvironment({DATABASE_URL:url});}finally{console.log=original;}
  assert.match(lines.join('\n'),/Database migrations complete/);
  const runtime=await createEngineRuntime({store,sessionSecret:'x'.repeat(40)});
  assert.deepEqual(await runtime.health(),{ok:true,kind:'postgres'});
  const identity=await runtime.authenticate(runtime.issueSession({tenantId:'tenant_demo_beta',subject:'customer-1'}).token);
  const home=await runtime.home(identity,{accountIds:['checking','savings']});
  assert.equal(home.accounts.length,2);assert.equal(home.syntheticOnly,true);
  await runtime.close();
 });
}
