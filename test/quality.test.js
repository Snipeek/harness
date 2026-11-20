'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {tasks,chains}=require('../scripts/quality-fixtures'),{gradeCode,gradeTask}=require('../scripts/quality-grader'),{summarize}=require('../scripts/summarize-quality');
test('verifier exercises exported API rather than an unexported helper',()=>{assert.equal(gradeCode('function fixed(){return 1;}module.exports={};',[['fixed()',1]])[0].passed,false);assert.equal(gradeCode('exports.fixed=()=>1;',[['fixed()',1]])[0].passed,true);});
test('multi-file verifier follows real relative exports and JSON dependencies, not helper-only behavior',()=>{
 const {gradeModules}=require('../scripts/quality-grader'),files={'main.js':"const {visible}=require('./model');module.exports={screen:xs=>visible(xs),seed:require('./seed.json')};",'model.js':'exports.visible=xs=>xs.filter(x=>!x.hidden);','seed.json':'[1,2]'};
 assert(gradeModules(files,[['api.screen([{hidden:true,id:1},{id:2}]).map(x=>x.id)',[2]],['api.seed',[1,2]]]).every(c=>c.passed));assert.equal(gradeModules({...files,'main.js':"require('fs');module.exports={};"},[['api.seed',[]]])[0].passed,false);
});
test('quality matrix has 12 tasks, four distinct cumulative chains and protected checks',()=>{
 assert.equal(tasks.length,12);assert.equal(chains.length,4);assert.equal(new Set([...tasks,...chains].map(t=>t.id)).size,16);
 for(const t of tasks.filter(t=>t.kind==='code'))assert(gradeCode(t.files['main.js'],t.checks).some(c=>!c.passed),t.id+' must expose a real failure');
 for(const c of chains){assert.equal(c.stages.length,3);assert(gradeCode(c.files['main.js'],c.stages[0].checks).some(c=>!c.passed));}
 for(const task of [...tasks,...chains])for(const [expression]of task.checks||task.stages?.flatMap(s=>s.checks)||[])assert.doesNotThrow(()=>new (require('node:vm').Script)(expression),task.id+' has an invalid evaluator expression');
});
test('independent grader catches changed protected data even when behavior passes',()=>{
 const task=tasks.find(t=>t.id==='data-zero-configuration'),source=task.files['main.js'].replaceAll('input.retries||','input.retries??').replaceAll('input.delay||','input.delay??');
 const good=gradeTask(task,source,{timeline:[]},task.files);assert.equal(good.passed,true);
 const tampered=gradeTask(task,source,{timeline:[]},{...task.files,'test.js':'process.exit(0)'});assert.equal(tampered.passed,false);
});
test('quality summary counts complete chains as runs and retains unsuccessful time in latency',()=>{
 const mk=(stage,passed,totalRunMs)=>({runId:'chain-0-a',task:'chain',variant:'a',stage,trial:0,totalRunMs,observedTokens:10,cumulativeUsage:{input:10*stage,output:0},metrics:[{phase:'generation',usageKnown:true}],grade:{passed}});
 const s=summarize({fixtureHash:'h',variants:[{name:'a'}],tasks:[{id:'chain',stages:3}],rows:[mk(1,true,10),mk(2,false,20),mk(3,true,30)]});
 assert.equal(s.variants.a.completeRuns,1);assert.equal(s.variants.a.acceptedAutomatic,0);assert.equal(s.variants.a.medianFullRunMs,30);
});
test('evaluation preparation sends no requests and refuses to overwrite an existing report',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-protocol-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const out=path.join(root,'run'),script=path.resolve('scripts/eval-quality.js');
 const result=JSON.parse(execFileSync(process.execPath,[script,'--output='+out],{encoding:'utf8'}));assert.equal(result.requestsSent,0);const before=await fs.readFile(path.join(out,'report.json'),'utf8');assert.throws(()=>execFileSync(process.execPath,[script,'--output='+out],{stdio:'pipe'}));assert.equal(await fs.readFile(path.join(out,'report.json'),'utf8'),before);
});

test('module visibility reference preserves the labels contract and filters summary once',()=>{
 const {tasks,reference}=require('../scripts/architecture-fixtures');
 const {gradeModules}=require('../scripts/quality-grader');
 const checks=tasks[0].stages.flatMap(stage=>stage.checks);
 assert(gradeModules(reference,checks).every(check=>check.passed));
 const broken={
  ...reference,
  'view.js': 'function labels(rows){return rows.filter(row=>row.hidden!==true).map(row=>row.label);}module.exports={labels};'
 };
 const failures=gradeModules(broken,checks).filter(check=>!check.passed);
 assert(failures.some(check=>check.expression.includes("fixtureModule('view.js').labels(")));
 assert(failures.some(check=>check.expression.includes('calls<=1')));
});
