'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {workspacePath,textFile}=require('./tools');
const hash=text=>createHash('sha256').update(text).digest('hex');
class ArchitectureStore{
 constructor(directory){this.directory=directory;}
 location(root,scope){if(typeof scope!=='string'||!scope.trim()||scope.length>200)throw Error('Choose a concise module scope');return path.join(this.directory,hash(path.resolve(root)),hash(scope)+'.json');}
 async sources(root,paths){if(!Array.isArray(paths)||!paths.length||paths.length>24||paths.some(p=>typeof p!=='string'))throw Error('Provide 1–24 workspace source paths');const realRoot=await fs.realpath(root);return Promise.all([...new Set(paths)].map(async name=>{const file=await workspacePath(root,name);return {path:path.relative(realRoot,file),sha256:hash(await textFile(file))};}));}
 async save(root,args){
  if(typeof args.summary!=='string'||!args.summary.trim()||args.summary.length>6000)throw Error('Provide a bounded architecture summary');
  const file=this.location(root,args.scope),sources=await this.sources(root,args.sources);
  const record={scope:args.scope,summary:args.summary,sources,updatedAt:Date.now(),authorship:'Model-authored working map. File hashes establish freshness, not semantic correctness.'};
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(record),{mode:0o600});await fs.rename(tmp,file);return {...record,stale:false};
 }
 async read(root,scope){
  let record;try{record=JSON.parse(await fs.readFile(this.location(root,scope),'utf8'));}catch(e){if(e.code==='ENOENT')return {scope,found:false};throw e;}
  const changes=await Promise.all(record.sources.map(async old=>{try{const [current]=await this.sources(root,[old.path]);return current.sha256===old.sha256?null:{path:old.path,reason:'changed'};}catch{return {path:old.path,reason:'missing or inaccessible'};}}));
  return {...record,found:true,stale:changes.some(Boolean),changedSources:changes.filter(Boolean),notice:'Only listed sources were checked. New files, external dependencies and runtime configuration may also invalidate this map; revalidate relevant boundaries.'};
 }
 async execute(root,args){if(args.action==='save')return this.save(root,args);if(args.action==='read'||!args.action)return this.read(root,args.scope);throw Error('Unsupported architecture_map action');}
}
module.exports={ArchitectureStore};
