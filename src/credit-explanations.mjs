import {bounded,ensure} from './runtime/guards.mjs';

const code='INVALID_CREDIT_EXPLANATION';
/** Factors that may never be used in, or explained as part of, a credit decision. */
const PROHIBITED=/^(age|race|color|colour|religion|national-origin|sex|gender|marital-status|public-assistance|disability|familial-status|ethnicity|sexual-orientation|zip-proxy)$/;

/**
 * BNK-037 credit explanations. Explains a decision produced elsewhere (a synthetic scorecard here); the engine
 * makes no credit decision. Contributions must reconcile exactly with the score, prohibited factors are refused,
 * and adverse outcomes list up to four principal reasons in plain language with actionable hints.
 */
export function explainCreditDecision({decisionId,decision,score,baselineScore,approvalThreshold,modelVersion,factors,reasonCatalog}){
 bounded(decisionId,'Decision ID',code);bounded(modelVersion,'Model version',code);
 ensure(['approve','decline','counteroffer'].includes(decision),code,'Decision is invalid');
 for(const value of [score,baselineScore,approvalThreshold])ensure(Number.isSafeInteger(value),code,'Scores must be integers');
 ensure(Array.isArray(factors)&&factors.length>=1&&factors.length<=50,code,'Factors are required');
 ensure(reasonCatalog&&typeof reasonCatalog==='object',code,'Reason catalog is required');
 const normalized=factors.map(factor=>{
  bounded(factor?.code,'Factor code',code);ensure(!PROHIBITED.test(factor.code),'PROHIBITED_FACTOR',`Factor ${factor.code} is prohibited in credit decisions`);
  ensure(Number.isSafeInteger(factor.contribution),code,'Contributions must be integers');ensure(typeof factor.customerActionable==='boolean',code,'Actionability must be explicit');
  const statement=reasonCatalog[factor.code];ensure(typeof statement==='string'&&statement.length>=10&&statement.length<=200,'MISSING_REASON_TEXT',`No plain-language reason for ${factor.code}`);
  return {...factor,statement};
 });
 const total=normalized.reduce((sum,factor)=>sum+factor.contribution,0);
 ensure(baselineScore+total===score,'UNRECONCILED_EXPLANATION','Factor contributions must reconcile exactly with the score');
 ensure((decision==='approve')===(score>=approvalThreshold)||decision==='counteroffer','DECISION_SCORE_MISMATCH','Decision is inconsistent with the score and threshold');
 const adverse=decision!=='approve';
 const principal=adverse?normalized.filter(factor=>factor.contribution<0).sort((left,right)=>left.contribution-right.contribution||(left.code<right.code?-1:1)).slice(0,4):[];
 ensure(!adverse||principal.length>=1,'NO_PRINCIPAL_REASON','An adverse decision needs at least one negative factor');
 const gap=Math.max(0,approvalThreshold-score);
 return Object.freeze({
  decisionId,decision,modelVersion,score,approvalThreshold,
  principalReasons:Object.freeze(principal.map((factor,index)=>Object.freeze({rank:index+1,code:factor.code,statement:factor.statement,customerActionable:factor.customerActionable}))),
  pointsToThreshold:adverse?gap:0,
  actionableHints:Object.freeze(principal.filter(factor=>factor.customerActionable).map(factor=>Object.freeze({code:factor.code,maxRecoverablePoints:-factor.contribution}))),
  engineMadeDecision:false,notAdvice:true,
  statement:'This explains a synthetic decision made by a separate scoring process. It is not an adverse action notice reviewed for any jurisdiction.',
  syntheticOnly:true
 });
}
