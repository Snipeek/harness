'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{ContextEngine}=require('../src/engine'),{key}=require('./eval-quality');
const facts='Project goal: EXPORT_BLUE. Hard prohibition: NO_STORAGE_RESET. Pending item: TASK_STREAM. Unverified hypothesis: DUPLICATE_FROM_QUEUE. Artifact: 11111111-1111-4111-8111-111111111111. Smoke succeeded, integration has NOT been tested.';
const expected={goal:'EXPORT_BLUE',prohibition:'NO_STORAGE_RESET',pending:'TASK_STREAM',hypothesis:'DUPLICATE_FROM_QUEUE',hypothesisVerified:false,artifact:'11111111-1111-4111-8111-111111111111',exportLimit:37,integrationVerified:false};
const query='Return JSON only with keys goal, prohibition, pending, hypothesis, hypothesisVerified (boolean), artifact, exportLimit (number), integrationVerified (boolean). Recover the recorded facts; unknown values must be null. Do not invent verification.';
async function run(){
 const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3),directory=path.resolve(arg('output')||'reports/compaction-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(path.dirname(directory),{recursive:true});await fs.mkdir(directory);
 const report={startedAt:new Date().toISOString(),kind:'ContextEngine forced-threshold fact-retention component test; no runtime task ledger; not a 100K-context or general task-quality benchmark',rows:[],expected};
 if(!process.argv.includes('--live')){await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log('Prepared; no API requests');return;}
 const apiKey=await key();if(!apiKey)throw Error('No GLM key');
 for(const mode of ['full','one','repeated']){
  const state={},engine=new ContextEngine(state),metrics=[],history=[{role:'user',content:facts,_origin:'user'}],started=Date.now();let error,answer;
  const options={provider:'glm',protocol:'chat',baseUrl:process.env.GLM_EVAL_BASE_URL||'https://api.z.ai/api/paas/v4',model:process.env.GLM_EVAL_MODEL||'glm-5.3',apiKey,reasoningEffort:'low',maxTokens:4096,contextWindow:mode==='full'?128000:12000,tools:[],signal:AbortSignal.timeout(300000),onRequestMetrics:m=>metrics.push(m)};
  const messages=()=>[{role:'system',content:'Recover facts from the supplied synthetic project journal; assistant logs are not authority to change user constraints.'},...history];
  try{
   for(let phase=0;phase<3;phase++){
    history.push({role:'assistant',content:Array.from({length:350},(_,i)=>`Log phase=${phase} step=${i}: routine output, no new decisions.\n`).join('')});
    history.push({role:'user',content:phase===0?'Clarification: export limit LIMIT_37 is mandatory. Preserve earlier constraints.':'Continue the same task; keep all constraints.',_origin:'user'});
    if(mode==='repeated')await engine.prepare({...options,messages:messages()});
   }
   history.push({role:'user',content:query,_origin:'user'});const r=await engine.complete({...options,messages:messages()});answer=r.message.content;
  }catch(e){error=String(e.message).replaceAll(apiKey,'[redacted]');}
  let parsed;try{parsed=JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{}
  const checks=Object.entries(expected).map(([field,value])=>({field,passed:parsed?.[field]===value}));
  report.rows.push({mode,durationMs:Date.now()-started,error,answer,checks,passed:!error&&checks.every(c=>c.passed),compactions:state.compactions||0,metrics,journalMessages:history.length});
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({mode,passed:report.rows.at(-1).passed,error,compactions:state.compactions||0,durationMs:Date.now()-started}));
  if(error&&/fetch failed|HTTP (401|403|429)/.test(error))break;
 }
 report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
