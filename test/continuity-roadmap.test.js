'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { ContextEngine } = require('../src/engine');
const { formatContext } = require('../src/retro');
const { TaskPool } = require('../src/tasks');
const { McpRegistry } = require('../src/mcp');
const { planVersion, feedbackFor } = require('../src/plan-editor');

test('a new turn keeps the previous request prefix and reports context estimates separately from cache usage', async () => {
  const metrics = [];
  const engine = new ContextEngine({}, async () => ({
    message:{role:'assistant',content:'Verified'},usage:{input_tokens:400,output_tokens:7,input_tokens_details:{cached_tokens:256}}
  }));
  const first = [{role:'system',content:'Instructions'},{role:'user',content:'First question'}];
  const second = [...first,{role:'assistant',content:'Verified'},
    {role:'user',_origin:'harness',content:'Latest plan'},{role:'user',content:'Second question'}];
  const options = {tools:[],onRequestMetrics:row => metrics.push({...row,actor:'main'})};
  await engine.complete({...options,messages:first});
  await engine.complete({...options,messages:second});
  assert.deepEqual(metrics[1].prefix,{sameBlocks:3,comparedBlocks:3,firstChanged:undefined});
  assert(metrics[1].contextBreakdown.taskState > 0);
  assert.match(formatContext({metrics}), /из кэша 256 · без кэша 144/);
  assert.match(formatContext({metrics}), /состояние задачи ≈/);
});

test('a slow external MCP server does not block discovery of a known ready tool', async t => {
  const slow = Promise.withResolvers();
  const registry = new McpRegistry([{name:'fast'},{name:'slow'}]);
  t.after(() => { slow.resolve(); registry.close(); });
  registry.clients.set('fast',{
    async listTools(){return {tools:[{name:'snapshot',description:'Inspect page',inputSchema:{type:'object'}}]};},
    async close(){}
  });
  await registry.refresh('fast');
  const requested=[];
  registry.connect=async name => {requested.push(name);await slow.promise;};
  const partial = JSON.parse(await registry.search('inspect page','session'));
  assert.deepEqual(partial.pending,['slow']);
  assert.equal(partial.tools[0].originalName,'snapshot');
  assert.deepEqual(requested,['slow']);
  requested.length=0;
  const exact=JSON.parse(await registry.search('fast/snapshot','session'));
  assert.equal(exact.tools.length,1);
  assert.deepEqual(requested,[]);
});

test('completed reports survive restart and a remote task with an unknown outcome never restarts automatically', async () => {
  const journal = {};
  const first = new TaskPool();
  const signal = new AbortController().signal;
  const done = first.startExternal('mcp_fixture','call-1',async()=>({status:'done',output:'result'}),
    {taskId:'task',turnId:'before',journal,signal},'chat');
  await first.batches.get(done.id).promise;
  const blocked=Promise.withResolvers();
  const pending=first.startExternal('mcp_fixture','call-2',()=>blocked.promise,
    {taskId:'task',turnId:'before',journal,signal},'chat');
  const restarted=new TaskPool(), restored=JSON.parse(JSON.stringify(journal));
  restarted.remember('chat',restored);
  const deliveries=restarted.collectTask('chat','task');
  assert.equal(deliveries.find(row=>row.id===done.id).results[0].callId,'call-1');
  assert.equal(deliveries.find(row=>row.id===pending.id).status,'interrupted');
  assert.deepEqual(restarted.collectTask('chat','task'),[]);
  const secondRestart=new TaskPool();
  secondRestart.remember('chat',JSON.parse(JSON.stringify(restored)));
  assert.deepEqual(secondRestart.collectTask('chat','task'),[]);
  blocked.resolve({status:'done'});
  await first.batches.get(pending.id).promise;
});

test('restart between two subagents keeps the first result and interrupts the second', async () => {
  const journal={}, pool=new TaskPool(), slow=Promise.withResolvers(), reported=Promise.withResolvers();
  const tasks=['Fast','Slow'].map(title=>({title,type:'explore',prompt:'Inspect '+title}));
  const {id}=JSON.parse(await pool.start(tasks,{
    taskId:'research',turnId:'initial',journal,signal:new AbortController().signal,settings:{},
    system:'Read-only fixture',mode:'plan',onStart(){},onUpdate(){},hostFor:()=>({}),
    onChange:()=>reported.resolve(),
    complete:async request=>{
      const title=request.messages[1].content;
      if(title.includes('Slow'))await slow.promise;
      return {message:{role:'assistant',content:title+' result'}};
    }
  },'research-chat'));
  await reported.promise;
  try{
    const restarted=new TaskPool();
    restarted.remember('research-chat',JSON.parse(JSON.stringify(journal)));
    const [batch]=restarted.collectTask('research-chat','research');
    assert.equal(batch.id,id);
    assert.equal(batch.status,'interrupted');
    assert.equal(batch.results.length,1);
    assert.equal(batch.results[0].result,'Inspect Fast result');
    assert.deepEqual(restarted.collectTask('research-chat','research'),[]);
  }finally{
    slow.resolve();
    await pool.batches.get(id).promise;
  }
});

test('a declared MCP task returns a result linked to the same remote task', async t => {
  const registry=new McpRegistry([{name:'fixture',command:process.execPath,
    args:[path.join(__dirname,'fixtures','mcp-task-server.cjs')]}]);
  t.after(()=>registry.close());
  const search=JSON.parse(await registry.search('fixture/example_task','chat'));
  assert.deepEqual(search.errors,[]);
  const tool=search.tools[0].name;
  assert.equal(registry.taskSupported(tool),true);
  let remoteId;
  const result=await registry.runTask(tool,{},AbortSignal.timeout(3000),id=>{remoteId=id;});
  assert.equal(typeof remoteId,'string');
  assert.equal(result.content[0].text,'Observed result');
});

test('a plan revision changes when the user-visible plan or task changes and feedback has bounded text', () => {
  const session={taskId:'a',plan:{goal:'Keep the interface',steps:[{title:'Check the callsite',status:'pending'}]}};
  const first=planVersion(session);
  assert.deepEqual(feedbackFor(session.plan,[{index:0,text:'  Include the existing caller  '}]),
    [{title:'Check the callsite',text:'Include the existing caller'}]);
  session.plan.steps[0].title='Check the boundary';
  assert.notEqual(first,planVersion(session));
  assert.deepEqual(feedbackFor(session.plan,[{index:42,text:'stale'}]),[]);
});

test('context report separates latest-turn actors, compaction and missing usage', () => {
  const metrics = [
    {turnId:'old',phase:'generation',actor:'main',usage:{prompt_tokens:99000}},
    {turnId:'new',phase:'generation',actor:'main',actualModel:'glm-5.3',
      usage:{prompt_tokens:100,completion_tokens:8,prompt_tokens_details:{cached_tokens:80}},contextBreakdown:{toolResults:46}},
    {turnId:'new',phase:'generation',actor:'subagent',actualModel:'glm-5.3-flash',
      usage:{prompt_tokens:36,completion_tokens:5},contextBreakdown:{toolResults:12}},
    {turnId:'new',phase:'compaction',actor:'main',actualModel:'glm-5.3'}
  ];
  const report = formatContext({metrics});
  assert.match(report,/Субагенты · glm-5\.3-flash: 1 запросов · вход 36 · кэш 0 · без кэша 36/);
  assert.match(report,/Сжатие · glm-5\.3: .*нет данных по 1/);
  assert.match(report,/вывод инструментов ≈58/);
  assert.doesNotMatch(report,/99\s?000/);
});
