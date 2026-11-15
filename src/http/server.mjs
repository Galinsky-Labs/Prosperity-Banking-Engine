import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {EngineError} from '../index.mjs';

const MAX_BODY_BYTES=64*1024;
const JSON_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; frame-ancestors 'none'",'x-data-mode':'synthetic'};

const STATUS_BY_CODE=new Map([
 ['UNAUTHENTICATED',401],['IDENTITY_UNVERIFIED',401],['IDENTITY_EXPIRED',401],
 ['NOT_FOUND',404],['ACCOUNT_NOT_FOUND',404],['EVIDENCE_NOT_FOUND',404],['EVENT_NOT_FOUND',404],['UNKNOWN_SYNTHETIC_SUBJECT',404],
 ['METHOD_NOT_ALLOWED',405],['UNKNOWN_OPERATION',404],['ENGINE_UNAVAILABLE',503],['CONSENT_NOT_FOUND',404],['PAYLOAD_TOO_LARGE',413],['UNSUPPORTED_MEDIA_TYPE',415],['RATE_LIMITED',429],
 ['REPLAY_MISMATCH',409],['VERSION_CONFLICT',409],['ENTRY_CONFLICT',409],['EVENT_CONFLICT',409],['EVIDENCE_CONFLICT',409],['AUDIT_CONFLICT',409],['REQUEST_CONFLICT',409],['LEASE_DENIED',409],['LEASE_EXPIRED',409],
 ['INSUFFICIENT_FUNDS',422],['CHAT_PROVIDER_UNAVAILABLE',503],['AMOUNT_OVERFLOW',422],['RAW_EVIDENCE_DENIED',422],['SENSITIVE_AUDIT_DATA',422],['DATA_USE_DENIED',422]
]);
export const statusForError=error=>{
 if(!(error instanceof EngineError))return 500;
 if(STATUS_BY_CODE.has(error.code))return STATUS_BY_CODE.get(error.code);
 if(/_DENIED$/.test(error.code))return 403;
 return 400;
};

class Router {
 #routes=[];
 add(method,pattern,handler,{auth=true}={}){
  const keys=[];const regex=new RegExp('^'+pattern.replace(/:([a-zA-Z]+)/g,(_,key)=>{keys.push(key);return '([^/]+)';})+'$');
  this.#routes.push({method,regex,keys,handler,auth});return this;
 }
 match(method,path){
  let pathMatched=false;
  for(const route of this.#routes){
   const match=route.regex.exec(path);if(!match)continue;pathMatched=true;
   if(route.method!==method)continue;
   const params={};
   try{route.keys.forEach((key,index)=>{params[key]=decodeURIComponent(match[index+1]);});}catch{throw new EngineError('INVALID_PATH','Path parameter encoding is invalid');}
   return {route,params};
  }
  return pathMatched?{methodNotAllowed:true}:null;
 }
}

async function readJson(request){
 if(request.method==='GET'||request.method==='HEAD')return {};
 const type=request.headers['content-type']??'';
 if(!/^application\/json\b/i.test(type))throw new EngineError('UNSUPPORTED_MEDIA_TYPE','Request body must be application/json');
 const chunks=[];let size=0;
 for await(const chunk of request){size+=chunk.length;if(size>MAX_BODY_BYTES)throw new EngineError('PAYLOAD_TOO_LARGE','Request body exceeds 64 KiB');chunks.push(chunk);}
 if(size===0)return {};
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new EngineError('INVALID_JSON','Request body must be valid JSON');}
 if(!body||typeof body!=='object'||Array.isArray(body))throw new EngineError('INVALID_JSON','Request body must be a JSON object');
 return body;
}

const safePath=raw=>{try{return new URL(raw??'/','http://engine.invalid').pathname;}catch{return '/invalid';}};
const pick=(body,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]));
const intParam=(value,fallback)=>{if(value===null||value===undefined||value==='')return fallback;if(!/^\d{1,6}$/.test(value))throw new EngineError('INVALID_QUERY','Numeric query parameter is invalid');return Number(value);};

/** Fixed-window per-client limiter for the public synthetic demo. */
function createRateLimiter({limit=120,windowMs=60_000,clock=Date.now}={}){
 const windows=new Map();
 return key=>{
  const now=clock(),current=windows.get(key);
  if(!current||current.resetAt<=now){if(windows.size>10_000)windows.clear();windows.set(key,{count:1,resetAt:now+windowMs});return true;}
  current.count+=1;return current.count<=limit;
 };
}

export function buildRoutes(runtime,{version}){
 const router=new Router();
 router.add('GET','/',async()=>({status:200,body:{service:'prosperity-banking-engine',version,notice:runtime.notice,dataMode:runtime.dataMode,nonProduction:true,docs:'https://github.com/Galinsky-Labs/Prosperity-Banking-Engine/blob/main/docs/HTTP_API.md'}}),{auth:false});
 router.add('GET','/health',async()=>{
  let storage;try{storage=await runtime.health();}catch{storage={ok:false};}
  const journal=runtime.journalStatus();if(journal.fatal)storage={...storage,ok:false};
  return {status:storage.ok?200:503,body:{status:storage.ok?'ok':'degraded',service:'prosperity-banking-engine',version,dataMode:runtime.dataMode,nonProduction:true,storage:{ok:storage.ok,kind:runtime.store.kind},chat:{kind:runtime.chatResponder.kind,id:runtime.chatResponder.id},journal:{sequence:journal.sequence,replayErrors:journal.replayErrors,fatal:journal.fatal!==null}}};
 },{auth:false});
 router.add('GET','/v1/synthetic/directory',async()=>({status:200,body:{syntheticOnly:true,notice:runtime.notice,tenants:runtime.directory.tenants}}),{auth:false});
 router.add('POST','/v1/synthetic/sessions',async({body})=>({status:201,body:runtime.issueSession(pick(body,['tenantId','subject']))}),{auth:false});
 router.add('GET','/v1/me',async({identity})=>({status:200,body:{tenantId:identity.tenantId,subject:identity.subject,issuer:identity.issuer,expiresAt:identity.expiresAt,roles:runtime.assignmentsFor(identity).map(assignment=>assignment.role),syntheticOnly:true}}));
 router.add('GET','/v1/home',async({identity,query})=>{
  const raw=query.get('accountIds');
  return {status:200,body:await runtime.home(identity,{accountIds:raw===null?null:raw.split(',').filter(Boolean)})};
 });
 router.add('GET','/v1/accounts/:accountId',async({identity,params})=>({status:200,body:await runtime.readAccount(identity,{accountId:params.accountId})}));
 router.add('GET','/v1/accounts/:accountId/transactions',async({identity,params,query})=>({status:200,body:{transactions:await runtime.transactions(identity,{accountId:params.accountId,limit:intParam(query.get('limit'),100)}),syntheticOnly:true}}));
 router.add('POST','/v1/accounts/:accountId/entries',async({identity,params,body})=>({status:201,body:await runtime.postEntry(identity,{...pick(body,['requestId','entryId','direction','amountMinor','currency','expectedVersion','descriptionCode']),accountId:params.accountId})}));
 router.add('POST','/v1/accounts/:accountId/forecast',async({identity,params,body})=>({status:200,body:await runtime.forecast(identity,{...pick(body,['currency','horizonDays','lookbackDays','scheduledItems']),accountId:params.accountId})}));
 router.add('POST','/v1/evidence',async({identity,body})=>{
  for(const raw of ['content','plaintext','ciphertext','bytes','data'])if(Object.hasOwn(body,raw))throw new EngineError('RAW_EVIDENCE_DENIED','Raw evidence must remain outside the metadata vault');
  return {status:201,body:await runtime.storeEvidence(identity,pick(body,['requestId','evidenceId','category','contentDigest','keyReference','mediaType','sizeBytes','capturedAt','source']))};
 });
 router.add('GET','/v1/evidence',async({identity,query})=>({status:200,body:{evidence:await runtime.listEvidence(identity,{limit:intParam(query.get('limit'),100)}),syntheticOnly:true}}));
 router.add('GET','/v1/evidence/:evidenceId',async({identity,params})=>({status:200,body:await runtime.getEvidence(identity,{evidenceId:params.evidenceId})}));
 router.add('POST','/v1/audit',async({identity,body})=>({status:201,body:await runtime.appendAudit(identity,pick(body,['requestId','recordId','eventType','outcome','correlationId','attributes','occurredAt']))}));
 router.add('GET','/v1/audit',async({identity,query})=>({status:200,body:{records:await runtime.listAudit(identity,{eventType:query.get('eventType'),afterSequence:intParam(query.get('afterSequence'),0),limit:intParam(query.get('limit'),100)}),syntheticOnly:true}}));
 router.add('POST','/v1/outbox/notes',async({identity,body})=>({status:201,body:await runtime.enqueueNote(identity,pick(body,['eventId','aggregateId','noteCode','idempotencyKey']))}));
 router.add('GET','/v1/outbox/events',async({identity,query})=>({status:200,body:{events:await runtime.listEvents(identity,{limit:intParam(query.get('limit'),100)}),syntheticOnly:true}}));
 router.add('POST','/v1/outbox/claims',async({identity,body})=>({status:200,body:{events:await runtime.claimEvents(identity,pick(body,['workerId','limit','leaseMs'])),syntheticOnly:true}}));
 router.add('POST','/v1/outbox/events/:eventId/complete',async({identity,params,body})=>({status:200,body:await runtime.completeEvent(identity,{...pick(body,['workerId','leaseVersion']),eventId:params.eventId})}));
 router.add('GET','/v1/me/accounts',async({identity})=>({status:200,body:{accountIds:await runtime.heldAccounts(identity),scope:'holder-or-staff',syntheticOnly:true}}));
 router.add('POST','/v1/modules/:module/:operation',async({identity,params,body})=>({status:200,body:await runtime.execute(`${params.module}.${params.operation}`,identity,body)}));
 router.add('POST','/v1/chat',async({identity,body})=>({status:200,body:await runtime.ask(identity,pick(body,['question']))}));
 return router;
}

/** Create the synthetic engine HTTP server. The runtime supplies authentication and domain services. */
export function createEngineServer({runtime,version='0.0.0',logger=console,rateLimit={}}){
 const router=buildRoutes(runtime,{version});
 const allow=createRateLimiter(rateLimit);
 return createServer(async(request,response)=>{
  const requestId=randomUUID(),started=Date.now();
  const send=(status,body)=>{response.writeHead(status,{...JSON_HEADERS,'x-request-id':requestId});response.end(request.method==='HEAD'?undefined:JSON.stringify(body));};
  let status=500;
  try{
   let url;try{url=new URL(request.url??'/','http://engine.invalid');}catch{throw new EngineError('INVALID_PATH','Request path is invalid');}
   const client=String(request.headers['x-forwarded-for']??request.socket.remoteAddress??'unknown').split(',')[0].trim();
   if(!allow(client))throw new EngineError('RATE_LIMITED','Too many requests');
   const matched=router.match(request.method==='HEAD'?'GET':request.method,url.pathname);
   if(!matched)throw new EngineError('NOT_FOUND','Route not found');
   if(matched.methodNotAllowed)throw new EngineError('METHOD_NOT_ALLOWED','Method not allowed');
   let identity=null;
   if(matched.route.auth){
    const header=request.headers.authorization??'';
    const token=/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(header)?header.slice(7):null;
    if(!token)throw new EngineError('UNAUTHENTICATED','A bearer synthetic session token is required');
    identity=await runtime.authenticate(token);
   }
   const body=await readJson(request);
   const result=await matched.route.handler({identity,params:matched.params,query:url.searchParams,body});
   status=result.status;send(status,result.body);
  }catch(error){
   status=statusForError(error);
   if(status===500)logger.error?.(JSON.stringify({level:'error',requestId,message:'unhandled engine error',errorName:error?.name,errorMessage:String(error?.message??'').slice(0,300)}));
   send(status,{error:{code:status===500?'INTERNAL_ERROR':error.code,message:status===500?'Internal error':error.message},requestId,syntheticOnly:true});
  }finally{
   if(safePath(request.url)!=='/health')logger.info?.(JSON.stringify({level:'info',requestId,method:request.method,path:safePath(request.url).replace(/\/v1\/(accounts|evidence|outbox\/events)\/[^/]+/,'/v1/$1/:id'),status,durationMs:Date.now()-started}));
  }
 });
}
