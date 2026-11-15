import {EngineError} from '../index.mjs';
import {ensure} from './guards.mjs';

/**
 * BNK-041 failure injection. Wraps any engine store and makes chosen operations fail on chosen call numbers,
 * before or after the underlying call runs ("after" models a commit whose acknowledgement was lost).
 * Used by tests and drills; never enabled by the start script.
 */
export function createFaultInjectingStore(store,plan={}){
 ensure(store&&typeof store==='object',"INVALID_FAULT_PLAN",'A store is required');
 const counts=new Map(),log=[];
 const wrapped=new Proxy(store,{get(target,property){
  const original=target[property];
  if(typeof original!=='function')return original;
  return async(...args)=>{
   const count=(counts.get(property)??0)+1;counts.set(property,count);
   const fault=(plan[property]??[]).find(item=>item.call===count);
   if(fault?.when==='before'){log.push({operation:property,call:count,when:'before'});throw new EngineError('INJECTED_FAULT',`Injected fault before ${String(property)}`);}
   const result=await original.apply(target,args);
   if(fault?.when==='after'){log.push({operation:property,call:count,when:'after'});throw new EngineError('INJECTED_FAULT',`Injected fault after ${String(property)}`);}
   return result;
  };
 }});
 return {store:wrapped,log};
}
