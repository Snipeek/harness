'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const repo=process.cwd();
const versions=['0.15.48','0.15.50','0.15.51'];
const suites={
 runtime:['services','agents','verification','regression-check'],
 context:['engine','compaction','tool-evidence','tools'],
 interface:['model-popup','transcript','editor-workflow','model-connections','activity']
};
const rounds={runtime:24,context:20,interface:36};
async function main(){
 const [version, suite, trial]=process.argv.slice(2);
 if(!versions.includes(version)||!suites[suite])throw Error('Unknown variant');
 const work=await fs.mkdtemp('/private/tmp/harness-real-ab-');
 const vsix=path.join(repo,'glm-token-usage-'+version+'.vsix');
 const packageSha256=createHash('sha256').update(await fs.readFile(vsix)).digest('hex');
 execFileSync('/usr/bin/unzip',['-q',vsix,'-d',work]);
 process.env.HARNESS_EVAL_EXTENSION=path.join(work,'extension/extension.js');
 const {createHost}=require(path.join(repo,'scripts/runtime-host'));
 const {key}=require(path.join(repo,'scripts/eval-quality'));
 const apiKey=await key();if(!apiKey)throw Error('No GLM credential');
 const root=path.join(work,'fixture');await fs.mkdir(root);
 const files=suites[suite].map(name=>path.join(repo,'test',name+'.test.js'));
 const cmd='./run-suite', check='/bin/test -x run-suite';
 // Keep only passing test names and counters; no paths, stack traces, env or source.
 const source=`const {spawnSync}=require('node:child_process');
 const files=${JSON.stringify(files)};
 const env={...process.env}; delete env.HARNESS_EVAL_EXTENSION; delete env.ZAI_API_KEY;
 const rounds=Number(process.argv[2]||${rounds[suite]});
 for(let i=0;i<rounds;i++){
   const r=spawnSync(process.execPath,['--test','--test-reporter=spec',...files],{cwd:${JSON.stringify(repo)},encoding:'utf8',env,timeout:25000});
   const clean=(r.stdout||'').split(/\\r?\\n/).filter(l=>/^✔ |^ℹ (?:tests|pass|fail) /.test(l)).map(l=>l.replace(/ \\(\\d+(?:\\.\\d+)?ms\\)$/,''));
   if(r.status!==0 || !clean.includes('ℹ fail 0')){console.error('Harness regression suite failed at round '+(i+1));process.exit(1);}
   if(rounds===1 || i===0)console.log(clean.join('\\n'));
   console.log('Round '+(i+1)+'/'+rounds+': '+clean.find(l=>l.startsWith('ℹ tests ')));
 }
 console.log('PASS ${suite.toUpperCase()} '+rounds+' rounds');`;
 const runner=path.join(root,'run-suite');
 await fs.writeFile(runner,'#!'+process.execPath+'\n'+source,{mode:0o700});
 const seed=execFileSync(runner,['1'],{cwd:root,encoding:'utf8',timeout:30000});
 const h=await createHost({root,storage:path.join(work,'storage'),apiKey,settings:{
  glmBaseUrl:'https://api.z.ai/api/coding/paas/v4',maxToolRounds:8,maxOutputTokens:4096,turnTimeoutSeconds:180
 },approveCommand:async c=>[cmd,check].includes(c)});
 if(suite!=='interface'){
  h.session.messages=[{role:'user',content:'The following historical Harness test outputs are read-only continuity data from completed checks. Do not replay those tool calls.'}];
  for(let i=0;i<8;i++){
   const id='historical_suite_'+i;
   h.session.messages.push({role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'run_command',arguments:JSON.stringify({command:cmd})}}]},
    {role:'tool',tool_call_id:id,content:'Exit code: 0\nHistorical regression run '+(i+1)+'\n'+seed});
  }
  h.session.messages.push({role:'assistant',content:'All historical checks completed. Next run needs fresh evidence.'});
 }
 const started=Date.now();
 try{
  await h.send(`Run the fresh local Harness ${suite} regression test suite. First call run_command with literal command ${check}, WITHOUT preflight. After success call run_command with literal command ${cmd}, timeout_seconds 120, and preflight with outcome "Read the exact PASS line", alternative "Historical or short checks do not verify all fresh rounds", and checks containing the successful prerequisite tool call ID. Use the evidence ID shown in the result if present. Do not quote the command, add flags, read the runner source, or run other tools. Report the exact final PASS line only after observing it. No edits.`);
  const metrics=h.session.metrics||[], timeline=h.session.timeline, usage=h.session.usage;
  const marker='PASS '+suite.toUpperCase()+' '+rounds[suite]+' rounds';
  const task=timeline.find(e=>e.name==='run_command'&&e.result?.includes(marker));
  const answer=timeline.filter(e=>e.role==='assistant'&&e.text).at(-1)?.text;
  const providerDuring=task?metrics.filter(m=>['generation','compaction'].includes(m.phase)&&m.at>=task.startedAt&&m.at<task.finishedAt):[];
  const out={version,packageSha256,suite,trial,seededHistory:suite!=='interface',rounds:rounds[suite],passed:Boolean(task&&answer?.includes(marker)),
   durationMs:Date.now()-started,commandMs:task?task.finishedAt-task.startedAt:null,background:task?.background===true,
   polls:timeline.filter(e=>['read_process','wait_process','task_status','wait_task'].includes(e.name)).length,
   providerCallsDuringCommand:task?providerDuring.length:null,modelRequests:metrics.filter(m=>m.phase==='generation').length,
   compactions:metrics.filter(m=>m.phase==='compaction').length,usage,uncached:usage.input-(usage.cached||0),
   requests:metrics.filter(m=>['generation','compaction'].includes(m.phase)).map(m=>({phase:m.phase,durationMs:m.durationMs,
    input:m.usage?.prompt_tokens??m.usage?.input_tokens??null,cacheRead:m.cacheRead??m.usage?.prompt_tokens_details?.cached_tokens??null,
    cacheWrite:m.cacheWrite??null,compactionCount:m.compactionCount??null})),
   tools:timeline.filter(e=>e.role==='tool').map(e=>({name:e.name,status:e.status,background:!!e.background})),
   marker:task?marker:null};
  await fs.writeFile(path.join(repo,'reports','harness-live-ab-'+suite+'-'+version+(trial?'-'+trial:'')+'.json'),JSON.stringify(out,null,2)+'\n');
  console.log(JSON.stringify(out)); if(!out.passed)process.exitCode=2;
 }finally{await h.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
