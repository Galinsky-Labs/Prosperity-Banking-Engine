import {PolicyGateway} from '../policy-gateway.mjs';
import {isNonHumanIdentity} from '../step-up.mjs';
import {bounded,ensure,requireDecision} from '../runtime/guards.mjs';
import {mintAttestation} from './attestations.mjs';
import {ClaimsLedger} from './claims-ledger.mjs';

const code='INVALID_VERIFICATION';
const DIGEST=/^[a-f0-9]{64}$/;

/**
 * BNK-030 independent evidence verification. Verifiers declare conflicts. A claim is assigned to the
 * least-loaded eligible human verifier who is not its author, not a project member and not conflicted.
 * The verifier must observe every evidence digest; any mismatch forces rejection. Only this service mints
 * attestations, which the BNK-023 ledger binds to the exact claim entry.
 */
export class IndependentVerification {
 #gateway;#ledger;#action;#verifiers=new Map();#assignments=new Map();
 constructor({gateway,ledger,action}){
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');ensure(ledger instanceof ClaimsLedger,code,'Claims ledger is required');
  this.#gateway=gateway;this.#ledger=ledger;this.#action=bounded(action,'Verification action',code);
 }
 #auth(identity,assignments,now){requireDecision(this.#gateway,{identity,action:this.#action,assignments,now},'VERIFICATION_DENIED');ensure(!isNonHumanIdentity(identity),'HUMAN_REQUIRED','Verification requires a human verifier');}
 #vkey(tenantId,issuer,subject){return `${tenantId}:${issuer}:${subject}`;}

 enroll({identity,conflicts,assignments,now}){
  this.#auth(identity,assignments,now);
  ensure(conflicts&&Array.isArray(conflicts.projectIds)&&Array.isArray(conflicts.founderIds)&&conflicts.projectIds.length+conflicts.founderIds.length<=200,code,'Conflict declarations are required');
  const record=Object.freeze({tenantId:identity.tenantId,issuer:identity.issuer,subject:identity.subject,conflicts:Object.freeze({projectIds:Object.freeze(conflicts.projectIds.map(id=>bounded(id,'Project ID',code))),founderIds:Object.freeze(conflicts.founderIds.map(id=>bounded(id,'Founder ID',code)))}),declaredAt:now});
  this.#verifiers.set(this.#vkey(identity.tenantId,identity.issuer,identity.subject),record);return record;
 }

 /** Assign by system policy; requester supplies project context but never chooses the verifier. */
 assign({identity,verificationId,projectId,founderId,claimId,projectMembers,readerAssignments,now}){
  bounded(verificationId,'Verification ID',code);bounded(founderId,'Founder ID',code);
  ensure(!this.#assignments.has(`${identity.tenantId}:${verificationId}`),'VERIFICATION_CONFLICT','Verification already exists');
  ensure(Array.isArray(projectMembers),code,'Project members are required');
  const claim=this.#ledger.claimEntry({identity,projectId,claimId,assignments:readerAssignments,now});
  const excluded=new Set([...projectMembers.map(member=>`${member.issuer}:${member.subject}`),`${claim.author.issuer}:${claim.author.subject}`]);
  const load=verifier=>[...this.#assignments.values()].filter(item=>item.verifierKey===this.#vkey(verifier.tenantId,verifier.issuer,verifier.subject)&&item.state==='ASSIGNED').length;
  const eligible=[...this.#verifiers.values()].filter(verifier=>verifier.tenantId===identity.tenantId&&!excluded.has(`${verifier.issuer}:${verifier.subject}`)&&!verifier.conflicts.projectIds.includes(projectId)&&!verifier.conflicts.founderIds.includes(founderId))
   .sort((left,right)=>load(left)-load(right)||(left.subject<right.subject?-1:1));
  ensure(eligible.length>0,'NO_INDEPENDENT_VERIFIER','No independent verifier is available');
  const chosen=eligible[0];
  const record=Object.freeze({tenantId:identity.tenantId,verificationId,projectId,claimId,claimHash:claim.entryHash,evidence:claim.evidence,verifierKey:this.#vkey(chosen.tenantId,chosen.issuer,chosen.subject),verifier:Object.freeze({issuer:chosen.issuer,subject:chosen.subject}),state:'ASSIGNED',assignedAt:now,syntheticOnly:true});
  this.#assignments.set(`${identity.tenantId}:${verificationId}`,record);return record;
 }

 decide({identity,verificationId,observedDigests,verdict,reasonCode,assignments,now}){
  this.#auth(identity,assignments,now);bounded(reasonCode,'Reason code',code);
  const key=`${identity.tenantId}:${bounded(verificationId,'Verification ID',code)}`,record=this.#assignments.get(key);
  ensure(record,'VERIFICATION_NOT_FOUND','Verification does not exist');
  ensure(record.verifierKey===this.#vkey(identity.tenantId,identity.issuer,identity.subject),'VERIFICATION_DENIED','Only the assigned verifier can decide');
  ensure(record.state==='ASSIGNED','VERIFICATION_STATE','Verification is already decided');
  ensure(['verified','rejected','inconclusive'].includes(verdict),code,'Verdict is invalid');
  ensure(observedDigests&&typeof observedDigests==='object',code,'Observed evidence digests are required');
  const checks=record.evidence.map(item=>{const observed=observedDigests[item.evidenceId];ensure(observed===undefined||(typeof observed==='string'&&DIGEST.test(observed)),code,'Observed digests must be SHA-256');return Object.freeze({evidenceId:item.evidenceId,observed:observed!==undefined,matches:observed===item.contentDigest});});
  let finalVerdict=verdict,finalReason=reasonCode;
  if(checks.some(check=>check.observed&&!check.matches)){finalVerdict='rejected';finalReason='EVIDENCE_DIGEST_MISMATCH';}
  else if(verdict==='verified'&&checks.some(check=>!check.observed)){finalVerdict='inconclusive';finalReason='EVIDENCE_NOT_REVIEWED';}
  const attestation=mintAttestation({tenantId:record.tenantId,projectId:record.projectId,claimId:record.claimId,claimHash:record.claimHash,verdict:finalVerdict,reasonCode:finalReason,verificationId,verifier:record.verifier,decidedAt:now});
  const entry=this.#ledger.recordAttestation(attestation);
  this.#assignments.set(key,Object.freeze({...record,state:'DECIDED',verdict:finalVerdict,reasonCode:finalReason,checks:Object.freeze(checks),decidedAt:now}));
  return Object.freeze({verificationId,verdict:finalVerdict,reasonCode:finalReason,checks:Object.freeze(checks),ledgerEntry:entry,syntheticOnly:true});
 }
}
