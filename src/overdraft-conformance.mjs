import {OPT_IN_REQUIRED_RAILS,OVERDRAFT_RAILS,evaluateOverdraft} from './overdraft.mjs';
import {ensure} from './runtime/guards.mjs';

/**
 * BNK-036 overdraft network certification support. Runs a fixed engine conformance suite against a tenant's
 * compiled overdraft policy and produces evidence for a later certification. It never claims certification:
 * `networkCertification` is always `not-obtained` and must be granted by the relevant networks and partners.
 */
export function runOverdraftConformance(policy,{suiteVersion='od-conformance-v1'}={}){
 const cases=[];
 const check=(caseId,input,expectation)=>{let result,error=null;try{result=evaluateOverdraft(policy,{currency:policy.currency,feesChargedToday:0,forcePost:false,...input});}catch(caught){error=caught.code??'ERROR';}
  const passed=error===null&&expectation(result);cases.push(Object.freeze({caseId,passed,decision:result?.decision??null,feeMinor:result?.feeMinor??null,reasons:result?Object.freeze([...result.reasons]):Object.freeze([error])}));};
 for(const rail of OPT_IN_REQUIRED_RAILS)check(`${rail}-no-opt-in-never-fee`,{rail,amountMinor:10_000,availableMinor:0,feeBearingCoverage:false},result=>result.feeMinor===0&&(result.decision==='decline'||policy.rails[rail]==='cover-no-fee'));
 for(const rail of OVERDRAFT_RAILS)check(`${rail}-force-post-no-fee-without-coverage`,{rail,amountMinor:10_000,availableMinor:0,feeBearingCoverage:false,forcePost:true},result=>result.decision==='approve'&&result.feeMinor===0);
 for(const rail of OVERDRAFT_RAILS)check(`${rail}-sufficient-funds`,{rail,amountMinor:100,availableMinor:1_000,feeBearingCoverage:true},result=>result.decision==='approve'&&result.feeMinor===0&&result.overdraftMinor===0);
 check('de-minimis-no-fee',{rail:'one-time-debit',amountMinor:Math.max(1,policy.deMinimisMinor),availableMinor:0,feeBearingCoverage:true},result=>result.feeMinor===0);
 check('daily-cap',{rail:'one-time-debit',amountMinor:policy.deMinimisMinor+10_000,availableMinor:0,feeBearingCoverage:true,feesChargedToday:policy.maxFeesPerDay},result=>result.feeMinor===0);
 check('fee-never-exceeds-overdraft',{rail:'one-time-debit',amountMinor:policy.deMinimisMinor+1,availableMinor:0,feeBearingCoverage:true},result=>result.feeMinor<=result.overdraftMinor);
 check('over-limit-declines',{rail:'one-time-debit',amountMinor:policy.maxOverdraftMinor+1,availableMinor:0,feeBearingCoverage:true},result=>result.decision==='decline'&&result.feeMinor===0);
 check('negative-balance-treated-as-zero',{rail:'ach',amountMinor:500,availableMinor:-10_000,feeBearingCoverage:false},result=>result.overdraftMinor<=500);
 const failed=cases.filter(item=>!item.passed);
 return Object.freeze({suiteVersion,policyVersion:policy.version,cases:Object.freeze(cases),passed:cases.length-failed.length,failed:failed.length,engineSelfTest:failed.length===0?'passed':'failed',networkCertification:'not-obtained',certifiedBy:null,statement:'Engine self-test evidence only. Network and partner certification have not been obtained.',syntheticOnly:true});
}
