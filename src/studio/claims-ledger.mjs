import {createHash} from 'node:crypto';
import {PolicyGateway} from '../policy-gateway.mjs';
import {bounded,ensure,requireDecision} from '../runtime/guards.mjs';
import {isMintedAttestation} from './attestations.mjs';

const code='INVALID_CLAIM';
const DIGEST=/^[a-f0-9]{64}$/;
const compiledContracts=new WeakSet();
export const CLAIM_TYPES=Object.freeze(['traction','revenue','customer-interviews','technical','team','market-size','regulatory']);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createClaimsContract({version,actions,maxEvidencePerClaim=10}){
 bounded(version,'Claims version',code);
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,code,'Claims actions are required');
 const normalized=Object.freeze({write:bounded(actions.write,'Write action',code),read:bounded(actions.read,'Read action',code)});
 ensure(Number.isInteger(maxEvidencePerClaim)&&maxEvidencePerClaim>=1&&maxEvidencePerClaim<=50,code,'Evidence bound is invalid');
 const contract=Object.freeze({version,actions:normalized,maxEvidencePerClaim,syntheticOnly:true});compiledContracts.add(contract);return contract;
}

/**
 * BNK-023 claims and evidence ledger. Each project has an append-only, hash-chained sequence of claims,
 * retractions and attestations. Claims reference evidence by vault ID and content digest only. A claim starts
 * UNVERIFIED; only attestations minted by independent verification (BNK-030) can change that, and authors
 * cannot attest. AI-drafted claims must be adopted by a human author before they enter the ledger.
 */
export class ClaimsLedger {
 #contract;#gateway;#entries=new Map();#requests=new Map();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),code,'Compiled claims contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }
 #chain(tenantId,projectId){const key=`${tenantId}:${projectId}`;if(!this.#entries.has(key))this.#entries.set(key,[]);return this.#entries.get(key);}
 #append(tenantId,projectId,body){
  const chain=this.#chain(tenantId,projectId),previousHash=chain.at(-1)?.entryHash??null,sequence=chain.length+1;
  const entry=Object.freeze({...body,tenantId,projectId,sequence,previousHash,entryHash:sha([tenantId,projectId,sequence,previousHash,body]),syntheticOnly:true});
  chain.push(entry);return entry;
 }

 submit({identity,requestId,projectId,claimId,claimType,metric,evidence,aiDrafted=false,humanAdopted=false,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.write,assignments,now},'CLAIM_DENIED');
  bounded(requestId,'Request ID',code);bounded(projectId,'Project ID',code);bounded(claimId,'Claim ID',code);
  ensure(CLAIM_TYPES.includes(claimType),code,'Claim type is unsupported');
  ensure(metric&&Object.getPrototypeOf(metric)===Object.prototype,code,'A structured metric is required');
  bounded(metric.name,'Metric name',code);bounded(metric.unit,'Metric unit',code);ensure(Number.isSafeInteger(metric.value)&&metric.value>=0,code,'Metric values must be nonnegative safe integers');
  ensure(Array.isArray(evidence)&&evidence.length>=1&&evidence.length<=this.#contract.maxEvidencePerClaim,'EVIDENCE_REQUIRED','Claims need bounded evidence references');
  const refs=evidence.map(item=>{bounded(item?.evidenceId,'Evidence ID',code);ensure(typeof item.contentDigest==='string'&&DIGEST.test(item.contentDigest),code,'Evidence digest is required');return Object.freeze({evidenceId:item.evidenceId,contentDigest:item.contentDigest});});
  ensure(new Set(refs.map(ref=>ref.evidenceId)).size===refs.length,code,'Evidence references must be unique');
  ensure(!aiDrafted||humanAdopted===true,'HUMAN_ADOPTION_REQUIRED','AI-drafted claims must be adopted by a human author');
  const requestKey=`${identity.tenantId}:${requestId}`,digest=sha([identity.issuer,identity.subject,projectId,claimId,claimType,metric,refs,aiDrafted]);
  const replay=this.#requests.get(requestKey);if(replay){ensure(replay.digest===digest,'REPLAY_MISMATCH','Claim request replay has different terms');return replay.entry;}
  ensure(!this.#chain(identity.tenantId,projectId).some(entry=>entry.kind==='CLAIM'&&entry.claimId===claimId),'CLAIM_CONFLICT','Claim ID already exists');
  const entry=this.#append(identity.tenantId,projectId,{kind:'CLAIM',claimId,claimType,metric:Object.freeze({name:metric.name,value:metric.value,unit:metric.unit}),evidence:Object.freeze(refs),author:Object.freeze({issuer:identity.issuer,subject:identity.subject}),aiDrafted,recordedAt:now});
  this.#requests.set(requestKey,{digest,entry});return entry;
 }

 retract({identity,projectId,claimId,reasonCode,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.write,assignments,now},'CLAIM_DENIED');bounded(reasonCode,'Reason code',code);
  const claim=this.#claim(identity.tenantId,projectId,claimId);
  ensure(claim.author.issuer===identity.issuer&&claim.author.subject===identity.subject,'CLAIM_DENIED','Only the author can retract a claim');
  ensure(this.status({identity,projectId,claimId,assignments,now}).state!=='RETRACTED','CLAIM_STATE','Claim is already retracted');
  return this.#append(identity.tenantId,projectId,{kind:'RETRACTION',claimId,reasonCode,by:identity.subject,recordedAt:now});
 }

 recordAttestation(attestation){
  ensure(isMintedAttestation(attestation),'ATTESTATION_FORGED','Only independent verification can attest claims');
  const claim=this.#claim(attestation.tenantId,attestation.projectId,attestation.claimId);
  ensure(attestation.claimHash===claim.entryHash,'ATTESTATION_STALE','Attestation does not match the claim entry');
  ensure(!(claim.author.issuer===attestation.verifier.issuer&&claim.author.subject===attestation.verifier.subject),'SEPARATION_OF_DUTIES','Authors cannot attest their own claims');
  return this.#append(attestation.tenantId,attestation.projectId,{kind:'ATTESTATION',claimId:attestation.claimId,verdict:attestation.verdict,verificationId:attestation.verificationId,verifier:attestation.verifier,recordedAt:attestation.decidedAt});
 }

 #claim(tenantId,projectId,claimId){bounded(projectId,'Project ID',code);bounded(claimId,'Claim ID',code);const claim=this.#chain(tenantId,projectId).find(entry=>entry.kind==='CLAIM'&&entry.claimId===claimId);ensure(claim,'CLAIM_NOT_FOUND','Claim does not exist');return claim;}

 claimEntry({identity,projectId,claimId,assignments,now}){requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'CLAIM_DENIED');return this.#claim(identity.tenantId,projectId,claimId);}

 status({identity,projectId,claimId,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'CLAIM_DENIED');
  const claim=this.#claim(identity.tenantId,projectId,claimId),related=this.#chain(identity.tenantId,projectId).filter(entry=>entry.claimId===claimId&&entry.kind!=='CLAIM');
  let state='UNVERIFIED';
  for(const entry of related){if(entry.kind==='RETRACTION')state='RETRACTED';else if(state!=='RETRACTED')state=entry.verdict==='verified'?'VERIFIED':entry.verdict==='rejected'?'REJECTED':'INCONCLUSIVE';}
  return Object.freeze({claimId,state,claim,attestations:Object.freeze(related.filter(entry=>entry.kind==='ATTESTATION')),syntheticOnly:true});
 }

 /** Recompute the hash chain; any in-memory tampering is detected. */
 verifyChain({identity,projectId,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'CLAIM_DENIED');
  let previousHash=null;
  for(const entry of this.#chain(identity.tenantId,projectId)){
   const {tenantId,projectId:project,sequence,previousHash:prior,entryHash,syntheticOnly,...body}=entry;
   if(prior!==previousHash||sha([tenantId,project,sequence,prior,body])!==entryHash)return false;previousHash=entryHash;
  }
  return true;
 }

 entries({identity,projectId,assignments,now}){requireDecision(this.#gateway,{identity,action:this.#contract.actions.read,assignments,now},'CLAIM_DENIED');bounded(projectId,'Project ID',code);return Object.freeze([...this.#chain(identity.tenantId,projectId)]);}
}
