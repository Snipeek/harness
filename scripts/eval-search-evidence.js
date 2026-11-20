const fs=require('fs/promises'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const repo=process.cwd();
async function run(version,work) {
 let source=repo;
 if(version!=='worktree'){
 const ext=path.join(work,version);
 await fs.mkdir(ext);
 execFileSync('unzip',['-q',path.join(repo,'glm-token-usage-'+version+'.vsix'),'extension/src/*','-d',ext]);
 await fs.symlink(path.join(repo,'node_modules'),path.join(ext,'extension/node_modules'));
 source=path.join(ext,'extension');
 }
 const {ContextEngine}=require(path.join(source,'src/engine.js'));
 const {executeTool}=require(path.join(source,'src/tools.js'));
 const root=await fs.realpath(work);
 const file=path.join(root,'client.ts');
 let traversals=0,reusedSearches=0,compactions=0,modelSteps=0,estimatedInput=0,summaryInput=0;
 const host={root,mode:'plan',findFiles:async()=>{traversals++;await new Promise(r=>setTimeout(r,15));return [file];}};
 host.searchFiles=async({query},dir,files)=>{
   if(!files)files=await host.findFiles('**/*',dir);
   if(!files.includes(file))throw Error('Missing fixture source');
   return JSON.stringify({matches:['client.ts:1: '+query],nextOffset:null});
 };
 if(version==='worktree')host.searchEvidence=new (require(path.join(repo,'src/tool-evidence')).SearchEvidence)();
 const state={};
 const engine=new ContextEngine(state,async options=>{
  const summary=options.messages[0]?.content.startsWith('You summarize');
  const estimate=Math.ceil(Buffer.byteLength(JSON.stringify(options.messages))*0.175);
  estimatedInput+=estimate;
  if(summary){compactions++;summaryInput+=estimate;}else modelSteps++;
  return {message:{content:summary?'Observed: absolute URL and AbortSignal are separate contracts. Preserve both.':'Checked.'},usage:{prompt_tokens:estimate,completion_tokens:10}};
 });
 const archiveToolOutput=version==='worktree'?async (text,id)=>{await fs.writeFile(path.join(work,id+'.log'),text);return id;}:undefined;
 const settings={archiveToolOutput,provider:'glm',protocol:'chat',model:'glm-5.3',baseUrl:'https://api.z.ai/api/coding/paas/v4',contextWindow:20000,maxTokens:2048};
 const messages=[{role:'system',content:'Check the request client.'},{role:'user',content:'Check absolute URL and AbortSignal contracts.'}];
 const start=performance.now();
 await engine.complete({...settings,messages});
 for(let i=0;i<10;i++){
  const result=JSON.parse(await executeTool('search_batch',{queries:['apiClient','STAFF_USER_SUGGEST_URL','AbortSignal'].map(query=>({query}))},host));
  if(result.reusedSearch){reusedSearches++;delete result.reusedSearch;}
  if(result.results.some(r=>r.error))throw Error('Search failed');
  const ids='search'+i;
  messages.push({role:'assistant',content:'',tool_calls:[{id:ids,function:{name:'search_batch',arguments:'{}'}}]},
  {role:'tool',tool_call_id:ids,content:JSON.stringify(result)+'\n'+('synthetic verbose diagnostic output ').repeat(185)});
  await engine.complete({...settings,messages});
 }
 return {version,compactions,searchBatches:10,scopeTraversals:traversals,repeatTraversals:traversals-(version==='0.15.47'?3:1),reusedSearches,modelSteps,allModelRequests:modelSteps+compactions,simulatedInputTokens:estimatedInput,simulatedSummaryInputTokens:summaryInput,localMs:Math.round(performance.now()-start)};
}
(async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-award-paired-'));try{
 await fs.writeFile(path.join(dir,'client.ts'),'export const apiClient = { get: (url, signal) => fetch(url, { signal }) };\n');
 for(const version of ['0.15.47','0.15.48','worktree'])console.log(JSON.stringify(await run(version,dir)));
}finally{await fs.rm(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
