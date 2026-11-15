import test from 'node:test';
import assert from 'node:assert/strict';
import {assessFeasibility,runFeasibilityExperiment} from '../src/studio/feasibility.mjs';
import {summarizeMarketValidation,wilsonIntervalBps} from '../src/studio/market-validation.mjs';
import {computeUnitEconomics,unitEconomicsSensitivity} from '../src/studio/unit-economics.mjs';

test('feasibility experiments run isolated, bounded and digest-recorded',()=>{
 const ok=runFeasibilityExperiment({experimentId:'throughput',expression:'input.invoices.filter(item=>item.amountMinor>0).length',inputs:{invoices:[{amountMinor:5},{amountMinor:0},{amountMinor:9}]}});
 assert.equal(ok.status,'passed');assert.equal(ok.result,2);assert.match(ok.resultDigest,/^[a-f0-9]{64}$/);assert.equal(ok.securityBoundary,false);
 assert.equal(runFeasibilityExperiment({experimentId:'loop',expression:'(()=>{while(true){}})()',inputs:{}}).errorCode,'TIMEOUT');
 assert.equal(runFeasibilityExperiment({experimentId:'missing',expression:'fetch("https://example.invalid")',inputs:{}}).errorCode,'EXPERIMENT_ERROR');
 for(const expression of ['process.exit(1)','this.constructor.constructor("return process")()','require("fs")','globalThis'])assert.throws(()=>runFeasibilityExperiment({experimentId:'escape',expression,inputs:{}}),{code:'SANDBOX_ESCAPE_DENIED'},expression);
 assert.throws(()=>runFeasibilityExperiment({experimentId:'x',expression:'1',inputs:{},dataCategory:'customer_financial_data'}),{code:'DATA_USE_DENIED'});
 const verdict=assessFeasibility({criteria:[{criterionId:'counts',required:true,experimentId:'throughput',expect:2},{criterionId:'latency',required:true,experimentId:'not-run'},{criterionId:'nice',required:false,experimentId:'loop'}],experiments:[ok]});
 assert.equal(verdict.verdict,'inconclusive');assert.equal(verdict.criteria[0].passed,true);
 assert.equal(assessFeasibility({criteria:[{criterionId:'counts',required:true,experimentId:'throughput',expect:3}],experiments:[ok]}).verdict,'not-feasible');
 assert.equal(assessFeasibility({criteria:[{criterionId:'counts',required:true,experimentId:'throughput',expect:2}],experiments:[ok]}).verdict,'feasible-in-sandbox');
});

test('market validation uses Wilson intervals and flags weak evidence',()=>{
 assert.deepEqual({...wilsonIntervalBps(10,20)},{lowerBps:2992,upperBps:7008});
 assert.equal(wilsonIntervalBps(0,10).lowerBps,0);
 const responses=[];
 for(let index=0;index<40;index+=1)responses.push({respondentId:`r${index}`,segment:'freelancers',outcome:index<20?'yes':'no',source:index%2?'interview':'survey',incentivized:index<5});
 for(let index=0;index<8;index+=1)responses.push({respondentId:`s${index}`,segment:'agencies',outcome:'yes',source:'survey',incentivized:true});
 responses.push({respondentId:'r1',segment:'freelancers',outcome:'yes',source:'pilot',incentivized:false});
 const summary=summarizeMarketValidation({responses});
 const [agencies,freelancers]=summary.segments;
 assert.equal(summary.duplicatesIgnored,1);
 assert.equal(freelancers.respondents,40);assert.equal(freelancers.signal,true);assert.deepEqual([...freelancers.warnings],[]);
 assert.equal(agencies.signal,false);assert.deepEqual([...agencies.warnings],['SMALL_SAMPLE','MOSTLY_INCENTIVIZED','SINGLE_SOURCE']);
 assert.throws(()=>summarizeMarketValidation({responses:[{respondentId:'x',segment:'a',outcome:'love-it',source:'survey',incentivized:false}]}),/Outcome/);
});

test('unit economics use integer math and plain warnings',()=>{
 const base={currency:'USD',priceMinor:4_900,variableCostMinor:900,paymentFeeBps:300,cacMinor:12_000,monthlyChurnBps:500};
 const result=computeUnitEconomics(base);
 assert.equal(result.feeMinor,147);assert.equal(result.contributionMinor,3_853);assert.equal(result.grossMarginBps,7863);
 assert.equal(result.ltvMinor,77_060);assert.equal(result.ltvToCacX100,642);assert.equal(result.paybackMonths,4);assert.deepEqual([...result.warnings],[]);
 const poor=computeUnitEconomics({...base,priceMinor:900,monthlyChurnBps:2_000});
 assert.deepEqual([...poor.warnings],['NEGATIVE_CONTRIBUTION','LTV_CAC_BELOW_3X','PAYBACK_OVER_24_MONTHS']);
 assert.ok(computeUnitEconomics({...base,cacMinor:200_000}).warnings.includes('CUSTOMERS_CHURN_BEFORE_PAYBACK'));
 assert.throws(()=>computeUnitEconomics({...base,priceMinor:49.99}),/safe integer/);
 const grid=unitEconomicsSensitivity(base);assert.equal(grid.length,15);
 assert.ok(grid.find(row=>row.priceStepBps===-2_000&&row.churnStepBps===2_500).ltvToCacX100<result.ltvToCacX100);
});
