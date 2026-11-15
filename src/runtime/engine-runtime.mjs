import {EngineError} from '../index.mjs';
import {authenticateIdentity,createRolePolicy} from '../identity.mjs';
import {PolicyGateway,createGatewayPolicy} from '../policy-gateway.mjs';
import {createBankAdapterContract} from '../bank-adapter.mjs';
import {createEventSchema} from '../event-outbox.mjs';
import {createEvidenceVaultContract} from '../evidence-vault.mjs';
import {createAuditSinkContract,TenantAuditSink} from '../audit-sink.mjs';
import {BankingHomeService,createBankingHomeContract} from '../banking-home.mjs';
import {TransactionNormalizer,createTransactionNormalizerContract} from '../transaction-normalizer.mjs';
import {CashFlowForecastService,createCashFlowForecastContract} from '../cash-flow-forecast.mjs';
import {DurableEventOutbox,DurableEvidenceVault,DurableLedger} from './durable-services.mjs';
import {ensure,requireDecision} from './guards.mjs';
import {SYNTHETIC_ROLES,createSyntheticDirectory,syntheticLedgerSeed} from '../synthetic/directory.mjs';
import {createSyntheticSessionIssuer} from '../synthetic/session-tokens.mjs';
import {BankerChatService,buildGroundingFacts,createBankerChatContract,createSimulatedResponder} from '../chat/banker-chat.mjs';

export const ENGINE_NOTICE='Non-production Prosperity Banking Engine demo. Synthetic data only: no real customers, accounts, funds or bank connections. Not a bank and not a bank-branded application.';

export const GATEWAY_RULES=Object.freeze([
 {action:'bank.home.read',permission:'home:read'},
 {action:'bank.accounts.read',permission:'bank:read'},
 {action:'bank.entries.post',permission:'bank:post',requiresMfa:true},
 {action:'bank.transactions.read',permission:'transactions:read'},
 {action:'bank.cashflow.forecast',permission:'cashflow:forecast'},
 {action:'evidence.read',permission:'evidence:read'},
 {action:'evidence.write',permission:'evidence:write'},
 {action:'audit.read',permission:'audit:read'},
 {action:'audit.write',permission:'audit:write'},
 {action:'outbox.operate',permission:'outbox:operate'},
 {action:'chat.ask',permission:'chat:ask'}
]);

export const EVENT_SCHEMAS=Object.freeze({
 ledgerEntryPosted:createEventSchema({type:'ledger.entry.posted',version:'v1',requiredFields:['accountId','amountMinor','direction','entryId']}),
 syntheticNote:createEventSchema({type:'synthetic.note.recorded',version:'v1',requiredFields:['noteCode']})
});

/** Compose the engine's existing domain units behind one async runtime used by the HTTP API. */
export async function createEngineRuntime({store,sessionSecret,dataMode='synthetic',clock=Date.now,seedAt=clock(),sessionTtlMs,chatProvider=createSimulatedResponder()}={}){
 ensure(dataMode==='synthetic','DATA_MODE_DENIED','Only DATA_MODE=synthetic is supported by this engine build');
 const directory=createSyntheticDirectory();
 const issuer=createSyntheticSessionIssuer({secret:sessionSecret,directory,ttlMs:sessionTtlMs});
 const rolePolicy=createRolePolicy(SYNTHETIC_ROLES.map(role=>({...role,permissions:[...role.permissions]})));
 const gateway=new PolicyGateway({policy:createGatewayPolicy({version:'engine-api-v1',rules:GATEWAY_RULES.map(rule=>({...rule}))}),rolePolicy});
 const adapterContract=createBankAdapterContract({adapterId:'synthetic-ledger',version:'v1',currencies:['USD'],actions:{read:'bank.accounts.read',post:'bank.entries.post'}});
 const homeContract=createBankingHomeContract({version:'home-v1',action:'bank.home.read',maxBalanceAgeMs:86_400_000,maxAccounts:20});
 const normalizerContract=createTransactionNormalizerContract({version:'normalizer-v1',action:'bank.transactions.read',maxTransactions:500});
 const forecastContract=createCashFlowForecastContract({version:'forecast-v1',action:'bank.cashflow.forecast',maxTransactions:500,maxScheduledItems:50,maxHorizonDays:90,maxLookbackDays:365});
 const vaultContract=createEvidenceVaultContract({version:'vault-v1',actions:{read:'evidence.read',write:'evidence.write'}});
 const auditContract=createAuditSinkContract({version:'audit-v1',actions:{read:'audit.read',write:'audit.write'},attributeKeys:['accountRef','amountMinor','channel','reasonCode']});

 const ledger=new DurableLedger({contract:adapterContract,gateway,store,eventSchema:EVENT_SCHEMAS.ledgerEntryPosted});
 const outbox=new DurableEventOutbox({store});
 const vault=new DurableEvidenceVault({contract:vaultContract,gateway,store});
 const audit=new TenantAuditSink({contract:auditContract,gateway});
 const chat=new BankerChatService({contract:createBankerChatContract({version:'banker-chat-v1',action:'chat.ask'}),gateway,provider:chatProvider});
 await store.seed(syntheticLedgerSeed({adapterId:adapterContract.adapterId,seedAt}));

 const readServices=async(identity,accountIds,now)=>{
  const adapter=await ledger.snapshot({identity,accountIds,now});
  const normalizer=new TransactionNormalizer({contract:normalizerContract,gateway,adapter});
  return {home:new BankingHomeService({contract:homeContract,gateway,adapter}),normalizer,forecast:new CashFlowForecastService({contract:forecastContract,gateway,normalizer})};
 };

 return Object.freeze({
  dataMode,notice:ENGINE_NOTICE,directory,store,
  issueSession:({tenantId,subject})=>issuer.issue({tenantId,subject,now:clock()}),
  async authenticate(token){
   const now=clock();
   try{return await authenticateIdentity({credential:token,now},async credential=>issuer.verify(credential,now));}
   catch(error){throw new EngineError('UNAUTHENTICATED','A valid synthetic session token is required');}
  },
  assignmentsFor:identity=>directory.assignmentsFor(identity),
  async home(identity,{accountIds}){const now=clock();return (await readServices(identity,accountIds,now)).home.getHome({identity,accountIds,assignments:directory.assignmentsFor(identity),now});},
  readAccount:(identity,{accountId})=>ledger.readAccount({identity,accountId,assignments:directory.assignmentsFor(identity),now:clock()}),
  async transactions(identity,{accountId,limit}){const now=clock();return (await readServices(identity,[accountId],now)).normalizer.list({identity,accountId,limit,assignments:directory.assignmentsFor(identity),now});},
  async forecast(identity,{accountId,...terms}){const now=clock();return (await readServices(identity,[accountId],now)).forecast.forecast({identity,accountId,...terms,assignments:directory.assignmentsFor(identity),now});},
  postEntry:(identity,command)=>ledger.postEntry({...command,identity,assignments:directory.assignmentsFor(identity),now:clock()}),
  storeEvidence:(identity,request)=>vault.store({...request,identity,assignments:directory.assignmentsFor(identity),now:clock()}),
  getEvidence:(identity,{evidenceId})=>vault.get({identity,evidenceId,assignments:directory.assignmentsFor(identity),now:clock()}),
  listEvidence:(identity,{limit})=>vault.list({identity,limit,assignments:directory.assignmentsFor(identity),now:clock()}),
  appendAudit:async(identity,record)=>audit.append({...record,identity,assignments:directory.assignmentsFor(identity),now:clock()}),
  listAudit:async(identity,query)=>audit.list({...query,identity,assignments:directory.assignmentsFor(identity),now:clock()}),
  async enqueueNote(identity,{eventId,aggregateId,noteCode,idempotencyKey}){
   const now=clock();requireDecision(gateway,{identity,action:'outbox.operate',assignments:directory.assignmentsFor(identity),now},'OUTBOX_DENIED');
   return outbox.enqueue(identity,EVENT_SCHEMAS.syntheticNote,{eventId,aggregateId,payload:{noteCode},idempotencyKey,occurredAt:now,now});
  },
  async listEvents(identity,{limit}){const now=clock();requireDecision(gateway,{identity,action:'outbox.operate',assignments:directory.assignmentsFor(identity),now},'OUTBOX_DENIED');return outbox.list(identity,{limit,now});},
  async claimEvents(identity,terms){const now=clock();requireDecision(gateway,{identity,action:'outbox.operate',assignments:directory.assignmentsFor(identity),now},'OUTBOX_DENIED');return outbox.claim(identity,{...terms,now});},
  async completeEvent(identity,terms){const now=clock();requireDecision(gateway,{identity,action:'outbox.operate',assignments:directory.assignmentsFor(identity),now},'OUTBOX_DENIED');return outbox.complete(identity,{...terms,now});},
  chatResponder:chat.responder,
  async ask(identity,{question}){
   const now=clock(),assignments=directory.assignmentsFor(identity);
   requireDecision(gateway,{identity,action:'chat.ask',assignments,now},'CHAT_DENIED');
   const services=await readServices(identity,['checking','savings'],now);
   const home=services.home.getHome({identity,accountIds:['checking','savings'],assignments,now});
   const transactions=services.normalizer.list({identity,accountId:'checking',limit:100,assignments,now});
   const forecast=services.forecast.forecast({identity,accountId:'checking',currency:'USD',horizonDays:7,lookbackDays:30,assignments,now});
   return chat.ask({identity,question,facts:buildGroundingFacts({home,transactions,forecast}),dataCategory:'synthetic_test_data',assignments,now});
  },
  health:()=>store.health(),
  close:()=>store.close()
 });
}
