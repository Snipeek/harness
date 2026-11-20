'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { complete, events, endpoint, responsesInput } = require('../src/providers');
async function* bytes(chunks) { for (const chunk of chunks) yield new TextEncoder().encode(chunk); }
function stream(chunks) { return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }
const packet = value => `data: ${JSON.stringify(value)}\n\n`;

test('SSE parser handles split UTF8, CRLF, multi-line data and final unterminated packet', async () => {
  const buffer = new TextEncoder().encode('event: delta\r\ndata: {"text":"Привет"}\r\n\r\ndata: {"last":true}');
  async function* chunks() { for (let i = 0; i < buffer.length; i += 3) yield buffer.slice(i, i + 3); }
  const result = []; for await (const event of events(chunks())) result.push(event);
  assert.deepEqual(result, [{ text: 'Привет' }, { last: true }]);
});
test('endpoint refuses unsafe transports and embedded credentials', () => {
  assert.equal(endpoint('https://api.z.ai/api/coding/paas/v4/', 'chat/completions'), 'https://api.z.ai/api/coding/paas/v4/chat/completions');
  assert.throws(() => endpoint('http://example.com/v1', 'chat/completions'));
  assert.throws(() => endpoint('https://user:pass@example.com', 'responses'));
  assert.equal(endpoint('http://127.0.0.1:1234/v1', 'responses'), 'http://127.0.0.1:1234/v1/responses');
});
test('chat streaming assembles fragmented tools and preserves reasoning, usage and text', async t => {
  let payload;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    payload = JSON.parse(options.body);
    return stream([
      packet({ choices: [{ delta: { content: 'Hello ', reasoning_content: 'internal' } }] }),
      packet({ choices: [{ delta: { content: 'world', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
      packet({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }, finish_reason: 'tool_calls' }] }),
      packet({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }), 'data: [DONE]\n\n'
    ]);
  });
  let text = '';
  const result = await complete({ provider: 'glm', protocol: 'chat', baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: 'fake', model: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [], onDelta: delta => text += delta });
  assert.equal(text, 'Hello world'); assert.equal(result.message.content, text);
  assert.equal(result.message.reasoning_content, 'internal');
  assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { path: 'README.md' });
  assert.equal(result.usage.prompt_tokens, 20); assert.equal(payload.thinking, undefined);
});
test('incomplete chat stream never executes partial tool arguments', async t => {
  t.mock.method(globalThis, 'fetch', async () => stream([packet({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'run_command', arguments: '{' } }] } }] })]));
  await assert.rejects(complete({ baseUrl: 'https://example.com/v1', apiKey: 'fake', model: 'test', tools: [], messages: [] }), /unexpectedly/);
});
test('Responses preserves reasoning items and maps call IDs for a followup tool result', async t => {
  const output = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'reason' }, { type: 'function_call', call_id: 'call_x', name: 'list_files', arguments: '{}' }];
  t.mock.method(globalThis, 'fetch', async () => stream([
    packet({ type: 'response.output_text.delta', delta: 'Checking' }),
    packet({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 8, output_tokens: 4 } } })
  ]));
  const result = await complete({ protocol: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'fake', model: 'test', tools: [], messages: [] });
  assert.equal(result.message.tool_calls[0].id, 'call_x');
  const input = responsesInput([result.message, { role: 'tool', tool_call_id: 'call_x', content: 'README.md' }]);
  assert.deepEqual(input, [...output, { type: 'function_call_output', call_id: 'call_x', output: 'README.md' }]);
});
test('HTTP errors redact credentials', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'bad key secret-key' } }), { status: 401 }));
  await assert.rejects(complete({ baseUrl: 'https://example.com', apiKey: 'secret-key', model: 'test', tools: [], messages: [] }), e => !e.message.includes('secret-key') && e.message.includes('401'));
});
test('stream error messages redact credentials too',async t=>{
 t.mock.method(globalThis,'fetch',async()=>stream([packet({error:{message:'provider rejected secret-key'}})]));
 await assert.rejects(complete({baseUrl:'https://example.com',apiKey:'secret-key',model:'test',tools:[],messages:[]}),e=>!e.message.includes('secret-key')&&e.metrics.usageKnown===false);
});

test('provider reasoning callbacks contain only supplied stream text', async t => {
  t.mock.method(globalThis, 'fetch', async () => stream([
    packet({ choices: [{ delta: { reasoning_content: 'Supplied summary' } }] }),
    packet({ choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] })
  ]));
  const parts = [];
  await complete({ baseUrl: 'https://example.com/v1', apiKey: 'fake', model: 'test', messages: [], tools: [], onReasoning: value => parts.push(value) });
  assert.deepEqual(parts, ['Supplied summary']);
});
test('telemetry separates empty SSE, reasoning, text, tools, model identity and missing usage',async t=>{
 t.mock.method(globalThis,'fetch',async()=>stream([packet({choices:[]}),packet({model:'actual-5.3',choices:[{delta:{reasoning_content:'r'}}]}),packet({choices:[{delta:{content:'answer',tool_calls:[{index:0,id:'x',function:{name:'read_file',arguments:'{}'}}]},finish_reason:'tool_calls'}]})]));
 const r=await complete({baseUrl:'https://example.org',apiKey:'test',model:'alias',tools:[],messages:[]});
 assert.equal(r.metrics.actualModel,'actual-5.3');assert.equal(r.metrics.usageKnown,false);assert(r.metrics.firstReasoningMs>=r.metrics.firstEventMs);assert(r.metrics.firstTextMs>=r.metrics.firstReasoningMs);assert(r.metrics.firstToolMs>=r.metrics.firstEventMs);assert.equal(r.metrics.attempts.length,1);
});
test('empty SSE does not disable the meaningful-output timeout and is never replayed',async t=>{
 let requests=0;t.mock.method(globalThis,'fetch',async(_url,{signal})=>{requests++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(packet({choices:[]})));signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});}}));});
 await assert.rejects(complete({baseUrl:'https://example.org',apiKey:'test',model:'m',tools:[],messages:[],firstEventTimeoutMs:20}),e=>e.metrics?.usageKnown===false&&e.metrics.attempts.length===1);assert.equal(requests,1);
});

test('ChatGPT plan uses refreshed credentials, developer instructions and namespaced local tools',async t=>{
 let payload,headers;let refreshed=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');payload=JSON.parse(options.body);headers=options.headers;return stream([packet({type:'response.completed',response:{status:'completed',output:[{type:'function_call',namespace:'agent_tools',name:'read_file',call_id:'c1',arguments:'{"path":"README.md"}'}],usage:{input_tokens:10,output_tokens:5}}})]);});
 const result=await complete({provider:'chatgpt',protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:'expired',getApiKey:async()=>{refreshed++;return 'renewed';},model:'account-model',reasoningEffort:'xhigh',maxTokens:2000,messages:[{role:'system',content:'Follow project rules'},{role:'user',content:'Read README'}],tools:[{type:'function',function:{name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}}}}}]});
 assert.equal(refreshed,1);assert.equal(headers.authorization,'Bearer renewed');assert.equal(payload.store,false);assert.equal(payload.stream,true);assert.deepEqual(payload.reasoning,{effort:'xhigh'});assert(!('max_output_tokens'in payload));assert.equal(payload.input[0].role,'developer');assert.equal(payload.tools[0].type,'namespace');assert.equal(payload.tools[0].tools[0].name,'read_file');assert.equal(result.message.tool_calls[0].function.name,'read_file');assert.equal(result.message._responseItems[0].namespace,'agent_tools');
});
test('ChatGPT subscription never sends OAuth credentials to a custom endpoint',async t=>{
 let called=false;t.mock.method(globalThis,'fetch',async()=>{called=true;throw Error('should not send');});await assert.rejects(complete({provider:'chatgpt',protocol:'responses',baseUrl:'https://other.test',apiKey:'private',model:'model',messages:[],tools:[]}),/official Responses/);assert.equal(called,false);
});

test('output exhaustion retains reported usage and never returns executable partial calls',async t=>{
 t.mock.method(globalThis,'fetch',async()=>stream([packet({choices:[{delta:{tool_calls:[{index:0,id:'unfinished',function:{name:'run_command',arguments:'{"command":'}}]},finish_reason:'length'}]}),packet({usage:{prompt_tokens:100,completion_tokens:4096,prompt_tokens_details:{cached_tokens:90}}})]));
 await assert.rejects(complete({apiKey:'fake',model:'glm-5.3',protocol:'chat',baseUrl:'https://api.z.ai/api/coding/paas/v4',tools:[],messages:[],maxTokens:4096}),error=>{assert.equal(error.code,'OUTPUT_LIMIT');assert.equal(error.usage.completion_tokens,4096);assert.equal(error.metrics.usageKnown,true);assert.equal(error.message.tool_calls,undefined);return true;});
});

test('Responses recovers completed streamed functions, message phases and encrypted reasoning when terminal output is empty',async t=>{
 const output=[{id:'r1',type:'reasoning',encrypted_content:'encrypted-history'},{id:'m1',type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Inspecting files',annotations:[]}]},{id:'f1',type:'function_call',call_id:'c1',namespace:'agent_tools',name:'read_file',arguments:'{"path":"README.md"}',status:'completed'}];
 t.mock.method(globalThis,'fetch',async()=>stream([
  packet({type:'response.output_item.done',output_index:0,item:output[0]}),packet({type:'response.output_text.delta',delta:'Inspecting files'}),packet({type:'response.output_item.done',output_index:1,item:output[1]}),
  packet({type:'response.output_item.added',output_index:2,item:{...output[2],arguments:'',status:'in_progress'}}),packet({type:'response.function_call_arguments.delta',output_index:2,item_id:'f1',delta:'{"path":'}),packet({type:'response.function_call_arguments.delta',output_index:2,item_id:'f1',delta:'"README.md"}'}),packet({type:'response.output_item.done',output_index:2,item:output[2]}),packet({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:10,output_tokens:20}}})
 ]));
 const result=await complete({protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:'test',model:'test',tools:[],messages:[]});assert.equal(result.message.tool_calls[0].function.name,'read_file');assert.equal(result.message.phase,'commentary');assert.deepEqual(result.message._responseItems,output);assert.deepEqual(responsesInput([result.message]),output);
});
test('Responses never executes unfinished streamed functions or duplicates finalized calls',async t=>{
 const call={id:'f',type:'function_call',call_id:'c',namespace:'agent_tools',name:'read_file',arguments:'{}',status:'completed'};let done=false;
 t.mock.method(globalThis,'fetch',async()=>stream([packet({type:'response.output_item.added',output_index:0,item:{...call,status:'in_progress'}}),...(done?[packet({type:'response.output_item.done',output_index:0,item:call})]:[]),packet({type:'response.completed',response:{status:'completed',output:done?[call]:[]}})]));
 const options={protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:'test',model:'test',tools:[],messages:[]};await assert.rejects(complete(options),/without a complete function call/);done=true;assert.equal((await complete(options)).message.tool_calls.length,1);
});
test('legacy empty response items no longer erase assistant text from subsequent requests',()=>{const input=responsesInput([{role:'assistant',content:'Previously displayed reply',_responseItems:[]}]);assert.equal(input.length,1);assert.equal(input[0].content[0].text,'Previously displayed reply');});

test('a broken response body retries once and discards unfinished calls', async t => {
  let requests = 0, retries = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++requests === 1) {
      const chunks = [packet({choices:[{delta:{content:'Partial',tool_calls:[{index:0,id:'abandoned',function:{name:'read_file',arguments:'{}'}}]}}]})];
      return new Response(new ReadableStream({pull(controller) {
        if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
        else controller.error(new TypeError('terminated'));
      }}));
    }
    return stream([packet({choices:[{delta:{content:'Recovered'},finish_reason:'stop'}]})]);
  });
  const result = await complete({protocol:'chat',apiKey:'test',model:'test',baseUrl:'https://example.com',messages:[],tools:[],onRetry:()=>retries++});
  assert.equal(retries,1);
  assert.equal(result.message.content,'Recovered');
  assert.equal(result.message.tool_calls,undefined);
});

test('explicit Responses caching marks only stable instructions and falls back on unsupported caching', async t => {
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    payloads.push(JSON.parse(request.body));
    if (payloads.length === 1) {
      return Response.json({ error: { message: 'Unsupported parameter: prompt_cache_options' } }, { status: 400 });
    }
    return stream([packet({ type: 'response.completed', response: { model: 'gpt-6.1-sol', output: [], usage: { input_tokens: 1200, output_tokens: 1, input_tokens_details: { cached_tokens: 1024 } } } })]);
  });
  const messages = [{ role: 'system', content: 'Stable rules' }, { role: 'user', content: 'Current task' }];
  const result = await complete({
    provider: 'chatgpt', baseUrl: 'https://api.openai.com/v1', protocol: 'responses',
    model: 'gpt-6.1-sol', apiKey: 'test-credential', messages, tools: [],
    promptCacheKey: 'workspace', explicitPromptCache: true
  });
  assert.deepEqual(payloads[0].prompt_cache_options, { mode: 'explicit' });
  assert.deepEqual(payloads[0].input[0], {
    role: 'developer',
    content: [{ type: 'input_text', text: 'Stable rules', prompt_cache_breakpoint: { mode: 'explicit' } }]
  });
  assert.deepEqual(payloads[0].input[1], messages[1]);
  assert.equal(payloads[1].prompt_cache_options, undefined);
  assert.equal(payloads[1].prompt_cache_key, 'workspace');
  assert.equal(result.metrics.cacheMode, 'implicit-fallback');
  assert.equal(result.usage.input_tokens_details.cached_tokens, 1024);
  assert.deepEqual(messages[0], { role: 'system', content: 'Stable rules' });
});

test('Responses output exhaustion exposes the same recoverable code and usage as Chat Completions', async t => {
  const usage = { input_tokens: 100, output_tokens: 4096 };
  t.mock.method(globalThis, 'fetch', async () => stream([packet({
    type: 'response.incomplete',
    response: { incomplete_details: { reason: 'max_output_tokens' }, usage }
  })]));
  await assert.rejects(complete({
    protocol: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'test',
    model: 'test', tools: [], messages: [], maxTokens: 4096
  }), error => error.code === 'OUTPUT_LIMIT' && assert.deepEqual(error.usage, usage) === undefined);
});
