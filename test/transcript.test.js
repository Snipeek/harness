'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupTurns, collectAgents } = require('../media/transcript');

test('reply text, tools, agent batches and final answer share one branch until the next user message', () => {
  const timeline = [
    { id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 't1', role: 'tool' },
    { id: 'batch', role: 'tool', agents: [] }, { id: 'a2', role: 'assistant' },
    { id: 'u2', role: 'user' }, { id: 'a3', role: 'assistant' }
  ];
  const groups = groupTurns(timeline);
  assert.equal(groups.length, 2); assert.equal(groups[0].user.id, 'u1');
  assert.deepEqual(groups[0].activity.map(e => e.id), ['a1', 't1', 'batch', 'a2']);
  assert.deepEqual(groups[1].activity.map(e => e.id), ['a3']);
});
test('streaming updates preserve turn identity and introductory notices remain outside user messages', () => {
  const timeline = [{ id: 'n', role: 'notice' }, { id: 'u', role: 'user' }, { id: 'a', role: 'assistant', text: '' }];
  const before = groupTurns(timeline); timeline[2].text = 'streamed'; const after = groupTurns(timeline);
  assert.equal(before[1].id, after[1].id); assert.equal(after[1].activity[0].text, 'streamed'); assert.equal(after[0].user, null);
});
test('subagent tree retains hierarchy and points nested agents to the root transcript event', () => {
  const child = { id: 'child', timeline: [] }, parent = { id: 'parent', timeline: [{ id: 'nested-batch', agents: [child] }] };
  const rows = collectAgents([{ id: 'root-batch', agents: [parent] }]);
  assert.deepEqual(rows.map(({ agent, parentId, rootEventId, depth }) => [agent.id, parentId, rootEventId, depth]), [
    ['parent', null, 'root-batch', 0], ['child', 'parent', 'root-batch', 1]
  ]);
});
test('duplicate agent records do not produce duplicate tree nodes', () => {
  const agent = { id: 'same', timeline: [] };
  assert.equal(collectAgents([{ id: 'first', agents: [agent] }, { id: 'second', agents: [agent] }]).length, 1);
});

test('tool presentation separates a Bash title from the exact executable command', () => {
  const { presentTool } = require('../media/transcript');
  const view = presentTool({ name: 'run_command', input: JSON.stringify({ command: 'pwd', description: 'Inspect working directory' }), result: '/workspace' });
  assert.equal(view.label, 'Bash'); assert.equal(view.description, 'Inspect working directory'); assert.equal(view.input, 'pwd'); assert.equal(view.output, '/workspace'); assert.equal(view.preview, false);
  assert.equal(presentTool({name:'Bash',input:{command:'pwd'}}).description, 'pwd');
  assert.equal(presentTool({name:'run_command',status:'done',result:'Exit code: 1\nFailed'}).preview, true);
});
test('start_tasks keeps raw details collapsed and shows assignment titles', () => {
  const { presentTool } = require('../media/transcript');
  const view = presentTool({name:'start_tasks',input:{tasks:[{title:'Trace routes'},{title:'Review tests'}]}});
  assert.equal(view.description, 'Trace routes, Review tests');
  assert.equal(view.preview, false);
});
test('artifact pages stay collapsed with paging arguments visible in the summary', () => {
  const { presentTool } = require('../media/transcript');
  const event = { name: 'read_artifact', input: '{"id":"artifact-1","offset":0,"limit":8000}', result: 'saved output', status: 'done' };
  const view = presentTool(event);
  assert.equal(view.preview, false);
  assert.equal(view.description, 'artifact-1 · offset 0 · limit 8000');
  assert.equal(view.output, 'saved output');
  assert.equal(presentTool({ ...event, status: 'error' }).preview, true);
});

test('browser, MCP and other routine tool details are collapsed by default', () => {
  const { presentTool } = require('../media/transcript');
  for (const name of ['mcp_browser_type', 'mcp_external', 'integration_status', 'future_tool']) {
    assert.equal(presentTool({ name, status: 'done', result: 'Details' }).preview, false);
    assert.equal(presentTool({ name, status: 'error', result: 'Failed' }).preview, true);
  }
  assert.equal(presentTool({ name: 'mcp_browser_type', input: { key: 'PageUp' } }).description, 'PageUp');
  assert.equal(presentTool({ name: 'edit_file', status: 'done' }).preview, true);
  assert.equal(presentTool({ name: 'run_command', status: 'waiting' }).preview, true);
});

test('Read presentation exposes a compact file label while preserving its full path', () => {
  const { presentTool } = require('../media/transcript');
  const view = presentTool({ name: 'Read', input: '{"file_path":"/workspace/media/chat.css"}', result: '1: body {}' });
  assert.equal(view.target, 'chat.css'); assert.equal(view.file, '/workspace/media/chat.css'); assert.equal(view.preview, false);
});

test('outgoing messages are visible before confirmation and reconcile with queue and history', () => {
  const { outgoingTimeline } = require('../media/transcript');
  const pending = [{ deliveryId: 'first', text: 'С вопросом', startedAt: 10, status: 'sending' }];
  assert.equal(outgoingTimeline([], [], pending)[0].status, 'sending');
  const queue = [{ id: 'host', deliveryId: 'first', text: 'С вопросом', at: 11 }];
  const waiting = outgoingTimeline([], queue, pending);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].status, 'queued');
  const delivered = [{ id: 'real', deliveryId: 'first', role: 'user', text: 'С вопросом' }];
  assert.deepEqual(outgoingTimeline(delivered, queue, pending), delivered);
  assert.equal(outgoingTimeline([], [], [{ ...pending[0], status: 'failed' }])[0].status, 'failed');
});

test('file read headers distinguish ranges and mark exact repeats', () => {
  const { presentTool } = require('../media/transcript');
  const input = {path:'src/extension.js',start_line:642,end_line:676};
  assert.equal(presentTool({name:'read_file',input,repeatReads:1}).description,'642–676 · Повтор');
  assert.equal(presentTool({name:'read_file',input:{...input,start_line:677,end_line:700}}).description,'677–700');
  assert.equal(presentTool({name:'read_files',input:{files:[input]},repeatReads:1}).description,'src/extension.js · 642–676 · Повтор');
});

test('follow-up suggestions require a concrete current action',()=>{
  const {followUpSuggestion}=require('../media/transcript');
  const session={taskId:'current',timeline:[
    {id:'u',role:'user',text:'Проверь'},
    {id:'edit',role:'tool',change:{file:'main.js'}},
    {id:'a',role:'assistant',status:'done',text:'Готово.'}
  ]};
  assert.equal(followUpSuggestion(session),'');
  assert.equal(followUpSuggestion({...session,plan:{taskId:'old',next_action:'Старый шаг'}}),'');
  assert.equal(followUpSuggestion({...session,plan:{steps:[{status:'done'}],next_action:'Закрытый шаг'}}),'');
  assert.equal(followUpSuggestion({...session,completion:{taskId:'current',status:'incomplete',
    gaps:['No current passing behavioral check','Unverified acceptance criterion: Повтор не дублирует запись']}}),
    'Проверь критерий — Повтор не дублирует запись');
  session.timeline.at(-1).text='Могу проверить смену часового пояса.';
  assert.equal(followUpSuggestion(session),'Давай проверить смену часового пояса.');
});
