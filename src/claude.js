'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';

// Traverse every UUID-bearing record: attachment/system nodes can connect real messages.
async function readClaude(file, project, depth = 0) {
  const nodes = new Map(); let title = '', customTitle = '', cost = 0, updated = 0, leaf, root;
  for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    updated = Math.max(updated, Date.parse(r.timestamp || '') || 0);
    if (r.type === 'custom-title' && r.customTitle) customTitle = r.customTitle;
    if (r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;
    if (r.type === 'cost-state' && typeof r.totalCostUSD === 'number') cost = r.totalCostUSD;
    if (r.uuid && (!r.isSidechain || depth > 0)) {
      nodes.set(r.uuid, r);
      if (r.type === 'user' || r.type === 'assistant') { leaf = r.uuid; root = r.cwd || root; }
    }
  }
  const chain = [], visited = new Set();
  for (let uuid = leaf; uuid && nodes.has(uuid) && !visited.has(uuid); uuid = nodes.get(uuid).parentUuid) { visited.add(uuid); chain.push(nodes.get(uuid)); }
  chain.reverse();
  const timeline = [], calls = new Map();
  const namespace = path.basename(file, '.jsonl');
  for (const r of chain) {
    if (!['user', 'assistant'].includes(r.type)) continue;
    const blocks = typeof r.message?.content === 'string' ? [{ type: 'text', text: r.message.content }] : r.message?.content || [];
    const startedAt = Date.parse(r.timestamp || '') || undefined;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i], id = `${namespace}:${r.uuid}:${i}`;
      if (b.type === 'text' && b.text) timeline.push({ id, role: r.type, text: b.text, startedAt });
      if (b.type === 'thinking' && b.thinking) timeline.push({ id, role: 'thinking', text: b.thinking, status: 'done', startedAt });
      if (b.type === 'tool_use') {
        const event = { id, role: 'tool', name: b.name, input: JSON.stringify(b.input || {}), result: '', status: 'interrupted', startedAt };
        if (['Agent', 'Task'].includes(b.name)) event.agents = [{ id: id + ':agent', role: 'agent', title: b.input?.description || 'Agent task', agentType: b.input?.subagent_type || 'general', prompt: b.input?.prompt || '', status: 'interrupted', timeline: [], startedAt, toolCount: 0, usage: { input: 0, output: 0 } }];
        calls.set(b.id, event); timeline.push(event);
      }
      if (b.type === 'tool_result') {
        const event = calls.get(b.tool_use_id); if (!event) continue;
        event.result = textOf(b.content) || (typeof b.content === 'string' ? b.content : ''); event.status = b.is_error ? 'error' : 'done'; event.finishedAt = startedAt;
        if (event.agents) {
          const agent = event.agents[0], result = r.toolUseResult || {};
          agent.status = event.status; agent.result = textOf(result.content) || event.result; agent.finishedAt = startedAt;
          agent.toolCount = result.totalToolUseCount || 0; agent.model = result.resolvedModel || ''; agent.background = !!result.isAsync;
          agent.usage = { input: result.usage?.input_tokens || 0, output: result.usage?.output_tokens || 0 };
          if (depth < 2 && typeof result.agentId === 'string' && /^[\w-]+$/.test(result.agentId)) {
            const childFile = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents', `agent-${result.agentId}.jsonl`);
            try { agent.timeline = (await readClaude(childFile, project, depth + 1)).timeline; } catch {}
          }
        }
      }
    }
  }
  const events = timeline.filter(e => ['user', 'assistant'].includes(e.role)).map(({ role, text }) => ({ role, text }));
  title = customTitle || title || (events.find(e => e.role === 'user')?.text || '').split('\n')[0].slice(0, 70) || 'Без названия';
  return { id: 'cc:' + path.relative(os.homedir(), file), file, project, root, title, updated, cost, events, timeline };
}
async function listClaude(root = path.join(os.homedir(), '.claude', 'projects')) {
  const out = [];
  for (const dir of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    for (const name of await fs.readdir(path.join(root, dir.name)).catch(() => [])) if (name.endsWith('.jsonl')) {
      try { out.push(await readClaude(path.join(root, dir.name, name), dir.name)); } catch {}
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}
module.exports = { listClaude, readClaude };
