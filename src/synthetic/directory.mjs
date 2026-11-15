import {SYNTHETIC_ISSUER} from './session-tokens.mjs';

/**
 * Synthetic demo directory. Tenants, subjects and accounts are invented test fixtures for the
 * non-production engine API. They do not represent any institution, person or real account.
 */
export const SYNTHETIC_ROLES=Object.freeze([
 {name:'customer',permissions:['home:read','bank:read','transactions:read','cashflow:forecast','evidence:read','chat:ask','consents:manage','hardship:request','overdraft:read','overdraft:change','stepup:request','stepup:approve','disputes:file','payments:initiate','onboarding:apply']},
 {name:'synthetic-operator',permissions:['bank:read','bank:post','transactions:read','evidence:read','evidence:write','audit:read','audit:write','outbox:operate','payments:operate','reconcile:run','agents:manage','agents:run','reports:read']},
 {name:'banker',permissions:['bank:read','transactions:read','audit:read','audit:write','hardship:draft','hardship:decide','disputes:work','disputes:decide','stepup:approve','onboarding:review','studio:review','reports:read','agents:manage']},
 {name:'agent',permissions:['agents:run','hardship:draft','disputes:work','stepup:request','studio:tools']},
 {name:'founder',permissions:['studio:founder','studio:projects','claims:write','claims:read','funding:refer']},
 {name:'verifier',permissions:['claims:read','verification:decide','studio:projects']}
]);

const customer=(subject,accounts)=>({subject,role:'customer',accounts});
export const SYNTHETIC_TENANTS=Object.freeze([
 {tenantId:'tenant_demo_alpha',label:'Synthetic demo tenant A',subjects:[customer('customer-1',[['checking','owner'],['savings','owner']]),customer('customer-2',[['checking-2','owner'],['savings','joint']]),{subject:'operator-1',role:'synthetic-operator'},{subject:'banker-1',role:'banker'},{subject:'banker-2',role:'banker'},{subject:'agent-1',role:'agent',workload:true},{subject:'founder-1',role:'founder'},{subject:'founder-2',role:'founder'},{subject:'verifier-1',role:'verifier'},{subject:'verifier-2',role:'verifier'}]},
 {tenantId:'tenant_demo_beta',label:'Synthetic demo tenant B',subjects:[customer('customer-1',[['checking','owner'],['savings','owner']]),{subject:'operator-1',role:'synthetic-operator'},{subject:'banker-1',role:'banker'},{subject:'founder-1',role:'founder'},{subject:'verifier-1',role:'verifier'}]}
]);

export function createSyntheticDirectory(tenants=SYNTHETIC_TENANTS){
 const index=new Map();
 for(const tenant of tenants)for(const entry of tenant.subjects)index.set(`${tenant.tenantId}\u0000${entry.subject}`,Object.freeze({tenantId:tenant.tenantId,...entry}));
 return Object.freeze({
  tenants:Object.freeze(tenants.map(({tenantId,label,subjects})=>Object.freeze({tenantId,label,subjects:Object.freeze(subjects.map(({subject,role,workload,accounts})=>Object.freeze({subject,role,workload:workload===true,accounts:Object.freeze((accounts??[]).map(([accountId])=>accountId))})))}))),
  findSubject:(tenantId,subject)=>typeof tenantId==='string'&&typeof subject==='string'?index.get(`${tenantId}\u0000${subject}`)??null:null,
  /** Server-side role assignments: never derived from caller-supplied fields. */
  assignmentsFor(identity){
   const entry=index.get(`${identity.tenantId}\u0000${identity.subject}`);
   if(!entry||identity.issuer!==SYNTHETIC_ISSUER)return [];
   return [Object.freeze({tenantId:entry.tenantId,issuer:SYNTHETIC_ISSUER,subject:entry.subject,role:entry.role,validFrom:0,validUntil:Number.MAX_SAFE_INTEGER,revoked:false})];
  }
 });
}

const DAY=86_400_000;

/** Deterministic synthetic accounts and 30 days of historical entries, relative to the seeding time. */
export function syntheticLedgerSeed({adapterId,seedAt,tenants=SYNTHETIC_TENANTS}){
 const accounts=[],entries=[],holders=[];
 tenants.forEach((tenant,tenantIndex)=>{
  const scale=tenantIndex+1;
  accounts.push({tenantId:tenant.tenantId,accountId:'checking',currency:'USD',balanceMinor:325_000*scale,balanceAsOf:seedAt,version:0,syntheticOnly:true});
  accounts.push({tenantId:tenant.tenantId,accountId:'savings',currency:'USD',balanceMinor:1_250_000*scale,balanceAsOf:seedAt-2*DAY,version:0,syntheticOnly:true});
  let sequence=0;
  const push=(accountId,day,direction,amountMinor,descriptionCode)=>{
   sequence+=1;const entryId=`seed-${String(sequence).padStart(4,'0')}`;
   entries.push({entryKey:`${tenant.tenantId}:${adapterId}:${entryId}`,entryId,tenantId:tenant.tenantId,accountId,direction,amountMinor,currency:'USD',descriptionCode,postedAt:seedAt-day*DAY,actor:{issuer:SYNTHETIC_ISSUER,subject:'synthetic-seed'},syntheticOnly:true});
  };
  const base=new Set(['checking','savings']);
  for(const accountId of new Set(tenant.subjects.flatMap(entry=>(entry.accounts??[]).map(([id])=>id)).filter(id=>!base.has(id))))accounts.push({tenantId:tenant.tenantId,accountId,currency:'USD',balanceMinor:87_500*scale,balanceAsOf:seedAt,version:0,syntheticOnly:true});
  for(const entry of tenant.subjects)for(const [accountId,relationship] of entry.accounts??[])holders.push({tenantId:tenant.tenantId,accountId,issuer:SYNTHETIC_ISSUER,subject:entry.subject,relationship});
  for(let day=30;day>=1;day-=1){
   if(day%14===2)push('checking',day,'credit',180_000*scale,'synthetic-payroll');
   if(day===25)push('checking',day,'debit',120_000*scale,'synthetic-rent');
   if(day%3===0)push('checking',day,'debit',(2_000+day*37)*scale,'synthetic-groceries');
   if(day%7===4)push('checking',day,'debit',4_500*scale,'synthetic-utilities');
   if(day===15)push('savings',day,'credit',25_000*scale,'synthetic-transfer-in');
  }
 });
 return {accounts,entries,holders};
}
