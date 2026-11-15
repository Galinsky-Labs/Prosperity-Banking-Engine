import {bounded,ensure} from '../runtime/guards.mjs';

const code='INVALID_ISSUE_PROFILE';
const FLAGS=['handlesPersonalData','handlesFundsOrPayments','offersCreditOrLending','offersSecuritiesOrInvestments','handlesHealthData','targetsChildren','operatesCrossBorder','automatedDecisionsAboutPeople','collectsBiometrics','usesThirdPartyBrandNames','sendsMarketingMessages'];
const COPYLEFT=new Set(['GPL-2.0','GPL-3.0','AGPL-3.0','LGPL-2.1','LGPL-3.0','MPL-2.0','SSPL-1.0']);
const NETWORK_COPYLEFT=new Set(['AGPL-3.0','SSPL-1.0']);
const PERMISSIVE=new Set(['MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC','0BSD','Unlicense','CC0-1.0']);

const RULES=[
 ['handlesPersonalData','privacy','high','Which privacy laws apply, what is the lawful basis, and how are access, deletion and retention handled?'],
 ['handlesFundsOrPayments','money-transmission','high','Does holding or moving customer funds need a money transmission licence or a regulated partner?'],
 ['offersCreditOrLending','lending','high','Do lending, disclosure and fair-lending rules apply to this credit offering?'],
 ['offersSecuritiesOrInvestments','securities','high','Does this involve offering securities or investment advice that needs registration or an exemption?'],
 ['handlesHealthData','health-privacy','high','Does health-data regulation apply, and are business associate or equivalent agreements needed?'],
 ['targetsChildren','childrens-privacy','high','Do children\'s online privacy rules require parental consent and data minimization?'],
 ['operatesCrossBorder','cross-border','medium','Which jurisdictions\' consumer, tax, sanctions and data-transfer rules apply?'],
 ['automatedDecisionsAboutPeople','automated-decisions','high','Do anti-discrimination, explanation or human-review requirements apply to automated decisions?'],
 ['collectsBiometrics','biometrics','high','Do biometric privacy laws require notice, written consent or retention schedules?'],
 ['usesThirdPartyBrandNames','trademark','medium','Has a trademark clearance search been done, and is any third-party brand use permitted?'],
 ['sendsMarketingMessages','marketing-consent','medium','Do anti-spam or telemarketing rules require opt-in consent and unsubscribe handling?']
];

/**
 * BNK-028 IP and compliance issue spotting. A deterministic checklist that turns a founder's structured product
 * profile into questions for qualified counsel. It never states that something is legal or compliant, and every
 * result is marked as not legal advice.
 */
export function spotIssues({projectId,profile,dependencies=[],distribution='saas'}){
 bounded(projectId,'Project ID',code);
 ensure(profile&&Object.getPrototypeOf(profile)===Object.prototype,code,'A structured profile is required');
 for(const key of Object.keys(profile))ensure(FLAGS.includes(key),code,`Unknown profile flag ${key}`);
 for(const flag of FLAGS)ensure(typeof profile[flag]==='boolean',code,`Profile flag ${flag} must be answered true or false`);
 ensure(['saas','distributed-binary','open-source','internal'].includes(distribution),code,'Distribution model is unsupported');
 ensure(Array.isArray(dependencies)&&dependencies.length<=500,code,'Dependencies are bounded');
 const issues=RULES.filter(([flag])=>profile[flag]).map(([flag,area,severity,question])=>Object.freeze({issueId:`${area}`,area,severity,question,trigger:flag}));
 for(const dependency of dependencies){
  bounded(dependency?.name,'Dependency name',code);ensure(typeof dependency.license==='string'&&dependency.license.length<=64,code,'Dependency licence is required');
  const license=dependency.license;
  if(PERMISSIVE.has(license))continue;
  if(NETWORK_COPYLEFT.has(license)&&distribution!=='open-source')issues.push(Object.freeze({issueId:`license-${dependency.name}`,area:'open-source-license',severity:'high',question:`${dependency.name} uses ${license}; network use may require releasing source. Is that acceptable?`,trigger:'dependency'}));
  else if(COPYLEFT.has(license)&&distribution==='distributed-binary')issues.push(Object.freeze({issueId:`license-${dependency.name}`,area:'open-source-license',severity:'high',question:`${dependency.name} uses ${license}; distributing binaries may impose source obligations.`,trigger:'dependency'}));
  else if(!COPYLEFT.has(license))issues.push(Object.freeze({issueId:`license-${dependency.name}`,area:'open-source-license',severity:'medium',question:`${dependency.name} has an unrecognized licence (${license}); confirm the terms.`,trigger:'dependency'}));
 }
 const high=issues.filter(issue=>issue.severity==='high').length;
 return Object.freeze({projectId,issues:Object.freeze(issues),highSeverityCount:high,requiresCounselReview:high>0,referral:'qualified-counsel',notLegalAdvice:true,statement:'This checklist raises questions only. It does not determine legality or compliance.',syntheticOnly:true});
}
