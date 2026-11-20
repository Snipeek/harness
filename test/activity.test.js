'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reasoningActivity } = require('../src/activity');

test('reasoning deltas precede their assistant response and coalesce into one row', () => {
  let time = 1000; const assistant = { id: 'answer', role: 'assistant', text: '' }, timeline = [{ id: 'user', role: 'user' }, assistant];
  const activity = reasoningActivity(timeline, assistant, () => {}, () => time);
  activity.append('Supplied ');
  assert.equal(timeline[1].estimatedTokens, 3);
  time = 2000; activity.append('reasoning.');
  assert.equal(timeline[1].estimatedTokens, 5);
  time = 4000; activity.textStarted(); time = 6000;
  activity.finish({ usage: { completion_tokens_details: { reasoning_tokens: 209 } } });
  assert.deepEqual(timeline.map(e => e.role), ['user', 'thinking', 'assistant']);
  assert.equal(timeline[1].estimatedTokens, undefined);
  assert.equal(timeline[1].text, 'Supplied reasoning.'); assert.equal(timeline[1].finishedAt, 4000); assert.equal(timeline[1].tokens, 209); assert.equal(timeline[1].status, 'done');
});
test('waiting without provider reasoning never fabricates a reasoning row or token count', () => {
  const assistant = { id: 'answer' }, timeline = [assistant]; const activity = reasoningActivity(timeline, assistant);
  activity.finish({ message: { content: 'Hello' }, usage: { completion_tokens: 42 } });
  assert.equal(timeline.length, 1); assert.equal(timeline[0], assistant);
});
test('interrupted reasoning retains received text with an interrupted status', () => {
  const assistant = {}, timeline = [assistant], activity = reasoningActivity(timeline, assistant);
  activity.append('Received summary'); activity.finish(null, 'interrupted');
  assert.equal(timeline[0].status, 'interrupted'); assert.equal(timeline[0].text, 'Received summary'); assert.equal(timeline[0].tokens, undefined);
});
test('nonstreamed reasoning can be displayed, while ordinary output tokens are not relabeled as reasoning', () => {
  const assistant = {}, timeline = [assistant], activity = reasoningActivity(timeline, assistant);
  activity.finish({ message: { reasoning_content: 'Provider supplied summary' }, usage: { completion_tokens: 80 } });
  assert.equal(timeline[0].role, 'thinking'); assert.equal(timeline[0].tokens, undefined);
});

test('a streamed provider summary is not an estimate of hidden reasoning tokens', () => {
  const assistant = {}, timeline = [assistant], activity = reasoningActivity(timeline, assistant);
  activity.append('A readable summary', { summary: true });
  assert.equal(timeline[0].estimatedTokens, undefined);
  activity.finish({ usage: { output_tokens_details: { reasoning_tokens: 30 } } });
  assert.equal(timeline[0].tokens, 30);
});
