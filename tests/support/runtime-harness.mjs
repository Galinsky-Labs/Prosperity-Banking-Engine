import {createEngineServer} from '../../src/http/server.mjs';
import {createEngineRuntime} from '../../src/runtime/engine-runtime.mjs';

export const SECRET='test-secret-'.padEnd(40,'x');
const quiet={info(){},error(){}};

/** Start an engine HTTP server on an ephemeral port over the given store with a controllable clock. */
export async function startEngine({store,time=1_800_000_000_000,onFatal,rateLimit={limit:10_000}}={}){
 const clock={now:time};
 const runtime=await createEngineRuntime({store,sessionSecret:SECRET,clock:()=>clock.now,onFatal});
 const server=createEngineServer({runtime,version:'test',logger:quiet,rateLimit});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(method,path,{token,body}={})=>{
  const response=await fetch(base+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
 };
 const session=async(tenantId,subject)=>(await call('POST','/v1/synthetic/sessions',{body:{tenantId,subject}})).body.token;
 const op=async(token,name,body={})=>{const [module,operation]=name.split('.');return call('POST',`/v1/modules/${module}/${operation}`,{token,body});};
 return {runtime,server,call,session,op,clock,advance:ms=>{clock.now+=ms;},close:async()=>{await new Promise(resolve=>server.close(resolve));await runtime.close();}};
}
