import {authorizeDataUse,classifyData,DATA_CLASSES} from './data-classification.mjs';
import {isNonHumanIdentity} from './step-up.mjs';
import {bounded,ensure} from './runtime/guards.mjs';

const code='INVALID_VENDOR';
const DIGEST=/^[a-f0-9]{64}$/;
const DAY=86_400_000;
const REQUIRED={low:['contract-signed','security-review'],medium:['contract-signed','security-review','privacy-review','business-continuity'],high:['contract-signed','security-review','privacy-review','business-continuity','financial-condition','subcontractor-list','independent-audit-report']};

/**
 * BNK-039 affiliate and vendor controls. Vendors get a risk tier, data scopes and due-diligence evidence
 * (digests only). Approval needs every required item for the tier, a human approver other than the submitter,
 * and a current contract. Access to restricted data requires the high tier. Affiliates need a disclosure.
 */
export class VendorRegistry {
 #vendors=new Map();
 register({identity,vendorId,services,dataScopes,riskTier,affiliated,contractEndsAt,now}){
  bounded(vendorId,'Vendor ID',code);ensure(Object.hasOwn(REQUIRED,riskTier),code,'Risk tier is invalid');ensure(typeof affiliated==='boolean',code,'Affiliation must be declared');
  ensure(Array.isArray(services)&&services.length>=1&&services.every(item=>typeof item==='string'&&item.length<=64),code,'Services are required');
  ensure(Array.isArray(dataScopes)&&dataScopes.length<=12,code,'Data scopes are bounded');
  for(const scope of dataScopes){const definition=classifyData(scope);ensure(definition.classification!==DATA_CLASSES.RESTRICTED||riskTier==='high','TIER_TOO_LOW','Restricted data scopes require the high risk tier');}
  ensure(Number.isSafeInteger(contractEndsAt)&&contractEndsAt>now,code,'Contract end must be in the future');
  const key=`${identity.tenantId}:${vendorId}`;ensure(!this.#vendors.has(key),'VENDOR_CONFLICT','Vendor already exists');
  const vendor=Object.freeze({tenantId:identity.tenantId,vendorId,services:Object.freeze([...services]),dataScopes:Object.freeze([...new Set(dataScopes)]),riskTier,affiliated,contractEndsAt,evidence:Object.freeze({}),state:'PENDING',submittedBy:identity.subject,approvedBy:null,approvedAt:null,nextReviewAt:null,syntheticOnly:true});
  this.#vendors.set(key,vendor);return vendor;
 }
 #vendor(identity,vendorId){const vendor=this.#vendors.get(`${identity.tenantId}:${vendorId}`);ensure(vendor,'VENDOR_NOT_FOUND','Vendor does not exist');return vendor;}
 addEvidence({identity,vendorId,item,contentDigest,now}){
  const vendor=this.#vendor(identity,vendorId);ensure(REQUIRED.high.includes(item),code,'Evidence item is unknown');ensure(typeof contentDigest==='string'&&DIGEST.test(contentDigest),code,'Evidence digest is required');
  const next=Object.freeze({...vendor,evidence:Object.freeze({...vendor.evidence,[item]:Object.freeze({contentDigest,reviewedBy:identity.subject,at:now})})});
  this.#vendors.set(`${identity.tenantId}:${vendorId}`,next);return next;
 }
 approve({identity,vendorId,affiliateDisclosure=null,now}){
  ensure(!isNonHumanIdentity(identity),'HUMAN_REQUIRED','Vendor approval requires a human');
  const vendor=this.#vendor(identity,vendorId);
  ensure(vendor.submittedBy!==identity.subject,'SEPARATION_OF_DUTIES','The submitter cannot approve the vendor');
  const missing=REQUIRED[vendor.riskTier].filter(item=>!vendor.evidence[item]);ensure(missing.length===0,'DUE_DILIGENCE_INCOMPLETE',`Missing due diligence: ${missing.join(', ')}`);
  if(vendor.affiliated)ensure(typeof affiliateDisclosure==='string'&&affiliateDisclosure.length>=20,'AFFILIATE_DISCLOSURE_REQUIRED','Affiliated vendors need a customer-facing disclosure');
  ensure(vendor.contractEndsAt>now,'CONTRACT_EXPIRED','Contract has expired');
  const next=Object.freeze({...vendor,state:'APPROVED',approvedBy:identity.subject,approvedAt:now,nextReviewAt:now+(vendor.riskTier==='high'?365:730)*DAY,affiliateDisclosure});
  this.#vendors.set(`${identity.tenantId}:${vendorId}`,next);return next;
 }
 /** Fail-closed access decision for a vendor touching a data category. */
 authorizeAccess({identity,vendorId,dataCategory,now}){
  const vendor=this.#vendor(identity,vendorId),reasons=[];
  if(vendor.state!=='APPROVED')reasons.push('NOT_APPROVED');
  if(vendor.contractEndsAt<=now)reasons.push('CONTRACT_EXPIRED');
  if(vendor.nextReviewAt!==null&&vendor.nextReviewAt<=now)reasons.push('REVIEW_OVERDUE');
  if(!vendor.dataScopes.includes(dataCategory))reasons.push('OUT_OF_SCOPE');
  if(reasons.length===0)authorizeDataUse({category:dataCategory,tenantId:identity.tenantId,operation:'read'});
  return Object.freeze({vendorId,dataCategory,allow:reasons.length===0,reasons:Object.freeze(reasons),syntheticOnly:true});
 }
}
