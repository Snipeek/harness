'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runAgents, findEvent, validateTasks } = require('../src/agents');
const tasks = () => ['A', 'B', 'C'].map(title => ({ title, type: 'explore', prompt: 'Inspect ' + title }));
const options = extra => ({ settings: {}, system: 'Test project', mode: 'manual', signal: new AbortController().signal, onStart() {}, onUpdate() {}, hostFor: () => ({}), ...extra });

test('subagents run concurrently, isolate contexts, preserve tool replies and account for usage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agent-')); t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.writeFile(path.join(root, 'file.txt'), 'test content');
  let active = 0, peak = 0, started, input = 0;
  const seen = [];
  const result = await runAgents(tasks(), options({
    maxDepth:0,
    onStart: agents => started = agents,
    onUsage: u => input += u.input_tokens,
    hostFor: () => ({ root }),
    complete: async request => {
      assert.equal(request.messages[1].role, 'user'); assert.equal(request.messages.filter(m => m.role === 'user').length, 1);
      assert(!request.tools.some(t => t.function.name === 'delegate_tasks'));
      active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--;
      if (request.messages.at(-1).role !== 'tool') {
        seen.push(request.messages[1].content);
        return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] }, usage: { input_tokens: 10, output_tokens: 2 } };
      }
      assert.match(request.messages.at(-1).content, /test content/);
      return { message: { role: 'assistant', content: 'Found content' }, usage: { input_tokens: 5, output_tokens: 1 } };
    }
  }));
  assert.equal(peak, 3); assert.equal(new Set(seen).size, 3); assert.equal(input, 45);
  assert(result.every(r => r.status === 'done' && r.tools === 1 && r.usage.input === 15));
  assert(started.every(a => a.timeline.length === 3 && a.finishedAt));
  assert.equal(findEvent([{ id: 'batch', agents: started }], started[0].timeline[1].id).name, 'read_file');
});

test('plan subagents cannot execute writes even when a model calls an unoffered tool', async () => {
  let requests = 0, output;
  await runAgents([{ title: 'Bad tool', type: 'general', prompt: 'Test' }], options({ mode: 'plan', complete: async request => {
    assert(!request.tools.some(t => t.function.name === 'write_file'));
    if (!requests++) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'write', function: { name: 'write_file', arguments: '{"path":"a","content":"oops"}' } }] } };
    output = request.messages.at(-1).content; return { message: { role: 'assistant', content: 'Cannot write' } };
  } }));
  assert.match(output, /not available/);
});

test('stopping one subagent does not cancel its sibling', async () => {
  const result = await runAgents(tasks().slice(0, 2), options({
    register: (agent, controller) => { if (agent.title === 'A') setTimeout(() => controller.abort(), 5); },
    complete: request => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ message: { role: 'assistant', content: 'Done' } }), 30);
      request.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    })
  }));
  assert.equal(result[0].status, 'cancelled'); assert.equal(result[1].status, 'done');
});

test('parent stop aborts all subagents and validation enforces the fanout cap', async () => {
  const parent = new AbortController(); setTimeout(() => parent.abort(), 10);
  const result = await runAgents(tasks(), options({ signal: parent.signal, complete: request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stop')), { once: true })) }));
  assert(result.every(a => a.status === 'cancelled')); assert.throws(() => validateTasks([...tasks(), tasks()[0]]), /1–3/); assert.throws(() => validateTasks([{ title: 'A', type: 'unknown', prompt: 'x' }]));
});

test('nested delegation preserves the tree, usage and depth limit', async () => {
  const root = await require('node:fs/promises').mkdtemp(require('node:path').join(require('node:os').tmpdir(),'glm-nested-'));
  let started;
  try {
    const result = await runAgents([{title:'Parent worker',type:'explore',prompt:'Inspect independently'}],{
      settings:{model:'fixture'},mode:'plan',system:'rules',signal:new AbortController().signal,
      onStart:agents=>{started=agents;},onUpdate:()=>{},hostFor:()=>({root}),
      complete:async options=>{
        const nested=options.messages[0].content.includes('subagent: Nested worker.');
        if(nested){assert(!options.tools.some(t=>t.function.name==='delegate_tasks'));return {message:{role:'assistant',content:'Nested evidence'},usage:{prompt_tokens:3,completion_tokens:2}};}
        if(options.messages.at(-1).role==='tool')return {message:{role:'assistant',content:'Combined evidence'},usage:{prompt_tokens:2,completion_tokens:1}};
        return {message:{role:'assistant',content:'',tool_calls:[{id:'nested',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{title:'Nested worker',type:'explore',prompt:'Inspect'}]})}}]},usage:{prompt_tokens:2,completion_tokens:1}};
      }
    });
    assert.equal(result[0].result,'Combined evidence');assert.equal(result[0].usage.input,7);assert.equal(started[0].timeline.find(e=>e.agents).agents[0].result,'Nested evidence');
  }finally{await require('node:fs/promises').rm(root,{recursive:true,force:true});}
});
test('read-only research subagents receive web and skill tools through the host adapter',async()=>{const {serviceTools}=require('../src/tool-registry');let invoked=false;const result=await runAgents([{title:'Research',type:'explore',prompt:'Search official sources'}],options({maxDepth:0,extraTools:()=>serviceTools.filter(t=>['web_search','load_skill'].includes(t.function.name)),executeExtraTool:async(name,args)=>{assert.equal(name,'web_search');assert.equal(args.query,'public documentation');invoked=true;return '{"results":[{"url":"https://example.com"}]}';},complete:async request=>{assert(request.tools.some(t=>t.function.name==='web_search'));assert(!request.tools.some(t=>t.function.name==='run_command'));return request.messages.at(-1).role==='tool'?{message:{role:'assistant',content:'Source found'}}:{message:{role:'assistant',content:'',tool_calls:[{id:'search',function:{name:'web_search',arguments:'{"query":"public documentation"}'}}]}};}}));assert(invoked);assert.equal(result[0].result,'Source found');});

test('structured delegation passes evidence and returns a retrievable partial report', async () => {
  const knownFacts = ['src/index.js:8 opens the connection'];
  const report = {
    outcome: 'partial',
    summary: 'Confirmed the entry point',
    findings: Array.from({ length: 12 }, () => ({ claim: 'a'.repeat(599), sources: ['src/index.js:8'] })),
    checks: [],
    open_questions: ['What closes the connection?']
  };
  let requests = 0;
  const [result] = await runAgents([{
    title: 'Trace connection', type: 'explore', prompt: 'Who owns connection cleanup?',
    scope: ['src/index.js'], known_facts: knownFacts, acceptance: ['Identify the cleanup owner']
  }], options({
    parentPlan: { decision: 'Keep the existing owner', constraints: ['Keep the public contract intact'], acceptance: ['A retry closes once'] },
    archiveOutput: async content => {
      assert.deepEqual(JSON.parse(content), report);
      return 'report-artifact';
    },
    complete: async request => {
      assert.match(request.messages[1].content, /src\/index.js:8 opens the connection/);
      assert.match(request.messages[1].content, /Identify the cleanup owner/);
      assert.match(request.messages[1].content, /Keep the existing owner.*Keep the public contract intact.*A retry closes once/);
      return { message: { role: 'assistant', content: ++requests === 1 ? 'Some notes' : JSON.stringify(report) } };
    }
  }));
  assert.equal(requests, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.report.findings.length, 3);
  assert.deepEqual(result.report.open_questions, report.open_questions);
  assert.equal(result.artifactId, 'report-artifact');
});

test('a background batch reports partial completion when a worker is blocked', async () => {
  const { TaskPool } = require('../src/tasks');
  const pool = new TaskPool();
  const config = options({
    complete: async () => ({ message: { role: 'assistant', content: JSON.stringify({
      outcome: 'blocked', summary: 'Source unavailable', findings: [], checks: [], open_questions: []
    }) } })
  });
  const { id } = JSON.parse(await pool.start(tasks().slice(0, 1), config, 'owner'));
  const result = JSON.parse(await pool.execute('wait_task', { id }, 'owner', config.signal));
  assert.equal(result.status, 'partial');
  assert.equal(result.results[0].status, 'blocked');
});

test('a malformed report gets one format-only attempt after the investigation limit', async () => {
  const task = { ...tasks()[0], acceptance: ['Find the entry point'] };
  const report = { outcome: 'complete', summary: 'Entry point is index.js:12.', findings: [
    { claim: 'Entry point located', sources: ['index.js:12'] }
  ], checks: [], open_questions: [] };
  let calls = 0;
  const [result] = await runAgents([task], options({
    maxRounds: 1,
    complete: async request => {
      if (++calls === 1) return { message: { role: 'assistant', content: report.summary } };
      assert.deepEqual(request.tools, []);
      assert(request.messages.some(message => message.content === report.summary));
      return { message: { role: 'assistant', content: JSON.stringify(report) } };
    }
  }));
  assert.equal(calls, 2);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.report, report);
});

test('output limit recovery uses the same evidence once without tools', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agent-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'file.txt'), 'Existing evidence');
  const report = { outcome: 'partial', summary: 'Found evidence', findings: [{ claim: 'Evidence exists', sources: ['file.txt:1'] }], checks: [], open_questions: ['Other paths remain unverified'] };
  for (const failsAgain of [false, true]) {
    let calls = 0;
    const [agent] = await runAgents(tasks().slice(0, 1), options({
      maxRounds: 2,
      hostFor: () => ({ root }),
      complete: async request => {
        calls++;
        if (calls === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] } };
        assert(request.messages.some(message => message.role === 'tool' && message.content.includes('Existing evidence')));
        if (calls === 2 || failsAgain) throw Object.assign(Error('Output limit'), { code: 'OUTPUT_LIMIT' });
        assert.deepEqual(request.tools, []);
        assert.match(request.messages.at(-1).content, /short JSON report/);
        return { message: { role: 'assistant', content: JSON.stringify(report) } };
      }
    }));
    assert.equal(calls, 3);
    assert.equal(agent.tools, 1);
    assert.equal(agent.status, failsAgain ? 'error' : 'partial');
    if (!failsAgain) assert.deepEqual(agent.report, report);
  }
});

test('a saved read-only worker continues by ID with its tool evidence and fresh usage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-worker-resume-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'file.txt'),'original verified evidence');
  const task = tasks()[0];
  const settings = {provider:'glm',model:'glm-5.3-flash',baseUrl:'https://example.com',protocol:'chat'};
  let saved;
  const [first] = await runAgents([task],options({settings, maxRounds:1,
    checkpoint: state => { saved=JSON.parse(JSON.stringify(state)); },
    hostFor:()=>({root}),
    complete:async()=>({message:{role:'assistant',tool_calls:[
      {id:'read',function:{name:'read_file',arguments:'{"path":"file.txt"}'}}
    ]},usage:{prompt_tokens:50}})
  }));
  assert.equal(first.status,'limited');
  assert.equal(saved.id,first.id);
  assert.equal(saved.messages.at(-1).tool_call_id,'read');
  const [second] = await runAgents([task],options({settings,resume:saved,followUp:'Summarize existing evidence.',
    hostFor:()=>{throw Error('No repeat reads expected');},
    complete:async request=>{
      assert(request.messages.some(m=>m.role==='tool'&&m.content.includes('original verified evidence')));
      assert.match(request.messages.at(-1).content,/Summarize existing evidence/);
      return {message:{role:'assistant',content:'Evidence preserved.'},usage:{prompt_tokens:13}};
    }
  }));
  assert.equal(second.id,first.id);
  assert.equal(second.tools,0);
  assert.equal(second.usage.input,13);
  const [changed] = await runAgents([task],options({settings:{...settings,baseUrl:'https://other.example'},
    resume:saved,followUp:'Continue',complete:async()=>assert.fail('Cannot send saved context to another endpoint')
  }));
  assert.equal(changed.status,'error');
  assert.match(changed.result,/connection or model changed/);
});
