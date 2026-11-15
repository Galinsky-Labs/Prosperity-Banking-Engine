import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {EngineError} from '../index.mjs';
import {authorizeDataUse} from '../data-classification.mjs';
import {ConsentLedger} from '../consent-ledger.mjs';
import {PolicyGateway} from '../policy-gateway.mjs';
import {isNonHumanIdentity} from '../step-up.mjs';
import {bounded,ensure,requireDecision} from '../runtime/guards.mjs';

const code='INVALID_PARTNER_ADAPTER';
const SYNTHETIC_WATCHLIST=Object.freeze(['SYNTHETIC WATCHLIST PERSON','TEST SANCTIONED ENTITY']);
const normalizeName=name=>name.normalize('NFKD').replace(/[^A-Za-z ]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
const ref=(prefix,value)=>`${prefix}_${createHash('sha256').update(value).digest('hex').slice(0,24)}`;

/**
 * BNK-033 identity verification and sanctions/PEP screening adapter contract, sandbox mode only. Live mode is
 * refused in this build: live onboarding needs an approved regulated partner (an external prerequisite).
 * The mock is deterministic on synthetic applicants and never contacts a provider.
 */
export function createIdentityScreeningAdapter({mode='mock',partnerId='synthetic-kyc-sandbox'}={}){
 if(mode!=='mock')throw new EngineError('PARTNER_APPROVAL_REQUIRED','Live identity and screening partners are disabled until a regulated partner is approved');
 bounded(partnerId,'Partner ID',code);
 return Object.freeze({
  partnerId,mode,live:false,
  async verifyIdentity(applicant){
   const name=normalizeName(applicant.fullName),checks=[];
   checks.push({check:'document',result:applicant.documentNumber.startsWith('SYN-')?'pass':'fail'});
   checks.push({check:'date-of-birth',result:/^\d{4}-\d{2}-\d{2}$/.test(applicant.dateOfBirth)?'pass':'fail'});
   checks.push({check:'liveness',result:name.includes('REVIEW')?'inconclusive':'pass'});
   const status=checks.some(item=>item.result==='fail')?'failed':checks.some(item=>item.result==='inconclusive')?'review':'verified';
   return {status,checks,providerReference:ref('idv',`${partnerId}:${applicant.applicantId}`)};
  },
  async screen(applicant){
   const name=normalizeName(applicant.fullName);
   const hits=SYNTHETIC_WATCHLIST.filter(entry=>entry===name||entry.split(' ').filter(part=>name.includes(part)).length>=2).map(entry=>({list:'synthetic-sanctions',matchType:entry===name?'exact':'partial'}));
   return {status:hits.length?'potential-match':'clear',hits,providerReference:ref('scr',`${partnerId}:${applicant.applicantId}`)};
  }
 });
}

/** Verify a partner callback: HMAC-SHA256 over `timestamp.body`, freshness window and one-time event IDs. */
export function createCallbackVerifier({secret,toleranceMs=300_000}){
 ensure(typeof secret==='string'&&secret.length>=32,code,'Callback secret of at least 32 characters is required');
 const seen=new Map();
 return Object.freeze({verify({signature,timestamp,eventId,body,now}){
  ensure(typeof body==='string'&&body.length<=65_536&&typeof signature==='string'&&Number.isSafeInteger(timestamp)&&typeof eventId==='string',code,'Callback fields are required');
  ensure(Math.abs(now-timestamp)<=toleranceMs,'CALLBACK_STALE','Callback timestamp is outside the tolerance window');
  const expected=createHmac('sha256',secret).update(`${timestamp}.${body}`).digest(),provided=Buffer.from(signature,'hex');
  ensure(provided.length===expected.length&&timingSafeEqual(provided,expected),'CALLBACK_FORGED','Callback signature is invalid');
  for(const [id,at] of seen)if(now-at>toleranceMs*2)seen.delete(id);
  ensure(!seen.has(eventId),'CALLBACK_REPLAY','Callback event was already processed');seen.set(eventId,now);
  return JSON.parse(body);
 }});
}

/**
 * Onboarding orchestration over the adapter. Requires the applicant's consent for identity processing,
 * keeps raw identity data out of results, routes any potential sanctions match or inconclusive check to human
 * review (never auto-declines on a fuzzy match), and gives declines adverse-action reason codes.
 */
export class SyntheticOnboarding {
 #adapter;#gateway;#action;#cases=new Map();
 constructor({adapter,gateway,action}){
  ensure(adapter&&adapter.live===false&&typeof adapter.verifyIdentity==='function'&&typeof adapter.screen==='function',code,'A sandbox adapter is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#adapter=adapter;this.#gateway=gateway;this.#action=bounded(action,'Review action',code);
 }

 /** Calls the sandbox adapter, then records the outcome. Exposed separately so the API can journal outcomes without PII. */
 async screenApplicant(applicant){
  bounded(applicant?.applicantId,'Applicant ID',code);
  for(const field of ['fullName','dateOfBirth','documentNumber'])ensure(typeof applicant[field]==='string'&&applicant[field].length>=1&&applicant[field].length<=128,code,`${field} is required`);
  const [idv,screening]=await Promise.all([this.#adapter.verifyIdentity(applicant),this.#adapter.screen(applicant)]);return {applicantId:applicant.applicantId,idv,screening};
 }

 async start({identity,applicant,consentLedger,consentId,now}){
  ensure(consentLedger instanceof ConsentLedger&&ConsentLedger.prototype.permits.call(consentLedger,identity,{consentId,scope:'identity:verify',now}),'CONSENT_REQUIRED','Applicant consent for identity verification is required');
  authorizeDataUse({category:'customer_identity',tenantId:identity.tenantId,operation:'write'});
  bounded(applicant?.applicantId,'Applicant ID',code);
  for(const field of ['fullName','dateOfBirth','documentNumber'])ensure(typeof applicant[field]==='string'&&applicant[field].length>=1&&applicant[field].length<=128,code,`${field} is required`);
  ensure(!this.#cases.has(`${identity.tenantId}:${applicant.applicantId}`),'ONBOARDING_CONFLICT','Onboarding already started');
  const [idv,screening]=await Promise.all([this.#adapter.verifyIdentity(applicant),this.#adapter.screen(applicant)]);
  return this.recordOutcome({identity,applicantId:applicant.applicantId,idv,screening,consentLedger,consentId,now});
 }

 /** Synchronous, PII-free decision step; journaled with adapter outcomes (statuses, check names, references) only. */
 recordOutcome({identity,applicantId,idv,screening,consentLedger,consentId,now}){
  ensure(consentLedger instanceof ConsentLedger&&ConsentLedger.prototype.permits.call(consentLedger,identity,{consentId,scope:'identity:verify',now}),'CONSENT_REQUIRED','Applicant consent for identity verification is required');
  bounded(applicantId,'Applicant ID',code);
  ensure(['verified','review','failed'].includes(idv?.status)&&Array.isArray(idv.checks)&&['clear','potential-match'].includes(screening?.status)&&Array.isArray(screening.hits),code,'Adapter outcomes are malformed');
  ensure(!this.#cases.has(`${identity.tenantId}:${applicantId}`),'ONBOARDING_CONFLICT','Onboarding already started');
  const applicant={applicantId};
  let decision,reasons=[];
  if(screening.status==='potential-match'){decision='manual-review';reasons.push('SCREENING_POTENTIAL_MATCH');}
  else if(idv.status==='review'){decision='manual-review';reasons.push('IDENTITY_INCONCLUSIVE');}
  else if(idv.status==='failed'){decision='declined';reasons.push(...idv.checks.filter(check=>check.result==='fail').map(check=>`IDV_${check.check.toUpperCase().replace(/-/g,'_')}_FAILED`));}
  else decision='approved-synthetic';
  const record=Object.freeze({tenantId:identity.tenantId,applicantId:applicant.applicantId,decision,reasons:Object.freeze(reasons),identityReference:idv.providerReference,screeningReference:screening.providerReference,screeningHits:screening.hits.length,partner:Object.freeze({id:this.#adapter.partnerId,mode:this.#adapter.mode}),startedAt:now,reviewedBy:null,liveAccountOpened:false,syntheticOnly:true});
  this.#cases.set(`${identity.tenantId}:${applicant.applicantId}`,record);return record;
 }

 review({identity,applicantId,outcome,reasonCode,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#action,assignments,now},'ONBOARDING_DENIED');
  ensure(!isNonHumanIdentity(identity),'HUMAN_REQUIRED','Manual onboarding review requires a human analyst');
  bounded(reasonCode,'Reason code',code);ensure(outcome==='approved-synthetic'||outcome==='declined',code,'Outcome is invalid');
  const key=`${identity.tenantId}:${bounded(applicantId,'Applicant ID',code)}`,record=this.#cases.get(key);
  ensure(record,'ONBOARDING_NOT_FOUND','Onboarding case does not exist');ensure(record.decision==='manual-review','ONBOARDING_STATE','Case is not awaiting review');
  const reviewed=Object.freeze({...record,decision:outcome,reasons:Object.freeze([...record.reasons,reasonCode]),reviewedBy:identity.subject,reviewedAt:now});
  this.#cases.set(key,reviewed);return reviewed;
 }
}
