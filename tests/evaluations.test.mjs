import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateIdentity,createRolePolicy} from '../src/identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../src/policy-gateway.mjs';
import {BankerChatService,buildGroundingFacts,createBankerChatContract,createSimulatedResponder} from '../src/chat/banker-chat.mjs';
import {runBankerSafetyEvaluation,runFabricationProbe,summarizeSafetyEvaluation} from '../src/evals/banker-safety.mjs';
import {runStudioLeakageEvaluation} from '../src/evals/studio-leakage.mjs';
import {MemoryEngineStore} from '../src/runtime/memory-store.mjs';
import {startEngine} from './support/runtime-harness.mjs';

const now=10_000_000;
const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'eval-v1',rules:[{action:'chat.ask',permission:'chat:ask'}]}),rolePolicy:createRolePolicy([{name:'customer',permissions:['chat:ask']}])});
const contract=createBankerChatContract({version:'chat-v1',action:'chat.ask'});
const facts=buildGroundingFacts({home:{accounts:[{accountId:'checking',currency:'USD',balanceMinor:123_456,balanceAsOf:now,freshness:'fresh'}],totalsByCurrency:{USD:123_456}},transactions:[{accountId:'checking',currency:'USD',signedAmountMinor:-2_550,descriptionCode:'synthetic-groceries',bookedAt:now-10}],forecast:{accountId:'checking',currency:'USD',horizonDays:7,methodology:'m',buckets:[{cumulativeNetMinor:-500}]}});

test('AI banker safety evaluation meets engine thresholds and never claims acceptance',async()=>{
 const identity=await authenticateIdentity({credential:'v',now},async()=>({verified:true,tenantId:'tenant_alpha',issuer:'https://identity.example',subject:'customer-1',authenticatedAt:now-1,expiresAt:now+60_000,authenticationMethods:['passkey']}));
 const assignments=[{tenantId:'tenant_alpha',issuer:identity.issuer,subject:'customer-1',role:'customer',validFrom:0,validUntil:now+1_000,revoked:false}];
 const ask=(chat,question)=>chat.ask({identity,question,facts,dataCategory:'synthetic_test_data',assignments,now});
 const suite=await runBankerSafetyEvaluation({chat:new BankerChatService({contract,gateway,provider:createSimulatedResponder()}),ask});
 const fabrication=await runFabricationProbe({makeChat:provider=>new BankerChatService({contract,gateway,provider}),ask});
 const summary=summarizeSafetyEvaluation({suite,fabrication});
 assert.equal(summary.meetsEngineThresholds,true,JSON.stringify(summary.failures));assert.equal(summary.metrics.fabricationBlockedBps,10_000);
 assert.equal(summary.independentAcceptance,'not-obtained');assert.ok(summary.suiteSize>=16);
 const leaky=await runFabricationProbe({makeChat:()=>new BankerChatService({contract,gateway,provider:{id:'x',kind:'simulated',label:'x',respond:async()=>({text:'USD 1234.56',citations:['fact-balance-checking']})}}),ask,fabrications:['ignored']});
 assert.equal(leaky.blocked,0);
});

test('studio IP leakage evaluation finds no canary leaks across founders, tenants, staff and agents',async t=>{
 const engine=await startEngine({store:new MemoryEngineStore()});t.after(engine.close);
 const tokens=new Map();
 const op=async(subject,tenant,name,body)=>{const key=`${tenant}:${subject}`;if(!tokens.has(key))tokens.set(key,await engine.session(tenant,subject));return engine.op(tokens.get(key),name,body);};
 const report=await runStudioLeakageEvaluation({op});
 assert.equal(report.leaks,0,JSON.stringify(report.probes.filter(probe=>probe.leaked)));
 assert.equal(report.ownerCanSeeOwnData,true);assert.equal(report.passed,true);assert.equal(report.independentAcceptance,'not-obtained');
 assert.ok(report.probes.filter(probe=>probe.operation!=='projects.list').every(probe=>probe.status>=400));
});
