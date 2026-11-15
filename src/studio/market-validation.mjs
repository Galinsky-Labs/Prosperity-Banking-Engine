import {bounded,ensure} from '../runtime/guards.mjs';

const code='INVALID_MARKET_VALIDATION';
/** Wilson score interval at 95% confidence, returned in integer basis points. */
export function wilsonIntervalBps(successes,total){
 ensure(Number.isInteger(successes)&&Number.isInteger(total)&&total>=1&&successes>=0&&successes<=total,code,'Counts are invalid');
 const z=1.959963984540054,p=successes/total,denominator=1+z*z/total,centre=p+z*z/(2*total),margin=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total));
 return Object.freeze({lowerBps:Math.max(0,Math.floor((centre-margin)/denominator*10_000)),upperBps:Math.min(10_000,Math.ceil((centre+margin)/denominator*10_000))});
}

/**
 * BNK-026 market validation. Summarizes structured interview, survey and pilot responses per segment with
 * Wilson intervals and explicit bias warnings. A segment shows a signal only when the interval's lower bound
 * clears the threshold with an adequate, non-duplicated, mostly unincentivized sample from more than one source.
 */
export function summarizeMarketValidation({responses,signalThresholdBps=2_000,minSample=30}){
 ensure(Array.isArray(responses)&&responses.length>=1&&responses.length<=10_000,code,'Bounded responses are required');
 ensure(Number.isInteger(signalThresholdBps)&&signalThresholdBps>=1&&signalThresholdBps<=10_000&&Number.isInteger(minSample)&&minSample>=5,code,'Thresholds are invalid');
 const segments=new Map(),seen=new Set();let duplicates=0;
 for(const response of responses){
  bounded(response?.respondentId,'Respondent ID',code);bounded(response.segment,'Segment',code);
  ensure(['yes','no','maybe'].includes(response.outcome),code,'Outcome must be yes, no or maybe');
  ensure(['interview','survey','pilot'].includes(response.source),code,'Source is unsupported');ensure(typeof response.incentivized==='boolean',code,'Incentive flag is required');
  const key=`${response.segment}:${response.respondentId}`;if(seen.has(key)){duplicates+=1;continue;}seen.add(key);
  const segment=segments.get(response.segment)??{total:0,yes:0,incentivized:0,sources:new Set()};
  segment.total+=1;if(response.outcome==='yes')segment.yes+=1;if(response.incentivized)segment.incentivized+=1;segment.sources.add(response.source);segments.set(response.segment,segment);
 }
 const summaries=[...segments.entries()].sort(([left],[right])=>left<right?-1:1).map(([segment,data])=>{
  const interval=wilsonIntervalBps(data.yes,data.total),warnings=[];
  if(data.total<minSample)warnings.push('SMALL_SAMPLE');
  if(data.incentivized*2>data.total)warnings.push('MOSTLY_INCENTIVIZED');
  if(data.sources.size<2)warnings.push('SINGLE_SOURCE');
  const signal=warnings.length===0&&interval.lowerBps>=signalThresholdBps;
  return Object.freeze({segment,respondents:data.total,positive:data.yes,rateBps:Math.round(data.yes/data.total*10_000),interval,warnings:Object.freeze(warnings),signal});
 });
 return Object.freeze({segments:Object.freeze(summaries),duplicatesIgnored:duplicates,method:'wilson-95',syntheticOnly:true,caveat:'Stated intent is not purchase behaviour.'});
}
