import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {authorizeDataUse} from '../data-classification.mjs';
import {bounded,ensure} from '../runtime/guards.mjs';

const code='INVALID_FEASIBILITY';
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>JSON.parse(JSON.stringify(value??null));

/**
 * BNK-025 technical feasibility sandbox. Runs small, engine-authored experiment expressions over synthetic
 * inputs in a fresh V8 context with no require, process, timers, network or filesystem, a time limit and a
 * bounded result. node:vm is NOT a security boundary, so founder-supplied code must never be run here; the
 * sandbox only rejects anything but synthetic test data and records digests of code, inputs and results.
 */
export function runFeasibilityExperiment({experimentId,expression,inputs,dataCategory='synthetic_test_data',timeoutMs=50}){
 bounded(experimentId,'Experiment ID',code);
 ensure(typeof expression==='string'&&expression.length>=1&&expression.length<=2_000,code,'Bounded experiment expression is required');
 ensure(!/\b(import|require|process|globalThis|Function|eval|constructor|__proto__|prototype)\b/.test(expression),'SANDBOX_ESCAPE_DENIED','Expression uses a forbidden identifier');
 ensure(dataCategory==='synthetic_test_data','DATA_USE_DENIED','The feasibility sandbox accepts synthetic test data only');
 authorizeDataUse({category:dataCategory,operation:'model_input'});
 ensure(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=1_000,code,'Timeout is out of bounds');
 const serializedInputs=JSON.stringify(inputs??null);ensure(serializedInputs.length<=65_536,code,'Inputs are too large');
 const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
 context.input=vm.runInContext(`(${serializedInputs})`,context);
 let status='passed',result=null,errorCode=null;
 try{result=plain(vm.runInContext(`'use strict';(${expression})`,context,{timeout:timeoutMs}));if(JSON.stringify(result).length>16_384){status='failed';result=null;errorCode='RESULT_TOO_LARGE';}}
 catch(error){status='failed';errorCode=/Script execution timed out/.test(String(error?.message))?'TIMEOUT':'EXPERIMENT_ERROR';}
 return Object.freeze({experimentId,status,result,errorCode,expressionDigest:sha(expression),inputDigest:sha(serializedInputs),resultDigest:sha(JSON.stringify(result)),syntheticOnly:true,securityBoundary:false});
}

/** Aggregate criteria into a verdict. Required criteria without a passing experiment keep the verdict inconclusive. */
export function assessFeasibility({criteria,experiments}){
 ensure(Array.isArray(criteria)&&criteria.length>=1&&criteria.length<=50,code,'Criteria are required');
 const byId=new Map((experiments??[]).map(experiment=>[experiment.experimentId,experiment]));
 const results=criteria.map(criterion=>{
  bounded(criterion?.criterionId,'Criterion ID',code);ensure(typeof criterion.required==='boolean',code,'Criterion requirement must be explicit');
  const experiment=byId.get(criterion.experimentId);
  const passed=experiment?experiment.status==='passed'&&(criterion.expect===undefined||JSON.stringify(experiment.result)===JSON.stringify(criterion.expect)):null;
  return Object.freeze({criterionId:criterion.criterionId,required:criterion.required,passed,evidence:experiment?experiment.resultDigest:null});
 });
 const required=results.filter(result=>result.required);
 const verdict=required.some(result=>result.passed===false)?'not-feasible':required.some(result=>result.passed===null)?'inconclusive':'feasible-in-sandbox';
 return Object.freeze({verdict,criteria:Object.freeze(results),caveat:'Sandbox results on synthetic inputs do not establish production feasibility.',syntheticOnly:true});
}
