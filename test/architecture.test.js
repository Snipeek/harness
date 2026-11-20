'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {ArchitectureStore}=require('../src/architecture'),{recordUser,taskState,taskTool,continuationState}=require('../src/task-state'),{SkillCatalog}=require('../src/skills');
test('module maps validate freshness, remain isolated per project and reject escaped sources',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'glm-map-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const a=path.join(base,'a'),b=path.join(base,'b');await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(a,'module.js'),'exports.value=1;');await fs.writeFile(path.join(b,'module.js'),'exports.value=2;');const store=new ArchitectureStore(path.join(base,'maps'));
 assert.equal((await store.read(a,'module')).found,false);await store.save(a,{scope:'module',summary:'Owner: module.js. Unknown: runtime cache.',sources:['module.js']});assert.equal((await store.read(a,'module')).stale,false);assert.equal((await store.read(b,'module')).found,false);
 await fs.writeFile(path.join(a,'module.js'),'exports.value=3;');assert.equal((await store.read(a,'module')).stale,true);await fs.rm(path.join(a,'module.js'));assert.equal((await store.read(a,'module')).changedSources[0].reason,'missing or inaccessible');await assert.rejects(store.save(a,{scope:'x',summary:'invalid',sources:['../b/module.js']}),/outside/);
});
test('genuine user constraints and focus survive persistence independently from model plan',()=>{
 const s={taskId:'t',initialGoal:'Build export',plan:{goal:'different model wording',focus:'serialization',next_action:'wire consumer',steps:[{title:'integrate',status:'pending'}]},checks:[{id:'v',taskId:'t',passed:true,command:'node test.js'}]};const u=recordUser(s,'Never reset storage. '+ 'x'.repeat(10000));const restored=JSON.parse(JSON.stringify(s));const state=taskState(restored);assert.equal(state.originalGoal,'Build export');assert.equal(state.nextAction,'wire consumer');assert.equal(state.checks[0].acceptance,'not_independently_evaluated');
 let text='',offset=0;do{const p=taskTool(restored,{update_id:u.id,offset});text+=p.content;offset=p.nextOffset;}while(offset!==null);assert.equal(text,u.content);assert.equal(continuationState(restored).pendingSteps.length,1);assert.throws(()=>taskTool(s,{update_id:'invented'}));
});
test('past genuine instructions remain retrievable after a new task starts',()=>{
 const s={taskId:'first',initialGoal:'first'},old=recordUser(s,'Keep blue labels.');s.taskId='second';s.initialGoal='second';const fresh=recordUser(s,'Add export.');assert.equal(taskState(s).userUpdates.length,1);assert.equal(taskState(s).userUpdates[0].id,fresh.id);assert.equal(taskTool(s,{update_id:old.id}).content,'Keep blue labels.');assert.equal(taskTool(s,{history_offset:0}).updates.length,2);
 s.plan={decision:'Use the current exporter',constraints:['Retain saved data'],acceptance:['Retry returns the existing export','x'.repeat(401)]};
 const checkpoint=continuationState(s);
 assert.deepEqual(checkpoint.recentClarifications.map(update=>update.id),[fresh.id]);
 assert.equal(checkpoint.decision,s.plan.decision);
 assert.deepEqual(checkpoint.constraints,s.plan.constraints);
 assert.deepEqual(checkpoint.acceptance,s.plan.acceptance.slice(0,1));
 assert.equal(checkpoint.planOmitted,true);
 assert.deepEqual(taskTool(s).acceptance,s.plan.acceptance);
});
test('bundled skills load progressively without Claude imports and preserve project overrides',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-skills-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const c=new SkillCatalog(root,{importClaude:false}),list=await c.list();assert.equal(list.length,3);
 for(const s of list){assert.match(s.name,/^ai-[a-z-]+$/);assert(s.description.length>30);const loaded=JSON.parse(await c.load(s.id));assert.equal(loaded.nextOffset,null);assert(loaded.text.length<6000);assert(!/TODO|\[INSERT/.test(loaded.text));}
 await fs.mkdir(path.join(root,'.agents/skills/override'),{recursive:true});await fs.writeFile(path.join(root,'.agents/skills/override/SKILL.md'),'---\nname: ai-module-evolution\ndescription: Project-specific module workflow\n---\nFollow project owner.');c.updated=0;assert.equal((await c.list()).find(s=>s.name==='ai-module-evolution').source,'project .agents');
});
