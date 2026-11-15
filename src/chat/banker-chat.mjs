import {EngineError} from '../index.mjs';
import {authorizeDataUse} from '../data-classification.mjs';
import {PolicyGateway} from '../policy-gateway.mjs';
import {ensure,requireDecision} from '../runtime/guards.mjs';

const compiledContracts=new WeakSet();
const MONEY=/\b([A-Z]{3}) (-?\d{1,15}\.\d{2})\b/g;
const FACT_ID=/^fact-[a-z0-9-]{1,64}$/;
export const formatMinor=(currency,minor)=>`${currency} ${minor<0?'-':''}${Math.trunc(Math.abs(minor)/100)}.${String(Math.abs(minor)%100).padStart(2,'0')}`;

/** Requests the banker must never fulfil itself: money movement, ledger, credit, fee or account changes. */
const ACTION_PATTERNS=[
 /\b(transfer|send|wire|pay|zelle|move)\b.*\b(money|funds|cash|\$|usd|dollars?|to)\b/i,
 /\b(withdraw|deposit|refund|reverse|charge ?back|cancel (the )?payment)\b/i,
 /\b(approve|increase|raise|grant|lower)\b.*\b(loan|credit|limit|overdraft)\b/i,
 /\b(waive|remove|refund)\b.*\bfees?\b/i,
 /\b(close|open|freeze|unfreeze|lock|unlock)\b.*\b(account|card)\b/i,
 /\b(turn on|enable|opt (me )?in|disable|opt (me )?out)\b.*\boverdraft\b/i
];
const INJECTION=/\b(ignore|disregard|override)\b.*\b(instructions|rules|policy|system)\b|\bsystem prompt\b|\bdeveloper mode\b/i;

export function createBankerChatContract({version,action,maxQuestionLength=600,maxFacts=80}){
 ensure(typeof version==='string'&&version.length>0&&version.length<=64,'INVALID_CHAT_CONTRACT','Chat contract version is required');
 ensure(typeof action==='string'&&action.length>0,'INVALID_CHAT_CONTRACT','Chat action is required');
 ensure(Number.isInteger(maxQuestionLength)&&maxQuestionLength>=20&&maxQuestionLength<=2_000,'INVALID_CHAT_CONTRACT','Question bound is invalid');
 ensure(Number.isInteger(maxFacts)&&maxFacts>=1&&maxFacts<=200,'INVALID_CHAT_CONTRACT','Fact bound is invalid');
 const contract=Object.freeze({version,action,maxQuestionLength,maxFacts,syntheticOnly:true});compiledContracts.add(contract);return contract;
}

/**
 * Build grounding facts only from engine-computed results (BNK-011 home, BNK-012 transactions,
 * BNK-013 forecast). Every amount the banker states must come from one of these facts.
 */
export function buildGroundingFacts({home=null,transactions=[],forecast=null,recentLimit=10}){
 const facts=[];
 for(const account of home?.accounts??[])facts.push({id:`fact-balance-${account.accountId}`,kind:'balance',accountId:account.accountId,currency:account.currency,valueMinor:account.balanceMinor,asOf:account.balanceAsOf,freshness:account.freshness});
 for(const [currency,total] of Object.entries(home?.totalsByCurrency??{}))facts.push({id:`fact-total-${currency.toLowerCase()}`,kind:'total',currency,valueMinor:total});
 const recent=[...transactions].sort((left,right)=>right.bookedAt-left.bookedAt).slice(0,recentLimit);
 recent.forEach((item,index)=>facts.push({id:`fact-txn-${index+1}`,kind:'transaction',accountId:item.accountId,currency:item.currency,valueMinor:item.signedAmountMinor,descriptionCode:item.descriptionCode,asOf:item.bookedAt}));
 const byCurrency=new Map();for(const item of transactions)if(item.signedAmountMinor<0)byCurrency.set(item.currency,(byCurrency.get(item.currency)??0)-item.signedAmountMinor);
 for(const [currency,spent] of byCurrency)facts.push({id:`fact-spend-${currency.toLowerCase()}`,kind:'spending',currency,valueMinor:spent,windowCount:transactions.length});
 if(forecast?.buckets?.length){const last=forecast.buckets.at(-1);facts.push({id:'fact-forecast-net',kind:'forecast',accountId:forecast.accountId,currency:forecast.currency,valueMinor:last.cumulativeNetMinor,horizonDays:forecast.horizonDays,methodology:forecast.methodology});}
 return Object.freeze(facts.map(fact=>Object.freeze({...fact,display:formatMinor(fact.currency,fact.valueMinor)})));
}

const describe=fact=>({balance:`${fact.accountId} balance`,total:`total across accounts`,transaction:`${fact.descriptionCode} on ${fact.accountId}`,spending:'outflows in the loaded history',forecast:`projected net change over the next ${fact.horizonDays} days for ${fact.accountId}`})[fact.kind];

/** Deterministic, offline responder. It is clearly labelled and never calls an AI model. */
export function createSimulatedResponder(){
 return Object.freeze({
  id:'simulated-deterministic-v1',kind:'simulated',label:'Simulated deterministic responder (no AI model)',
  async respond({question,facts}){
   const q=question.toLowerCase(),pick=kinds=>facts.filter(fact=>kinds.includes(fact.kind));
   let chosen,lead;
   if(/forecast|project|next (week|month|days)|going to|will i/.test(q)){chosen=pick(['forecast','balance']);lead='Here is the mechanical projection the engine computed (not a promise):';}
   else if(/spen|outflow|bills?|expens|transaction|recent|purchase/.test(q)){chosen=pick(['spending','transaction']).slice(0,6);lead='From your posted transactions:';}
   else if(/balance|how much|available|total|money|account/.test(q)){chosen=pick(['balance','total']);lead='Your current synthetic balances:';}
   else return {text:'I can explain your synthetic balances, recent transactions, spending and the engine cash-flow forecast. Ask about one of those.',citations:[]};
   if(!chosen.length)return {text:'I do not have engine data that answers that yet.',citations:[]};
   const lines=chosen.map(fact=>`- ${describe(fact)}: ${fact.display}${fact.freshness==='stale'?' (balance may be out of date)':''} [${fact.id}]`);
   return {text:[lead,...lines].join('\n'),citations:chosen.map(fact=>fact.id)};
  }
 });
}

/** Every stated money amount must equal a cited fact; every citation must exist. */
export function validateGrounding({text,citations},facts){
 if(typeof text!=='string'||text.length===0||text.length>4_000||!Array.isArray(citations)||citations.length>facts.length)return {ok:false,reason:'MALFORMED_RESPONSE'};
 const byId=new Map(facts.map(fact=>[fact.id,fact]));
 if(!citations.every(id=>typeof id==='string'&&FACT_ID.test(id)&&byId.has(id)))return {ok:false,reason:'UNKNOWN_CITATION'};
 const allowed=new Set(citations.map(id=>byId.get(id).display));
 for(const match of text.matchAll(MONEY))if(!allowed.has(`${match[1]} ${match[2]}`))return {ok:false,reason:'UNGROUNDED_AMOUNT'};
 if(/\$\s?\d|\d+(\.\d+)?\s?(dollars|usd|eur|gbp)\b/i.test(text.replace(MONEY,'')))return {ok:false,reason:'UNGROUNDED_AMOUNT'};
 return {ok:true};
}

export class BankerChatService {
 #contract;#gateway;#provider;
 constructor({contract,gateway,provider}){
  ensure(compiledContracts.has(contract),'INVALID_CHAT_CONTRACT','Compiled chat contract is required');
  ensure(gateway instanceof PolicyGateway,'INVALID_CHAT_CONTRACT','Policy gateway is required');
  ensure(provider&&typeof provider.respond==='function'&&(provider.kind==='simulated'||provider.kind==='model')&&typeof provider.id==='string','INVALID_CHAT_PROVIDER','A labelled chat provider is required');
  this.#contract=contract;this.#gateway=gateway;this.#provider=provider;
 }

 get responder(){return Object.freeze({id:this.#provider.id,kind:this.#provider.kind,label:this.#provider.label});}

 async ask({identity,question,facts,dataCategory,assignments,now}){
  requireDecision(this.#gateway,{identity,action:this.#contract.action,assignments,now},'CHAT_DENIED');
  ensure(typeof question==='string'&&question.trim().length>0&&question.length<=this.#contract.maxQuestionLength,'INVALID_CHAT_QUESTION','A bounded question is required');
  ensure(Array.isArray(facts)&&facts.length<=this.#contract.maxFacts&&facts.every(fact=>FACT_ID.test(fact?.id??'')&&typeof fact.display==='string'),'INVALID_CHAT_FACTS','Engine-built grounding facts are required');
  const responder=this.responder,base={tenantId:identity.tenantId,responder,contractVersion:this.#contract.version,notFinancialAdvice:true,syntheticOnly:true};
  const handoff=(reason,text)=>Object.freeze({...base,answer:text,citations:Object.freeze([]),grounded:true,handoff:Object.freeze({reason,to:'human-banker'})});
  if(ACTION_PATTERNS.some(pattern=>pattern.test(question)))return handoff('ACTION_REQUEST','I cannot move money, change your account, credit, fees or overdraft settings. Those actions need you to act directly with step-up approval, or a human banker.');
  if(INJECTION.test(question))return handoff('POLICY_PROBE','I can only answer from your engine data. A human banker can help with anything else.');
  if(responder.kind==='model')authorizeDataUse({category:dataCategory,tenantId:identity.tenantId,operation:'model_input'});
  let draft;
  try{draft=await this.#provider.respond({question:question.trim(),facts});}
  catch(error){if(error instanceof EngineError&&error.code==='DATA_USE_DENIED')throw error;draft=null;}
  if(draft?.refused)return handoff('PROVIDER_REFUSED','I cannot answer that here. A human banker can help.');
  const check=draft?validateGrounding(draft,facts):{ok:false,reason:'PROVIDER_UNAVAILABLE'};
  if(!check.ok)return Object.freeze({...handoff(check.reason,'I could not produce an answer grounded in your engine data. A human banker can help.'),grounded:false});
  const byId=new Map(facts.map(fact=>[fact.id,fact]));
  return Object.freeze({...base,answer:draft.text,citations:Object.freeze([...new Set(draft.citations)].map(id=>byId.get(id))),grounded:true,handoff:null});
 }
}
