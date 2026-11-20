'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHost}=require('../scripts/runtime-host');
const packet=data=>`data: ${JSON.stringify(data)}\n\n`;
test('editor context sends a path or a selection once when its chip is included', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'harness-editor-context-')));
  const file = path.join(root, 'main.js');
  await fs.writeFile(file, 'private file contents\nconst selected = true;\n');
  const host = await createHost({root, storage: path.join(root, '.storage'), settings: {attachOpenFile: true}});
  t.after(async () => { await host.close(); await fs.rm(root, {recursive: true, force: true}); });
  const {app, session, view} = host;
  const posts = [];
  view.postMessage = message => posts.push(message);
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(packet({choices: [{delta: {content: 'OK'}, finish_reason: 'stop'}]})));
  const editor = {document: {uri: {scheme: 'file', fsPath: file}, getText: () => 'const selected = true;\n'},
    selection: {isEmpty: true}};
  const send = async (text, editorContextKey) => {
    await app.receive(view, {type: 'send', text, attachments: [], editorContextKey});
    return session.messages.filter(message => message.role === 'user').at(-1).content;
  };
  app.rememberEditor(editor);
  const pathChip = posts.at(-1).context;
  assert.equal(pathChip.label, 'main.js');
  assert.equal(await send('Dismissed'), 'Dismissed');
  const first = await send('Inspect the file', pathChip.key);
  assert.match(first, /\{"file":"main\.js"\}$/);
  assert.doesNotMatch(first, /private file contents|const selected/);
  assert.equal(await send('Same file', pathChip.key), 'Same file');

  editor.selection = {isEmpty: false, start: {line: 1, character: 0}, end: {line: 2, character: 0}};
  app.rememberEditor(editor);
  const selectionChip = posts.at(-1).context;
  assert.equal(selectionChip.label, 'main.js:2');
  assert.equal(await send('Stale chip', pathChip.key), 'Stale chip');
  assert.deepEqual(JSON.parse((await send('Inspect selection', selectionChip.key)).split('\n').at(-1)),
    {file: 'main.js', startLine: 2, endLine: 2, selection: 'const selected = true;\n'});
  assert.equal(await send('Same selection', selectionChip.key), 'Same selection');
});
test('background questions and approvals notify once and open the waiting chat without answering', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-attention-'));
  const notices=[], opened=[];
  const host=await createHost({root,storage:path.join(root,'.storage'),showInformationMessage(message,action){
    const choice=Promise.withResolvers();
    notices.push({message,action,choice});
    return choice.promise;
  }});
  t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
  const {app,session}=host;
  const panel={active:true};
  app.panels.set(session.id,panel);
  app.openTab=id=>opened.push(id);
  const question=new AbortController();
  const waiting=app.approve(session,{kind:'question'},question.signal);
  assert.equal(notices.length,0);
  panel.active=false;
  app.notifyPendingAttention();
  app.notifyPendingAttention();
  assert.equal(notices.length,1);
  assert.match(notices[0].message,/ответа на вопрос/);
  notices[0].choice.resolve(notices[0].action);
  await Promise.resolve();
  assert.deepEqual(opened,[session.id]);
  assert.equal(app.pending.size,1);
  question.abort();
  assert.equal(await waiting,false);

  const command=new AbortController();
  const approval=app.approve(session,{kind:'command'},command.signal);
  assert.equal(notices.length,2);
  assert.match(notices[1].message,/подтверждения действия/);
  command.abort();
  assert.equal(await approval,false);
  notices[1].choice.resolve(notices[1].action);
  await Promise.resolve();
  assert.deepEqual(opened,[session.id]);
});
test('a request failure reaches the composer as an error notice and stays in chat history', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-error-banner-'));
  const host=await createHost({root,storage:path.join(root,'.storage')});
  t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
  const posts=[];
  host.view.postMessage=message=>posts.push(message);
  t.mock.method(globalThis,'fetch',async()=>new Response('{"error":{"message":"Model unavailable"}}',{status:400}));
  await host.send('Check file');
  assert.deepEqual(posts.find(post=>post.kind==='error'),{
    type:'notice',kind:'error',sessionId:host.session.id,text:'HTTP 400: Model unavailable'
  });
  assert.match(host.session.timeline.at(-1).text,/HTTP 400: Model unavailable/);
});
test('ordinary analysis and an optimization follow-up retain the same Plan tool schema', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-plan-prefix-'));
 const host=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 host.session.mode='plan';
 const requests=[];
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
   requests.push(JSON.parse(body));
   return new Response(packet({choices:[{delta:{content:'No changes made.'},finish_reason:'stop'}]}));
 });
 await host.send('Опиши архитектуру модуля.');
 await host.send('Предложи оптимизацию архитектуры с контрпримером.');
 assert.equal(requests.length,2);
 assert.deepEqual(requests[0].tools,requests[1].tools);
 assert(requests[1].tools.some(tool=>tool.function.name==='trace_symbol'));
 assert.equal(host.session.metrics.at(-1).prefix.firstChanged,undefined);
});
test('opt-in idle compaction saves an isolated checkpoint, preserves history and charges usage once', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-idle-compaction-'));
 const host=await createHost({root,storage:path.join(root,'.storage'),
  settings:{idleCompactionMinutes:30,contextWindow:16000}});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 const {app,session}=host;
 session.updated=Date.now()-3600000;
 session.turnId='saved';
 session.identity='glm|https://api.z.ai/api/coding/paas/v4|glm-5.3|chat';
 session.context={estimatedTokens:23000};
 session.messages=[
   {role:'user',content:'x'.repeat(24000)},
   {role:'assistant',content:'Earlier answer'},
   {role:'user',content:'Open question'}
 ];
 const history=JSON.stringify(session.messages);
 let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{
  requests++;
  return new Response(packet({choices:[{delta:{content:'Saved continuation'},finish_reason:'stop'}],
    usage:{prompt_tokens:20,completion_tokens:3}}));
 });
 await app.compactIdleSession();
 assert.equal(session.context.summary,'Saved continuation');
 assert.equal(JSON.stringify(session.messages),history);
 assert(session.metrics.every(row=>row.phase==='idle-compaction'));
 assert.equal(session.usage.input,requests*20);
 const before=requests;
 await app.compactIdleSession();
 assert.equal(requests,before);
});
test('retro reports saved metrics without adding history or calling a provider', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-retro-'));
  const host = await createHost({ root, storage: path.join(root, '.storage') });
  t.after(async () => { await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  const { app, session, view } = host;
  t.mock.method(globalThis, 'fetch', async () => assert.fail('retro must stay local'));
  const messages = [];
  view.postMessage = message => messages.push(message);
  session.turnId = 'in-progress';
  session.metrics = [
    { turnId:'previous', phase:'generation', actor:'main', at:10, durationMs:200, usage:{ input_tokens:80, output_tokens:7, input_tokens_details:{ cached_tokens:0 } } },
    { turnId:'previous', phase:'tool', actor:'main', name:'read_files', at:220, durationMs:10, status:'done', eventId:'one' },
    { turnId:'previous', phase:'tool', actor:'main', name:'read_files', at:240, durationMs:20, status:'done', eventId:'two' },
    { turnId:'in-progress', phase:'generation', actor:'main', at:300, durationMs:500, usage:{ prompt_tokens:900, completion_tokens:12 } }
  ];
  session.timeline = [
    { role:'tool', id:'one', input:'{"path":"private/file","line":1}' },
    { role:'tool', id:'two', input:'{"line":1,"path":"private/file"}' }
  ];
  app.runs.set(session.id, new AbortController());
  await app.receive(view, { type:'retro' });
  assert.equal(messages[0].type,'retro');
  assert.equal(messages[0].sessionId,session.id);
  assert.match(messages[0].text,/вход 80 · выход 7 · кэш 0/);
  assert.match(messages[0].text,/read_files.*повторов с теми же аргументами 1/);
  assert.doesNotMatch(messages[0].text,/private\/file|900/);
  assert.equal(session.timeline.length,2);
  assert.equal(session.messages.length,0);
  app.runs.delete(session.id);
  await app.receive(view, { type:'retro' });
  assert.match(messages[1].text,/вход 900 · выход 12 · кэш недоступен/);
});
test('one stop cancels the provider and rejects its late tool calls', { timeout: 3000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-stop-'));
  const host = await createHost({ root, storage: path.join(root, '.storage') });
  t.after(async () => {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    requests++;
    started.resolve(signal);
    await released.promise;
    return new Response(packet({ choices: [{ delta: {
      tool_calls: [{ index: 0, id: 'late', function: { name: 'read_file', arguments: '{"path":"main.js"}' } }]
    }, finish_reason: 'tool_calls' }] }));
  });
  const turn = host.send('Read main.js');
  const signal = await started.promise;
  try {
    await host.app.receive(host.view, { type: 'stop' });
    assert.equal(signal.aborted, true);
  } finally {
    released.resolve();
    await turn;
  }
  assert.equal(requests, 1);
  assert.equal(host.app.runs.has(host.session.id), false);
  assert.equal(host.session.timeline.at(-1).text, 'Остановлено.');
  assert.equal(host.session.timeline.some(event => event.role === 'tool'), false);
});
test('clipboard images reach the GLM vision model and the coordinator receives its evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-image-'));
  const host = await createHost({ root, storage: path.join(root, '.storage') });
  t.after(async () => { await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    const content = payload.model === 'glm-5.3-flash' ? 'Visible save button' : 'Verified screenshot description';
    return new Response(packet({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
  });
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const image = { kind: 'image', label: 'Screenshot.png', width: 450, height: 270, thumbnail: 'data:image/webp;base64,QUJDRA==' };
  await host.app.send(host.view, 'Inspect the screenshot', [{ ...image, dataUrl }]);
  assert.equal(payloads[0].model, 'glm-5.3-flash');
  assert.deepEqual(payloads[0].messages.at(-1).content.at(-1), { type: 'image_url', image_url: { url: dataUrl } });
  assert.match(payloads[1].messages.at(-1).content, /Visible save button/);
  assert.equal(host.session.usage.input, 20);
  assert.deepEqual(host.session.timeline[0].attachments, [image]);
  const { responsesInput } = require('../src/providers');
  assert.deepEqual(responsesInput(payloads[0].messages.slice(-1))[0].content, [
    { type: 'input_text', text: 'Inspect the screenshot' },
    { type: 'input_image', image_url: dataUrl, detail: 'auto' }
  ]);
});
test('Architecture offers background delegation directly and injects results while other agents run', { timeout: 3000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-background-reports-'));
  const host = await createHost({ root, storage: path.join(root, '.storage'), settings: { workProfile: 'architecture' } });
  let finishSlow;
  const slow = new Promise(resolve => { finishSlow = resolve; });
  t.after(async () => {
    finishSlow();
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  host.session.mode = 'plan';
  const tasks = [
    { type: 'explore', title: 'Fast evidence', prompt: 'Fast assignment' },
    { type: 'explore', title: 'Slow evidence', prompt: 'Slow assignment' }
  ];
  let parentRounds = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { messages, tools } = JSON.parse(options.body);
    let delta;
    if (messages[0].content.includes('You are the explore subagent:')) {
      const isSlow = messages.some(message => message.content === 'Slow assignment');
      if (isSlow) await slow;
      delta = { content: isSlow ? 'Slow result' : 'Fast result' };
    } else {
      const reports = messages.filter(message => message.content?.startsWith('[Background task results'));
      if (++parentRounds === 1) {
        assert(tools.some(tool => tool.function.name === 'start_tasks'));
        delta = { tool_calls: [{ index: 0, id: 'start', function: { name: 'start_tasks', arguments: JSON.stringify({ tasks }) } }] };
      } else if (reports.length === 0) {
        delta = { content: 'Preliminary synthesis' };
      } else if (reports.length === 1) {
        assert.match(reports[0].content, /Fast result/);
        assert.doesNotMatch(reports[0].content, /Slow result/);
        finishSlow();
        delta = { content: 'Fast evidence integrated' };
      } else {
        assert.match(reports[1].content, /Slow result/);
        assert.doesNotMatch(reports[1].content, /Fast result/);
        delta = { content: 'Both reports integrated' };
      }
    }
    return new Response(packet({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  await host.send('Investigate the architecture');
  assert.equal(host.session.timeline.at(-1).text, 'Both reports integrated');
});

test('ordinary delegation returns before the worker finishes and a parked parent wakes on steering and completion', {timeout:3000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-event-delegation-'));
  const host = await createHost({root, storage:path.join(root, '.storage')});
  const worker = Promise.withResolvers();
  const parked = [Promise.withResolvers(), Promise.withResolvers()];
  t.after(async () => { worker.resolve(); await host.close(); await fs.rm(root, {recursive:true, force:true}); });
  const {app, session} = host;
  const wait = app.tasks.waitForChange.bind(app.tasks);
  let waits = 0, main = 0, hooks = 0;
  app.tasks.waitForChange = (...args) => {
    assert.equal(args[2], Infinity);
    parked[waits++].resolve();
    return wait(...args);
  };
  app.runProjectHooks = async (_hooks, event) => { if (event === 'subagentStop') hooks++; };
  t.mock.method(globalThis, 'fetch', async (_url, {body}) => {
    const {messages} = JSON.parse(body);
    let delta;
    if (messages[0].content.includes('You are the explore subagent:')) {
      await worker.promise;
      delta = {content:'Completed evidence'};
    } else if (++main === 1) {
      const tasks = [{title:'Independent evidence',type:'explore',prompt:'Find a fact'}];
      delta = {tool_calls:[{index:0,id:'delegate',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks})}}]};
    } else if (main === 2) {
      const launch = JSON.parse(messages.at(-1).content);
      assert.equal(launch.background, true);
      assert.equal(launch.status, 'running');
      delta = {content:'Independent work complete'};
    } else if (main === 3) {
      assert(messages.some(message => message.content === 'Use the shorter report'));
      delta = {content:'Steering received'};
    } else {
      assert.equal(hooks, 1);
      const reports = messages.filter(message => message.content?.startsWith('[Background task results'));
      assert.equal(reports.length, 1);
      assert.match(reports[0].content, /Completed evidence/);
      delta = {content:'Combined report'};
    }
    return new Response(packet({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]}));
  });
  const run = host.send('Delegate an independent investigation');
  await parked[0].promise;
  assert.equal(main, 2);
  await host.send('Use the shorter report');
  await parked[1].promise;
  assert.equal(main, 3);
  worker.resolve();
  await run;
  assert.equal(main, 4);
  assert.equal(waits, 2);
  assert.equal(session.timeline.at(-1).text, 'Combined report');
});
test('sidebar lists only writable AI sessions, preserving editable copies and excluding imported originals from counts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-own-sessions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());const {SessionManager}=require('../src/sidebar');h.app.settings=async()=>({provider:'glm',model:'glm-5.3',apiKey:'fake'});
 h.session.messages=[{role:'user',content:'Our conversation'}];h.session.usage={input:2,output:3};const copy={...h.session,id:'copy',title:'CC copy',updated:2,usage:{input:4,output:5}};h.app.sessions.set(copy.id,copy);h.app.sessions.set('other-project',{...copy,id:'other-project',root:root+'-other',updated:100,usage:{input:0,output:0}});h.app.sessions.set('readonly',{...h.session,id:'readonly',readonly:true,updated:99,usage:{input:999,output:999}});h.app.imported.set('cc:old',{id:'cc:old',title:'Old Claude conversation',readonly:true,updated:100});
 const manager=new SessionManager(h.app);let payload;manager.view={postMessage:p=>payload=p};await manager.state();assert.deepEqual(new Set(payload.sessions.map(s=>s.id)),new Set([h.session.id,'copy']));assert(payload.sessions.every(s=>!s.readonly));assert.deepEqual(payload.usage,{input:6,output:8});assert.deepEqual(h.app.recent().map(s=>s.id).sort(),[h.session.id,'copy'].sort());assert.equal(h.app.imported.size,1);
 h.app.localWorkspaceFolders=()=>[{uri:{scheme:'file',fsPath:root+'-other'}}];
 await manager.state();
 assert.deepEqual(payload.sessions.map(s=>s.id),['other-project']);
 assert.deepEqual(h.app.recent().map(s=>s.id),['other-project']);
});
test('production main loop routes web and skill services, records requests and command success separately from acceptance',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-runtime-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const host=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>host.close());
 let round=0,searched=0,fetched=0;
 host.app.web.search=async()=>{searched++;return 'https://example.org/source';};host.app.web.read=async()=>{fetched++;return 'Verified source';};
 t.mock.method(globalThis,'fetch',async()=>new Response(packet({model:'reported-model',choices:[{delta:++round===1?{tool_calls:[{index:0,id:'s',function:{name:'web_search',arguments:'{"query":"official docs"}'}},{index:1,id:'f',function:{name:'web_fetch',arguments:'{"url":"https://example.org/source"}'}}]}:{content:'Answer with source'},finish_reason:round===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3}})));
 await host.send('Research official docs');assert.equal(searched,1);assert.equal(fetched,1);
 assert.equal(host.session.timeline.filter(e=>e.role==='notice').length,0);
 assert.equal(host.session.metrics.filter(m=>m.phase==='generation').length,2);assert.equal(host.session.metrics[0].actualModel,'reported-model');
 assert.equal(host.session.metrics.filter(m=>m.phase==='tool'&&m.status==='done').length,2);
});
test('production verify_task does not label an exit-zero command as independent acceptance',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-verifier-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const h=await createHost({root,storage:path.join(root,'.storage'),approveCommand:async()=>({allow:true,execution:{file:process.execPath,args:['-e','process.exit(0)']}})});t.after(()=>h.close());h.session.turnChanges=[];
 const check=JSON.parse(await h.app.serviceTool('verify_task',{command:'node test.js',description:'Public test'},h.session,root,new AbortController().signal,{}));
 assert.equal(check.commandPassed,true);assert.equal(check.acceptance,'not_independently_evaluated');
});
test('a genuine clarification cancels stale tool execution and preserves the original goal and architecture fields',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-steering-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'main.js'),'original');const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());
 h.session.initialGoal='Extend the module';h.session.taskId='original-task';h.session.plan={goal:'Extend the module',invariant:'Keep seed',owner:'model',steps:[{title:'integrate',status:'pending'}]};
 let started,release,round=0;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r),payloads=[];
 t.mock.method(globalThis,'fetch',async(_url,o)=>{payloads.push(JSON.parse(o.body));round++;if(round===1){started();await gate;}const delta=round===1?{tool_calls:[{index:0,id:'old',function:{name:'write_file',arguments:'{"path":"main.js","content":"stale"}'}}]}:round===2?{tool_calls:[{index:0,id:'plan',function:{name:'update_plan',arguments:'{"goal":"Extend the module","steps":[{"title":"integrate","status":"done"}]}'}}]}:{content:'Kept requested data'};return new Response(packet({choices:[{delta,finish_reason:round<=2?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:5}}));});
 const run=h.send('Continue the implementation');await ready;await h.send('Do not apply the proposed edit; preserve the original file.');release();await run;
 assert.equal(await fs.readFile(path.join(root,'main.js'),'utf8'),'original');assert.equal(h.session.initialGoal,'Extend the module');assert.equal(h.session.plan.invariant,'Keep seed');assert.equal(h.session.userUpdates.length,2);assert(payloads.some(p=>p.messages.some(m=>m.content?.includes('Do not apply the proposed edit'))));assert(payloads.every(p=>p.messages.every(m=>!('_origin'in m))));
});
test('a successful recognized test after the latest edit needs no duplicate verify_task round',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-receipts-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'main.js'),'original');const h=await createHost({root,storage:path.join(root,'.storage'),approveCommand:async()=>({allow:true,execution:{file:process.execPath,args:['-e','process.exit(0)']}})});t.after(()=>h.close());let rounds=0;
 t.mock.method(globalThis,'fetch',async()=>{rounds++;return new Response(packet({choices:[{delta:rounds===1?{tool_calls:[{index:0,id:'edit',function:{name:'write_file',arguments:'{"path":"main.js","content":"module.exports={value:1};"}'}},{index:1,id:'test',function:{name:'run_command',arguments:'{"command":"node test.js","description":"Run behavioral test"}'}}]}:{content:'Implemented and checked'},finish_reason:rounds===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}));});
 await h.send('Implement value=1 and check it');assert.equal(rounds,2);assert.equal(h.session.checks.length,1);assert.equal(h.session.checks[0].commandPassed,true);assert.equal(h.session.checks[0].changeRevision,1);assert.match(await fs.readFile(path.join(root,'main.js'),'utf8'),/value:1/);
});
test('large unsaved selections remain recoverable instead of silently losing the tail',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-attachment-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());const text='selected code '.repeat(2500)+'MANDATORY_TAIL_CONSTRAINT',preview=await h.app.attachmentPreview(text),id=preview.match(/id=([a-f0-9-]{36})/)[1];assert.match(preview,/INCOMPLETE/);assert.equal(await fs.readFile(path.join(root,'.storage/artifacts',id),'utf8'),text);
});
test('clear discards the old pending task and canonical updates along with chat context',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-clear-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());h.session.plan={goal:'old',steps:[{title:'old work',status:'pending'}]};h.session.initialGoal='old';h.session.userUpdates=[{id:'old',content:'old'}];await h.send('/clear');assert.equal(h.session.plan,null);assert.equal(h.session.initialGoal,'');assert.deepEqual(h.session.userUpdates,[]);assert.deepEqual(h.session.messages,[]);
});
test('subagents receive their bounded assignment without the parent saved plan',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-agent-focus-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());h.session.initialGoal='ROOT_ONLY_PLAN';h.session.taskId='root-task';h.session.plan={goal:'ROOT_ONLY_PLAN',steps:[{title:'investigate',status:'pending'}]};let parent=0,children=0;
 t.mock.method(globalThis,'fetch',async(_url,o)=>{const p=JSON.parse(o.body),system=p.messages[0].content;let delta,finish='stop';if(system.includes('You are the explore subagent:')){children++;assert(p.messages.every(m=>!m.content?.includes('ROOT_ONLY_PLAN')));assert(p.messages.some(m=>m.content==='Locate the owner in the assigned scope.'));delta={content:'Bounded findings'};}else{parent++;assert(!system.includes('ROOT_ONLY_PLAN'));assert(p.messages[1].content.includes('ROOT_ONLY_PLAN'));if(parent===1){delta={tool_calls:[{index:0,id:'delegate',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{title:'Locate owner',type:'explore',prompt:'Locate the owner in the assigned scope.'}]})}}]};finish='tool_calls';}else if(parent===2){delta={tool_calls:[{index:0,id:'finish',function:{name:'update_plan',arguments:JSON.stringify({goal:'ROOT_ONLY_PLAN',steps:[{title:'investigate',status:'done'}]})}}]};finish='tool_calls';}else delta={content:'Integrated findings'};}return new Response(packet({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:2}}));});
 await h.send('Continue the bounded investigation');assert.equal(children,1);assert.equal(parent,3);assert.equal(h.session.timeline.filter(e=>e.role==='notice').length,0);
});

test('long cached turns continue by default while explicit total budgets still stop before the next request',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-budget-regression-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'main.js'),'evidence');
 for(const accounting of ['uncached','total']){
  const h=await createHost({root,storage:path.join(root,accounting),settings:{budgetAccounting:accounting,turnTokenBudget:1000,maxToolRounds:0,turnTimeoutSeconds:0}});let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(packet({choices:[{delta:requests===1?{tool_calls:[{index:0,id:'read',function:{name:'read_file',arguments:'{"path":"main.js"}'}}]}:{content:'Verified evidence; task completed'},finish_reason:requests===1?'tool_calls':'stop'}],usage:{prompt_tokens:1100000,completion_tokens:20,prompt_tokens_details:{cached_tokens:1099900}}}));});
  await h.send('Inspect main.js');assert.equal(requests,accounting==='uncached'?2:1);const notices=h.session.timeline.filter(e=>e.role==='notice');assert.equal(notices.length,accounting==='uncached'?0:1);if(accounting==='total')assert.match(notices[0].text,/бюджет задачи/);assert(h.session.usage.input>=1100000);await h.close();t.mock.restoreAll();
 }
});

test('Auto resolves existing approvals and blocks protected edits inline',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-auto-pending-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());const controller=new AbortController(),entry={id:'command'};
 h.session.mode='manual';const pending=h.app.reviewAction(h.session,root,entry,{kind:'command',detail:'touch ready && ls'},controller.signal);assert.equal(h.app.pending.size,1);
 await h.app.receive(h.view,{type:'mode',mode:'auto'});assert.equal((await pending).allow,true);assert.equal(h.app.pending.size,0);
 const decision=await h.app.reviewAction(h.session,root,entry,{kind:'command',detail:'curl -s --max-time 10 https://example.com | grep title'},controller.signal);assert.equal(decision.allow,true);assert.equal(h.app.pending.size,0);
 const risky={id:'risky'};
 const requested=h.app.reviewAction(h.session,root,risky,{kind:'command',detail:'ls && rm approval-required',cwd:root},controller.signal);
 const result=await Promise.race([requested,new Promise(resolve=>setTimeout(()=>resolve('waiting'),25))]);
 assert.equal(result,'waiting');
 const [id]=h.app.pending.keys();
 assert.equal(risky.status,'waiting');
 await h.app.reviewPending(h.session);
 assert.equal(h.app.pending.size,1);
 await h.app.receive(h.view,{type:'approval',id,allow:true});
 assert.equal(await requested,true);
 assert.equal(h.session.mode,'auto');
 const edit={id:'edit'};
 assert.equal(await h.app.reviewAction(h.session,root,edit,{kind:'edit',change:{file:path.join(root,'.env')}},controller.signal),false);
 assert.match(edit.deferReason,/Auto blocked/);
 assert.equal(h.app.pending.size,0);
});

test('switching to Auto during a tool call releases Bash and updates the next model round', {timeout:3000}, async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-active-auto-'));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 const wrapHost=h.app.toolHost.bind(h.app);
 h.app.toolHost=(...args)=>({...wrapHost(...args),approveCommand:Object.getPrototypeOf(h.app).toolHost.apply(h.app,args).approveCommand});
 let requests=0;
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  const first=++requests===1;
  assert.match(JSON.parse(body).messages[0].content,first?/Mode: Manual/i:/Mode: Auto/i);
  const delta=first?{tool_calls:[{index:0,id:'bash',function:{name:'run_command',arguments:'{"command":"printf switched > result.txt"}'}}]}:{content:'Command complete'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 const turn=h.send('Write a local test result using Bash.');
 while(!h.app.pending.size && h.app.runs.size)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(h.app.pending.size,1);
 await h.app.receive(h.view,{type:'mode',mode:'auto'});
 await turn;
 assert.equal(await fs.readFile(path.join(root,'result.txt'),'utf8'),'switched');
 assert.equal(h.app.pending.size,0);
 assert.equal(requests,2);
});

test('production Responses loop continues commentary, executes streamed tools and returns results before finalizing',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-responses-tools-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'main.js'),'REAL SOURCE EVIDENCE');const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());const {ModelConnections}=require('../src/model-connections');
 t.mock.method(ModelConnections.prototype,'settings',async()=>({provider:'chatgpt',protocol:'responses',apiKey:'fake',model:'gpt-test',baseUrl:'https://api.openai.com/v1'}));h.session.modelProfileId='test-profile';h.app.context.globalState.get=(key,fallback)=>key==='ai.modelConnections'?{activeId:'test-profile',profiles:[{id:'test-profile',provider:'chatgpt'}]}:fallback;
 const payloads=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const payload=JSON.parse(options.body);payloads.push(payload);let item;
 if(payloads.length===1)item={id:'m1',type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'I will inspect main.js',annotations:[]}]};
 else if(payloads.length===2)item={id:'f1',type:'function_call',call_id:'c1',namespace:'agent_tools',name:'read_file',arguments:'{"path":"main.js"}',status:'completed'};
 else{assert(payload.input.some(i=>i.type==='function_call_output'&&i.call_id==='c1'&&i.output.includes('REAL SOURCE EVIDENCE')));item={id:'m2',type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Verified source inspected',annotations:[]}]};}
 return new Response(packet({type:'response.output_item.done',output_index:0,item})+packet({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:10,output_tokens:5}}}));});
 await h.send('Inspect main.js');assert.equal(payloads.length,3);assert(h.session.timeline.some(e=>e.role==='tool'&&e.name==='read_file'&&e.result.includes('REAL SOURCE EVIDENCE')));assert.equal(h.session.timeline.filter(e=>e.role==='notice').length,0);assert(payloads[1].input.some(i=>i.phase==='commentary'));assert(h.session.messages.at(-1).content.includes('Verified source'));assert.equal(h.session.usage.output,15);
});

test('sidebar attributes usage per provider without rendering cumulative token totals',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-provider-usage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=await createHost({root,storage:path.join(root,'.storage')});t.after(()=>h.close());const {SessionManager}=require('../src/sidebar');h.app.settings=async()=>({provider:'chatgpt',model:'gpt-test',apiKey:'fake'});
 h.session.provider='glm';h.session.messages=[{role:'user',content:'GLM task'}];h.session.usage={input:100,output:10,cached:80};h.app.sessions.set('gpt',{...h.session,id:'gpt',provider:'chatgpt',usage:{input:200,output:20,cached:100,reasoning:5}});h.app.sessions.set('api',{...h.session,id:'api',provider:'openai',usage:{input:300,output:30}});let payload;const manager=new SessionManager(h.app);manager.view={postMessage:p=>payload=p};await manager.state();assert.equal(payload.usageByProvider.chatgpt.input,200);assert.equal(payload.usageByProvider.glm.input,100);assert.equal(payload.usageByProvider.openai.input,300);assert.equal(payload.usage.input,600);
 const {parseHTML}=require('linkedom'),vm=require('node:vm'),{window,document}=parseHTML(await fs.readFile('media/sidebar.html','utf8')),messages=[];const context=vm.createContext({window,document,acquireVsCodeApi:()=>({getState:()=>({}),setState(){},postMessage:m=>messages.push(m)}),setInterval(){},console});for(const name of ['icons','sidebar'])vm.runInContext(await fs.readFile('media/'+name+'.js','utf8'),context);const event=new window.Event('message');event.data=payload;window.dispatchEvent(event);assert.equal(document.querySelector('#usage, .provider-usage-row, .chatgpt-usage-link'),null);
});

test('GPT delegation uses the Claude Haiku model alias on the GLM connection',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-haiku-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const h=await createHost({root,storage:path.join(root,'.storage'),apiKey:'glm-test-key'});t.after(()=>h.close());
 t.mock.method(h.app.context.secrets,'get',async key=>key==='ai.openai.key'?'gpt-test-key':'glm-test-key');
 h.settings.provider='openai';h.settings.openaiModel='gpt-test';
 const previous=process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
 process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL='glm-test-haiku';
 t.after(()=>{if(previous===undefined)delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL=previous;});
 let parents=0,children=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
   const payload=JSON.parse(options.body);
   if(url.includes('chat/completions')){
     children++;assert.equal(payload.model,'glm-test-haiku');assert.equal(options.headers.authorization,'Bearer glm-test-key');
     assert(payload.messages[0].content.includes('configured model=glm-test-haiku'));
     assert(!payload.messages[0].content.includes('configured model=gpt-test'));
     return new Response(packet({choices:[{delta:{content:'Independent finding'},finish_reason:'stop'}],usage:{prompt_tokens:17,completion_tokens:3}}));
   }
   assert.equal(payload.model,'gpt-test');assert.equal(options.headers.authorization,'Bearer gpt-test-key');
   const item=++parents===1?{type:'function_call',call_id:'delegate',name:'delegate_tasks',arguments:JSON.stringify({wait:true,tasks:[{title:'Check',type:'explore',prompt:'Check assigned scope'}]})}:{type:'message',content:[{type:'output_text',text:'Integrated finding'}]};
   if(parents===2)assert(payload.input.some(input=>input.type==='function_call_output'&&input.output.includes('Independent finding')));
   return new Response(packet({type:'response.completed',response:{status:'completed',output:[item],usage:{input_tokens:10,output_tokens:3}}}));
 });
 await h.send('Delegate a read-only check');
 assert.equal(children,1);assert.equal(parents,2);assert.equal(h.session.delegatedUsage.glm.input,17);
 assert.deepEqual(require('../src/sidebar').providerUsage([h.session]).openai,{input:20,output:6,cached:0,reasoning:0});
});

test('a direct request for чатжпт launches the saved ChatGPT worker without a model questionnaire', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-chatgpt-worker-'));
  const host = await createHost({root, storage:path.join(root, '.storage')});
  t.after(async () => { await host.close(); await fs.rm(root, {recursive:true, force:true}); });
  const {app, session} = host;
  const accountId = 'f2423a1a-cffd-4499-9ec1-91af6d75514d';
  const profile = {id:'saved-sol', accountId, label:'GPT-6.1 Sol · ChatGPT', provider:'chatgpt',
    protocol:'responses', baseUrl:'https://api.openai.com/v1', model:'gpt-6.1-sol'};
  const other = {...profile, id:'saved-astra', label:'GPT-6.2 Astra · ChatGPT', model:'gpt-6.2-astra'};
  await app.context.globalState.update('ai.modelConnections', {activeId:profile.id, profiles:[profile,other]});
  t.mock.method(app.context.secrets, 'get', async key => key === 'ai.chatgpt.' + accountId
    ? JSON.stringify({access_token:'test-chatgpt-token', expires_at:Date.now()+600000}) : 'test-glm-token');
  let parent = 0, workers = 0, questionnaires = 0;
  app.approve = async () => { questionnaires++; return false; };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === 'https://api.openai.com/v1/responses') {
      workers++;
      assert.equal(body.model, profile.model);
      assert.equal(options.headers.authorization, 'Bearer test-chatgpt-token');
      const output = [{type:'message',content:[{type:'output_text',text:'Independent finding from Sol'}]}];
      return new Response(packet({type:'response.completed', response:{status:'completed',output,usage:{input_tokens:23,output_tokens:4}}}));
    }
    const args = (++parent === 1) ? {
      question:'Кому поручить независимый анализ?',
      options:['GPT-6.1 Sol (ChatGPT)','Дефолтный субагент (без подключения)']
    } : {tasks:[{title:'Review',type:'review',prompt:'Review the evidence',connection_id:'OMITTED — see prompt'}]};
    if (parent === 2) {
      const answer = body.messages.find(message => message.role === 'tool');
      assert.deepEqual(JSON.parse(answer.content), {status:'answered',answer:'GPT-6.1 Sol (ChatGPT)',source:'existing_user_request'});
    }
    const delta = parent > 2 ? {content:'Integrated the review'} :
      {tool_calls:[{index:0,id:String(parent),function:{name:parent===1?'ask_user':'delegate_tasks',arguments:JSON.stringify(args)}}]};
    return new Response(packet({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]}));
  });
  await host.send('попроси в субагенте чатжпт провести свой анализ');
  const [worker] = session.timeline.find(entry => entry.name === 'delegate_tasks').agents;
  assert.equal(worker.model, 'gpt-6.1-sol');
  assert.equal(worker.result, 'Independent finding from Sol');
  assert.equal(workers, 1);
  assert.equal(questionnaires, 0);
});

test('named Codex and Qwen workers use saved connections while the default worker and parent stay on GLM', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-codex-review-'));
  const host = await createHost({root, storage: path.join(root, '.storage')});
  t.after(async () => { await host.close(); await fs.rm(root, {recursive:true, force:true}); });
  const {app, session} = host;
  const accountId = 'f2423a1a-cffd-4499-9ec1-91af6d75514d';
  const profile = {id:'saved-codex', accountId, label:'Codex', provider:'chatgpt',
    protocol:'responses', baseUrl:'https://api.openai.com/v1', model:'gpt-6.2-sol'};
  const qwen = {id:'saved-qwen', label:'Qwen Coder', provider:'custom', protocol:'chat',
    baseUrl:'https://qwen.example/v1', model:'Qwen/Qwen3-Coder'};
  await app.context.globalState.update('ai.modelConnections', {activeId:null, profiles:[profile,qwen]});
  t.mock.method(app.context.secrets, 'get', async key => {
    if (key === 'ai.chatgpt.' + accountId) return JSON.stringify({access_token:'test-codex-token', expires_at:Date.now()+600000});
    return key === 'ai.modelConnection.' + qwen.id ? 'test-qwen-token' : 'test-glm-token';
  });
  let rootRequests = 0, codexRequests = 0, qwenRequests = 0, glmWorkers = 0;
  app.approve = async (_session, question) => ({answer:question.options[0],source:'option'});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === 'https://api.openai.com/v1/responses') {
      codexRequests++;
      assert.equal(body.model, profile.model);
      assert.equal(options.headers.authorization, 'Bearer test-codex-token');
      assert(body.input.some(item => JSON.stringify(item).includes('Review the route')));
      assert(!body.tools.some(tool => /(?:edit_file|run_command)/.test(tool.name)));
      const output = [{type:'message',content:[{type:'output_text',text:'Codex finding'}]}];
      return new Response(packet({type:'response.completed', response:{status:'completed',output,usage:{input_tokens:23,output_tokens:4}}}));
    }
    if (url === qwen.baseUrl + '/chat/completions') {
      qwenRequests++;
      assert.equal(body.model, qwen.model);
      assert.equal(options.headers.authorization, 'Bearer test-qwen-token');
      assert(!body.tools.some(tool => /(?:edit_file|run_command)/.test(tool.function.name)));
      return new Response(packet({choices:[{delta:{content:'Qwen finding'},finish_reason:'stop'}],usage:{prompt_tokens:19,completion_tokens:3}}));
    }
    assert.equal(options.headers.authorization, 'Bearer test-glm-token');
    const isWorker = body.messages[0].content.includes('You are the explore subagent');
    let delta = {content:'GLM finding'}, finish_reason = 'stop';
    if (isWorker) {
      glmWorkers++;
    } else if (++rootRequests === 5) {
      const args = {question:'Which model should review?',options:[qwen.label,'Default worker']};
      delta = {tool_calls:[{index:0,id:'choose',function:{name:'ask_user',arguments:JSON.stringify(args)}}]};
      finish_reason = 'tool_calls';
    } else if ([1, 3, 6].includes(rootRequests)) {
      const delegation = body.tools.find(tool => tool.function.name === 'delegate_tasks');
      assert.match(delegation.function.description, /Qwen\/Qwen3-Coder/);
      const qwenTask = {title:'Qwen review',type:'review',connection_id:qwen.id,prompt:'Review the call site'};
      const tasks = rootRequests === 6 ? [qwenTask] : [
        {title:'Codex review',type:'review',connection_id:profile.id,prompt:'Review the route'},
        qwenTask, {title:'Explore',type:'explore',prompt:'Find another entry point'}];
      delta = {tool_calls:[{index:0,id:'delegate',function:{name:'delegate_tasks',arguments:JSON.stringify({wait:true,tasks})}}]};
      finish_reason = 'tool_calls';
    }
    return new Response(packet({choices:[{delta,finish_reason}]}));
  });
  await host.send('Пусть Codex в субагенте проверит маршрут, Qwen проверит вызов, а обычный субагент найдёт точку входа.');
  const [review, qwenReview, explore] = session.timeline.find(entry => entry.name === 'delegate_tasks').agents;
  assert.equal(review.status, 'done');
  assert.equal(review.provider, 'chatgpt');
  assert.equal(review.model, profile.model);
  assert.equal(review.result, 'Codex finding');
  assert.equal(qwenReview.result, 'Qwen finding');
  assert.equal(qwenReview.model, qwen.model);
  assert.equal(explore.provider, 'glm');
  assert.equal(session.delegatedUsage.chatgpt.input, 23);
  assert.equal(session.delegatedUsage.custom.input, 19);
  assert.equal(session.provider, 'glm');

  await host.send('Запусти обычную проверку субагентами.');
  const rejected = session.timeline.findLast(entry => entry.name === 'delegate_tasks').agents[0];
  assert.equal(rejected.status, 'error');
  assert.match(rejected.result, /explicitly request/);
  assert.equal(codexRequests, 1);
  assert.equal(qwenRequests, 1);
  assert.equal(glmWorkers, 2);

  await host.send('Уточни, какую модель использовать для ревью, и запусти её.');
  const confirmed = session.timeline.findLast(entry => entry.name === 'delegate_tasks').agents[0];
  assert.equal(confirmed.model, qwen.model);
  assert.equal(confirmed.result, 'Qwen finding');
  assert.equal(qwenRequests, 2);
});

test('project Review model and prompt reach the provider, and the tool allowlist stays read-only', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-role-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.harness'));
 await fs.writeFile(path.join(root,'.harness','config.json'),JSON.stringify({roles:{
  review:{model:'glm-review-test',prompt:'Check the saved diff.',tools:['read_file','edit_file']}
 }}));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 let requests=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const payload=JSON.parse(options.body);
  const request=++requests;
  let delta={content:'Report integrated'};
  let finish='stop';
  if(request===1){
   delta={tool_calls:[{index:0,id:'review',function:{name:'delegate_tasks',arguments:JSON.stringify({
    tasks:[{title:'Review fixture',type:'review',prompt:'Check the result.'}]
   })}}]};
   finish='tool_calls';
  }else if(request===2){
   assert.equal(payload.model,'glm-review-test');
   assert.match(payload.messages[0].content,/Check the saved diff\./);
   assert.deepEqual(payload.tools.map(tool=>tool.function.name),['read_file']);
   delta={content:JSON.stringify({outcome:'complete',summary:'Reviewed',findings:[],checks:[],open_questions:[]})};
  }
  return new Response(packet({choices:[{delta,finish_reason:finish}]}));
 });
 await h.send('Review the change');
 assert.equal(requests,3);
 const delegation=h.session.timeline.find(entry=>entry.name==='delegate_tasks');
 assert.equal(delegation.agents[0].model,'glm-review-test');
 assert.equal(delegation.agents[0].report.summary,'Reviewed');
});

test('approved project memory is loaded in another chat and can be forgotten', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-memory-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=path.join(root,'.storage');
 const first=await createHost({root,storage});
 t.after(()=>first.close());
 let requests=0;
 first.app.approve=async(_session,details)=>details.kind==='memory';
 t.mock.method(globalThis,'fetch',async()=>{
  const save=++requests===1;
  const delta=save?{tool_calls:[{index:0,id:'remember',function:{name:'project_memory',arguments:JSON.stringify({
   action:'save', key:'test command', note:'package.json:8 defines npm test.'
  })}}]}:{content:'Saved'};
  return new Response(packet({choices:[{delta,finish_reason:save?'tool_calls':'stop'}]}));
 });
 await first.send('Remember the project test command');
 const second=await createHost({root,storage});
 t.after(()=>second.close());
 assert.match(await second.app.systemPrompt(root,'manual'),/package\.json:8 defines npm test/);
 assert.doesNotMatch(await second.app.systemPrompt(root,'manual',{memory:{enabled:false}}),/package\.json:8 defines npm test/);
 const unrelated=path.join(root,'other');
 await fs.mkdir(unrelated);
 assert.deepEqual(await second.app.projectMemory.list(unrelated),[]);
 second.app.approve=async()=>false;
 const args={action:'forget',key:'test command'};
 await second.app.projectMemoryAction(second.session,root,{},args,new AbortController().signal);
 assert.equal((await second.app.projectMemory.list(root)).length,1);
 second.app.approve=async()=>true;
 await second.app.projectMemoryAction(second.session,root,{},args,new AbortController().signal);
 assert.deepEqual(await second.app.projectMemory.list(root),[]);
});

test('required project hooks ask approval, block completion on refusal and skip Plan', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-hook-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.harness'));
 const command=JSON.stringify(process.execPath)+' -e "console.log(\'fixture passed\')"';
 await fs.writeFile(path.join(root,'.harness','config.json'),JSON.stringify({hooks:[
  {event:'beforeFinish',command,required:true}
 ]}));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 t.mock.method(globalThis,'fetch',async()=>new Response(packet({choices:[{delta:{content:'Answer'},finish_reason:'stop'}]})));
 let approvals=0;
 h.app.approve=async(_session,details)=>{assert.equal(details.kind,'hook');approvals++;return approvals>1;};
 await h.send('Inspect the fixture');
 assert.equal(approvals,1);
 assert.equal(h.session.completion.status,'incomplete');
 assert.match(h.session.completion.gaps[0],/Required project hook/);
 await h.send('Retry the check');
 assert.equal(approvals,2);
 assert.equal(h.session.completion.status,'complete');
 assert(h.session.timeline.some(entry=>entry.name==='project_hook'&&entry.result.includes('fixture passed')));
 h.session.mode='plan';
 await h.send('Plan the next change');
 assert.equal(approvals,2);
});

test('Architecture reviews its changed revision in a fresh read-only context and retains blockers', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-architecture-review-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'before');
 const calls=(id,name,args)=>({tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify(args)}}]});
 const h=await createHost({root,storage:path.join(root,'.storage'),settings:{workProfile:'architecture'},
  approveCommand:async()=>({allow:true,execution:{file:process.execPath,args:['-e','process.exit(0)']}})});
 t.after(()=>h.close());
 let parent=0, reviewers=0;
 t.mock.method(globalThis,'fetch',async(_url,o)=>{
  const payload=JSON.parse(o.body);
  let delta;
  if(payload.messages[0].content.includes('You are an independent software architecture reviewer')){
   reviewers++;
   assert.equal(payload.model,'glm-5.3');
   assert(!payload.tools.some(tool=>['edit_file','run_command','delegate_tasks'].includes(tool.function.name)));
   const packetText=payload.messages[1].content;
   assert.match(packetText,/"before":\{"text":"before","truncated":false\},"after":\{"text":"after","truncated":false\}/);
   assert.match(packetText,/"commandPassed":true/);
   assert.match(packetText,/Keep the public contract/);
   assert(!packetText.includes('PRIVATE IMPLEMENTER ANSWER'));
   delta={content:JSON.stringify({outcome:'partial',summary:'Contract changed',
    findings:[{claim:'Public contract changed',sources:['main.js:1']}],checks:[],open_questions:[]})};
  }else{
   parent++;
   if(parent===1)delta=calls('edit','edit_file',{path:'main.js',old_text:'before',new_text:'after'});
   else if(parent===2)delta=calls('check','run_command',{command:'node test.js'});
   else delta={content:'PRIVATE IMPLEMENTER ANSWER'};
  }
  return new Response(packet({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}],
   usage:{prompt_tokens:10,completion_tokens:1}}));
 });
 await h.send('Change main.js. Keep the public contract.');
 assert.equal(reviewers,1);
 assert.equal(parent,4);
 assert.equal(h.session.completion.status,'incomplete');
 assert.match(h.session.completion.gaps.join(' '),/Independent architecture review/);
 assert.equal(h.session.usage.input,50);
});

test('Architecture reviews before check reminders and accepts a recorded test the reviewer cannot rerun', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-early-review-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'before');
 const h=await createHost({root,storage:path.join(root,'.storage'),settings:{workProfile:'architecture',regressionAudit:false},
  approveCommand:async()=>({allow:true,execution:{file:process.execPath,args:['-e','process.exit(0)']}})});
 t.after(()=>h.close());
 const call=(id,name,args)=>({tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify(args)}}]});
 const sequence=[];
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const {messages}=JSON.parse(options.body);
  const reviewer=messages[0].content.includes('You are an independent software architecture reviewer');
  const phase=sequence.length;
  sequence.push(reviewer?'review':'parent');
  let delta={content:'Done'};
  if(phase===0)delta=call('edit','edit_file',{path:'main.js',old_text:'before',new_text:'after'});
  if(phase===2){
   assert(reviewer);
   assert.match(messages[1].content,/"checks":\[\]/);
   delta={content:JSON.stringify({outcome:'partial',summary:'Need a behavioral test',
    findings:[],checks:[],open_questions:['Does the public test pass?']})};
  }
  if(phase===3){
   assert.match(messages.at(-1).content,/Independent architecture review.*No current passing behavioral check/s);
   delta=call('test','run_command',{command:'node test.js'});
  }
  if(phase===5){
   assert(reviewer);
   assert.match(messages[1].content,/"id":"[^"]+","command":"node test\.js".*?"commandPassed":true/);
   assert.match(messages[1].content,/put that limitation in limitations/);
   delta={content:JSON.stringify({outcome:'complete',summary:'Read the recorded passing test',
    findings:[],checks:['Recorded node test.js passed'],open_questions:[],
    limitations:['Read-only reviewer could not rerun the recorded test.']})};
  }
  return new Response(packet({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]}));
 });
 await h.send('Change main.js and verify it.');
 assert.deepEqual(sequence,['parent','parent','review','parent','parent','review']);
 assert.equal(h.session.completion.status,'complete');
 assert.equal(h.session.timeline.filter(entry=>entry.name==='architecture_review').length,2);
});

test('Architecture keeps a passing check when the reviewer exhausts its budget', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-review-budget-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'before');
 const h=await createHost({root,storage:path.join(root,'.storage'),settings:{workProfile:'architecture'},
  approveCommand:async()=>({allow:true,execution:{file:process.execPath,args:['-e','process.exit(0)']}})});
 t.after(()=>h.close());
 let parent=0, reviews=0;
 const call=(name,args)=>({tool_calls:[{index:0,id:name,function:{name,arguments:JSON.stringify(args)}}]});
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const {messages}=JSON.parse(options.body);
  const reviewing=messages[0].content.includes('You are an independent software architecture reviewer');
  if(reviewing)reviews++;else parent++;
  const delta=reviewing?call('read_file',{path:'main.js'}):parent===1
   ?call('edit_file',{path:'main.js',old_text:'before',new_text:'after'}):parent===2
   ?call('run_command',{command:'node test.js'}):{content:'Done'};
  return new Response(packet({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}],
   usage:{prompt_tokens:reviewing?33000:10,completion_tokens:1}}));
 });
 await h.send('Change main.js and verify it.');
 assert.equal(reviews,1);
 assert.equal(parent,3);
 assert.equal(h.session.timeline.find(event=>event.name==='architecture_review').status,'limited');
 assert.equal(h.session.completion.status,'complete');
});

test('Architecture records unresolved checks when early review runs in the last allowed round', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-review-final-round-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'before');
 const h=await createHost({root,storage:path.join(root,'.storage'),
  settings:{workProfile:'architecture',maxToolRounds:2,regressionAudit:false}});
 t.after(()=>h.close());
 let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{
  const request=++requests;
  const delta=request===1?{tool_calls:[{index:0,id:'edit',function:{name:'edit_file',
   arguments:'{"path":"main.js","old_text":"before","new_text":"after"}'}}]}:
   {content:request===2?'Proposed final':JSON.stringify({outcome:'complete',summary:'Diff checked',
    findings:[],checks:[],open_questions:[],limitations:['Review did not run commands.']})};
  return new Response(packet({choices:[{delta,finish_reason:request===1?'tool_calls':'stop'}]}));
 });
 await h.send('Change main.js');
 assert.equal(requests,3);
 assert.equal(h.session.completion.status,'incomplete');
 assert.match(h.session.completion.gaps.join(' '),/No current passing behavioral check/);
});

test('check receipts become stale when a user edits a pinned input outside Harness', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-check-input-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'tracked');
 await fs.writeFile(path.join(root,'seed.json'),'{"value":1}');
 const h=await createHost({root,storage:path.join(root,'.storage'),
  approveCommand:async()=>({allow:true,execution:{file:process.execPath,args:['-e','process.exit(0)']}})});
 t.after(()=>h.close());
 h.session.taskId='task';
 h.session.turnId='turn';
 h.session.turnChanges=['main.js'];
 h.session.plan={acceptance:['reads seed']};
 const receipt=JSON.parse(await h.app.serviceTool('verify_task',{
  command:'node test.js',description:'Check seed reader',criteria:['reads seed'],inputs:['seed.json'],
  scenarios:[{criterion:'reads seed',input:'{"value":1}',expected:'value is 1'}]
 },h.session,root,new AbortController().signal,{}));
 assert.equal(receipt.scenarios.length,1);
 assert.equal(receipt.commandPassed,true);
 await fs.writeFile(path.join(root,'seed.json'),'{"value":2}');
 await h.app.refreshCheckFingerprints(h.session,root);
 assert.equal(h.session.checks.at(-1).stale,true);
 const {completionGaps}=require('../src/verification');
 assert(completionGaps(h.session).some(gap=>gap.includes('reads seed')));
});

test('a passing hook closes its command criterion and can link behavior without another run', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-hook-evidence-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'tracked');
 await fs.writeFile(path.join(root,'seed.json'),'[1]');
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 const signal=new AbortController().signal;
 const criterion='Restores the seed';
 Object.assign(h.session,{taskId:'task',turnId:'turn',turnChanges:['main.js'],plan:{acceptance:['node test.js exits 0',criterion]}});
 let runs=0;
 h.app.approve=async()=>{runs++;return {allow:true,execution:{file:process.execPath,args:['-e','console.log("restores seed")']}};};
 await h.app.runProjectHooks([{event:'beforeFinish',command:'node test.js',inputs:['seed.json']}],'beforeFinish',h.session,root,signal);
 const [receipt]=h.session.checks;
 const {completionGaps}=require('../src/verification');
 assert.deepEqual(completionGaps(h.session),['Unverified acceptance criterion: '+criterion]);
 const args={id:receipt.id,criteria:[criterion],coverage:'The fixture checks the restored value.'};
 await h.app.serviceTool('link_check',args,h.session,root,signal,{});
 assert.deepEqual(completionGaps(h.session),[]);
 assert.equal(runs,1);
 await fs.writeFile(path.join(root,'seed.json'),'[2]');
 await assert.rejects(h.app.serviceTool('link_check',args,h.session,root,signal,{}),/current/);
 assert.equal(receipt.stale,true);
});

test('call evidence checks exact callsites, definitions and branch lines', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-call-proof-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'function route(x){\n if(!x) return;\n return dispatch(x);\n}\nfunction dispatch(x){return x;}');
 const {verifySourceEdges}=require('../src/source-evidence');
 const edge={caller:'route',callee:'dispatch',
  call:{path:'main.js',line:3,excerpt:'dispatch(x)'},
  definition:{path:'main.js',line:5,excerpt:'function dispatch'},
  condition:{path:'main.js',line:2,excerpt:'if(!x) return'}};
 const [verified]=await verifySourceEdges(root,[edge]);
 assert.equal(verified.call.sha256,verified.condition.sha256);
 const [located, mismatch, missing] = await verifySourceEdges(root,[
  {...edge,call:{path:'main.js',line:3}},
  {...edge,call:{...edge.call,line:2,excerpt:'x'.repeat(500)}},
  {...edge,call:{path:'main.js',line:99}}
 ]);
 assert.equal(located.call.excerpt,'return dispatch(x);');
 assert.equal(mismatch.call.status,'excerpt_mismatch');
 assert.equal(mismatch.call.excerpt,'if(!x) return;');
 assert.equal(mismatch.definition.status,'located');
 assert.equal(missing.call.status,'out_of_range');
});

test('opted-in Architecture checks overlap review and finish on the same revision',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-parallel-review-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'main.js'),'before');
 await fs.mkdir(path.join(root,'.harness'));
 await fs.writeFile(path.join(root,'.harness','config.json'),JSON.stringify({hooks:[
  {event:'beforeFinish',command:'node test.js',parallel_review:true}
 ]}));
 const h=await createHost({root,storage:path.join(root,'.storage'),settings:{workProfile:'architecture'}});
 t.after(()=>h.close());
 let reviewActive=false,requests=0;
 let finishCheck;
 const checked=new Promise(resolve=>{finishCheck=resolve;});
 h.app.reviewArchitecture=async(_session,_root,_id,options)=>{
  reviewActive=true;
  assert.deepEqual(options.pendingChecks,['node test.js']);
  await checked;
  return {status:'done',report:{findings:[],open_questions:[]}};
 };
 h.app.runProjectHooks=async(_hooks,event,session)=>{
  if(event!=='beforeFinish')return;
  assert(reviewActive);
  require('../src/verification').recordCheck(session,{
   command:'node test.js',category:'project-check',output:'Exit code: 0\n'
  });
  finishCheck();
 };
 t.mock.method(globalThis,'fetch',async()=>{
  const first=++requests===1;
  const delta=first?{tool_calls:[{index:0,id:'edit',function:{name:'edit_file',
   arguments:'{"path":"main.js","old_text":"before","new_text":"after"}'}}]}:{content:'Done'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 await h.send('Update main.js.');
 assert.equal(requests,2);
 assert.equal(h.session.completion.status,'complete');
});

test('the built-in GLM appears in model choices only when a usable credential is configured', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-model-credentials-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=path.join(root,'home'), claude=path.join(home,'.claude');
 await fs.mkdir(claude,{recursive:true});
 t.mock.method(os,'homedir',()=>home);
 const env=process.env.ZAI_API_KEY;
 delete process.env.ZAI_API_KEY;
 t.after(()=>{ if(env!==undefined)process.env.ZAI_API_KEY=env; });
 const h=await createHost({root,storage:path.join(root,'.storage'),apiKey:''});
 t.after(()=>h.close());
 let packet;
 h.view.postMessage=message=>{packet=message;};
 const saved={id:'saved',provider:'openai',model:'configured-model'};
 h.app.modelConnections.list=()=>[saved];
 for(const settings of [
   {ANTHROPIC_BASE_URL:'https://api.z.ai/api/anthropic'},
   {ANTHROPIC_BASE_URL:'https://api.z.ai/api/anthropic',ANTHROPIC_AUTH_TOKEN:'  '},
   {ANTHROPIC_BASE_URL:'https://api.anthropic.com',ANTHROPIC_AUTH_TOKEN:'unrelated-key'}
 ]){
   await fs.writeFile(path.join(claude,'settings.json'),JSON.stringify({env:settings}));
   await h.app.state(h.view);
   assert.equal(packet.provider.configured,false);
   assert.deepEqual(packet.modelConnections,[saved]);
 }
 await fs.writeFile(path.join(claude,'settings.json'),JSON.stringify({env:{
   ANTHROPIC_BASE_URL:'https://api.z.ai/api/anthropic',ANTHROPIC_AUTH_TOKEN:'fixture-glm-key'
 }}));
 await h.app.state(h.view);
 assert.equal(packet.provider.configured,true);
 assert.deepEqual(packet.modelConnections.map(model=>model.id),['legacy','saved']);
 assert(!JSON.stringify(packet).includes('fixture-glm-key'));
});

test('streaming state sends a timeline delta for only the revised event',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-ui-delta-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 const packets=[];
 h.view.postMessage=message=>packets.push(JSON.parse(JSON.stringify(message)));
 h.session.timeline=[
  {id:'history',role:'assistant',text:'x'.repeat(12000),status:'done'},
  {id:'active',role:'assistant',text:'one',status:'running'}
 ];
 await h.app.state(h.view);
 h.session.timeline[1].text='one two';
 await h.app.state(h.view);
 assert.equal(packets[0].session.timeline.length,2);
 const delta=packets[1].session.timelineDelta;
 assert.equal(delta.base,packets[0].sequence);
 assert.deepEqual(delta.updates,[[1,h.session.timeline[1]]]);
 assert(JSON.stringify(packets[1]).length < JSON.stringify(packets[0]).length / 5);
});

test('messages queued during slow provider preparation keep their order and delivery IDs', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-send-order-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 let release;
 const paused=new Promise(resolve=>{release=resolve;});
 const realSettings=h.app.sessionSettings.bind(h.app);
 h.app.sessionSettings=async session=>{await paused;return realSettings(session);};
 t.mock.method(globalThis,'fetch',async()=>new Response(packet({choices:[{delta:{content:'Done'},finish_reason:'stop'}]})));
 const first=h.app.send(h.view,'First',[],'11111111-1111-4111-8111-111111111111');
 try {
  await h.app.send(h.view,'Second',[],'22222222-2222-4222-8222-222222222222');
  assert.equal(h.session.queue[0].text,'Second');
 } finally { release(); }
 await first;
 const users=h.session.timeline.filter(event=>event.role==='user');
 assert.deepEqual(users.map(event=>event.text),['First','Second']);
 assert.deepEqual(users.map(event=>event.deliveryId[0]),['1','2']);
 assert.equal(h.session.queue.length,0);
});

test('failed preparation identifies the original delivery without adding a chat duplicate', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-send-failure-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 h.app.sessionSettings=async()=>({model:'glm-5.3',apiKey:''});
 const messages=[];
 h.view.postMessage=message=>messages.push(message);
 const deliveryId='33333333-3333-4333-8333-333333333333';
 await h.app.receive(h.view,{type:'send',text:'Keep this draft',deliveryId});
 assert.equal(messages.find(message=>message.type==='sendFailed')?.deliveryId,deliveryId);
 assert.equal(h.session.timeline.filter(event=>event.role==='user').length,0);
});

test('the Plan agent waits for a user choice and receives it as a tool result', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-question-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 h.session.mode='plan';
 let waiting;
 const shown=new Promise(resolve=>{waiting=resolve;});
 const approve=h.app.approve.bind(h.app);
 h.app.approve=(...args)=>{const result=approve(...args);waiting();return result;};
 let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const payload=JSON.parse(options.body);
  assert(payload.tools.some(tool=>tool.function.name==='ask_user'));
  const first=++calls===1;
  if(!first)assert(payload.messages.some(message=>message.role==='tool'&&JSON.parse(message.content).answer==='Local'));
  const delta=first?{tool_calls:[{index:0,id:'ask',function:{name:'ask_user',
   arguments:'{"decision_id":"deployment-scope","question":"Where should this run?","why":"The deployment mode affects verification.","options":["Local","Remote"]}'}}]}:{content:'Proceeding locally.'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 const running=h.send('Help decide where to run.');
 await shown;
 const id=[...h.app.pending.keys()][0];
 await h.app.receive(h.view,{type:'approval',id,allow:true,auto:true});
 assert.equal(h.app.pending.size,1);
 assert.equal(h.app.pending.get(id).public.why,'The deployment mode affects verification.');
 assert.equal(h.session.mode,'plan');
 await h.app.receive(h.view,{type:'answerQuestion',id,choice:0});
 await running;
 assert.equal(calls,2);
 assert(h.session.timeline.some(event=>event.role==='user'&&event.text==='Local'));
 const decision=h.session.decisions.at(-1);
 assert.equal(decision.id,'deployment-scope');
 assert.equal(decision.answer,'Local');
 const entry=h.app.event(h.session,{role:'tool',name:'update_plan'});
 const plan=JSON.parse(await h.app.serviceTool('update_plan',{
   goal:'Deploy', steps:[], acceptance:['Starts locally'],
   decision_criteria:[{decision_id:decision.id,criterion:'Starts locally'}]
 },h.session,root,new AbortController().signal,entry));
 assert.deepEqual(plan.decisionCriteria,[{decisionId:decision.id,criterionId:plan.criterionRefs[0].id}]);
 const repeated=JSON.parse(await h.app.serviceTool('ask_user',{
   decision_id:'another-id', question:'Where should this run!', options:['Local','Remote']
 },h.session,root,new AbortController().signal,entry));
 assert.equal(repeated.decision_id,decision.id);
 assert.equal(repeated.answer,'Local');
 const signal=new AbortController().signal;
 const reused=JSON.parse(await h.app.serviceTool('ask_user',{
   decision_id:decision.id, question:'Where should this run?', options:['Local','Remote']
 },h.session,root,signal,entry));
 assert.equal(reused.answer,'Local');
 await assert.rejects(h.app.serviceTool('ask_user',{
   decision_id:decision.id, question:'Where should this run?', options:['Remote','Local']
 },h.session,root,signal,entry),/Reuse a decision ID/);
 assert.equal(h.session.decisions.length,1);
 assert.equal(h.app.pending.size,0);
 assert.equal(require('../src/task-state').continuationState(h.session).recentDecisions[0].answer,'Local');

});

test('Plan completes the analysis while preserving pending implementation work', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-plan-completion-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(()=>h.close());
 h.session.mode='plan';
 const steps=[{title:'Fix the resource owner',status:'pending'},{title:'Run the regression test',status:'pending'}];
 let requests=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const {tools}=JSON.parse(options.body);
  assert(!tools.some(tool=>['edit_file','run_command','verify_task'].includes(tool.function.name)));
  const first=++requests===1;
  const delta=first?{tool_calls:[{index:0,id:'plan',function:{name:'update_plan',
   arguments:JSON.stringify({goal:'Propose a resource cleanup change',steps})}}]}:
   {content:'A delayed connection can outlive early cleanup. Wait for settlement before closing clients.'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 await h.send('Analyze the lifecycle and propose a fix without edits.');
 assert.equal(requests,2);
 assert.deepEqual(h.session.plan.steps,steps);
 assert.equal(h.session.completion.status,'complete');
 assert(!h.session.timeline.some(event=>event.role==='notice'));
 const {completionGaps}=require('../src/verification');
 assert.deepEqual(completionGaps({...h.session,mode:'manual'}),steps.map(step=>'Open step: '+step.title));
});

test('both prompt styles teach when to ask and how to use the answer', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-question-policy-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const promptStyle of ['compact','detailed']){
  const h=await createHost({root,storage:path.join(root,promptStyle),settings:{promptStyle}});
  try {
   const prompt=await h.app.systemPrompt(root,'plan');
   assert.match(prompt,/after checking relevant code/);
   assert.match(prompt,/For clear or cheaply reversible decisions, proceed without an interview/);
   assert.match(prompt,/Apply the actual answer to the plan and add a concrete acceptance scenario/);
   assert.match(prompt,/If skipped, do not infer consent/);
   assert.match(prompt,/defer dependent questions until its answer is known/);
   assert.match(prompt,/When explicitly asked to stress-test or grill a plan/);
   assert.match(prompt,/Leave future implementation and test steps pending/);
   assert.match(prompt,/try one concrete counterexample.*dependency contracts/);
   assert.match(prompt,/replace the failing fix in the recommended plan/);
   assert.match(prompt,/Distinguish a mental trace from a reproduced test/);
  } finally { await h.close(); }
 }
});

test('installed extension lookup matches the display name in Plan without shell or a question', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'harness-extension-lookup-'));
 const h = await createHost({root, storage:path.join(root,'.storage'), installedExtensions:[
  {id:'snipeek.glm-token-usage', isActive:true, packageJSON:{displayName:'Harness',name:'glm-token-usage',version:'0.15.16'},
   extensionUri:{scheme:'file',fsPath:path.join(root,'extension')}}
 ]});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 h.session.mode='plan';
 let step = 0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const payload=JSON.parse(options.body);
  if (++step===1) {
   assert(payload.tools.some(tool=>tool.function.name==='find_extensions'));
   return new Response(packet({choices:[{delta:{tool_calls:[{index:0,id:'find',function:{name:'find_extensions',arguments:'{"query":"харнес"}'}}]},finish_reason:'tool_calls'}]}));
  }
  const result=JSON.parse(payload.messages.at(-1).content);
  assert.deepEqual(result.extensions.map(extension=>extension.id),['snipeek.glm-token-usage']);
  assert.equal(result.extensions[0].active,true);
  assert.equal(result.preflightEvidenceId,'find');
  return new Response(packet({choices:[{delta:{content:'Harness is installed.'},finish_reason:'stop'}]}));
 });
 await h.send('найди харнес экстеншен вс коде');
 assert.deepEqual(h.session.timeline.filter(event=>event.role==='tool').map(event=>event.name),['find_extensions']);
 assert.equal(h.app.pending.size,0);
});

test('a web continuation cannot claim full coverage when the opening range was skipped', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-web-coverage-'));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 h.app.web.read=async()=>JSON.stringify({url:'https://example.org/article',title:'Article',snapshot:'v1',offset:5,endOffset:10,totalChars:10,nextOffset:null,text:'tail!'});
 let step=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const payload=JSON.parse(options.body);
  if (++step===1) return new Response(packet({choices:[{delta:{tool_calls:[{index:0,id:'fetch',function:{name:'web_fetch',arguments:'{"url":"https://example.org/article","offset":5}'}}]},finish_reason:'tool_calls'}]}));
  const result=JSON.parse(payload.messages.at(-1).content);
  assert.deepEqual(result.turnCoverage,{complete:false,readChars:5});
  assert.equal(result.preflightEvidenceId,'fetch');
  return new Response(packet({choices:[{delta:{content:'Summary of the fetched excerpt.'},finish_reason:'stop'}]}));
 });
 await h.send('Summarize the end of the article');
 assert.match(h.session.timeline.at(-1).text,/часть извлечённого текста.*Article/);
});

test('local edits without attachments start focused and escalate when exploration continues', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-focused-'));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(root,'main.js'),'function f() { return g(); }');
 await fs.writeFile(path.join(root,'helper.js'),'function g() { return 1; }');
 const payloads=[];
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  const payload=JSON.parse(body);
  payloads.push(payload);
  const path=['main.js','helper.js'][payloads.length-1];
  const delta=path?{tool_calls:[{index:0,id:'read-'+path,function:{name:'read_file',arguments:JSON.stringify({path})}}]}:{content:'Done'};
  return new Response(packet({choices:[{delta,finish_reason:path?'tool_calls':'stop'}]}));
 });
 await h.send('Fix the return value in f.');
 const names=payload=>payload.tools.map(tool=>tool.function.name);
 assert(names(payloads[0]).includes('search_batch'));
 assert(names(payloads[0]).includes('apply_patchset'));
 assert(names(payloads[0]).includes('verify_revision'));
 assert(!names(payloads[0]).includes('repository_docs'));
 assert(names(payloads[2]).includes('repository_docs'));
 const before=payloads.length;
 await h.send('Fix the architecture across modules.');
 assert(names(payloads[before]).includes('repository_docs'));
});

test('architecture turns receive scoped symbol hints before the first model call, with ordinary turns unchanged', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-repo-map-'));
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'harness-repo-map-store-'));
 await fs.mkdir(path.join(root,'src'));
 await fs.mkdir(path.join(root,'dist'));
 await fs.writeFile(path.join(root,'src','server.js'),"import { runTurn } from './worker.js';\napp.post('/chat/completions', runTurn);");
 await fs.writeFile(path.join(root,'src','worker.js'),'export function runTurn() { return "BODY_MUST_NOT_BE_IN_MAP"; }');
 await fs.writeFile(path.join(root,'dist','generated.js'),'export function accidentalDiscovery() {}');
 await fs.writeFile(path.join(root,'README.md'),
  '# Server architecture\n[Worker docs](src/README.md)\nREADME_BODY_NOT_FOR_PROMPT\n```\n# Faux code heading\n```');
 await fs.writeFile(path.join(root,'src','README.md'),'# runTurn execution');
 await fs.writeFile(path.join(root,'dist','README.md'),'# Generated documentation');
 const h=await createHost({root,storage});
 t.after(async()=>{await h.close();await Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(storage,{recursive:true,force:true})]);});
 h.session.mode='plan';
 const payloads=[];
 t.mock.method(globalThis,'fetch',async(_url, options)=>{
  const payload=JSON.parse(options.body);
  payloads.push(payload);
  const first=payloads.length===1;
  const delta=first?{tool_calls:[{index:0,id:'repo-read',function:{name:'read_files',arguments:JSON.stringify({files:[{path:'src/server.js'},{path:'src/worker.js'}]})}}]}:{content:'Answer'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 await h.send('Проследи POST /chat/completions до runTurn');
 await h.send('Спасибо!');
 const repoMap=payloads[0].messages.find(message=>message.content?.includes?.('[Harness repository map'));
 const docs=payloads[0].messages.find(message=>message.content?.includes?.('README navigation hints'));
 assert.match(docs.content,/Server architecture/);
 assert.match(docs.content,/"links":\["src\/README.md"\]/);
 assert.match(docs.content,/runTurn execution/);
 assert.doesNotMatch(docs.content,/README_BODY_NOT_FOR_PROMPT|Generated documentation|Faux code heading/);
 assert.match(repoMap.content,/POST \/chat\/completions@2/);
 assert.match(repoMap.content,/runTurn@1/);
 assert.match(repoMap.content,/read_files/);
 assert.match(repoMap.content,/counterexample/);
 assert.doesNotMatch(repoMap.content,/BODY_MUST_NOT_BE_IN_MAP|accidentalDiscovery/);
 assert.equal(payloads[1].messages.find(message=>message.content===repoMap.content)?.content,repoMap.content);
 assert.match(payloads[1].messages.at(-1).content,/BODY_MUST_NOT_BE_IN_MAP/);
 assert(!payloads[2].messages.some(message=>message.content?.includes?.('[Harness repository map')));
 assert(!h.session.messages.some(message=>message.content?.includes?.('[Harness repository map')));
});

test('repository map follows imports past the initial shortlist to a deep public response', async t => {
 const {compactRepositoryMap}=require('../src/repository-map');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-map-imports-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files={
  'src/index.mjs':"import { runTurn } from './internal/routes/index.mjs';\napp.post('/render', runTurn);",
  'src/internal/routes/index.mjs':"import { publicPayloadOf } from '../out/view.mjs';\nexport function runTurn() { return publicPayloadOf(); }",
  'src/internal/out/view.mjs':"export function publicPayloadOf() {}"
 };
 for(let i=0;i<30;i++)files[`decoy-${i}.js`]='export function unrelated() {}';
 await Promise.all(Object.entries(files).map(async ([name,content])=>{
  const file=path.join(root,name);
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,content);
 }));
 const canonical=await fs.realpath(root);
 const result=await compactRepositoryMap(canonical,'Проследи POST /render до публичного JSON-ответа',{
  findFiles:async()=>Object.keys(files).map(name=>path.join(canonical,name))
 });
 assert.match(result,/POST \/render@2/);
 assert.match(result,/runTurn@2/);
 assert.match(result,/publicPayloadOf@1/);
});

test('optimization checks reject an existing inline guard and a duplicate enclosing guard before recommending an edit', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-proposal-review-'));
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'harness-proposal-store-'));
 const guard="if (env.NODE_ENV !== 'production')";
 const snippet=[`${guard} journal(expensive());`,`${guard} {`,'  journal(other());','}'].join('\n');
 await fs.writeFile(path.join(root,'main.js'),snippet);
 const host=await createHost({root,storage});
 t.after(async()=>{await host.close();await Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(storage,{recursive:true,force:true})]);});
 host.session.mode='plan';
 const proposals=[
  {path:'main.js',line:1,before:'journal(expensive());',after:`${guard} journal(expensive());`},
  {path:'main.js',line:1,before:`${guard} journal(expensive());`,after:`${guard} journal(expensive());`},
  {path:'main.js',line:3,before:'  journal(other());',after:`  ${guard} journal(other());`},
  {path:'main.js',line:3,before:'  journal(other());',after:'  journal(summarize(other()));'}
 ];
 let round=0;
 t.mock.method(globalThis,'fetch',async(_url, options)=>{
  const payload=JSON.parse(options.body);
  assert(payload.tools.some(tool=>tool.function.name==='review_source_change'));
  assert(payload.messages.some(message=>message.content?.includes?.('enclosing if/return')));
  const expected=['source_mismatch','already_present','already_present','distinct_source_change'];
  if(round>0) {
   const result=JSON.parse(payload.messages.at(-1).content);
   assert.equal(result.status,expected[round-1]);
   if(round===1)assert.equal(result.context[0].text,`${guard} journal(expensive());`);
  }
  const proposal=proposals[round];
  const delta=proposal ? {tool_calls:[{index:0,id:'review-'+round,function:{name:'review_source_change',arguments:JSON.stringify(proposal)}}]} : {content:'Reviewed.'};
  round++;
  return new Response(packet({choices:[{delta,finish_reason:proposal?'tool_calls':'stop'}]}));
 });
 await host.send('Предложи безопасный шаг оптимизации.');
 assert.equal(round,5);
 assert.equal(await fs.readFile(path.join(root,'main.js'),'utf8'),snippet);
});

test('command edits invalidate previous checks and a pinned reproduction confirms the patched revision', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-command-reproduction-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);
  const git = require('node:util').promisify(require('node:child_process').execFile);
  await git('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, '.gitignore'), 'generated.tmp\n');
  const main = path.join(root, 'main.js');
  const script = path.join(root, 'test.js');
  await fs.writeFile(main, 'module.exports = false;\n');
  await fs.writeFile(script, "if (!require('./main')) { console.error('feature is disabled'); process.exitCode = 1; }\n");
  await git('git', ['add', 'main.js', 'test.js', '.gitignore'], { cwd: root });
  const patch = "const fs = require('node:fs'); fs.writeFileSync('main.js', 'module.exports = true;\\n'); fs.writeFileSync('generated.tmp', 'ignored');";
  const probe = "if (!require('./main')) { console.error('inline: feature is disabled'); process.exitCode = 1; }";
  const inlineCommand = 'node -e ' + JSON.stringify(probe);
  const host = await createHost({
    root, storage: path.join(directory, 'storage'),
    approveCommand: command => ({
      allow: true, execution: { file: process.execPath, args: command === 'node test.js' ? ['test.js'] : ['-e', command === inlineCommand ? probe : patch] }
    })
  });
  t.after(async () => { await host.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const { app, session } = host;
  const { executeTool } = require('../src/tools');
  const { completionGaps, currentChecks } = require('../src/verification');
  session.taskId = 'latest-task';
  session.turnId = 'turn';
  const signal = new AbortController().signal;
  const event = () => app.event(session, { role: 'tool' });
  const verify = args => app.serviceTool('verify_task', {
    command: 'node test.js', description: 'Run regression test', inputs: ['test.js'], ...args
  }, session, root, signal, event()).then(JSON.parse);

  const baseline = await verify({ reproduction: { exit_code: 1, output_contains: 'feature is disabled' } });
  assert.equal(baseline.reproduction.observed, true);
  const callVerify = args => app.serviceTool('verify_task',args,session,root,signal,event()).then(JSON.parse);
  const inline = await callVerify({command:inlineCommand,description:'Inline probe',
    reproduction:{inline:true,exit_code:1,output_contains:'inline: feature is disabled'}});
  assert.equal(inline.reproduction.observed,true);
  await assert.rejects(callVerify({baseline_id:inline.id}),/before the patch/);
  assert.deepEqual(currentChecks(session), []);
  assert.match(completionGaps(session).join(), /Confirm the observed reproduction/);

  await executeTool('run_command', { command: 'apply test fixture patch' }, app.toolHost(session, root, signal, event()));
  assert.deepEqual(session.turnChanges, ['main.js']);
  assert.notEqual(session.changeLog[0].commandChange.before, session.changeLog[0].commandChange.after);
  const changes = JSON.parse(await app.serviceTool('inspect_changes', {}, session, root, signal, event()));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].current, changes[0].after);

  await fs.appendFile(script, '\n// Changed test.\n');
  await assert.rejects(verify({ baseline_id: baseline.id }), /test or fixtures changed/);
  await fs.writeFile(script, "if (!require('./main')) { console.error('feature is disabled'); process.exitCode = 1; }\n");
  const confirmation = await callVerify({ baseline_id: baseline.id });
  assert.equal(confirmation.baselineId, baseline.id);
  const replay = await callVerify({baseline_id:inline.id});
  assert.equal(replay.baselineId,inline.id);
  assert.equal(replay.command,inlineCommand);
  assert.deepEqual(completionGaps(session), []);

  await fs.writeFile(main, 'module.exports = false;\n');
  await app.refreshCheckFingerprints(session, root);
  assert.match(completionGaps(session).join(), /Confirm the observed reproduction/);
});

test('a bug fix gets one opportunity to record a reproduction before the first source patch', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-repro-flow-'));
  const root=path.join(dir,'workspace');
  await fs.mkdir(root);
  const file=path.join(root,'main.js');
  await fs.writeFile(file,'module.exports = false;');
  const probe="if(!require('./main')) { console.error('value disabled'); process.exitCode=1; }";
  const command='node -e '+JSON.stringify(probe);
  const executed=[];
  const host=await createHost({root,storage:path.join(dir,'storage'),approveCommand:actual=>{
    executed.push(actual);
    return {allow:true,execution:{file:process.execPath,args:['-e',probe]}};
  }});
  host.session.mode='auto';
  t.after(async()=>{await host.close();await fs.rm(dir,{recursive:true,force:true});});
  const patch={path:'main.js',old_text:'false',new_text:'true'};
  let request=0;
  t.mock.method(globalThis,'fetch',async()=>{
    const call=(name,args)=>({tool_calls:[{index:0,id:'call-'+request,function:{name,arguments:JSON.stringify(args)}}]});
    let delta;
    switch(++request) {
      case 1: delta=call('edit_file',patch); break;
      case 2:
        assert.equal(await fs.readFile(file,'utf8'),'module.exports = false;');
        delta=call('verify_task',{command,description:'Check exported value',
          reproduction:{inline:true,exit_code:1,output_contains:'value disabled'}});
        break;
      case 3: delta=call('edit_file',patch); break;
      case 4: {
        const baseline=host.session.checks.find(check=>check.reproduction?.observed);
        delta=call('verify_task',{baseline_id:baseline.id});
        break;
      }
      default: delta={content:'Fixed and verified.'};
    }
    return new Response(packet({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]}));
  });
  await host.send('Fix main.js so it exports true.');
  assert.equal(request,5);
  assert.equal(await fs.readFile(file,'utf8'),'module.exports = true;');
  assert.deepEqual(executed,[command,command]);
  assert.equal(host.session.completion.status,'complete');
});

test('patchset validates every file before writing and revision verification reuses only identical workspaces', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'harness-patch-verify-'));
  await fs.mkdir(path.join(dir,'workspace'));
  const root = await fs.realpath(path.join(dir,'workspace'));
  await fs.writeFile(path.join(root,'main.js'),'exports.value = 0;\n');
  await fs.writeFile(path.join(root,'test.js'),"if(require('./main').value!==2)process.exitCode=1;\n");
  let commands = 0;
  const host = await createHost({root,storage:path.join(dir,'storage'),allowedFiles:['main.js','aux.js'],
    approveCommand:command=>{
      commands++;
      return {allow:true,execution:{file:process.execPath,args:command==='node test.js'?['test.js']:['--check','main.js']}};
    }
  });
  t.after(async()=>{await host.close();await fs.rm(dir,{recursive:true,force:true});});
  const { app, session } = host;
  const vscodeSignals = new AbortController();
  const { executeTool } = require('../src/tools');
  session.taskId='patch';
  session.turnId='turn';
  session.turnChanges=[];
  session.plan={steps:[{title:'Implement',status:'running'}],acceptance:['value is two']};
  const entry = () => app.event(session,{role:'tool',name:'test'});
  const patch = changes => executeTool('apply_patchset',{changes,path:'main.js'},app.toolHost(session,root,vscodeSignals.signal,entry()));
  const main = {path:'main.js',old_text:' = 0',new_text:' = 2'};
  const denied = await patch([main,{path:'test.js',old_text:'!==2',new_text:'!==0'}]);
  assert.match(denied,/rejected/i);
  await assert.rejects(patch([main,{path:'test.js',old_text:'missing',new_text:'no'}]),/match exactly once/);
  assert.equal(await fs.readFile(path.join(root,'main.js'),'utf8'),'exports.value = 0;\n');
  await assert.rejects(patch([main,{path:'main.js',old_text:'value = 0',new_text:'value = 1'}]),/overlap/);
  await patch([main,{old_text:'exports.value',new_text:'/* same export */ exports.value'},
    {path:'aux.js',create:true,new_text:'exports.extra = true;\n'}]);
  assert.equal(await fs.readFile(path.join(root,'main.js'),'utf8'),'/* same export */ exports.value = 2;\n');
  assert.deepEqual(session.turnChanges,['main.js','aux.js']);
  assert.equal(session.changeLog.length,2);

  const args={checks:[
    {name:'Syntax',command:'node --check main.js'},
    {name:'Behavior',command:'node test.js',criteria:['value is two'],inputs:['test.js']}
  ],done_steps:['Implement']};
  const verify=()=>app.serviceTool('verify_revision',args,session,root,vscodeSignals.signal,entry()).then(JSON.parse);
  const first=await verify();
  assert.equal(first.passed,true);
  assert.equal(session.plan.steps[0].status,'done');
  assert.deepEqual(first.remaining,[]);
  assert.equal(commands,2);
  const second=await verify();
  assert.equal(second.passed,true);
  assert(second.checks.every(check=>check.reused));
  assert.equal(commands,2);

  const checkBehavior=(extra={})=>app.serviceTool('verify_task',{
    command:'node test.js',criteria:['value is two'],inputs:['test.js'],...extra
  },session,root,vscodeSignals.signal,entry()).then(JSON.parse);
  const duplicate=await checkBehavior();
  assert.equal(duplicate.id,first.checks[1].id);
  assert.equal(duplicate.reused,true);
  assert.equal(commands,2);
  const forced=await checkBehavior({refresh:true});
  assert.notEqual(forced.id,duplicate.id);
  assert.equal(commands,3);

  await fs.writeFile(path.join(root,'configuration.json'),'{}\n');
  await app.refreshCheckFingerprints(session,root);
  const {currentChecks}=require('../src/verification');
  assert.deepEqual(currentChecks(session),[]);
  const third=await verify();
  assert.equal(third.passed,true);
  assert(third.checks.every(check=>!check.reused));
  assert.equal(commands,5);
});

test('completed plan evidence gets a title and unknown check criteria stay unlinked without blocking a valid patch', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-plan-fields-'));
  const root=path.join(dir,'workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'main.js'),'module.exports = 0;');
  await fs.writeFile(path.join(root,'test.js'),"require('node:assert/strict').equal(require('./main.js'),2);");
  const host=await createHost({root,storage:path.join(dir,'storage'),
    approveCommand:()=>({allow:true,execution:{file:process.execPath,args:['test.js']}})});
  t.after(async()=>{await host.close();await fs.rm(dir,{recursive:true,force:true});});
  const {app,session}=host;
  session.taskId='patch';
  session.turnId='turn';
  const signal=new AbortController().signal;
  const evidence='The caller expects this export.';
  const plan=JSON.parse(await app.serviceTool('update_plan',{goal:'Update the value',steps:[
    {status:'done',evidence},{title:'Change value',status:'pending'}
  ],acceptance:['The user-visible value is two']},session,root,signal,{}));
  assert.equal(plan.steps[0].title,evidence);
  const {goal:omittedGoal,...rest}=plan;
  const partial=JSON.parse(await app.serviceTool('update_plan',{steps:rest.steps},session,root,signal,{}));
  assert.equal(partial.goal,omittedGoal);
  await assert.rejects(app.serviceTool('update_plan',{goal:'Preserve work',steps:[{status:'pending'}]},session,root,signal,{}),/needs a title/);
  const entry=app.event(session,{role:'tool',name:'apply_patchset'});
  const {executeTool}=require('../src/tools');
  const result=JSON.parse(await executeTool('apply_patchset',{
    path:'main.js',changes:[{old_text:' = 0',new_text:' = 2'}],
    verify:{done_steps:['Change value'],checks:[{name:'Behavior',command:'node test.js',criteria:['made-up criterion']}]}
  },app.toolHost(session,root,signal,entry)));
  assert.equal(result.verification.passed,true);
  assert.deepEqual(result.verification.checks[0].unlinkedCriteria,['made-up criterion']);
  assert.deepEqual(session.checks[0].criterionIds,[]);
  assert.equal(session.plan.steps[1].status,'pending');
  assert.equal(await fs.readFile(path.join(root,'main.js'),'utf8'),'module.exports = 2;');
});

test('the tool-round reserve requests a tool-free answer and completes verified edits', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-reserve-'));
  const root=path.join(dir,'workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'main.js'),'exports.value = 0;\n');
  await fs.writeFile(path.join(root,'test.js'),"if(require('./main').value!==2)process.exitCode=1;\n");
  const host=await createHost({root,storage:path.join(dir,'storage'),settings:{maxToolRounds:2},
    approveCommand:()=>({allow:true,execution:{file:process.execPath,args:['test.js']}})});
  t.after(async()=>{await host.close();await fs.rm(dir,{recursive:true,force:true});});
  const requests=[];
  const calls=[
    ['edit_file',{path:'main.js',old_text:' = 0',new_text:' = 2'}],
    ['verify_revision',{checks:[{name:'Behavior',command:'node test.js'}]}]
  ];
  t.mock.method(globalThis,'fetch',async(_url,opts)=>{
    const body=JSON.parse(opts.body);
    const index=requests.push(body)-1;
    const [name,args]=calls[index]||[];
    const delta=name?{tool_calls:[{index:0,id:'call'+index,function:{name,arguments:JSON.stringify(args)}}]}:{content:'Behavior verified.'};
    return new Response(packet({choices:[{delta,finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10}}));
  });
  await host.send('Correct the exported value and run the behavior test.');
  assert.equal(requests.length,3);
  assert.equal(requests.at(-1).tools.length,0);
  assert.equal(host.session.completion.status,'complete');
  assert.match(host.session.timeline.findLast(entry=>entry.role==='assistant').text,/verified/i);
});

test('a long turn reserves patch rounds and continues after a rejected patch and a text-only reply', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-patch-recovery-'));
  const root=path.join(dir,'workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'main.js'),'exports.value = 0;\n');
  await fs.writeFile(path.join(root,'test.js'),"if(require('./main').value!==2)process.exitCode=1;\n");
  const host=await createHost({root,storage:path.join(dir,'storage'),settings:{maxToolRounds:8},
    approveCommand:()=>({allow:true,execution:{file:process.execPath,args:['test.js']}})});
  t.after(async()=>{await host.close();await fs.rm(dir,{recursive:true,force:true});});
  const requests=[];
  const edits=old_text=>[{path:'main.js',old_text,new_text:' = 2'}];
  const check={checks:[{name:'Behavior',command:'node test.js'}]};
  t.mock.method(globalThis,'fetch',async(_url,opts)=>{
    const body=JSON.parse(opts.body);
    const index=requests.push(body)-1;
    const action=index<5 ? ['read_file',{path:'main.js'}]
      : index===5 ? ['apply_patchset',{changes:edits(' = stale'),verify:check}]
      : index===7 ? ['apply_patchset',{changes:edits(' = 0'),verify:check}] : null;
    const delta=action?{tool_calls:[{index:0,id:'call'+index,function:{name:action[0],arguments:JSON.stringify(action[1])}}]}
      : {content:index===6?'The patch needs a correction.':'Behavior verified.'};
    if(index===5)delta.tool_calls.unshift({index:1,id:'late-search',function:{name:'search_files',arguments:'{"query":"value"}'}});
    return new Response(packet({choices:[{delta,finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10}}));
  });
  await host.send('Correct the exported value and run the behavior test.');
  assert.equal(requests.length,9);
  assert.deepEqual(requests[5].tools,requests[4].tools);
  assert.match(requests[5].messages.at(-1).content,/Broad searches and new delegation are paused/);
  assert.ok(requests[7].tools.some(tool=>tool.function.name==='apply_patchset'));
  assert.match(requests[7].messages.at(-1).content,/Continue the current task in this turn/);
  assert.equal(requests[8].tools.length,0);
  assert.equal(await fs.readFile(path.join(root,'main.js'),'utf8'),'exports.value = 2;\n');
  assert.equal(host.session.completion.status,'complete');
  const [rejected,applied]=host.session.timeline.filter(entry=>entry.name==='apply_patchset');
  assert.equal(rejected.status,'error');
  assert.equal(JSON.parse(applied.result).verification.passed,true);
  assert.match(host.session.timeline.find(entry=>entry.name==='search_files').result,/reserved for a patch or verification/);
});

test('test assertions reach the opening request and a plan pivot reads only missing rows', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-research-pivot-'));
  const host=await createHost({root,storage:path.join(root,'.storage')});
  t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'src'));
  await fs.mkdir(path.join(root,'test'));
  await fs.writeFile(path.join(root,'src/audit.js'),'const ready = true;\nexports.readAudit = () => ready;\nexports.version = 2;');
  await fs.writeFile(path.join(root,'test/audit.test.js'),"const {readAudit} = require('../src/audit.js');\nassert.equal(readAudit(), true);");
  const calls=[
    ['read_file',{path:'src/audit.js',start_line:1,end_line:2}],
    ['update_plan',{goal:'Check the audit source',steps:[{title:'Read the caller',status:'running'}],owner:'first guess'}],
    ['update_plan',{steps:[{title:'Read the caller',status:'done'}],owner:'verified owner'}],
    ['read_file',{path:'src/audit.js',start_line:1,end_line:3}]
  ];
  let index=0;
  t.mock.method(globalThis,'fetch',async(_url,{body})=>{
    const request=JSON.parse(body);
    if(index===0)assert.match(JSON.stringify(request.messages),/2: assert.equal\(readAudit\(\), true\)/);
    const action=calls[index++];
    const delta=action?{tool_calls:[{index:0,id:'call'+index,function:{name:action[0],arguments:JSON.stringify(action[1])}}]}
      : {content:'Source and test were checked.'};
    return new Response(packet({choices:[{delta,finish_reason:action?'tool_calls':'stop'}]}));
  });
  await host.send('Inspect src/audit.js and test/audit.test.js and confirm the owner.');
  assert.ok(host.session.timeline.some(event=>event.planBranch?.to==='verified owner'));
  const followup=JSON.parse(host.session.timeline.findLast(event=>event.name==='read_file').result);
  assert.equal(followup.content,'3: exports.version = 2;\n');
  assert.deepEqual(followup.previouslyRead,[[1,2]]);
  const metrics=require('../src/research-coverage').researchCoverage(host.session.timeline,[
    {path:'test/audit.test.js',start:2,end:2},{path:'src/audit.js',start:3,end:3}
  ]);
  assert.equal(metrics.branches.at(-1).newRequired,1);
});

test('high effort retries once at low effort when adaptive and honors a fixed effort', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-adaptive-output-'));
  const root=path.join(dir,'workspace');
  await fs.mkdir(root);
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const policy of ['adaptive','fixed']){
    const host=await createHost({root,storage:path.join(dir,policy),settings:{reasoningEffort:'high',effortPolicy:policy}});
    const efforts=[];
    const mock=t.mock.method(globalThis,'fetch',async(_url,options)=>{
      const request=JSON.parse(options.body);
      const index=efforts.push(request.reasoning_effort);
      return new Response(packet({choices:[{
        delta:index===1?{}:{content:'Recovered with a shorter answer.'},
        finish_reason:index===1?'length':'stop'
      }],usage:{prompt_tokens:100,completion_tokens:10}}));
    });
    try{
      await host.send('Analyze the sample.');
      assert.deepEqual(efforts,policy==='adaptive'?['high','low']:['high']);
      assert.equal(host.session.completion.status,policy==='adaptive'?'complete':'incomplete');
    }finally{mock.mock.restore();await host.close();}
  }
});

test('adaptive GLM starts read-only research at low and keeps fixed effort',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-plan-effort-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const effortPolicy of ['adaptive','fixed']){
    const host=await createHost({root:dir,storage:path.join(dir,effortPolicy),settings:{reasoningEffort:'high',effortPolicy}});
    host.session.mode='plan';
    const efforts=[];
    const mock=t.mock.method(globalThis,'fetch',async(_url,options)=>{
      efforts.push(JSON.parse(options.body).reasoning_effort);
      return new Response(packet({choices:[{delta:{content:'The source establishes the owner.'},finish_reason:'stop'}]}));
    });
    try {
      await host.send('Analyze the architecture without editing.');
      assert.deepEqual(efforts,[effortPolicy==='adaptive'?'low':'high']);
    } finally {mock.mock.restore();await host.close();}
  }
});

test('patchset can save connected edits and verify behavior in the same tool call', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-inline-verify-'));
  const root=path.join(dir,'workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'main.js'),'exports.value = 0;\n');
  await fs.writeFile(path.join(root,'test.js'),"if(require('./main').value!==2 || !require('./aux').ready)process.exitCode=1;\n");
  const host=await createHost({root,storage:path.join(dir,'storage'),allowedFiles:['main.js','aux.js'],settings:{maxToolRounds:1},
    approveCommand:()=>({allow:true,execution:{file:process.execPath,args:['test.js']}})});
  t.after(async()=>{await host.close();await fs.rm(dir,{recursive:true,force:true});});
  let requests=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);
    const first=requests++===0;
    if(!first)assert.equal(body.tools.length,0);
    const delta=first?{tool_calls:[{index:0,id:'patch-with-checks',function:{name:'apply_patchset',arguments:JSON.stringify({
      changes:[
        {path:'main.js',old_text:' = 0',new_text:' = 2'},
        {path:'aux.js',create:true,new_text:'exports.ready = true;\n'}
      ],
      verify:{checks:[{name:'Updated exports',command:'node test.js'}]}
    })}}]}:{content:'Both files saved and verified.'};
    return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10}}));
  });
  await host.send('Set value and add the readiness module. Verify together.');
  const tool=host.session.timeline.find(event=>event.name==='apply_patchset');
  const result=JSON.parse(tool.result);
  assert.deepEqual(result.updated,['main.js','aux.js']);
  assert.equal(result.verification.passed,true);
  assert.equal(host.session.completion.status,'complete');
  assert.equal(requests,2);
});

test('round-limited Plan preserves up to 4096 output tokens for the final synthesis',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-plan-final-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const host=await createHost({root,storage:path.join(root,'state'),settings:{maxToolRounds:1,maxOutputTokens:5000}});
 host.session.mode='plan';
 const requests=[];
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  requests.push(JSON.parse(body));
  return new Response(packet({choices:[requests.length===1
   ? {delta:{tool_calls:[{index:0,id:'files',function:{name:'list_files',arguments:'{}'}}]},finish_reason:'tool_calls'}
   : {delta:{content:'Source-backed plan.'},finish_reason:'stop'}]}));
 });
 try {
  await host.send('Analyze ownership and propose a minimal plan.');
  assert.equal(requests.length,2);
  assert.equal(requests[1].max_tokens,4096);
  assert.deepEqual(requests[1].tools,[]);
  assert.match(host.session.timeline.at(-1).text,/Source-backed plan/);
 }finally{await host.close();}
});

test('patchset approvals keep the chat in place and only open a diff on request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'harness-patchset-diff-'));
  const {app,session,view,close}=await createHost({root,storage:path.join(root,'.storage')});
  t.after(async()=>{await close();await fs.rm(root,{recursive:true,force:true});});
  app.panels.set(session.id,{active:true});
  const opened=[];
  app.showDiff=async (...args)=>{opened.push(args);};
  const controller=new AbortController();
  t.after(()=>controller.abort());
  const request=Object.getPrototypeOf(app).toolHost.call(app,session,root,controller.signal,{name:'apply_patchset'});
  const first=path.join(root,'one.js'),second=path.join(root,'two.js');
  const one=request.approveEdit(first,'old one','new one');
  const two=request.approveEdit(second,'old two','new two');
  assert.deepEqual(opened,[]);
  const [idOne,idTwo]=[...app.pending.keys()];
  await app.receive(view,{type:'approval',id:idOne,allow:true});
  assert.equal(await one,true);
  assert.deepEqual(opened,[]);
  await app.receive(view,{type:'diff',id:idTwo});
  assert.deepEqual(opened,[[second,'old two','new two']]);
  await app.receive(view,{type:'approval',id:idTwo,allow:true});
  assert.equal(await two,true);

  const single=Object.getPrototypeOf(app).toolHost.call(app,session,root,controller.signal,{name:'edit_file'});
  const ordinary=single.approveEdit(first,'old one','new one');
  assert.deepEqual(opened.at(-1),[first,'old one','new one']);
  const [idSingle]=[...app.pending.keys()];
  await app.receive(view,{type:'approval',id:idSingle,allow:true});
  assert.equal(await ordinary,true);
});

test('deployment preflight blocks execution until a successful tool result is cited', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-deploy-preflight-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const approved=[];
 const h=await createHost({root,storage:path.join(root,'.storage'),approveCommand:async command=>{approved.push(command);return true;}});
 t.after(()=>h.close());
 const command='printf "%s\\n" "docker compose up"';
 const check='printf "postgres reachable\\n"';
 const preflight={outcome:'Confirm HTTPS readiness',alternative:'Use existing image; start dependencies only',checks:['precheck']};
 const steps=[
  ['missing',command,{}],
  ['failed','exit 7',{}],
  ['bad-evidence',command,{preflight:{...preflight,checks:['failed']}}],
  ['precheck',check,{}],
  ['launch',command,{preflight}]
 ];
 let i=0;
 t.mock.method(globalThis,'fetch',async()=>{
  const next=steps[i++];
  if(!next)return new Response(packet({choices:[{delta:{content:'Readiness fixture complete.'},finish_reason:'stop'}]}));
  const [id,command,args]=next;
  return new Response(packet({choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name:'run_command',arguments:JSON.stringify({command,...args})}}]},finish_reason:'tool_calls'}]}));
 });
 await h.send('Deploy the sample stack.');
 const results=h.session.timeline.filter(e=>e.name==='run_command');
 assert.match(results[0].result,/Preflight.*did not start/);
 assert.match(results[2].result,/Preflight.*did not start/);
 assert.match(results[4].result,/Exit code: 0/);
 assert.equal(results[4].background,true);
 assert.match(results[4].result,/full log artifact:/);
 assert.equal(i,6);
 assert.deepEqual(approved,['exit 7',check,command]);
});

test('Stop starts the queued message in the same conversation once',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-stop-queue-'));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 let calls=0;const started=Promise.withResolvers();
 t.mock.method(globalThis,'fetch',async(_url,{signal,body})=>{
   if(++calls===1){
    started.resolve();
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
   }
   assert(JSON.parse(body).messages.some(m=>m.role==='user'&&m.content==='Next message'));
   return new Response(packet({choices:[{delta:{content:'Follow-up complete'},finish_reason:'stop'}]}));
 });
 const running=h.send('First message'); await started.promise;
 const deliveryId='11111111-1111-4111-8111-111111111111';
 await h.app.send(h.view,'Next message',[],deliveryId);
 await h.app.receive(h.view,{type:'stop'}); await running;
 assert.equal(calls,2);
 assert.equal(h.session.queue.length,0);
 assert.equal(h.session.timeline.filter(e=>e.deliveryId===deliveryId).length,1);
 assert.equal(h.session.userUpdates.filter(e=>e.content==='Next message').length,1);
});

test('session titles use a short summary and preserve a manual rename during generation', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-title-'));
 const h=await createHost({root,storage:path.join(root,'.storage'),generateTitles:true});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 let response=Promise.withResolvers();
 t.mock.method(globalThis,'fetch',async()=>response.promise);
 const title=()=>h.app.nameSession(h.session,{provider:'glm',protocol:'chat',baseUrl:'https://api.z.ai/api/coding/paas/v4',model:'glm-5.3',apiKey:'test'},'а можешь посмотреть почему клики теряются');
 const generated=title();
 await h.app.rename(h.session.id,'Ручное имя');
 const reply=()=>new Response(packet({choices:[{delta:{content:'Потеря кликов в меню'},finish_reason:'stop'}]}));
 response.resolve(reply());
 await generated;
 assert.equal(h.session.title,'Ручное имя');
 delete h.session.titleCustomized;
 h.session.title='New conversation';
 response=Promise.withResolvers(); response.resolve(reply());
 await title();
 assert.equal(h.session.title,'Потеря кликов в меню');
});

test('the first message names the chat while the agent response is pending', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-early-title-'));
 const h=await createHost({root,storage:path.join(root,'.storage'),generateTitles:true});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 const agent=Promise.withResolvers(), naming=Promise.withResolvers();
 const original=h.app.nameSession.bind(h.app);
 h.app.nameSession=(...args)=>original(...args).then(naming.resolve);
 const first='Почему теряются клики в меню?';
 const reply=content=>new Response(packet({choices:[{delta:{content},finish_reason:'stop'}]}));
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  const payload=JSON.parse(body);
  if(payload.messages[0].content.startsWith('Summarize the first user message')){
   assert.deepEqual(JSON.parse(payload.messages[1].content),{request:first});
   return reply('Потеря кликов в меню');
  }
  return agent.promise;
 });
 const turn=h.send(first);
 try {
  await naming.promise;
  assert.equal(h.session.title,'Потеря кликов в меню');
  assert(h.app.runs.has(h.session.id));
  assert.equal((await h.app.store.load()).find(session=>session.id===h.session.id)?.title,h.session.title);
 } finally {
  agent.resolve(reply('Проверил обработчик.'));
  await turn;
 }
});

test('a running command can move to the background without relaunch and returns its completion once',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-promote-'));
 const command='printf starting; sleep .7; printf FINAL_MARKER';
 let approvals=0;
 const h=await createHost({root,storage:path.join(root,'.storage'),approveCommand:async c=>{assert.equal(c,command);approvals++;return true;}});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  const messages=JSON.parse(body).messages;
  if(++calls===1)return new Response(packet({choices:[{delta:{tool_calls:[{index:0,id:'move',type:'function',function:{name:'run_command',arguments:JSON.stringify({command})}}]},finish_reason:'tool_calls'}]}));
  const receipt=JSON.parse(messages.find(m=>m.role==='tool').content);
  assert(receipt.background);
  assert.notEqual(receipt.task_id,receipt.process_id);
  const completions=messages.filter(m=>m.role==='user'&&m.content.includes('[Background task results')&&m.content.includes('FINAL_MARKER'));
  assert.equal(completions.length,1);
  assert(completions[0].content.includes(receipt.process_id));
  return new Response(packet({choices:[{delta:{content:completions.length?'Final result seen':'Waiting for completion'},finish_reason:'stop'}]}));
 });
 const turn=h.send('Run the check');
 let entry;
 for(let i=0;i<100;i++){
  entry=h.session.timeline.find(e=>e.name==='run_command'&&e.canBackground);
  if(entry)break;
  await new Promise(r=>setTimeout(r,5));
 }
 assert(entry);
 await h.app.receive(h.view,{type:'backgroundCommand',id:entry.id});
 await turn;
 assert.equal(approvals,1);
 assert.equal(h.app.services.processes.size,1);
 assert.equal(calls,2);
 assert(!h.session.timeline.find(e=>e.name==='run_command').result.includes('FINAL_MARKER'));
 assert.equal(h.session.messages.filter(m=>m.role==='user'&&m.content.includes('[Background task results')).length,1);
 assert.equal(h.session.timeline.filter(e=>e.role==='assistant').at(-1).text,'Final result seen');
});

test('the parent can resume a checkpointed worker through the production tool path', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-resume-tool-'));
 const host=await createHost({root,storage:path.join(root,'storage')});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 host.session.mode='plan';
 let parent=0,worker=0,id;
 const call=(name,args)=>({tool_calls:[{index:0,id:name,function:{name,arguments:JSON.stringify(args)}}]});
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
   const {messages,tools}=JSON.parse(options.body);
   let delta;
   if(messages[0].content.includes('You are the explore subagent:')){
     if(++worker===2){
       assert(messages.some(m=>m.role==='assistant'&&m.content==='Prior verified finding.'));
       assert.match(messages.at(-1).content,/Check the remaining edge/);
     }
     delta={content:worker===1?'Prior verified finding.':'Edge confirmed.'};
   }else if(++parent===1){
     delta=call('delegate_tasks',{wait:true,tasks:[{title:'Investigate',type:'explore',prompt:'Find evidence'}]});
   }else if(parent===3){
     assert(tools.some(tool=>tool.function.name==='resume_agent'));
     delta=call('resume_agent',{id,prompt:'Check the remaining edge'});
   }else delta={content:'Evidence integrated.'};
   return new Response(packet({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]}));
 });
 await host.send('Investigate');
 [id]=Object.keys(host.session.agentCheckpoints);
 assert(id);
 const [stored]=await host.app.store.load();
 assert.equal(stored.agentCheckpoints[id].messages.at(-1).content,'Prior verified finding.');
 await host.send('Continue subagent '+id);
 assert.equal(worker,2);
 assert.equal(host.session.timeline.findLast(event=>event.name==='resume_agent').agents[0].id,id);
});

test('a goal automatically continues after an independent finding and accepts only after a clear verdict', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-goal-test-'));
 const host=await createHost({root,storage:path.join(root,'storage')});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 host.session.mode='plan';
 let parent=0, reviews=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
   const {messages,tools=[]}=JSON.parse(options.body);
   let content;
   if(messages[0].content.includes('You are the review subagent:')){
     const task=messages.find(message=>message.role==='user').content;
     assert.match(task,/Explain the save contract/);
     assert(!tools.some(tool=>['edit_file','run_command'].includes(tool.function.name)));
     const first=++reviews===1;
     content=JSON.stringify({outcome:first?'partial':'complete',summary:first?'False case missing':'All cases covered',
       findings:first?[{claim:'Verify the false case',sources:['index.js:1']}]:[],checks:['Compared acceptance criteria and source.'],open_questions:[]});
   } else {
     if(++parent===2)assert(messages.some(message=>message.role==='user'&&message.content.includes('Verify the false case')));
     content=parent===1?'Initial contract summary':'Contract covers false and empty input.';
   }
   return new Response(packet({choices:[{delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:5,prompt_tokens_details:{cached_tokens:20}}}));
 });
 await host.send('/goal --budget 2000 --turns 3 Explain the save contract');
 assert.equal(parent,2);
 assert.equal(reviews,2);
 assert.equal(host.session.goal.status,'complete');
 assert.equal(host.session.goal.spent,420);
 assert.equal(host.session.goal.turns,2);
 assert.equal(host.session.userUpdates.length,1);
 assert.equal(host.session.taskId,host.session.goal.taskId);
 assert.equal((await host.app.store.load())[0].goal.status,'complete');
});

test('a goal stops on budget before executing a tool and keeps the transcript valid', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-goal-budget-'));
 const host=await createHost({root,storage:path.join(root,'storage')});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 host.session.mode='plan';
 let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{
   requests++;
   return new Response(packet({choices:[{delta:{tool_calls:[{index:0,id:'over-budget',
     function:{name:'read_file',arguments:'{"path":"irrelevant.js"}'}}]},finish_reason:'tool_calls'}],
     usage:{prompt_tokens:1000,completion_tokens:50}}));
 });
 await host.send('/goal --budget 1000 Inspect the source');
 assert.equal(host.session.goal.status,'blocked');
 assert.match(host.session.goal.reason,/бюджет цели/);
 assert.equal(requests,1);
 assert(!host.session.messages.some(message=>message.tool_calls?.some(call=>call.id==='over-budget')));
 assert(!host.session.timeline.some(event=>event.name==='read_file'));
});

test('a paused goal stops the active request and resumes the same task only on command', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-goal-pause-'));
 const host=await createHost({root,storage:path.join(root,'storage')});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 host.session.mode='plan';
 const started=Promise.withResolvers();
 let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
   if(++calls===1){
     started.resolve();
     await new Promise((_,reject)=>{
       if(options.signal.aborted)reject(options.signal.reason);
       else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
     });
   }
   const isReview=JSON.parse(options.body).messages[0].content.includes('You are the review subagent:');
   const content=isReview?JSON.stringify({outcome:'complete',summary:'Evidence accepted',findings:[],checks:['Compared source.'],open_questions:[]}):'Source checked.';
   return new Response(packet({choices:[{delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10}}));
 });
 const running=host.send('/goal Inspect the contract');
 await started.promise;
 const id=host.session.taskId;
 await host.send('/goal pause');
 await running;
 assert.equal(host.session.goal.status,'paused');
 assert.equal(calls,1);
 await host.send('/goal resume');
 assert.equal(host.session.goal.status,'complete');
 assert.equal(host.session.taskId,id);
 assert.equal(calls,3);
});

test('bounded read-only work starts with a small tool set and can expand in the same turn', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-lean-context-'));
 const host=await createHost({root,storage:path.join(root,'storage')});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 host.session.mode='plan';
 let rounds=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const names=JSON.parse(options.body).tools.map(tool=>tool.function.name);
  const first=++rounds===1;
  assert(!names.includes('run_command'));
  if(first){
   assert(names.includes('read_files'));
   assert(names.includes('expand_tools'));
   assert(!names.includes('delegate_tasks'));
   assert(!names.includes('web_fetch'));
  }else{
   assert(names.includes('delegate_tasks'));
   assert(names.includes('web_fetch'));
  }
  const delta=first?{tool_calls:[{index:0,id:'expand',function:{name:'expand_tools',arguments:'{}'}}]}:{content:'Source scope expanded.'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 await host.send('Explain the local source, read-only.');
 assert.equal(rounds,2);
});

test('only one explicitly named source file qualifies for focused edits', () => {
 const {boundedRequest}=require('../src/prompt');
 assert.equal(boundedRequest('Fix main.js while preserving the API. Edit only main.js.','auto'),true);
 assert.equal(boundedRequest('Исправь src/main.ts.','manual'),true);
 assert.equal(boundedRequest('Fix main.js and helper.js.','auto'),false);
 assert.equal(boundedRequest('Fix main.js. '+ 'Keep the existing contract. '.repeat(12),'auto'),false);
 assert.equal(boundedRequest('Fix main.js and delegate this to a subagent.','auto'),false);
 assert.equal(boundedRequest('Read-only review against https://example.org.','plan'),false);
});


test('a malformed focused read can recover without expanding the tool set', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-focused-recovery-'));
 await fs.writeFile(path.join(root,'entry.js'),'let state = 0;\n');
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 h.session.mode='plan';
 const requests=[];
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  requests.push(JSON.parse(body));
  const n=requests.length;
  const delta=n<3?{tool_calls:[{index:0,id:'read'+n,function:{name:'read_files',arguments:JSON.stringify({files:[{path:'entry.js',start_line:n===1?'1':1}]})}}]}:{content:'Done'};
  return new Response(packet({choices:[{delta,finish_reason:delta.content?'stop':'tool_calls'}]}));
 });
 await h.send('Проследи состояние. Файлы не меняй.');
 assert.equal(requests.length,3);
 assert.deepEqual(requests[1].tools,requests[0].tools);
 assert.deepEqual(requests[2].tools,requests[0].tools);
 assert(requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('Invalid tool arguments')));
 assert(requests[2].messages.some(m=>m.role==='tool'&&m.content.includes('let state = 0')));
});

test('explicit edit scope works for domain-specific verbs and excludes review instructions', () => {
 const {scopedEditPaths}=require('../src/prompt');
 assert.deepEqual(scopedEditPaths('Change the label and edit only main.js.','manual'),['main.js']);
 assert.deepEqual(scopedEditPaths('Слей записи по id. Менять можно только main.js. Запусти node check.cjs.','manual'),['main.js']);
 assert.deepEqual(scopedEditPaths('Собери сводку. Исходные строки не меняй. Менять можно только main.js.','manual'),['main.js']);
 assert.deepEqual(scopedEditPaths('Сравни варианты. Файлы не меняй. Менять можно только main.js.','manual'),[]);
 assert.deepEqual(scopedEditPaths('Explain why someone said do not edit only main.js.','manual'),[]);
 assert.deepEqual(scopedEditPaths('Исправь сбой. Менять можно только main.js, ../outside.js.','manual'),[]);
});

test('a single explicit UI move keeps a narrow tool set and the existing check', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-scoped-single-'));
 await fs.writeFile(path.join(root,'check.cjs'),'console.log(1)');
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 let request;
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  request=JSON.parse(body);
  return new Response(packet({choices:[{delta:{content:'Done'},finish_reason:'stop'}]}));
 });
 await h.send('Перенеси переключатель в меню, сохрани условие показа MCP. Сохрани поведение браузерной кнопки «Назад». Менять можно только web/LandingView.jsx. Запусти node check.cjs.');
 const names=request.tools.map(tool=>tool.function.name);
 for(const name of ['read_file','edit_file','verify_revision','expand_tools'])assert(names.includes(name));
 assert(!names.includes('repository_docs'));
 assert.match(request.messages.find(message=>message.role==='system').content,/Harness runs the requested existing check/);
 const {scopedEditPaths}=require('../src/prompt');
 assert.deepEqual(scopedEditPaths('Fix browser history. Open the browser to verify. Edit only web/src/lib/chat.js.','manual'),[]);
 assert.deepEqual(scopedEditPaths('Move the switch. Edit only ../outside.jsx.','manual'),[]);
 assert.deepEqual(scopedEditPaths('Move the switch. Edit only web/Menu.jsx.','plan'),[]);
});

test('explicit connected edits keep a narrow tool set and preserve verification', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-scoped-edit-'));
 const h=await createHost({root,storage:path.join(root,'.storage')});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 let request;
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  request=JSON.parse(body);
  return new Response(packet({choices:[{delta:{content:'Done'},finish_reason:'stop'}]}));
 });
 await h.send('Исправь исход и серию. Менять можно только chat/story.js, chat/speak.js. Запусти node check.cjs.');
 const names=request.tools.map(tool=>tool.function.name);
 for(const name of ['search_batch','apply_patchset','verify_revision','expand_tools'])assert(names.includes(name));
 assert(!names.includes('repository_docs'));
 assert.equal(require('../src/prompt').scopedEditPaths('Fix the architecture. Edit only main.js, worker.js.','manual').length,0);
});

test('scoped edit verifies an explicitly requested existing check when the model omits it', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-scoped-required-check-'));
 const script=path.join(root,'check.cjs');
 const h=await createHost({root,storage:path.join(root,'.storage'),approveCommand:async command=>{
  assert.equal(command,'node check.cjs');
  return {allow:true,execution:{file:process.execPath,args:[script]}};
 }});
 t.after(async()=>{await h.close();await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(root,'main.js'),'module.exports = 1;\n');
 await fs.writeFile(path.join(root,'helper.js'),'module.exports = 3;\n');
 await fs.writeFile(script,"require('node:assert/strict').equal(require('./main.js'),2);\n");
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{
  const first=calls++===0;
  const delta=first?{tool_calls:[{index:0,id:'edit',function:{name:'edit_file',arguments:JSON.stringify({path:'main.js',old_text:'module.exports = 1;',new_text:'module.exports = 2;'})}}]}:{content:'Done'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 await h.send('Change the exported value. Edit only main.js, helper.js. Run node check.cjs.');
 assert.equal(h.session.completion.status,'complete',JSON.stringify(h.session.completion));
 assert(h.session.checks.some(check=>check.command==='node check.cjs'&&check.commandPassed));
 assert(h.session.timeline.some(event=>event.name==='diff_regression'));
});

test('revision verification reports the underlying diagnostic before a generic assertion', async t => {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'harness-check-diagnostic-'));
 const root=path.join(temp,'workspace');
 await fs.mkdir(root);
 const script=path.join(root,'check.cjs');
 await fs.writeFile(script,"console.log('FAIL: expected 2'); console.log('Evaluator error: Unexpected token'); process.exitCode=1;\n");
 const h=await createHost({root,storage:path.join(temp,'storage'),approveCommand:async()=>({allow:true,execution:{file:process.execPath,args:[script]}})});
 t.after(async()=>{await h.close();await fs.rm(temp,{recursive:true,force:true});});
 h.session.taskId='diagnostic';
 h.session.turnId='turn';
 h.session.initialGoal='Run node check.cjs.';
 h.session.turnChanges=['main.js'];
 const entry=h.app.event(h.session,{role:'tool',name:'verify_revision'});
 const args={checks:[{command:'node check.cjs'}]};
 const tool=require('../src/tool-registry').serviceTools.find(tool=>tool.function.name==='verify_revision');
 assert.doesNotThrow(()=>require('../src/validation').validateCall(tool,args));
 const result=JSON.parse(await h.app.serviceTool('verify_revision',args,h.session,root,new AbortController().signal,entry));
 assert.equal(result.checks[0].name,'node check.cjs');
 assert.equal(result.passed,false);
 assert.equal(result.checks[0].detail,'Exit code: 1\nEvaluator error: Unexpected token');
 assert(result.remaining.includes('Required check failed on this revision: node check.cjs'));
 assert(result.checks[0].artifact);
 assert.match(require('../src/verification').completionGaps(h.session).join('\n'),/FAIL: expected 2/);
});

test('single scoped patchset delivers the test result before the next model request', async t => {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'harness-saved-check-'));
 const root=path.join(temp,'workspace');
 await fs.mkdir(root);
 const script=path.join(root,'check.cjs');
 await fs.writeFile(path.join(root,'main.js'),'module.exports = 1;\n');
 await fs.writeFile(script,"require('node:assert/strict').equal(require('./main.js'),2);\n");
 let approvals=0;
 const h=await createHost({root,storage:path.join(temp,'storage'),approveCommand:async command=>{
  assert.equal(command,'node check.cjs');
  approvals++;
  return {allow:true,execution:{file:process.execPath,args:[script]}};
 }});
 t.after(async()=>{await h.close();await fs.rm(temp,{recursive:true,force:true});});
 let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  const first=calls++===0;
  if(first){
   const request=JSON.parse(body);
   assert.match(request.messages.find(x=>x.role==='system').content,/Harness runs the requested existing check/);
  }
  if(!first)assert(JSON.parse(body).messages.some(x=>x.role==='tool'&&x.content.includes('Scoped verification on saved revision: node check.cjs passed.')));
  const delta=first?{tool_calls:[{index:0,id:'edit',function:{name:'apply_patchset',arguments:JSON.stringify({path:'main.js',changes:[{old_text:'module.exports = 1;',new_text:'module.exports = 2;'}]})}}]}:{content:'Done'};
  return new Response(packet({choices:[{delta,finish_reason:first?'tool_calls':'stop'}]}));
 });
 await h.send('Change the exported value. Edit only main.js. Run node check.cjs.');
 assert.equal(h.session.completion.status,'complete',JSON.stringify(h.session.completion));
 assert.equal(approvals,1);
 assert(h.session.timeline.some(event=>event.name==='diff_regression'));
});

test('a scoped edit reports its diff counterexample before the next model step', async t => {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'harness-saved-counterexample-'));
 const root=path.join(temp,'workspace');
 await fs.mkdir(root);
 const file=path.join(root,'main.js'),script=path.join(root,'check.cjs');
 const original='exports.pick=(xs,k)=>xs[0]?.id??null;';
 const incomplete='exports.pick=(xs,k)=>xs.find(x=>x.id===k)?.id??xs.find(x=>x.disabled!==true)?.id??null;';
 const repaired=incomplete.replace('x.id===k','x.id===k&&x.disabled!==true');
 await fs.writeFile(file,original+'\n');
 await fs.writeFile(script,"require('node:assert/strict').equal(require('./main').pick([{id:1},{id:0}],0),0);\n");
 let checks=0;
 const h=await createHost({root,storage:path.join(temp,'storage'),approveCommand:async command=>{
  assert.equal(command,'node check.cjs');
  checks++;
  return {allow:true,execution:{file:process.execPath,args:[script]}};
 }});
 t.after(async()=>{await h.close();await fs.rm(temp,{recursive:true,force:true});});
 let requests=0;
 t.mock.method(globalThis,'fetch',async(_url,{body})=>{
  const request=JSON.parse(body),index=requests++;
  if(index===1)assert(request.messages.some(message=>message.role==='tool'&&
    message.content.includes('node check.cjs passed.')&&message.content.includes('exact match that fails the disabled rule')));
  const change=[[original,incomplete],[incomplete,repaired]][index];
  const delta=change?{tool_calls:[{index:0,id:'edit'+index,function:{name:'edit_file',arguments:JSON.stringify({path:'main.js',old_text:change[0],new_text:change[1]})}}]}:{content:'Done'};
  return new Response(packet({choices:[{delta,finish_reason:change?'tool_calls':'stop'}]}));
 });
 await h.send('Select an eligible exact match, otherwise the first record with disabled !== true, or null. Edit only main.js. Run node check.cjs.');
 assert.equal(requests,3);
 assert.equal(checks,2);
 assert.equal(await fs.readFile(file,'utf8'),repaired+'\n');
 assert.equal(h.session.completion.status,'complete');
 assert(h.session.timeline.some(event=>event.name==='diff_regression'));
});
