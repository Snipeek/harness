'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Services,searchNative}=require('../src/services');
const {TaskPool}=require('../src/tasks');
const {setTimeout:delay}=require('node:timers/promises');
test('artifact byte cursors preserve UTF-8 across boundaries and terminate',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-utf8-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=new Services(root),original='яя🌍'.repeat(20),id=await s.artifact(original);let offset=0,text='',pages=0;do{const p=JSON.parse(await s.readArtifact(id,offset,5));text+=p.text;offset=p.nextOffset;assert(++pages<100);}while(offset!==null);assert.equal(text,original);await assert.rejects(s.readArtifact(id,1,5),/boundary/);});
test('native search regex, pagination, ignores escaped symlinks and supports hostile path/query characters',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-search-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const a=path.join(root,'--odd name.txt');await fs.writeFile(a,'hello 1\nhello 2\nhello 3\n');await fs.symlink('/etc/passwd',path.join(root,'outside'));const r=JSON.parse(await searchNative(root,[a,path.join(root,'outside')],{query:'hello \\d',regex:true,limit:2},undefined));assert.equal(r.matches.length,2);assert.equal(r.nextOffset,2);const next=JSON.parse(await searchNative(root,[a],{query:'hello',offset:2,limit:2},undefined));assert.equal(next.matches.length,1);assert.equal(next.truncated,false);});
test('background processes return immediately, preserve exit output, enforce ownership, cancellation and plan policy',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'glm-process-'));const services=new Services(path.join(root,'artifacts'));t.after(()=>{services.close();return fs.rm(root,{recursive:true,force:true});});const host={root,signal:new AbortController().signal,mode:'auto',approveCommand:async()=>true};const p=JSON.parse(await services.start({command:`${JSON.stringify(process.execPath)} -e 'setTimeout(()=>console.log("done"),100)'`},host,'a'));assert.equal(p.status,'running');assert.throws(()=>services.owned(p.process_id,'other'));let r;do{r=JSON.parse(await services.execute('wait_process',{id:p.process_id,timeout_ms:1000},host,'a'));}while(r.status==='running');assert.equal(r.exitCode,0);assert.match(r.output,/done/);const artifact=await services.artifact('complete output');assert.match(await services.readArtifact(artifact),/complete output/);await assert.rejects(services.readArtifact('../secret'));await assert.rejects(services.start({command:'pwd'},{...host,mode:'plan'},'a'),/Plan/);const waiting=JSON.parse(await services.start({command:'sleep 20'},host,'a'));await services.execute('stop_process',{id:waiting.process_id},host,'a');await delay(40);assert.notEqual(services.owned(waiting.process_id,'a').status,'running');});
test('asynchronous subagents return an ID before completion and results can be collected',async()=>{const pool=new TaskPool(),controller=new AbortController();const started=Date.now();const result=JSON.parse(await pool.start([{title:'Investigate',type:'explore',prompt:'Inspect'}],{settings:{model:'test'},system:'rules',signal:controller.signal,mode:'plan',onStart:()=>{},onUpdate:()=>{},complete:async()=>{await delay(70);return {message:{role:'assistant',content:'Evidence found'},usage:{prompt_tokens:2,completion_tokens:2}};}},'a'));assert(Date.now()-started<60);assert.equal(result.status,'running');const end=JSON.parse(await pool.execute('wait_task',{id:result.id,timeout_ms:500},'a',controller.signal));assert.equal(end.results[0].result,'Evidence found');await assert.rejects(pool.execute('task_status',{id:result.id},'b'),/Unknown/);pool.close();});

test('a completed worker is collectable before its sibling and is delivered once', async () => {
  const pool = new TaskPool();
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const signal = new AbortController().signal;
  const { id } = JSON.parse(await pool.start([
    { title: 'Fast', type: 'explore', prompt: 'Fast' },
    { title: 'Slow', type: 'explore', prompt: 'Slow' }
  ], { turnId: 'turn', settings: { model: 'test' }, system: 'rules', mode: 'plan', signal,
    onStart() {}, onUpdate() {}, complete: async options => {
      if (options.messages.at(-1).content === 'Slow') await slow;
      return { message: { content: 'Evidence' } };
    } }, 'owner'));
  try {
    const first = JSON.parse(await pool.execute('wait_task', { id }, 'owner', signal));
    assert.equal(first.status, 'running');
    assert.deepEqual(first.results.map(result => result.title), ['Fast']);
    assert.deepEqual(pool.collect('owner','turn'), []);
  } finally { release(); }
  await pool.batches.get(id).promise;
  assert.deepEqual(pool.collect('owner','turn')[0].results.map(result => result.title), ['Slow']);
  assert.deepEqual(pool.collect('owner','turn'), []);
});

test('web source coverage joins only contiguous ranges of the same snapshot',()=>{
 const {WebCoverage,webPageSlice,readerNotFound}=require('../src/web');
 const coverage=new WebCoverage(),page={url:'https://example.org',title:'Article',snapshot:'one',method:'direct HTTPS',text:'x'.repeat(30),links:[]};
 assert.equal(readerNotFound('Page not found · GitHub Pages','body'),true);
 assert.equal(readerNotFound('An article about 404 errors','A useful source'),false);
 assert.deepEqual(coverage.record(webPageSlice(page,{offset:20,limit:10})),{complete:false,readChars:10});
 assert.deepEqual(coverage.record(webPageSlice(page,{offset:0,limit:10})),{complete:false,readChars:20});
 assert.deepEqual(coverage.record(webPageSlice(page,{offset:10,limit:10})),{complete:true,readChars:30});
 assert.equal(coverage.incomplete().length,0);
 assert.deepEqual(coverage.record(webPageSlice({...page,snapshot:'two'},{offset:0,limit:10})),{complete:false,readChars:10});
 assert.throws(()=>webPageSlice(page,{offset:30}),/outside/);
 const escaped=webPageSlice({...page,text:'\n"'.repeat(10000)},{limit:16000});
 assert(JSON.stringify(escaped).length<=11500);
 assert.equal(escaped.nextOffset,escaped.text.length);
});

test('one process wait wakes after exit and tracking, while preview and cancellation do not wait for the job', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-event-wait-'));
  const services = new Services(path.join(root, 'artifacts'));
  let finishedTracking=0;
  const host = { root, mode:'auto', approveCommand:async()=>true, trackCommand:async()=>async()=>{await delay(10);finishedTracking++;} };
  const start = async () => JSON.parse(await services.start({command:'sleep 20; exit 7'},host,'a')).process_id;
  const id = await start();
  const second = await start();
  t.after(async()=>{services.close();await fs.rm(root,{recursive:true,force:true});});
  const run = async (name,id,args={},options={}) => JSON.parse(await services.execute(name,{id,...args},{...host,...options},'a'));
  assert.equal((await run('read_process',id,{preview:true})).status,'running');
  const abort = new AbortController();
  const cancelled = run('wait_process',second,{}, {signal:abort.signal});
  abort.abort();
  await assert.rejects(cancelled,{name:'AbortError'});
  const deadline = await run('wait_process',second,{}, {deadline:Date.now()+15});
  assert.equal(deadline.status,'running');
  for(const [processId,tool] of [[id,'read_process'],[second,'wait_process']]){
    const waiting = run(tool,processId);
    await services.execute('stop_process',{id:processId},host,'a');
    const result = await waiting;
    assert.equal(result.status,'done');
    assert.equal(result.exitSignal,'SIGTERM');
    assert.equal(finishedTracking,processId===id?1:2);
  }
});
