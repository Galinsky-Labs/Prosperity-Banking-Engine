import {bounded,ensure} from './runtime/guards.mjs';

const code='INVALID_RECONCILIATION';
const DAY=86_400_000;
const line=(item,label)=>{bounded(item?.reference,`${label} reference`,code);ensure(Number.isSafeInteger(item.signedAmountMinor)&&item.signedAmountMinor!==0&&Number.isSafeInteger(item.at),code,`${label} amount and time are required`);return item;};

/**
 * BNK-034 reconciliation of engine-ledger entries against a bank-of-record statement. The bank core is
 * authoritative: breaks are reported for humans and never auto-corrected. Matching is by reference, then by
 * exact amount within a date tolerance; balance continuity is checked separately.
 */
export function reconcile({currency,engineEntries,statement,toleranceMs=2*DAY}){
 ensure(typeof currency==='string'&&/^[A-Z]{3}$/.test(currency),code,'Currency is required');
 ensure(statement&&Number.isSafeInteger(statement.openingMinor)&&Number.isSafeInteger(statement.closingMinor)&&Array.isArray(statement.lines)&&statement.lines.length<=10_000,code,'Statement with opening, closing and lines is required');
 ensure(Array.isArray(engineEntries)&&engineEntries.length<=10_000,code,'Engine entries are bounded');
 const engine=engineEntries.map(item=>({...line(item,'Engine'),matched:false})),bank=statement.lines.map(item=>({...line(item,'Statement'),matched:false}));
 const matches=[],amountMismatches=[];
 for(const entry of engine){
  const candidate=bank.find(item=>!item.matched&&item.reference===entry.reference);
  if(!candidate)continue;
  candidate.matched=entry.matched=true;
  if(candidate.signedAmountMinor!==entry.signedAmountMinor)amountMismatches.push(Object.freeze({reference:entry.reference,engineMinor:entry.signedAmountMinor,bankMinor:candidate.signedAmountMinor}));
  else matches.push(Object.freeze({reference:entry.reference,method:'reference'}));
 }
 for(const entry of engine.filter(item=>!item.matched)){
  const candidate=bank.find(item=>!item.matched&&item.signedAmountMinor===entry.signedAmountMinor&&Math.abs(item.at-entry.at)<=toleranceMs);
  if(candidate){candidate.matched=entry.matched=true;matches.push(Object.freeze({reference:entry.reference,bankReference:candidate.reference,method:'amount-and-date',needsConfirmation:true}));}
 }
 const net=statement.lines.reduce((sum,item)=>sum+item.signedAmountMinor,0);
 const balanceContinuous=statement.openingMinor+net===statement.closingMinor;
 const unmatchedEngine=engine.filter(item=>!item.matched).map(item=>Object.freeze({reference:item.reference,signedAmountMinor:item.signedAmountMinor}));
 const unmatchedBank=bank.filter(item=>!item.matched).map(item=>Object.freeze({reference:item.reference,signedAmountMinor:item.signedAmountMinor}));
 const breaks=unmatchedEngine.length+unmatchedBank.length+amountMismatches.length+(balanceContinuous?0:1);
 return Object.freeze({currency,matched:Object.freeze(matches),amountMismatches:Object.freeze(amountMismatches),unmatchedEngine:Object.freeze(unmatchedEngine),unmatchedBank:Object.freeze(unmatchedBank),balanceContinuous,breakCount:breaks,status:breaks===0?'reconciled':'breaks-require-review',authoritative:'bank-of-record',autoCorrected:false,syntheticOnly:true});
}

/** Deposit funds-availability schedule under a tenant hold policy. Integer minor units; holds never exceed policy maximums. */
export function depositAvailability({amountMinor,channel,accountAgeDays,depositedAt,policy}){
 ensure(Number.isSafeInteger(amountMinor)&&amountMinor>0&&Number.isInteger(accountAgeDays)&&accountAgeDays>=0&&Number.isSafeInteger(depositedAt),code,'Deposit fields are invalid');
 ensure(['cash','electronic','check','mobile-check'].includes(channel),code,'Channel is unsupported');
 ensure(policy&&Number.isSafeInteger(policy.nextDayMinor)&&Number.isInteger(policy.standardHoldDays)&&Number.isInteger(policy.newAccountHoldDays)&&Number.isInteger(policy.newAccountAgeDays)&&Number.isSafeInteger(policy.largeDepositMinor)&&Number.isInteger(policy.largeDepositHoldDays),code,'Hold policy is incomplete');
 if(channel==='cash'||channel==='electronic')return Object.freeze({schedule:Object.freeze([Object.freeze({availableAt:depositedAt,amountMinor,reason:'IMMEDIATE_CHANNEL'})]),syntheticOnly:true});
 const isNew=accountAgeDays<policy.newAccountAgeDays,schedule=[];
 const firstMinor=Math.min(amountMinor,policy.nextDayMinor);schedule.push({availableAt:depositedAt+DAY,amountMinor:firstMinor,reason:'NEXT_DAY_PORTION'});
 let rest=amountMinor-firstMinor;
 if(rest>0){
  const largePortion=Math.max(0,Math.min(rest,amountMinor-policy.largeDepositMinor));
  const normal=rest-largePortion,holdDays=isNew?policy.newAccountHoldDays:policy.standardHoldDays;
  if(normal>0)schedule.push({availableAt:depositedAt+holdDays*DAY,amountMinor:normal,reason:isNew?'NEW_ACCOUNT_HOLD':'STANDARD_HOLD'});
  if(largePortion>0)schedule.push({availableAt:depositedAt+Math.max(holdDays,policy.largeDepositHoldDays)*DAY,amountMinor:largePortion,reason:'LARGE_DEPOSIT_HOLD'});
 }
 ensure(schedule.reduce((sum,item)=>sum+item.amountMinor,0)===amountMinor,code,'Schedule must cover the full deposit');
 return Object.freeze({schedule:Object.freeze(schedule.map(item=>Object.freeze(item))),noticeRequired:schedule.length>1,syntheticOnly:true});
}
