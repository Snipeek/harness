'use strict';
const { createHash } = require('node:crypto');

function describeRequest({messages, tools = []}, estimate, state, memo) {
  const bins = {};
  const count = (group, tokens) => { bins[group] = (bins[group] || 0) + tokens; };
  const skillCalls = new Set(messages.flatMap(message => (message.tool_calls || [])
    .filter(call => ['load_skill', 'read_skill_resource'].includes(call.function?.name))
    .map(call => call.id)));
  const schema = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
  const entries = [{group:'tools', hash:schema(tools)}];
  for (const tool of tools) count(tool.function?.name?.startsWith('mcp_') ? 'mcp' : 'tools', estimate(tool));
  for (const message of messages) {
    const group = message.role === 'system' ? 'instructions' : message._origin === 'harness' ? 'taskState'
      : message.role !== 'tool' ? 'history' : skillCalls.has(message.tool_call_id) ? 'skills' : 'toolResults';
    const cached = memo?.get(message) || {tokens:estimate(message),hash:schema(message)};
    memo?.set(message,cached);
    count(group,cached.tokens);
    entries.push({group, hash:cached.hash});
  }
  const previous = state.requestPrefix;
  let prefix;
  if (previous) {
    let common = 0;
    while (common < previous.length && common < entries.length && previous[common] === entries[common].hash) common++;
    prefix = { sameBlocks:common, comparedBlocks:Math.min(previous.length, entries.length),
      firstChanged:common < Math.min(previous.length, entries.length) ? entries[common].group : undefined };
  }
  state.requestPrefix = entries.slice(0, 1024).map(entry => entry.hash);
  return { contextBreakdown:bins, prefix };
}

function validContextWindow(value) {
  return Number.isInteger(value) && value >= 8192 && value <= 10000000 ? value : undefined;
}

function idleCompactionBudget({context,updated,identity}, now, minutes, window) {
  if(!identity || !context?.estimatedTokens || now-updated < minutes*60000) return undefined;
  if(context.estimatedTokens < Math.min(200000,Math.floor(window*.75)))return undefined;
  return Math.floor(window*.45);
}

module.exports = { describeRequest, validContextWindow, idleCompactionBudget };
