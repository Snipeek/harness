'use strict';
const { randomUUID } = require('node:crypto');
// Only materialize a reasoning row when the provider actually supplies reasoning text.
function reasoningActivity(timeline, assistant, notify = () => {}, now = Date.now) {
  let entry, reasoningBytes = 0;
  function append(delta, { summary = false } = {}) {
    if (typeof delta !== 'string' || !delta) return;
    if (!entry) {
      entry = { id: randomUUID(), role: 'thinking', text: '', status: 'running', startedAt: now() };
      const index = timeline.indexOf(assistant);
      timeline.splice(index < 0 ? timeline.length : index, 0, entry);
    }
    entry.text += delta;
    if (!summary) {
      reasoningBytes += Buffer.byteLength(delta);
      entry.estimatedTokens = Math.ceil(reasoningBytes / 4);
    }
    notify();
  }
  function textStarted() { if (entry && !entry.finishedAt) { entry.finishedAt = now(); entry.status = 'done'; } }
  function finish(result, status = 'done') {
    if (!entry && result?.message?.reasoning_content) append(result.message.reasoning_content);
    if (!entry) return;
    entry.finishedAt ||= now(); entry.status = status;
    const tokens = result?.usage?.completion_tokens_details?.reasoning_tokens ?? result?.usage?.output_tokens_details?.reasoning_tokens;
    if (Number.isFinite(tokens) && tokens >= 0) {
      entry.tokens = tokens;
      delete entry.estimatedTokens;
    }
    notify();
  }
  function reset(){if(entry){finish(null,'interrupted');entry=undefined;reasoningBytes=0;}}
  return { append, textStarted, finish,reset };
}
module.exports = { reasoningActivity };
