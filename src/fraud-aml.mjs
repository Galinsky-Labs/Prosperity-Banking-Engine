import {isNonHumanIdentity} from './step-up.mjs';
import {bounded,ensure} from './runtime/guards.mjs';

const code='INVALID_MONITORING';
const DAY=86_400_000;

/**
 * BNK-038 fraud and AML handoff interfaces (mock). Deterministic monitoring rules raise alerts over normalized
 * transactions; alerts become cases for human analysts. Report drafting is a mock that can never be filed by
 * the engine, and customer-facing status never reveals monitoring (no tipping off).
 */
export function monitorTransactions({accountId,transactions,rules}){
 bounded(accountId,'Account ID',code);ensure(Array.isArray(transactions)&&transactions.length<=5_000,code,'Transactions are bounded');
 ensure(rules&&Number.isSafeInteger(rules.reportingThresholdMinor)&&Number.isSafeInteger(rules.structuringBandMinor)&&Number.isInteger(rules.structuringCount)&&Number.isInteger(rules.velocityCount)&&Number.isSafeInteger(rules.velocityWindowMs)&&Number.isSafeInteger(rules.largeDebitMinor),code,'Monitoring rules are incomplete');
 const sorted=[...transactions].sort((left,right)=>left.bookedAt-right.bookedAt),alerts=[];
 const near=sorted.filter(item=>item.signedAmountMinor>0&&item.signedAmountMinor<rules.reportingThresholdMinor&&item.signedAmountMinor>=rules.reportingThresholdMinor-rules.structuringBandMinor);
 for(let index=0;index+rules.structuringCount-1<near.length;index+=1){const window=near.slice(index,index+rules.structuringCount);if(window.at(-1).bookedAt-window[0].bookedAt<=7*DAY){alerts.push({ruleId:'possible-structuring',evidence:window.map(item=>item.transactionId)});break;}}
 for(const item of sorted)if(item.signedAmountMinor>=rules.reportingThresholdMinor)alerts.push({ruleId:'threshold-credit',evidence:[item.transactionId]});
 const debits=sorted.filter(item=>item.signedAmountMinor<0);
 for(let index=0;index+rules.velocityCount-1<debits.length;index+=1){const window=debits.slice(index,index+rules.velocityCount);if(window.at(-1).bookedAt-window[0].bookedAt<=rules.velocityWindowMs){alerts.push({ruleId:'debit-velocity',evidence:window.map(item=>item.transactionId)});break;}}
 for(const item of debits)if(-item.signedAmountMinor>=rules.largeDebitMinor)alerts.push({ruleId:'large-debit',evidence:[item.transactionId]});
 return Object.freeze(alerts.map(alert=>Object.freeze({accountId,...alert,evidence:Object.freeze(alert.evidence)})));
}

export class FinancialCrimeCaseQueue {
 #cases=new Map();
 open({tenantId,caseId,alerts,now}){
  ensure(/^tenant_[a-z0-9_-]+$/.test(tenantId??''),code,'Tenant is required');bounded(caseId,'Case ID',code);
  ensure(Array.isArray(alerts)&&alerts.length>=1,code,'Alerts are required');ensure(!this.#cases.has(`${tenantId}:${caseId}`),'CASE_CONFLICT','Case already exists');
  const record=Object.freeze({tenantId,caseId,alerts:Object.freeze([...alerts]),state:'OPEN',disposition:null,analyst:null,sarDraft:null,openedAt:now,syntheticOnly:true});
  this.#cases.set(`${tenantId}:${caseId}`,record);return record;
 }
 #case(tenantId,caseId){const record=this.#cases.get(`${tenantId}:${caseId}`);ensure(record,'CASE_NOT_FOUND','Case does not exist');return record;}
 dispose({identity,caseId,disposition,rationaleCode,now}){
  ensure(!isNonHumanIdentity(identity),'HUMAN_REQUIRED','Financial-crime dispositions require a human analyst');bounded(rationaleCode,'Rationale code',code);
  ensure(['cleared','escalated'].includes(disposition),code,'Disposition is invalid');
  const record=this.#case(identity.tenantId,caseId);ensure(record.state==='OPEN','CASE_STATE','Case is already disposed');
  const next=Object.freeze({...record,state:disposition==='cleared'?'CLEARED':'ESCALATED',disposition:Object.freeze({disposition,rationaleCode,at:now}),analyst:identity.subject});
  this.#cases.set(`${identity.tenantId}:${caseId}`,next);return next;
 }
 /** Mock report draft for an escalated case. It can never be filed from the engine. */
 draftReport({identity,caseId,now}){
  ensure(!isNonHumanIdentity(identity),'HUMAN_REQUIRED','Report drafting requires a human analyst');
  const record=this.#case(identity.tenantId,caseId);ensure(record.state==='ESCALATED','CASE_STATE','Only escalated cases can have a report draft');
  const sarDraft=Object.freeze({format:'mock-sar-draft-v1',alertRules:Object.freeze(record.alerts.map(alert=>alert.ruleId)),preparedBy:identity.subject,preparedAt:now,filed:false,filingChannel:'none-sandbox',watermark:'SYNTHETIC MOCK - NOT A REGULATORY FILING'});
  const next=Object.freeze({...record,sarDraft});this.#cases.set(`${identity.tenantId}:${caseId}`,next);return next;
 }
 /** Customer-facing status: generic and identical for every case state, so monitoring is never disclosed. */
 customerStatus(){return Object.freeze({status:'under-review',message:'Some account activity is being reviewed. A banker will contact you if anything is needed.',syntheticOnly:true});}
 list({tenantId}){return Object.freeze([...this.#cases.values()].filter(record=>record.tenantId===tenantId));}
}
