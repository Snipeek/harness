'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {tasks,chains}=require('./quality-fixtures'),{createHost}=require('./runtime-host'),{gradeTask,hash}=require('./quality-grader');
async function key(){if(process.env.ZAI_API_KEY)return process.env.ZAI_API_KEY;try{const e=JSON.parse(await fs.readFile(path.join(os.homedir(),'.claude/settings.json'),'utf8')).env||{};if(/^https:\/\/(api\.z\.ai|open\.bigmodel\.cn)(\/|$)/.test(e.ANTHROPIC_BASE_URL||''))return e.ANTHROPIC_AUTH_TOKEN||e.ANTHROPIC_API_KEY;}catch{}return '';}
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.split('=').slice(1).join('=');
async function run(){
 const requested=arg('tasks')?.split(','),suite=(arg('suite')==='architecture'?require('./architecture-fixtures').tasks:arg('suite')==='efficiency'?require('./efficiency-fixtures').tasks:arg('suite')==='scheduler'?require('./scheduler-fixture').tasks:arg('suite')==='slide-language'?require('./slide-language-fixture').tasks:[...tasks,...chains]).filter(t=>!requested||requested.includes(t.id));
 if(!suite.length)throw Error('No selected tasks');
 const trials=Math.max(1,Math.min(10,Number(arg('trials')||1))),stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const directory=path.resolve(arg('output')||path.join('reports','quality-'+stamp));await fs.mkdir(path.dirname(directory),{recursive:true});await fs.mkdir(directory);
 const effort=arg('effort')||'low',experiment=arg('experiment')||'prompt';
 if(!['low','high','max'].includes(effort)||!['prompt','tools','effort','skills','architecture-review','parallel-review','models','focused-local-edits'].includes(experiment))throw Error('Unsupported effort/experiment');
 const localEditExperiment=experiment==='focused-local-edits';
 const parallelReview=experiment==='parallel-review';
 const reviewExperiment=parallelReview||experiment==='architecture-review';
 const modelExperiment=experiment==='models';
 if(modelExperiment && effort==='max')throw Error('Use low or high effort for the paired model experiment.');
 const chatgptModel=process.env.HARNESS_CHATGPT_MODEL||'gpt-6.1-sol';
 const allVariants=modelExperiment
  ?[{name:'glm',provider:'glm',model:process.env.GLM_EVAL_MODEL||'glm-5.3'},{name:'chatgpt',provider:'chatgpt',model:chatgptModel}]
  :reviewExperiment
  ?[{name:'without-review',workProfile:'architecture',architectureReview:false},{name:parallelReview?'with-parallel-review':'with-review',workProfile:'architecture',architectureReview:true}]
  :localEditExperiment?[{name:'before',focusedLocalEdits:false},{name:'after',focusedLocalEdits:true}]:experiment==='skills'?[{name:'without-bundled',bundledSkills:false},{name:'with-bundled',bundledSkills:true}]:experiment==='prompt'?[{name:'detailed',promptStyle:'detailed'},{name:'compact',promptStyle:'compact'}]:experiment==='tools'?[{name:'standard',toolProfile:'standard'},{name:'lean',toolProfile:'lean'}]:[{name:'low',reasoningEffort:'low'},{name:'max',reasoningEffort:'max'}];
 const variants=allVariants.filter(v=>!arg('variant')||v.name===arg('variant'));if(!variants.length)throw Error('Unknown variant');
 const snapshotFiles=['extension.js','package.json',...(await fs.readdir('src')).filter(f=>f.endsWith('.js')).map(f=>'src/'+f),...(await fs.readdir('scripts')).filter(f=>f.endsWith('.js')).map(f=>'scripts/'+f),...(await fs.readdir('skills')).map(f=>'skills/'+f+'/SKILL.md')];
 const snapshot=await Promise.all(snapshotFiles.map(async file=>({path:file,content:await fs.readFile(file,'utf8')})));
 for(const item of snapshot){const target=path.join(directory,'runtime-snapshot',item.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,item.content);}
 const report={schemaVersion:1,sourceSnapshotHash:hash(snapshot),startedAt:new Date().toISOString(),kind:'Production AIWorkspace loop; headless editor adapter; synthetic tasks; public commands constrained',experiment,effort,effortPolicy:arg('policy')||'fixed',promptStyle:arg('prompt')||'detailed',maxOutputTokens:Number(arg('max-output')||8192),trials,fixtureHash:hash(suite),runtimeHash:hash(await Promise.all(['extension.js','src/providers.js','src/engine.js','src/tools.js','src/prompt.js','src/agents.js','src/services.js','scripts/quality-grader.js','scripts/quality-fixtures.js','scripts/runtime-host.js','scripts/architecture-fixtures.js','src/architecture.js','src/task-state.js','src/skills.js'].map(p=>fs.readFile(p,'utf8')))),environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,cpus:os.availableParallelism(),memoryBytes:os.totalmem()},endpoint:process.env.GLM_EVAL_BASE_URL||'https://api.z.ai/api/paas/v4',configuredModel:process.env.GLM_EVAL_MODEL||'glm-5.3',cacheControl:'implicit; cold cache not guaranteed',variants,tasks:suite.map(t=>({id:t.id,kind:t.kind,stages:t.stages?.length||1,fixtureHash:hash(t)})),rows:[],live:process.argv.includes('--live'),budgetTokens:Number(arg('budget')||500000),manualReview:'Evidence/web responses require blinded human rubric; automatic checks alone do not establish full quality.'};
 const save=()=>fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));await save();
 if(!report.live){console.log(JSON.stringify({prepared:directory,tasks:report.tasks.length,trials,variants,requestsSent:0}));return;}
 const apiKey=await key();
 const chatgptToken=modelExperiment ? process.env.HARNESS_CHATGPT_ACCESS_TOKEN : undefined;
 delete process.env.HARNESS_CHATGPT_ACCESS_TOKEN;
 if(!apiKey || (modelExperiment && !chatgptToken)){
  report.stopped=!apiKey ? 'No GLM credential available' : 'No ChatGPT evaluation credential available';
  await save();
  throw Error(report.stopped+'; no requests sent.');
 }
 let spent=0,stop=false;
 for(let trial=0;trial<trials&&!stop;trial++)for(let ti=0;ti<suite.length&&!stop;ti++)for(const variant of ((trial+ti)%2?[...variants].reverse():variants)){
  if(spent>=report.budgetTokens){report.stopped='Global observed token budget reached';stop=true;break;}
  const task=suite[ti],runId=`${task.id}-${trial}-${variant.name}`,out=path.join(directory,runId),root=path.join(out,'workspace');await fs.mkdir(root,{recursive:true});
  for(const [name,text]of Object.entries(task.files||{}))await fs.writeFile(path.join(root,name),text);
  if(reviewExperiment){
   await fs.mkdir(path.join(root,'.harness'));
   const roles=Object.fromEntries(['explore','plan','review','general'].map(name=>[name,{model:report.configuredModel}]));
   await fs.writeFile(path.join(root,'.harness','config.json'),JSON.stringify({
    roles,...(parallelReview?{hooks:[{event:'beforeFinish',command:'node test.js',required:true,parallel_review:true}]}:{})
   }));
  }
  const publicPath=path.join(out,'public-checks.json');let publicChecks=[];await fs.writeFile(publicPath,'[]');
  const allowedFiles=task.allowedFiles||(task.kind==='code'||task.kind==='chain'?['main.js']:[]);
  const publicExecution={allow:true,execution:{file:process.execPath,args:[path.join(directory,'runtime-snapshot/scripts/quality-public-check.js'),root,publicPath]}};
  const h=await createHost({root,storage:path.join(out,'storage'),apiKey,settings:{glmBaseUrl:report.endpoint,glmModel:report.configuredModel,reasoningEffort:effort,effortPolicy:arg('policy')||'fixed',promptStyle:arg('prompt')||'detailed',toolProfile:'standard',maxOutputTokens:Number(arg('max-output')||8192),turnTimeoutSeconds:180,turnTokenBudget:100000,subagentTokenBudget:50000,...(modelExperiment?{}:variant)},approveCommand:async cmd=>{
   if(cmd==='node test.js')return publicExecution;
   const name=cmd.match(/^node --check ([\w.-]+\.js)$/)?.[1];if(name&&allowedFiles.includes(name))return {allow:true,execution:{file:process.execPath,args:['--check',path.join(root,name)]}};
   throw Error('Evaluator command restriction, not user rejection: run node test.js or node --check FILE.js separately. Shell compounds and inline execution are unavailable in this evaluation.');
  },allowedFiles});
  if(modelExperiment && variant.provider==='chatgpt'){
   h.app.sessionSettings=async()=>({
    provider:'chatgpt',protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:chatgptToken,
    accountId:'evaluation',model:variant.model,reasoningEffort:effort
   });
  }
  if(parallelReview)h.app.approve=async(_session,details)=>
   details.kind==='hook'&&details.detail==='node test.js'?publicExecution:false;
  if(task.readOnly)h.session.mode='plan';
  if(task.sources){h.app.web.search=async()=>JSON.stringify({sources:task.sources.map(s=>({url:s.url,excerpt:s.text.slice(0,120)}))});h.app.web.read=async({url})=>JSON.stringify(task.sources.find(s=>s.url===url)||{error:'Unknown corpus URL'});}
  if(task.mcp){const scope=await h.app.integrationsFor(root);scope.mcp.configs=[{name:'evaluator',command:process.execPath,args:[path.join(__dirname,'../test/fixtures/quality-mcp.cjs')]}];h.app.approve=async(_s,details)=>details.kind==='mcp';}
  let checks=[],start=Date.now();
  try{for(const [stageIndex,stage]of (task.stages||[task]).entries()){
   checks.push(...(stage.checks||[]));publicChecks.push(...(stage.publicChecks||(stage.checks||[]).slice(0,1)));await fs.writeFile(publicPath,JSON.stringify(task.kind==='module'?{kind:'module',checks:publicChecks}:publicChecks));const before=h.session.usage.input+h.session.usage.output;
   const metricsStart=h.session.metrics?.length||0;
   const timer=setTimeout(()=>h.app.runs.get(h.session.id)?.abort(new Error('Evaluation wall-clock limit')),180000);
   const at=Date.now();try{await h.send(task.readOnly?stage.prompt:localEditExperiment?'Fix the following. '+stage.prompt.replace('Run node test.js for the public smoke check. Only main.js may change.', 'Verify with node test.js exactly. Only main.js may change.'):parallelReview?stage.prompt.replace('Run node test.js.','The evaluator runs node test.js automatically at the end of the turn. Do not run it manually unless diagnosing a failure.'):stage.prompt+'\nEvaluation environment: run node test.js and node --check FILE.js separately. Other commands, shell compounds, inline execution and changes to protected tests/data are unavailable. Report any verification limitation accurately.');}finally{clearTimeout(timer);}
   const source=await fs.readFile(path.join(root,'main.js'),'utf8').catch(()=>''),files={};for(const f of new Set([...Object.keys(task.files||{}),...allowedFiles]))files[f]=await fs.readFile(path.join(root,f),'utf8').catch(()=>null);
   const grade=gradeTask(task,source,h.session,files,checks),observed=h.session.usage.input+h.session.usage.output-before;spent+=observed;
   const firstEdit=h.session.changeLog?.find(change=>change.at>=at);
   const row={firstEditMs:firstEdit?firstEdit.at-at:null,runId,task:task.id,kind:task.kind,trial,variant:variant.name,stage:stageIndex+1,durationMs:Date.now()-at,totalRunMs:Date.now()-start,observedTokens:observed,cumulativeUsage:{...h.session.usage},...(modelExperiment?{provider:variant.provider,configuredModel:variant.model}:{}),metrics:[...h.session.metrics.slice(metricsStart)],grade,sourceHash:hash(source),
    ...(reviewExperiment?{completion:h.session.completion,
     reviews:h.session.timeline.filter(e=>e.name==='architecture_review'&&e.startedAt>=at).map(({status,result,startedAt,finishedAt})=>({status,result,startedAt,finishedAt})),
     checks:h.session.timeline.filter(e=>e.name==='project_hook'&&e.startedAt>=at).map(({status,result,startedAt,finishedAt})=>({status,result,startedAt,finishedAt}))}:{})};report.rows.push(row);await save();console.log(JSON.stringify({runId,stage:row.stage,passed:grade.passed,manualReviewRequired:grade.manualReviewRequired,durationMs:row.durationMs,firstEditMs:row.firstEditMs,observedTokens:observed}));
   if(grade.notices.some(n=>/HTTP (401|403|429)|fetch failed|ENOTFOUND|ECONNREFUSED/.test(n))){report.stopped='Auth/quota/transport failure retained; stopping further spend';stop=true;break;}
   if(spent>=report.budgetTokens){report.stopped='Global observed token budget reached';stop=true;break;}
  }}finally{await h.close();}
 }
 if(modelExperiment){
  const comparable=Map.groupBy(report.rows,row=>JSON.stringify([row.task,row.trial]));
  const paired=[...comparable.values()].filter(rows=>variants.length===2
   && variants.every(variant=>rows.filter(row=>row.variant===variant.name).length===(suite.find(task=>task.id===rows[0].task).stages?.length||1)));
  const pairedRunIds=new Set(paired.flatMap(rows=>rows.map(row=>row.runId)));
  report.pairedTasks=paired.length;
  report.comparison=Object.fromEntries(variants.map(variant=>{
   const groups=Map.groupBy(report.rows.filter(row=>row.variant===variant.name),row=>row.runId);
   const runs=[...groups.values()].filter(rows=>pairedRunIds.has(rows[0].runId));
   const accepted=runs.filter(rows=>rows.every(row=>row.grade.passed && !row.grade.manualReviewRequired)).length;
   const usage=runs.reduce((total,rows)=>{
    const {input=0,output=0,cached=0}=rows.at(-1).cumulativeUsage;
    return {total:total.total+input+output,uncached:total.uncached+input+output-cached};
   },{total:0,uncached:0});
   return [variant.name,{attempted:groups.size,paired:runs.length,accepted,observedTokens:usage.total,
    uncachedTokens:usage.uncached,observedTokensPerAccepted:accepted?usage.total/accepted:null,
    uncachedTokensPerAccepted:accepted?usage.uncached/accepted:null}];
  }));
 }
 report.finishedAt=new Date().toISOString();report.observedTokens=spent;await save();console.log('Report: '+path.join(directory,'report.json'));
}
if(require.main===module)run().catch(e=>{console.error(String(e.message).slice(0,400));process.exitCode=1;});
module.exports={run,key};
