import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const MIGRATIONS_DIRECTORY=fileURLToPath(new URL('../../migrations/',import.meta.url));
const LOCK_ID=4_217_920_331;

export function loadMigrations(directory=MIGRATIONS_DIRECTORY){
 return readdirSync(directory).filter(name=>/^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort().map(name=>{
  const sql=readFileSync(`${directory}/${name}`,'utf8');
  return Object.freeze({version:name.slice(0,3),name,sql,checksum:createHash('sha256').update(sql).digest('hex')});
 });
}

/**
 * Apply pending SQL migrations once, in order, under a session advisory lock. Applied migrations are
 * checksum-pinned: editing an applied file fails closed instead of silently diverging.
 */
export async function migrate(client,{migrations=loadMigrations(),log=()=>{}}={}){
 await client.query('SELECT pg_advisory_lock($1)',[LOCK_ID]);
 try{
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const {rows}=await client.query('SELECT version,name,checksum FROM schema_migrations');
  const applied=new Map(rows.map(row=>[row.version,row]));
  const ran=[];
  for(const migration of migrations){
   const existing=applied.get(migration.version);
   if(existing){if(existing.checksum!==migration.checksum)throw new Error(`Applied migration ${migration.name} has been modified`);continue;}
   await client.query('BEGIN');
   try{await client.query(migration.sql);await client.query('INSERT INTO schema_migrations (version,name,checksum) VALUES ($1,$2,$3)',[migration.version,migration.name,migration.checksum]);await client.query('COMMIT');}
   catch(error){await client.query('ROLLBACK');throw error;}
   ran.push(migration.name);log(`applied ${migration.name}`);
  }
  return {applied:ran,total:migrations.length};
 }finally{await client.query('SELECT pg_advisory_unlock($1)',[LOCK_ID]);}
}
