import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {createAuditSinkContract,TenantAuditSink} from '../src/audit-sink.mjs';

const now=10_000_000;
const identityFor=async(tenantId='tenant_alpha',subject='auditor-1')=>authenticateIdentity({credential:'valid',now},async()=>({verified:true,tenantId,issuer:'https://identity.example',subject,authenticatedAt:now-1_000,expiresAt:now+60_000,authenticationMethods:['workload']}));
const rolePolicy=createRolePolicy([{name:'audit-operator',permissions:['audit:read','audit:write']}]);
const policy=createGatewayPolicy({version:'audit-policy-v1',rules:[{action:'audit.read',permission:'audit:read'},{action:'audit.write',permission:'audit:write'}]});
const contract=createAuditSinkContract({version:'audit-v1',actions:{read:'audit.read',write:'audit.write'},attributeKeys:['attempt','service']});
const assignmentFor=(tenantId='tenant_alpha',subject='auditor-1')=>({tenantId,issuer:'https://identity.example',subject,role:'audit-operator',validFrom:now-10_000,validUntil:now+10_000,revoked:false});
const sink=()=>new TenantAuditSink({contract,gateway:new PolicyGateway({policy,rolePolicy})});
const append=(identity,overrides={})=>({identity,requestId:'request-1',recordId:'record-1',eventType:'policy.decision',outcome:'allowed',correlationId:'trace-1',attributes:{attempt:1,service:'gateway'},occurredAt:now-100,assignments:[assignmentFor(identity.tenantId,identity.subject)],now,...overrides});

test('appends immutable hash-chained records and replays exact requests',async()=>{
 const identity=await identityFor(),repository=sink(),first=repository.append(append(identity)),replay=repository.append(append(identity,{now:now+1}));
 assert.strictEqual(replay,first);assert.equal(first.sequence,1);assert.equal(first.previousHash,null);assert.match(first.recordHash,/^[a-f0-9]{64}$/);assert.equal(Object.isFrozen(first.attributes),true);
 const second=repository.append(append(identity,{requestId:'request-2',recordId:'record-2'}));assert.equal(second.sequence,2);assert.equal(second.previousHash,first.recordHash);
 assert.throws(()=>repository.append(append(identity,{outcome:'denied'})),/different terms/);
});

test('isolates tenant queries and requires exact read authorization',async()=>{
 const alpha=await identityFor(),beta=await identityFor('tenant_beta'),repository=sink(),record=repository.append(append(alpha));
 assert.deepEqual(repository.list({identity:alpha,assignments:[assignmentFor()],now}),[record]);
 assert.deepEqual(repository.list({identity:beta,assignments:[assignmentFor('tenant_beta')],now}),[]);
 assert.throws(()=>repository.list({identity:alpha,assignments:[],now}),/authorization/);
});

test('rejects sensitive, undeclared and unbounded observability data',async()=>{
 const identity=await identityFor(),repository=sink();
 assert.throws(()=>repository.append({...append(identity),payload:'raw'}),/Sensitive audit/);
 assert.throws(()=>repository.append(append(identity,{attributes:{service:'gateway',customerId:'customer-1'}})),/Sensitive audit|allowlisted/);
 assert.throws(()=>repository.append(append(identity,{attributes:{service:{nested:true}}})),/bounded scalars/);
 assert.throws(()=>createAuditSinkContract({version:'v1',actions:{read:'audit.read',write:'audit.write'},attributeKeys:['accessToken']}),/non-sensitive/);
});

test('fails closed for forged identities, expired sessions and duplicate record ids',async()=>{
 const identity=await identityFor(),repository=sink();repository.append(append(identity));
 assert.throws(()=>repository.append(append({...identity},{requestId:'request-2',recordId:'record-2'})),/Verified identity/);
 assert.throws(()=>repository.append(append(identity,{requestId:'request-2',recordId:'record-2',now:identity.expiresAt})),/Active verified/);
 assert.throws(()=>repository.append(append(identity,{requestId:'request-2'})),/already exists/);
});
