'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const vscode = require('vscode');
exports.run = async () => {
  const report = { ok: false, requests: 0 };
  let server, app, queueStarted=false, queueToolStarted=false, planStage=0,asyncStage=0;
  try {
    const extension = vscode.extensions.getExtension('snipeek.glm-token-usage');
    assert(extension); app = await extension.activate();
    assert(app.manager, 'custom sidebar registered');
    await vscode.commands.executeCommand('workbench.view.extension.glmAI');
    const cfg = vscode.workspace.getConfiguration('glmTokenUsage');
    server = http.createServer((request, response) => {
      let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => {
        report.requests++;
        const p = JSON.parse(body); const child = p.messages[0].content.includes('You are the explore subagent:');
        const finish = message => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Provider-supplied test summary.' } }] }) + '\n\n');
          response.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n');
        };
        if(!child&&p.messages.some(m=>m.role==='user'&&m.content==='ASYNC_TEST')) {
          asyncStage++;
          if(asyncStage===1)finish({tool_calls:[{index:0,id:'discover',type:'function',function:{name:'search_tools',arguments:'{"query":"start_tasks"}'}}]});
          else if(asyncStage===2)finish({tool_calls:[{index:0,id:'start',type:'function',function:{name:'start_tasks',arguments:JSON.stringify({tasks:[{title:'Background fixture',type:'explore',prompt:'Read hello.txt'}]})}}]});
          else finish({content:asyncStage===3?'Started; premature final':'Background evidence accepted'});return;
        }
        if(p.messages.at(-1).content==='QUEUE_TOOL_START'){queueToolStarted=true;setTimeout(()=>finish({tool_calls:[{index:0,id:'stale-write',type:'function',function:{name:'write_file',arguments:'{"path":"should-not-write.txt","content":"stale"}'}}]}),100);return;}
        if(p.messages.some(m=>m.role==='user'&&m.content==='PLAN_TEST')) {
          planStage++;
          if(planStage===1||planStage===3)finish({tool_calls:[{index:0,id:'plan'+planStage,type:'function',function:{name:'update_plan',arguments:JSON.stringify({goal:'Retain original task',steps:[{title:'Finish pending work',status:planStage===1?'pending':'done',evidence:planStage===3?'Fixture check passed':undefined}]})}}]});
          else finish({content:planStage===2?'Premature final':'Plan completed'});return;
        }
        if(p.messages.at(-1).content==='QUEUE_START'){queueStarted=true;setTimeout(()=>finish({content:'First phase'}),100);return;}
        if(p.messages.at(-1).content==='QUEUE_UPDATE'){finish({content:'Constraint applied.'});return;}
        if (p.messages.at(-1).role === 'tool') finish({ content: child ? 'Subagent read hello.txt successfully.' : 'Both subagents completed.' });
        else if (child) finish({ tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.txt"}' } }] });
        else finish({ tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'delegate_tasks', arguments: JSON.stringify({ tasks: [{ title: 'Read fixture A', type: 'explore', prompt: 'Read hello.txt' }, { title: 'Read fixture B', type: 'explore', prompt: 'Inspect hello.txt independently' }] }) } }] });
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await cfg.update('provider', 'custom', vscode.ConfigurationTarget.Global);
    await cfg.update('customBaseUrl', `http://127.0.0.1:${server.address().port}/v1`, vscode.ConfigurationTarget.Global);
    await cfg.update('customModel', 'smoke-test', vscode.ConfigurationTarget.Global);
    await app.context.secrets.store('ai.custom.key', 'local-smoke-key');
    const scope=await app.integrationsFor('/private/tmp/glm-ai-smoke');const skills=await scope.skills.list();assert(skills.some(s=>s.name==='deep-research'),'Claude user skills must be visible');assert((await app.systemPrompt('/private/tmp/glm-ai-smoke','auto')).includes('web_search'));assert((await app.systemPrompt('/private/tmp/glm-ai-smoke','auto')).includes('deep-research'));const loaded=JSON.parse(await scope.skills.load(skills.find(s=>s.name==='deep-research').id));assert(loaded.text.includes('Research'));report.integrations={userSkills:skills.length,webTools:'web_search and web_fetch offered',globalMcp:scope.mcp.catalog().map(s=>s.name)};
    const session = app.newSession(); await app.save(session);
    const panel = app.openTab(session.id); assert(panel);
    assert.equal(app.openTab(session.id), panel, 'duplicate opens reuse the tab');
    assert.equal(app.lastPanel, panel);
    // Bind is asynchronous: wait for the registered webview session, not a fixed UI delay.
    const until = Date.now() + 10000;
    while (!app.views.has(panel.webview)) { if (Date.now() > until) throw new Error('Webview did not bind'); await new Promise(r => setTimeout(r, 10)); }
    await app.send(panel.webview, 'Use two subagents to inspect hello.txt.', []);
    const batch = session.timeline.find(e => e.agents?.length);
    assert(batch); assert.equal(batch.agents.length, 2);
    assert(batch.agents.every(a => a.status === 'done' && a.toolCount === 1));
    assert.equal(session.timeline.at(-1).text, 'Both subagents completed.');
    assert.equal(session.usage.input, 72);
    assert.equal(app.runs.size, 0); assert.equal(app.agentRuns.size, 0);
    await app.receive(panel.webview, { type: 'selectModel', model: 'smoke-test-next' });
    assert.equal(session.modelOverride, 'smoke-test-next');
    await app.send(panel.webview, 'Continue with the selected model.', []);
    assert(!session.timeline.some(e => e.role === 'notice' && /Provider or/.test(e.text)), 'same-provider model switching must preserve the conversation');
    assert.equal(session.model, 'smoke-test-next');
    const sending=app.send(panel.webview,'QUEUE_START',[]);
    while(!queueStarted)await new Promise(r=>setTimeout(r,5));
    await app.send(panel.webview,'QUEUE_UPDATE',[]);assert.equal(session.queue.length,1);await sending;
    assert.equal(session.queue.length,0);assert.equal(session.timeline.at(-1).text,'Constraint applied.');report.queue='steering consumed within active turn';
    const planSession=app.newSession(),planPanel=app.openTab(planSession.id);while(!app.views.has(planPanel.webview))await new Promise(r=>setTimeout(r,10));
    await app.send(planPanel.webview,'PLAN_TEST',[]);assert.equal(planSession.plan.steps[0].status,'done');assert.equal(planStage,4);report.plan='pending step resumed after premature final';planPanel.dispose();
    await app.receive(panel.webview, { type: 'mode', mode: 'auto' });
    assert.equal(session.mode, 'auto');
    const { executeTool } = require('../src/tools');
    const autoEntry = { id: 'auto-smoke', result: '' };
    const autoHost = app.toolHost(session, '/private/tmp/glm-ai-smoke', new AbortController().signal, autoEntry);
    assert.match(await executeTool('run_command', { command: 'cat hello.txt' }, autoHost), /Hello from/);
    assert.equal(autoEntry.approval.mode, 'auto');
    await executeTool('write_file', { path: 'auto-smoke.txt', content: 'Auto edit passed.' }, autoHost);
    assert.equal(await fs.readFile('/private/tmp/glm-ai-smoke/auto-smoke.txt', 'utf8'), 'Auto edit passed.');
    const verification=JSON.parse(await app.serviceTool('verify_task',{command:'cat hello.txt',description:'Read fixture smoke check'},session,'/private/tmp/glm-ai-smoke',new AbortController().signal,{id:'verify-smoke',result:''}));
    assert.equal(verification.turnId,session.turnId);assert.equal(verification.taskId,session.taskId);assert.equal(verification.passed,true);assert.deepEqual(verification.paths,['auto-smoke.txt']);report.verification='actual command result bound to task and own changed paths';
    await fs.rm('/private/tmp/glm-ai-smoke/auto-smoke.txt');
    const stale=app.send(panel.webview,'QUEUE_TOOL_START',[]);while(!queueToolStarted)await new Promise(r=>setTimeout(r,5));await app.send(panel.webview,'QUEUE_UPDATE',[]);await stale;await assert.rejects(fs.access('/private/tmp/glm-ai-smoke/should-not-write.txt'));report.steeringSafety='stale Auto write deferred before execution';
    const asyncSession=app.newSession(),asyncPanel=app.openTab(asyncSession.id);while(!app.views.has(asyncPanel.webview))await new Promise(r=>setTimeout(r,10));await app.send(asyncPanel.webview,'ASYNC_TEST',[]);assert.equal(asyncSession.timeline.at(-1).text,'Background evidence accepted');assert.equal(asyncStage,4);assert(asyncSession.timeline.find(e=>e.agents?.length).agents.every(a=>a.status==='done'));report.background='parent resumed after asynchronous worker completed';asyncPanel.dispose();
    const review = app.reviewAction(session, '/private/tmp/glm-ai-smoke', {}, { kind: 'command', detail: 'ls && rm needs-review' }, new AbortController().signal);
    const deadline = Date.now() + 5000; while (!app.pending.size) { if (Date.now() > deadline) throw new Error('Auto failed to request confirmation'); await new Promise(r=>setTimeout(r,10)); }
    await app.receive(panel.webview, { type: 'approval', id: [...app.pending.keys()][0], allow: false });
    assert.equal(await review, false);
    await assert.rejects(fs.access('/private/tmp/glm-ai-smoke/needs-review'));
    report.auto = 'read command and edit approved; rm prompted and denied';
    assert(session.timeline.some(e=>e.role==='thinking' && e.text === 'Provider-supplied test summary.'), 'provider reasoning should reach the transcript');
    assert(batch.agents.every(a=>a.timeline.some(e=>e.role==='thinking')), 'subagents should preserve supplied reasoning');
    report.reasoning = 'main and child stream summaries preserved';
    report.ok = true; report.agents = batch.agents.length; report.toolCalls = batch.agents.reduce((n, a) => n + a.toolCount, 0); report.inputTokens = session.usage.input;
    panel.dispose(); await app.store.remove(session.id); app.sessions.delete(session.id);
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    if (app) await app.context.secrets.delete('ai.custom.key');
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.writeFile('/private/tmp/glm-ai-vscode-smoke-result.json', JSON.stringify(report, null, 2));
  }
};
