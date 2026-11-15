import {PolicyGateway} from '../policy-gateway.mjs';
import {isNonHumanIdentity} from '../step-up.mjs';
import {bounded,ensure,requireDecision} from '../runtime/guards.mjs';

const code='INVALID_FUNDING';
const KINDS=Object.freeze({grant:'non-dilutive','loan-referral':'credit','accelerator':'program','investor-referral':'investment'});
const SHAREABLE=['projectSummary','stage','sector','region','verifiedClaimCount','monthlyRevenueMinor','contactEmail'];

export function createFundingCatalog(programs){
 ensure(Array.isArray(programs)&&programs.length>=1&&programs.length<=200,code,'Programs are required');
 const catalog=programs.map(program=>{
  bounded(program?.programId,'Program ID',code);ensure(Object.hasOwn(KINDS,program.kind),code,'Program kind is unsupported');
  const criteria=program.criteria??{};
  for(const key of ['stages','sectors','regions'])ensure(Array.isArray(criteria[key])&&criteria[key].length>=1,code,`Criteria ${key} are required`);
  ensure(Number.isInteger(criteria.minVerifiedClaims)&&criteria.minVerifiedClaims>=0,code,'Verified-claim minimum is required');
  ensure(criteria.maxMonthlyRevenueMinor===null||Number.isSafeInteger(criteria.maxMonthlyRevenueMinor),code,'Revenue ceiling is invalid');
  ensure(['none','fixed','percentage'].includes(program.referralCompensation?.type)&&typeof program.referralCompensation.disclosure==='string'&&program.referralCompensation.disclosure.length>=10,code,'Referral compensation must be declared with a disclosure');
  return Object.freeze({programId:program.programId,kind:program.kind,category:KINDS[program.kind],criteria:Object.freeze({...criteria}),referralCompensation:Object.freeze({...program.referralCompensation})});
 });
 ensure(new Set(catalog.map(program=>program.programId)).size===catalog.length,code,'Program IDs must be unique');
 return Object.freeze(catalog);
}

const notices=program=>Object.freeze([
 ...(program.category==='investment'?['Investment opportunities are not deposits, are not insured, may lose value and are offered only by separately authorized providers. The engine does not accept or arrange investments.']:[]),
 ...(program.category==='credit'?['A referral is not a credit decision or offer. Any lender makes its own decision.']:[]),
 `Referral compensation: ${program.referralCompensation.disclosure}`
]);

/**
 * BNK-031 funding matching and referrals. Matches are explainable criteria checks over a founder-supplied profile
 * and independently verified claim counts, with compensation and investment/credit separation notices. A
 * referral shares only fields the founder explicitly chose, needs the founder's own human, affirmative action,
 * and never accepts, arranges or advises on an investment or loan.
 */
export class FundingReferrals {
 #catalog;#gateway;#action;#referrals=new Map();
 constructor({catalog,gateway,action}){ensure(Array.isArray(catalog)&&Object.isFrozen(catalog),code,'A compiled catalog is required');ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');this.#catalog=catalog;this.#gateway=gateway;this.#action=bounded(action,'Referral action',code);}

 match({profile}){
  ensure(profile&&typeof profile==='object',code,'Profile is required');
  for(const key of ['stage','sector','region'])bounded(profile[key],key,code);
  ensure(Number.isInteger(profile.verifiedClaimCount)&&profile.verifiedClaimCount>=0&&Number.isSafeInteger(profile.monthlyRevenueMinor)&&profile.monthlyRevenueMinor>=0,code,'Verified claims and revenue are required');
  return Object.freeze(this.#catalog.map(program=>{
   const unmet=[];const c=program.criteria;
   if(!c.stages.includes(profile.stage))unmet.push('stage');if(!c.sectors.includes(profile.sector)&&!c.sectors.includes('any'))unmet.push('sector');
   if(!c.regions.includes(profile.region)&&!c.regions.includes('any'))unmet.push('region');
   if(profile.verifiedClaimCount<c.minVerifiedClaims)unmet.push('verified-claims');
   if(c.maxMonthlyRevenueMinor!==null&&profile.monthlyRevenueMinor>c.maxMonthlyRevenueMinor)unmet.push('revenue-ceiling');
   return Object.freeze({programId:program.programId,kind:program.kind,eligible:unmet.length===0,unmetCriteria:Object.freeze(unmet),notices:notices(program),notAdvice:true});
  }).sort((left,right)=>Number(right.eligible)-Number(left.eligible)||left.unmetCriteria.length-right.unmetCriteria.length||(left.programId<right.programId?-1:1)));
 }

 refer({identity,referralId,programId,profile,sharedFields,affirmative,acknowledgedNotices,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#action,assignments,now},'REFERRAL_DENIED');
  ensure(!isNonHumanIdentity(identity),'HUMAN_REQUIRED','Only the founder can make a referral');
  bounded(referralId,'Referral ID',code);ensure(!this.#referrals.has(`${identity.tenantId}:${referralId}`),'REFERRAL_CONFLICT','Referral already exists');
  const program=this.#catalog.find(candidate=>candidate.programId===programId);ensure(program,'PROGRAM_NOT_FOUND','Program does not exist');
  const match=this.match({profile}).find(candidate=>candidate.programId===programId);ensure(match.eligible,'NOT_ELIGIBLE','Founder does not meet the program criteria');
  ensure(affirmative===true,'AFFIRMATIVE_CONSENT_REQUIRED','Referral requires an affirmative founder action');
  ensure(acknowledgedNotices===true,'NOTICES_REQUIRED','The founder must acknowledge the program notices');
  ensure(Array.isArray(sharedFields)&&sharedFields.length>=1&&sharedFields.every(field=>SHAREABLE.includes(field)),code,'Shared fields must be chosen from the allowed list');
  const shared=Object.freeze(Object.fromEntries([...new Set(sharedFields)].filter(field=>profile[field]!==undefined).map(field=>[field,profile[field]])));
  const referral=Object.freeze({tenantId:identity.tenantId,referralId,programId,kind:program.kind,founder:Object.freeze({issuer:identity.issuer,subject:identity.subject}),sharedData:shared,notices:match.notices,referredAt:now,acceptsInvestment:false,arrangesCredit:false,syntheticOnly:true});
  this.#referrals.set(`${identity.tenantId}:${referralId}`,referral);return referral;
 }
}
