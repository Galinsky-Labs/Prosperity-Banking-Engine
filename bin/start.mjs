import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createEngineServer} from '../src/http/server.mjs';
import {createEngineRuntime} from '../src/runtime/engine-runtime.mjs';
import {MemoryEngineStore} from '../src/runtime/memory-store.mjs';

const {version}=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const log=(level,message,extra={})=>console.log(JSON.stringify({level,message,...extra}));

/** Memory store by default; Postgres when DATABASE_URL is set, after applying migrations at start. */
export async function createStoreFromEnvironment(env=process.env){
 if(!env.DATABASE_URL)return new MemoryEngineStore();
 const [{default:pg},{migrate},{PostgresEngineStore}]=await Promise.all([import('pg'),import('../src/runtime/migrate.mjs'),import('../src/runtime/postgres-store.mjs')]);
 const client=new pg.Client({connectionString:env.MIGRATION_DATABASE_URL||env.DATABASE_URL,connectionTimeoutMillis:15_000});
 await client.connect();
 try{const result=await migrate(client,{log:message=>log('info','migration',{detail:message})});log('info','Database migrations complete',{applied:result.applied.length,total:result.total});}
 finally{await client.end();}
 return new PostgresEngineStore({connectionString:env.DATABASE_URL,max:Number(env.DATABASE_POOL_MAX??5)});
}

export async function main(env=process.env){
 if(env.DATA_MODE!=='synthetic'){log('error','Refusing to start: DATA_MODE must be "synthetic" for this non-production engine');process.exitCode=1;return null;}
 let sessionSecret=env.ENGINE_SESSION_SECRET;
 if(!sessionSecret){sessionSecret=randomBytes(32).toString('hex');log('warn','ENGINE_SESSION_SECRET is not set; using an ephemeral per-process secret (synthetic sessions reset on restart)');}
 const store=await createStoreFromEnvironment(env);
 let chatProvider;
 if(env.ANTHROPIC_API_KEY){const {createAnthropicChatProvider}=await import('../src/chat/anthropic-provider.mjs');chatProvider=createAnthropicChatProvider({apiKey:env.ANTHROPIC_API_KEY,model:env.ENGINE_CHAT_MODEL||undefined});}
 else log('info','ANTHROPIC_API_KEY is not set; banker chat uses the labelled simulated deterministic responder');
 const runtime=await createEngineRuntime({store,sessionSecret,dataMode:env.DATA_MODE,chatProvider});
 const server=createEngineServer({runtime,version});
 const port=Number(env.PORT??3000);
 await new Promise(resolve=>server.listen(port,'0.0.0.0',resolve));
 log('info','Prosperity Banking Engine synthetic API listening',{port,storage:store.kind,chat:runtime.chatResponder.id,dataMode:env.DATA_MODE,version,nonProduction:true});
 const shutdown=signal=>{log('info','Shutting down',{signal});server.close(()=>runtime.close().finally(()=>process.exit(0)));setTimeout(()=>process.exit(0),5_000).unref();};
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 return {server,runtime};
}

if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{log('error','Engine failed to start',{errorMessage:String(error?.message??error).slice(0,300)});process.exit(1);});
