'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { listClaude, readClaude } = require('../src/claude');

test('claude history: main chain, duplicates, sidechains, titles, cost', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-hist-'));
  const dir = path.join(root, 'Users-x-proj'); await fs.mkdir(dir);
  const file = path.join(dir, 'a.jsonl');
  const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-11-01T10:00:00Z', message: { content: 'сделай фичу' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-01T10:00:05Z', message: { content: [{ type: 'text', text: 'готово' }] } },
    { type: 'user', uuid: 's1', parentUuid: 'a1', isSidechain: true, message: { content: 'сайдчейн' } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-11-01T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'спасибо' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'пожалуйста' } },
    { type: 'ai-title', aiTitle: 'Старый заголовок' },
    { type: 'cost-state', totalCostUSD: 1.25 },
    { type: 'custom-title', customTitle: 'Мой разговор' },
    'not json at all'
  ];
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n'));
  const s = await readClaude(file, 'Users-x-proj');
  assert.equal(s.title, 'Мой разговор');
  assert.equal(s.cost, 1.25);
  assert.equal(s.project, 'Users-x-proj');
  assert.deepEqual(s.events.map(e => e.role + ':' + e.text), ['user:сделай фичу', 'assistant:готово', 'user:спасибо', 'assistant:пожалуйста']);
  const list = await listClaude(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, s.id);
  await fs.rm(root, { recursive: true, force: true });
});

test('claude history: fallback title from first user message', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-hist-'));
  const file = path.join(root, 'p', 'b.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'Первая строка\nвторая' } }));
  const s = await readClaude(file, 'p');
  assert.equal(s.title, 'Первая строка');
  await fs.rm(root, { recursive: true, force: true });
});

test('claude transcript keeps tools, thinking and traverses non-message parent nodes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-tools-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, [
    { type: 'user', uuid: 'u', message: { content: 'Read file' } },
    { type: 'attachment', uuid: 'bridge', parentUuid: 'u' },
    { type: 'assistant', uuid: 'a', parentUuid: 'bridge', message: { content: [{ type: 'thinking', thinking: 'A saved reasoning block' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'file.txt' } }] } },
    { type: 'user', uuid: 'result', parentUuid: 'a', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'File text' }] } },
    { type: 'assistant', uuid: 'final', parentUuid: 'result', message: { content: 'Read complete' } },
    { type: 'custom-title', customTitle: 'My title' }, { type: 'ai-title', aiTitle: 'Generated later' }
  ].map(JSON.stringify).join('\n'));
  const session = await readClaude(file, 'project');
  assert.equal(session.title, 'My title'); assert.equal(session.events[0].text, 'Read file');
  assert.deepEqual(session.timeline.map(e => e.role), ['user', 'thinking', 'tool', 'assistant']);
  assert.equal(session.timeline[2].result, 'File text'); assert.equal(session.timeline[2].status, 'done');
});

test('claude imports a real subagent transcript attached by agentId', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-agent-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'session', 'subagents'), { recursive: true });
  await fs.writeFile(path.join(root, 'session', 'subagents', 'agent-child.jsonl'), JSON.stringify({ type: 'assistant', uuid: 'child-final', isSidechain: true, message: { content: 'Found the issue' } }));
  await fs.writeFile(path.join(root, 'session.jsonl'), [
    { type: 'user', uuid: 'u', message: { content: 'Investigate' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: { description: 'Review code', subagent_type: 'Explore', prompt: 'Find the bug' } }] } },
    { type: 'user', uuid: 'r', parentUuid: 'a', toolUseResult: { agentId: 'child', totalToolUseCount: 4 }, message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'Done' }] } }
  ].map(JSON.stringify).join('\n'));
  const session = await readClaude(path.join(root, 'session.jsonl'), 'project');
  const agent = session.timeline[1].agents[0]; assert.equal(agent.title, 'Review code'); assert.equal(agent.toolCount, 4); assert.equal(agent.timeline[0].text, 'Found the issue');
});
