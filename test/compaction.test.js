'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ContextEngine}=require('../src/engine');
test('compaction failures retain the complete journal and never commit an empty checkpoint',async()=>{
 const state={},messages=[{role:'user',content:'Never modify seed. '+ 'x'.repeat(23000)},{role:'assistant',content:'Pending: implement cancel'},{role:'user',content:'Continue'}],original=JSON.stringify(messages),engine=new ContextEngine(state,async()=>({message:{content:''},usage:{prompt_tokens:5}}));
 await assert.rejects(engine.prepare({messages,tools:[],contextWindow:10000,maxTokens:1024}),/empty/);assert.equal(JSON.stringify(messages),original);assert.equal(state.summary,undefined);assert.equal(state.through,undefined);
});
test('generation and all summary calls carry distinct usage telemetry, calibrated from observed input',async()=>{
 const telemetry=[],state={},messages=[{role:'user',content:'Constraint: keep BLUE. '+ 'x'.repeat(25000)},{role:'assistant',content:'Unverified hypothesis, pending task'},{role:'user',content:'Continue'}],engine=new ContextEngine(state,async options=>({message:{role:'assistant',content:options.tools.length?'done':'CONSTRAINTS: BLUE. UNVERIFIED: hypothesis. PENDING: task.'},usage:{prompt_tokens:100,completion_tokens:20}}));
 await engine.complete({messages,tools:[],contextWindow:10000,maxTokens:1024,onRequestMetrics:r=>telemetry.push(r)});
 assert(telemetry.some(t=>t.phase==='compaction'));assert.equal(telemetry.at(-1).phase,'generation');assert(telemetry.every(t=>t.usageKnown));assert.equal(state.compactions,1);
 const calibrated=new ContextEngine({},async()=>({message:{content:'ok'},usage:{prompt_tokens:2000,completion_tokens:2}}));await calibrated.complete({messages:[{role:'user',content:'short'}],tools:[]});assert(calibrated.state.tokenRatio>1);
});
test('repeated checkpoints preserve exact recent tool groups and keep original user constraints recoverable',async()=>{
 const state={},messages=[{role:'user',content:'Do not reset storage. '+'x'.repeat(24000)},{role:'assistant',content:'Old result'},{role:'user',content:'Pending: implement cancel'}],before=JSON.stringify(messages),engine=new ContextEngine(state,async()=>({message:{content:'CONSTRAINTS: do not reset storage. PENDING: implement cancel. UNVERIFIED: not yet checked.'},usage:{prompt_tokens:10,completion_tokens:15}}));
 await engine.prepare({messages,contextWindow:10000,maxTokens:1024});messages.push({role:'assistant',content:'log '+'y'.repeat(24000)},{role:'user',content:'Then verify'},{role:'assistant',content:'',reasoning_content:'exact',tool_calls:[{id:'c',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'exact tool output'});
 const prepared=await engine.prepare({messages,contextWindow:10000,maxTokens:1024});assert(state.compactions>=2);assert.equal(prepared.at(-1).content,'exact tool output');assert.equal(prepared.at(-2).reasoning_content,'exact');assert(prepared.some(m=>m.content?.includes('do not reset storage')));assert.equal(JSON.stringify(messages.slice(0,3)),before);
});

test('provider measurements lower a conservative estimate without changing another model',async()=>{
 const state={};let summaries=0;
 const engine=new ContextEngine(state,async opts=>{
  if(opts.messages[0]?.content.startsWith('You summarize'))summaries++;
  return {message:{content:'Summary.'},usage:{prompt_tokens:1500,completion_tokens:10}};
 });
 const base={provider:'glm',protocol:'chat',model:'glm-example',contextWindow:10000,maxTokens:1024};
 const history=[{role:'user',content:'x'.repeat(9400)},{role:'assistant',content:'ok'}];
 await engine.complete({...base,messages:history});
 const expanded=[...history,{role:'user',content:'y'.repeat(6200)}];
 await engine.prepare({...base,messages:expanded});
 assert.equal(summaries,0);
 await engine.prepare({...base,model:'other',messages:expanded});
 assert.equal(summaries,1);
});
