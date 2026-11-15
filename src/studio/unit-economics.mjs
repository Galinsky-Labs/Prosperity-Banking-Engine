import {ensure} from '../runtime/guards.mjs';

const code='INVALID_UNIT_ECONOMICS';
const int=(value,label,min=0)=>{ensure(Number.isSafeInteger(value)&&value>=min,code,`${label} must be a safe integer of at least ${min}`);return value;};

/**
 * BNK-027 pricing and unit economics. Integer minor units and basis points throughout. Returns monthly
 * contribution, gross margin, churn-based lifetime value, LTV:CAC, CAC payback and plain warnings. These are
 * planning estimates for a founder, not credit, investment or pricing approval decisions.
 */
export function computeUnitEconomics({currency,priceMinor,variableCostMinor,paymentFeeBps=0,cacMinor,monthlyChurnBps}){
 ensure(typeof currency==='string'&&/^[A-Z]{3}$/.test(currency),code,'Currency is required');
 int(priceMinor,'Price',1);int(variableCostMinor,'Variable cost');int(cacMinor,'Acquisition cost');
 ensure(Number.isInteger(paymentFeeBps)&&paymentFeeBps>=0&&paymentFeeBps<=10_000,code,'Payment fee is invalid');
 ensure(Number.isInteger(monthlyChurnBps)&&monthlyChurnBps>=1&&monthlyChurnBps<=10_000,code,'Monthly churn must be between 1 and 10000 basis points');
 const feeMinor=Math.ceil(priceMinor*paymentFeeBps/10_000),contributionMinor=priceMinor-variableCostMinor-feeMinor;
 const grossMarginBps=Math.trunc(contributionMinor*10_000/priceMinor);
 const expectedLifetimeMonthsX100=Math.trunc(1_000_000/monthlyChurnBps);
 const ltvMinor=contributionMinor>0?Math.trunc(contributionMinor*10_000/monthlyChurnBps):0;
 const ltvToCacX100=cacMinor===0?null:Math.trunc(ltvMinor*100/cacMinor);
 const paybackMonths=contributionMinor>0?Math.ceil(cacMinor/contributionMinor):null;
 const warnings=[];
 if(contributionMinor<=0)warnings.push('NEGATIVE_CONTRIBUTION');
 if(ltvToCacX100!==null&&ltvToCacX100<300)warnings.push('LTV_CAC_BELOW_3X');
 if(paybackMonths===null||paybackMonths>24)warnings.push('PAYBACK_OVER_24_MONTHS');
 if(paybackMonths!==null&&expectedLifetimeMonthsX100<paybackMonths*100)warnings.push('CUSTOMERS_CHURN_BEFORE_PAYBACK');
 return Object.freeze({currency,feeMinor,contributionMinor,grossMarginBps,expectedLifetimeMonthsX100,ltvMinor,ltvToCacX100,paybackMonths,warnings:Object.freeze(warnings),notAdvice:true,syntheticOnly:true});
}

/** Price and churn sensitivity grid around a base case. */
export function unitEconomicsSensitivity(base,{priceStepsBps=[-2_000,-1_000,0,1_000,2_000],churnStepsBps=[-2_500,0,2_500]}={}){
 ensure(Array.isArray(priceStepsBps)&&priceStepsBps.length<=11&&Array.isArray(churnStepsBps)&&churnStepsBps.length<=11,code,'Sensitivity grid is too large');
 const rows=[];
 for(const priceStep of priceStepsBps)for(const churnStep of churnStepsBps){
  const priceMinor=Math.max(1,Math.trunc(base.priceMinor*(10_000+priceStep)/10_000)),monthlyChurnBps=Math.min(10_000,Math.max(1,Math.trunc(base.monthlyChurnBps*(10_000+churnStep)/10_000)));
  const result=computeUnitEconomics({...base,priceMinor,monthlyChurnBps});
  rows.push(Object.freeze({priceStepBps:priceStep,churnStepBps:churnStep,priceMinor,monthlyChurnBps,ltvToCacX100:result.ltvToCacX100,paybackMonths:result.paybackMonths,warnings:result.warnings}));
 }
 return Object.freeze(rows);
}
