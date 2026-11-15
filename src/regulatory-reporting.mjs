import {createHash} from 'node:crypto';
import {bounded,ensure} from './runtime/guards.mjs';

const code='INVALID_REPORT';
export const REPORT_WATERMARK='SYNTHETIC - NOT FOR REGULATORY FILING';
const canonical=value=>JSON.stringify(value,(key,inner)=>inner&&typeof inner==='object'&&!Array.isArray(inner)?Object.fromEntries(Object.keys(inner).sort().map(name=>[name,inner[name]])):inner);
const sum=(rows,field)=>rows.reduce((total,row)=>total+row[field],0);

const BUILDERS={
 'deposit-balances':({accounts})=>{
  ensure(Array.isArray(accounts),code,'Accounts are required');
  const byType=new Map();for(const account of accounts){ensure(Number.isSafeInteger(account.balanceMinor),code,'Balances must be integers');const type=account.accountId.replace(/-\d+$/,'');const row=byType.get(type)??{accountType:type,accounts:0,balanceMinor:0};row.accounts+=1;row.balanceMinor+=account.balanceMinor;byType.set(type,row);}
  const rows=[...byType.values()].sort((left,right)=>left.accountType<right.accountType?-1:1);return {rows,totals:{accounts:sum(rows,'accounts'),balanceMinor:sum(rows,'balanceMinor')}};
 },
 'overdraft-fee-summary':({decisions})=>{
  ensure(Array.isArray(decisions),code,'Decisions are required');
  const byRail=new Map();for(const decision of decisions){const row=byRail.get(decision.rail)??{rail:decision.rail,approved:0,declined:0,feeMinor:0,feeBearing:0};row[decision.decision==='approve'?'approved':'declined']+=1;row.feeMinor+=decision.feeMinor;if(decision.feeMinor>0)row.feeBearing+=1;byRail.set(decision.rail,row);}
  const rows=[...byRail.values()].sort((left,right)=>left.rail<right.rail?-1:1);return {rows,totals:{approved:sum(rows,'approved'),declined:sum(rows,'declined'),feeMinor:sum(rows,'feeMinor')}};
 },
 'disputes-and-complaints':({disputes,now})=>{
  ensure(Array.isArray(disputes)&&Number.isSafeInteger(now),code,'Disputes are required');
  const byReason=new Map();for(const dispute of disputes){const row=byReason.get(dispute.reasonCode)??{reasonCode:dispute.reasonCode,filed:0,resolved:0,acknowledgedLate:0,openPastResolveBy:0};row.filed+=1;if(dispute.state==='RESOLVED')row.resolved+=1;if(dispute.acknowledgedLate)row.acknowledgedLate+=1;if(dispute.state!=='RESOLVED'&&now>dispute.deadlines.resolveBy)row.openPastResolveBy+=1;byReason.set(dispute.reasonCode,row);}
  const rows=[...byReason.values()].sort((left,right)=>left.reasonCode<right.reasonCode?-1:1);return {rows,totals:{filed:sum(rows,'filed'),resolved:sum(rows,'resolved'),acknowledgedLate:sum(rows,'acknowledgedLate'),openPastResolveBy:sum(rows,'openPastResolveBy')}};
 }
};
export const REPORT_KINDS=Object.freeze(Object.keys(BUILDERS));

/**
 * BNK-040 regulatory reporting generators. Produces synthetic report artifacts from engine data with reconciled
 * totals, a canonical SHA-256 checksum and a permanent watermark. Reports are never filed: `filingStatus` is
 * always `not-filed`. Real report formats, schedules and filing require the institution's compliance team.
 */
export function generateSyntheticReport({kind,tenantId,periodStart,periodEnd,generatedAt,data}){
 ensure(Object.hasOwn(BUILDERS,kind),code,'Report kind is unsupported');ensure(/^tenant_[a-z0-9_-]+$/.test(tenantId??''),code,'Tenant is required');
 ensure(Number.isSafeInteger(periodStart)&&Number.isSafeInteger(periodEnd)&&periodStart<periodEnd&&Number.isSafeInteger(generatedAt),code,'Period is invalid');
 const {rows,totals}=BUILDERS[kind](data??{});
 for(const [field,value] of Object.entries(totals))ensure(sum(rows,field)===value,'REPORT_UNRECONCILED',`Total ${field} does not reconcile`);
 const body={kind,tenantId,periodStart,periodEnd,rows,totals};
 return Object.freeze({header:Object.freeze({watermark:REPORT_WATERMARK,kind,tenantId,periodStart,periodEnd,generatedAt,generator:'prosperity-engine-synthetic-v1'}),rows:Object.freeze(rows.map(row=>Object.freeze(row))),totals:Object.freeze(totals),checksum:createHash('sha256').update(canonical(body)).digest('hex'),filingStatus:'not-filed',filingChannel:null,syntheticOnly:true});
}

export function renderReportCsv(report){
 ensure(report?.header?.watermark===REPORT_WATERMARK,code,'Only watermarked synthetic reports can be rendered');
 const columns=Object.keys(report.rows[0]??{});
 const escape=value=>{const text=String(value);return /[",\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
 return [`# ${REPORT_WATERMARK}`,`# kind=${report.header.kind} tenant=${report.header.tenantId} checksum=${report.checksum}`,columns.join(','),...report.rows.map(row=>columns.map(column=>escape(row[column])).join(','))].join('\n')+'\n';
}
