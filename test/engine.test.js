'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {schedule,ContextEngine,estimateTokens,usageOf,reuseReadEvidence}=require('../src/engine');
const {glmParameters,complete}=require('../src/providers');
const {setTimeout:delay}=require('node:timers/promises');
test('batch reads reuse only matching full evidence still visible to the model',()=>{
 const range={path:'main.js',revision:'v1',startLine:1,endLine:20,content:'a line of source\n'.repeat(20)};
 const changed={...range,revision:'v2'};
 const error={path:'missing.js',error:'Not found'};
 const messages=[{role:'tool',tool_call_id:'original',content:JSON.stringify({files:[range]})}];
 const payload=JSON.stringify({files:[range,changed,error]});
 const result=JSON.parse(reuseReadEvidence('read_files',payload,messages));
 const {content,...metadata}=range;
 assert.deepEqual(result.files,[{...metadata,unchanged:true,previousToolCallId:'original'},changed,error]);
 assert.equal(reuseReadEvidence('read_files',payload,[]),payload);
 const afterCompaction=JSON.parse(reuseReadEvidence('read_files',payload,[{role:'tool',tool_call_id:'reference',content:JSON.stringify(result)}]));
 assert.deepEqual(afterCompaction.files[0],range);
 assert.equal(afterCompaction.files[1].previousToolCallId,'reference');
 const single=[{role:'tool',tool_call_id:'source',content:JSON.stringify({...range,preflightEvidenceId:'source'})}];
 assert.equal(JSON.parse(reuseReadEvidence('read_file',JSON.stringify(range),single)).previousToolCallId,'source');
});
test('compaction restores a referenced range when its original result leaves the context',async()=>{
 const metadata={path:'main.js',revision:'v1',startLine:1};
 const original=JSON.stringify({files:[{...metadata,content:'const value = 1;'}]});
 const reference=JSON.stringify({files:[{...metadata,unchanged:true,previousToolCallId:'original'}]});
 const tool=(id,content)=>({role:'tool',tool_call_id:id,content});
 const engine=new ContextEngine({through:1,summary:'Earlier evidence'});
 const prepared=await engine.prepare({messages:[tool('original',original),tool('later',reference)],maxTokens:1024});
 assert.equal(prepared.at(-1).content,original);
 assert.equal(engine.visibleMessages.at(-1).content,reference);
 const single=await engine.prepare({messages:[
  tool('original',JSON.stringify({...metadata,content:'const value = 1;',preflightEvidenceId:'original'})),
  tool('later',JSON.stringify({...metadata,unchanged:true,previousToolCallId:'original',preflightEvidenceId:'later'}))
 ],maxTokens:1024});
 assert.deepEqual(JSON.parse(single.at(-1).content),{...metadata,content:'const value = 1;',preflightEvidenceId:'later'});
});
test('independent reads overlap, writes form barriers and output order remains stable',async()=>{let active=0,peak=0;const order=[];const calls=['read_file','search_files','edit_file','read_file'].map((name,id)=>({id,function:{name}}));const result=await schedule(calls,async c=>{if(c.function.name==='edit_file')assert.equal(active,0);active++;peak=Math.max(peak,active);await delay(c.id===0?20:5);active--;order.push(c.id);return c.id;});assert.deepEqual(result,[0,1,2,3]);assert.equal(peak,2);assert(order.indexOf(2)>order.indexOf(0));});
test('context compaction keeps full history and complete tool groups with exact recent reasoning',async()=>{const messages=[{role:'system',content:'rules'},{role:'user',content:'Fix bug '+ 'x'.repeat(12000)},{role:'assistant',content:'',reasoning_content:'keep exact',tool_calls:[{id:'c',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'old '.repeat(5000)},{role:'user',content:'Continue with constraint'},{role:'assistant',content:'new',reasoning_content:'exact newest'}];const before=JSON.stringify(messages),state={};const engine=new ContextEngine(state,async()=>({message:{content:'Goal: fix bug. Constraint retained. Tool c completed.'},usage:{prompt_tokens:100,completion_tokens:10}}));const prepared=await engine.prepare({messages,tools:[],maxTokens:1024,contextWindow:10000});assert.equal(JSON.stringify(messages),before);assert(prepared.some(m=>m.content.includes('Constraint retained')));assert.equal(prepared.at(-1).reasoning_content,'exact newest');assert.equal(state.compactions,1);assert(estimateTokens(prepared)<8000);const again=await engine.prepare({messages,tools:[],maxTokens:1024,contextWindow:10000});assert.deepEqual(prepared,again);});
test('context engine refuses to drop unmatched tools to fit a budget',async()=>{const engine=new ContextEngine({},()=>{throw Error('should not compact');});await assert.rejects(engine.prepare({messages:[{role:'user',content:'x'.repeat(30000)}],tools:[],maxTokens:1024,contextWindow:8192}),/exceeds/);});
test('GLM-5.3 always enables reasoning and preserves thinking with supported effort',()=>{assert.deepEqual(glmParameters('glm-5.3',{reasoningEffort:'low'}),{thinking:{type:'enabled',clear_thinking:false},reasoning_effort:'low'});assert.deepEqual(glmParameters('glm-4.7',{}),{thinking:{type:'enabled',clear_thinking:false}});assert.deepEqual(glmParameters('custom',{}),{});assert.deepEqual(usageOf({prompt_tokens:10,completion_tokens:6,prompt_tokens_details:{cached_tokens:8},completion_tokens_details:{reasoning_tokens:4}}),{input:10,output:6,cached:8,reasoning:4});});
test('retry only transient HTTP errors before any tool stream is consumed',async t=>{let attempts=0;t.mock.method(globalThis,'fetch',async()=>{if(++attempts===1)return new Response('{}',{status:503});return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');});const r=await complete({baseUrl:'https://example.com',apiKey:'fake',model:'test',messages:[],tools:[]});assert.equal(r.message.content,'ok');assert.equal(attempts,2);assert(r.metrics.durationMs>=400);});
test('a stalled provider is retried before the first event, never after receiving output',async t=>{let attempts=0;t.mock.method(globalThis,'fetch',async(_url,{signal})=>{if(++attempts===1)return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return new Response('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\n');});const result=await complete({baseUrl:'https://example.com',apiKey:'fake',model:'test',messages:[],tools:[],firstEventTimeoutMs:20});assert.equal(result.message.content,'recovered');assert.equal(attempts,2);assert.equal(result.metrics.firstEventRetries,1);});

test('screenshot usage excludes repeated cached input only from optional budgets, retaining total mode',()=>{
 const {budgetTokens}=require('../src/engine'),usage={input:1012317,output:9450,cached:876928};assert.equal(budgetTokens(usage),144839);assert.equal(budgetTokens(usage,'total'),1021767);assert.equal(budgetTokens({input:100,output:5}),105);
});
test('truncated compaction retries once with low effort and a larger bounded output without losing history or usage',async()=>{
 const messages=[{role:'system',content:'rules'},{role:'user',content:'Read architecture '+ 'x'.repeat(110000)},{role:'assistant',content:'Evidence retained'},{role:'user',content:'Continue task'}],original=JSON.stringify(messages),state={},calls=[];let billed=0;
 const engine=new ContextEngine(state,async options=>{calls.push(options);if(calls.length===1){const error=Error('length');error.code='OUTPUT_LIMIT';error.usage={prompt_tokens:55000,completion_tokens:8192};throw error;}return {message:{content:'Goal and source paths retained; continue pending architecture review.'},usage:{prompt_tokens:55000,completion_tokens:100}};});
 const prepared=await engine.prepare({messages,tools:[],contextWindow:64000,maxTokens:16384,reasoningEffort:'max',onCompactionUsage:usage=>billed+=usage.completion_tokens});assert.equal(calls.length,3);assert.deepEqual(calls[0].messages,calls[1].messages);assert.equal(calls[0].reasoningEffort,'low');assert.equal(calls[0].maxTokens,8192);assert.equal(calls[1].maxTokens,16384);assert(billed>=8292);assert.equal(JSON.stringify(messages),original);assert.equal(state.compactions,1);assert(prepared.some(m=>m.content.includes('pending architecture')));assert.equal(prepared.at(-1).content,'Continue task');
});
test('failed compaction recovery is bounded and never commits a partial checkpoint',async()=>{
 const state={},messages=[{role:'user',content:'x'.repeat(110000)},{role:'user',content:'Continue'}];let attempts=0;const engine=new ContextEngine(state,async()=>{attempts++;const error=Error('length');error.code='OUTPUT_LIMIT';throw error;});await assert.rejects(engine.prepare({messages,tools:[],contextWindow:64000,maxTokens:16384}));assert.equal(attempts,2);assert.equal(state.summary,undefined);assert.equal(state.through,undefined);assert.equal(messages[0].content.length,110000);
});

test('one unsupported cache attempt is enough for the rest of the turn', async () => {
  const attempts = [];
  const engine = new ContextEngine({}, async options => {
    attempts.push(options.disableExplicitCache);
    return { message: { content: 'ok' }, metrics: { cacheMode: 'implicit-fallback' } };
  });
  const options = { messages: [{ role: 'system', content: 'rules' }], maxTokens: 128 };
  await engine.complete(options);
  await engine.complete(options);
  assert.deepEqual(attempts, [undefined, true]);
});

test('a free read slot immediately starts the next read and keeps the write barrier', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const starts = [];
  const calls = ['read_file','read_file','read_file','write_file'].map((name, id) => ({ id, function: { name } }));
  const completed = schedule(calls, async call => {
    starts.push(call.id);
    if (call.id === 0) await slow;
    if (call.id === 2) release();
    return call.id;
  }, 2);
  assert.deepEqual(await completed, [0,1,2,3]);
  assert.deepEqual(starts, [0,1,2,3]);
});

test('web excerpts reuse only identical visible snapshots and ranges', async () => {
 const page={url:'https://example.com/source',snapshot:'a',offset:0,endOffset:400,text:'source line\n'.repeat(40)};
 const tool=(id,result)=>({role:'tool',tool_call_id:id,content:JSON.stringify(result)});
 const prior=tool('source',page);
 const current={...page,turnCoverage:{complete:true}};
 const result=JSON.parse(reuseReadEvidence('web_fetch',JSON.stringify(current),[prior]));
 assert.equal(result.previousToolCallId,'source');
 assert.equal(result.text,undefined);
 for(const change of [{snapshot:'b'},{offset:1},{url:'https://example.com/other'}]){
  const changed={...current,...change};
  assert.deepEqual(JSON.parse(reuseReadEvidence('web_fetch',JSON.stringify(changed),[prior])),changed);
 }
 const engine=new ContextEngine({through:1,summary:'Earlier evidence'});
 const prepared=await engine.prepare({messages:[prior,tool('later',result)],maxTokens:1024});
 assert.deepEqual(JSON.parse(prepared.at(-1).content),current);
});
