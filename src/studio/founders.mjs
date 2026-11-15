import {createHash} from 'node:crypto';
import {PolicyGateway} from '../policy-gateway.mjs';
import {bounded,ensure,requireDecision} from '../runtime/guards.mjs';

const code='INVALID_FOUNDER';
const DIGEST=/^[a-f0-9]{64}$/;
const compiledContracts=new WeakSet();
/** Studio IP postures. The founder keeps ownership in every posture; none transfers IP to the studio or institution. */
export const IP_POSTURES=Object.freeze(['founder-owned-no-license','founder-owned-evaluation-license','founder-owned-collaboration-license']);

export function createFounderContract({version,actions,termsVersion,termsDigest,defaultPosture='founder-owned-no-license'}){
 bounded(version,'Founder version',code);bounded(termsVersion,'Terms version',code);
 ensure(typeof termsDigest==='string'&&DIGEST.test(termsDigest),code,'Studio terms SHA-256 digest is required');
 ensure(IP_POSTURES.includes(defaultPosture),code,'Default IP posture is invalid');
 ensure(actions&&Object.getPrototypeOf(actions)===Object.prototype,code,'Founder actions are required');
 const normalized=Object.freeze({onboard:bounded(actions.onboard,'Onboard action',code),review:bounded(actions.review,'Review action',code)});
 const contract=Object.freeze({version,actions:normalized,termsVersion,termsDigest,defaultPosture,syntheticOnly:true});
 compiledContracts.add(contract);return contract;
}
export const termsDigestOf=text=>createHash('sha256').update(text,'utf8').digest('hex');

/**
 * BNK-021 founder onboarding and IP rights. A founder joins with an affirmative acceptance of the exact studio
 * terms. Ownership of pre-existing and new IP stays with the founder; any studio licence is explicit, scoped and
 * revocable. Pre-existing IP is declared by content digest only, never by uploading the work itself.
 */
export class FounderRegistry {
 #contract;#gateway;#founders=new Map();
 constructor({contract,gateway}){
  ensure(compiledContracts.has(contract),code,'Compiled founder contract is required');
  ensure(gateway instanceof PolicyGateway,code,'Policy gateway is required');
  this.#contract=contract;this.#gateway=gateway;
 }
 #key(identity){return `${identity.tenantId}:${identity.issuer}:${identity.subject}`;}
 #self(identity,assignments,now){requireDecision(this.#gateway,{identity,action:this.#contract.actions.onboard,assignments,now},'FOUNDER_DENIED');}
 #save(identity,record){this.#founders.set(this.#key(identity),record);return record;}

 onboard({identity,founderId,affirmative,termsVersion,termsDigest,ipPosture=this.#contract.defaultPosture,assignments,now}){
  this.#self(identity,assignments,now);bounded(founderId,'Founder ID',code);
  ensure(affirmative===true,'AFFIRMATIVE_CONSENT_REQUIRED','Studio terms require an affirmative acceptance');
  ensure(termsVersion===this.#contract.termsVersion&&termsDigest===this.#contract.termsDigest,'TERMS_MISMATCH','The exact current studio terms must be accepted');
  ensure(IP_POSTURES.includes(ipPosture),code,'IP posture is invalid');
  ensure(!this.#founders.has(this.#key(identity)),'FOUNDER_CONFLICT','Founder is already onboarded');
  ensure(![...this.#founders.values()].some(founder=>founder.tenantId===identity.tenantId&&founder.founderId===founderId),'FOUNDER_CONFLICT','Founder ID is already used');
  return this.#save(identity,Object.freeze({tenantId:identity.tenantId,founderId,subject:Object.freeze({issuer:identity.issuer,subject:identity.subject}),termsVersion,ipOwner:'founder',ipPosture,priorIp:Object.freeze([]),version:1,onboardedAt:now,history:Object.freeze([Object.freeze({event:'ONBOARDED',ipPosture,at:now})]),syntheticOnly:true}));
 }

 declarePriorIp({identity,assetId,assetKind,contentDigest,expectedVersion,assignments,now}){
  this.#self(identity,assignments,now);bounded(assetId,'Asset ID',code);
  ensure(['code','design','document','dataset','trademark','patent-application','other'].includes(assetKind),code,'Asset kind is unsupported');
  ensure(typeof contentDigest==='string'&&DIGEST.test(contentDigest),code,'Asset SHA-256 digest is required; raw works are not accepted');
  const founder=this.profile({identity,assignments,now});ensure(expectedVersion===founder.version,'STALE_FOUNDER','Founder record changed');
  ensure(founder.priorIp.length<200&&!founder.priorIp.some(asset=>asset.assetId===assetId),code,'Asset IDs must be unique and bounded');
  const asset=Object.freeze({assetId,assetKind,contentDigest,declaredAt:now,owner:'founder'});
  return this.#save(identity,Object.freeze({...founder,priorIp:Object.freeze([...founder.priorIp,asset]),version:founder.version+1,history:Object.freeze([...founder.history,Object.freeze({event:'PRIOR_IP_DECLARED',assetId,at:now})])}));
 }

 changeLicense({identity,ipPosture,expectedVersion,assignments,now}){
  this.#self(identity,assignments,now);ensure(IP_POSTURES.includes(ipPosture),code,'IP posture is invalid');
  const founder=this.profile({identity,assignments,now});ensure(expectedVersion===founder.version,'STALE_FOUNDER','Founder record changed');
  return this.#save(identity,Object.freeze({...founder,ipPosture,version:founder.version+1,history:Object.freeze([...founder.history,Object.freeze({event:'LICENSE_CHANGED',ipPosture,at:now})])}));
 }

 profile({identity,assignments,now}){
  this.#self(identity,assignments,now);const founder=this.#founders.get(this.#key(identity));ensure(founder,'FOUNDER_NOT_FOUND','Founder is not onboarded');return founder;
 }

 /** Staff view used by other studio units: confirms a founder exists and the current licence posture. */
 /** Internal lookup for system components: current licence posture of a founder, or null. */
 postureOf({tenantId,founderId}){return [...this.#founders.values()].find(record=>record.tenantId===tenantId&&record.founderId===founderId)?.ipPosture??null;}
 lookup({identity,founderId,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.actions.review,assignments,now},'FOUNDER_DENIED');bounded(founderId,'Founder ID',code);
  const founder=[...this.#founders.values()].find(record=>record.tenantId===identity.tenantId&&record.founderId===founderId);ensure(founder,'FOUNDER_NOT_FOUND','Founder does not exist');
  return Object.freeze({founderId,ipOwner:founder.ipOwner,ipPosture:founder.ipPosture,priorIpCount:founder.priorIp.length,syntheticOnly:true});
 }
}

/** Whether a studio party may use a founder's work for a purpose under the current posture. */
export function studioUsePermitted(posture,purpose){
 ensure(IP_POSTURES.includes(posture),code,'IP posture is invalid');
 ensure(['evaluate','collaborate','commercialize','train-models','publish'].includes(purpose),code,'Purpose is unsupported');
 if(purpose==='commercialize'||purpose==='train-models'||purpose==='publish')return false;
 if(purpose==='evaluate')return posture!=='founder-owned-no-license';
 return posture==='founder-owned-collaboration-license';
}
