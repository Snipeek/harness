'use strict';

// Provider adapters keep transport-specific history separate from the agent/tools.
function endpoint(base, suffix) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('API URL must use HTTPS (HTTP is allowed only for localhost).');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Use a base URL without credentials, query or fragment.');
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + suffix;
  return url.toString();
}

async function* events(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.search(/\r?\n\r?\n/)) !== -1) {
      const raw = pending.slice(0, index);
      const separator = pending.slice(index).match(/^\r?\n\r?\n/)[0];
      pending = pending.slice(index + separator.length);
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
  pending += decoder.decode();
  const data = pending.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (data && data !== '[DONE]') yield JSON.parse(data);
}

function responsesInput(messages) {
  return messages.flatMap(m => {
    if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }];
    if (m.role === 'assistant' && m._responseItems?.length) return m._responseItems;
    if (m.role === 'assistant') return [
      ...(m.content ? [{ role: 'assistant', content: [{ type: 'output_text', text: m.content, annotations: [] }] }] : []),
      ...(m.tool_calls || []).map(t => ({ type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments }))
    ];
    const content = m.role === 'user' && Array.isArray(m.content)
      ? m.content.map(part => part.type === 'image_url'
        ? { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }
        : { type: 'input_text', text: part.text })
      : m.content;
    return [{ role: m.role, content }];
  });
}

function chatMessages(messages, textOnly) {
  return messages.map(({ _responseItems, _origin, _updateId, ...message }) => {
    if (!textOnly || !Array.isArray(message.content)) return message;
    const content = message.content.map(part => {
      if (typeof part?.text === 'string') return part.text;
      if (part?.type === 'image_url' || part?.type === 'input_image') {
        return '[Image stored in chat history. This text-only model cannot view it.]';
      }
      return '[Non-text attachment unavailable to this model.]';
    }).join('\n');
    return { ...message, content };
  });
}

function requestPayload(options) {
  const { model, protocol, messages, tools = [], maxTokens = 8192 } = options;
  const responses = protocol === 'responses';
  const glmVision = /^glm-(?:5\.3-flash|\d+(?:\.\d+)?v(?:-[a-z0-9-]+)?)(?:\[1m\])?$/i.test(model);
  const payload = responses ? {
    model, input: responsesInput(messages), stream: true, store: false, include: ['reasoning.encrypted_content'],
    max_output_tokens: maxTokens,
    tools: tools.map(t => ({ type: 'function', ...t.function, strict: false }))
  } : {
    model, messages: chatMessages(messages, options.provider==='glm' && !glmVision), stream: true,
    max_tokens: maxTokens, tools,
    ...(options.provider === 'glm' ? glmParameters(model, options) : {})
  };
  return payload;
}

async function completeOnce(options) {
  const { baseUrl, model, protocol, messages, tools, signal, onDelta = () => {}, onReasoning = () => {}, maxTokens = 8192 } = options;
  const apiKey=options.getApiKey?await options.getApiKey():options.apiKey;options.onCredential?.(apiKey);
  if(options.provider==='chatgpt'&&(baseUrl!=='https://api.openai.com/v1'||protocol!=='responses'))throw Error('ChatGPT requires the official Responses API');
  if (!apiKey) throw new Error('API key is missing. Open AI → Settings → Configure provider.');
  if (!model) throw new Error('Set a model in AI: Configure Provider.');
  const startedAt = Date.now(); let firstTokenAt, actualModel;
  const marks = {};
  const meaningful = kind => { marks[kind] ??= Date.now() - startedAt; options.onMeaningfulEvent?.(); };
  const responses = protocol === 'responses';
  const payload = requestPayload(options);
  if (responses && options.promptCacheKey && baseUrl === 'https://api.openai.com/v1') {
    payload.prompt_cache_key = options.promptCacheKey;
  }
  if(options.provider==='chatgpt'){
    delete payload.max_output_tokens;
    if (require('./chatgpt-auth').reasoningLevels.includes(options.reasoningEffort)) {
      payload.reasoning = { effort: options.reasoningEffort };
    }
    payload.input=payload.input.map(item=>item.role==='system'?{...item,role:'developer'}:item.type==='function_call'&&!item.namespace?{...item,namespace:'agent_tools'}:item);
    if(payload.tools.length)payload.tools=[{type:'namespace',name:'agent_tools',description:'Local coding agent tools',tools:payload.tools}];
  }
  const cachePrefix = payload.input?.[0];
  const explicitCache = options.explicitPromptCache && !options.disableExplicitCache &&
    baseUrl === 'https://api.openai.com/v1' && /^gpt-6(?:[.-]|$)/.test(model) &&
    ['system', 'developer'].includes(cachePrefix?.role) &&
    typeof cachePrefix.content === 'string';
  if (explicitCache) {
    payload.prompt_cache_options = { mode: 'explicit' };
    payload.input[0] = {
      ...cachePrefix,
      role: 'developer',
      content: [{ type: 'input_text', text: cachePrefix.content, prompt_cache_breakpoint: { mode: 'explicit' } }]
    };
  }
  let res;
  for (let attempt = 0; ; attempt++) {
  const transport = { startedAt: Date.now(), status: null }; options.attempts?.push(transport);
  try { res = await fetch(endpoint(baseUrl, responses ? 'responses' : 'chat/completions'), {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload), signal, redirect: 'error'
  }); } catch(error) {
    transport.durationMs=Date.now()-transport.startedAt;transport.error=signal?.aborted?'aborted':'transport';transport.usageKnown=false;
    if(signal?.aborted || attempt >= (options.retries ?? 2)) throw error;
    await require('node:timers/promises').setTimeout(500 * 2 ** attempt, undefined, {signal}); continue;
  }
  transport.status=res.status;transport.headersMs=Date.now()-transport.startedAt;transport.usageKnown=false;
  if (![429, 502, 503, 504].includes(res.status) || attempt >= (options.retries ?? 2)) break;
  transport.durationMs=Date.now()-transport.startedAt;
  const retryAfter = Number(res.headers.get('retry-after'));
  await res.body?.cancel();
  await require('node:timers/promises').setTimeout(Math.min(10000, retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt), undefined, { signal });
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const body = await res.json(); detail += ': ' + (body.error?.message || body.message || 'API request failed'); } catch {}
    if (explicitCache && res.status === 400 && /prompt_cache_(?:options|breakpoint)/i.test(detail)) {
      const rejected = options.attempts?.at(-1);
      if (rejected) rejected.error = 'explicit-cache-rejected';
      return completeOnce({ ...options, disableExplicitCache: true });
    }
    throw new Error(detail.replaceAll(apiKey, '[redacted]').slice(0, 1500));
  }
  if (!res.body) throw new Error('API returned an empty body.');
  const message = { role: 'assistant', content: '' };
  let usage, finished = false, finishFailure;
  const calls = new Map(),responseItems=new Map();
  const itemSlot=event=>{if(event.output_index!==undefined)return event.output_index;const id=event.item?.id||event.item_id;for(const [key,record]of responseItems)if(id&&record.item.id===id)return key;return id;};
  try{for await (const event of events(res.body)) {
    if(firstTokenAt===undefined){firstTokenAt=Date.now();options.onFirstEvent?.();}
    actualModel = event.model || event.response?.model || actualModel;
    if (event.error) throw new Error(event.error.message || 'API stream error');
    if (responses) {
      if(['response.output_item.added','response.output_item.done'].includes(event.type)&&event.item){
        const key=itemSlot(event),old=responseItems.get(key);responseItems.set(key,{item:{...old?.item,...event.item},done:event.type==='response.output_item.done'||old?.done});
      }
      if(['response.function_call_arguments.delta','response.function_call_arguments.done'].includes(event.type)){
        const key=itemSlot(event),old=responseItems.get(key)||{item:{type:'function_call',id:event.item_id},done:false};
        if(event.type.endsWith('.delta'))old.item.arguments=(old.item.arguments||'')+(event.delta||'');
        else{old.item.arguments=event.arguments;old.argumentsDone=true;}
        responseItems.set(key,old);
      }
      if (event.type === 'response.reasoning_summary_text.delta' && event.delta) { meaningful('firstReasoningMs'); onReasoning(event.delta, { summary: true }); }
      if (event.type === 'response.output_text.delta' && event.delta) { meaningful('firstTextMs'); message.content += event.delta; onDelta(event.delta); }
      if (event.type === 'response.function_call_arguments.delta' && event.delta) meaningful('firstToolMs');
      if (event.type === 'response.completed') {
        if (event.response.status && event.response.status !== 'completed') throw new Error('Incomplete API response');
        const streamed=[...responseItems.values()];
        const finalItems=event.response.output||[];
        const finalIds=new Set(finalItems.map(i=>i.id).filter(Boolean));
        const recovered=streamed.filter(record=>!finalIds.has(record.item.id));
        if(recovered.some(record=>record.item.type==='function_call'&&!record.done&&!record.argumentsDone))throw Error('Responses stream ended without a complete function call. No tool was executed.');
        message._responseItems = [...recovered.filter(record=>record.done||record.argumentsDone).map(record=>record.item),...finalItems];
        if(message._responseItems.some(item=>item.type==='function_call'&&item.status==='incomplete'))throw Error('Responses returned an incomplete function call. No tool was executed.');
        const lastMessage=message._responseItems.filter(item=>item.type==='message').at(-1);if(lastMessage?.phase)message.phase=lastMessage.phase;
        if(!message._responseItems.length&&message.content)message._responseItems=[{role:'assistant',type:'message',content:[{type:'output_text',text:message.content,annotations:[]}]}];
        message.tool_calls = message._responseItems.filter(i => i.type === 'function_call').map(i => ({ id: i.call_id, type: 'function', function: { name: i.name, arguments: i.arguments } }));
        if (!message.content) message.content = message._responseItems.filter(i => i.type === 'message').flatMap(i => i.content || []).map(c => c.text || c.refusal || '').join('');
        usage = event.response.usage; finished = true;
        if(message.content) meaningful('firstTextMs');
        if(message.tool_calls.length) meaningful('firstToolMs');
        break; // A completed Responses response is terminal; do not wait for socket closure.
      }
      if (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason === 'max_output_tokens') {
        usage = event.response.usage;
        finishFailure = 'OUTPUT_LIMIT';
        finished = true;
        break;
      }
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw new Error(event.response?.error?.message || event.message || 'Model response interrupted; try a larger output limit.');
    } else {
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) { meaningful('firstTextMs'); message.content += delta.content; onDelta(delta.content); }
      if (delta.reasoning_content) { meaningful('firstReasoningMs'); message.reasoning_content = (message.reasoning_content || '') + delta.reasoning_content; onReasoning(delta.reasoning_content); }
      for (const part of delta.tool_calls || []) {
        if(part.function?.name || part.function?.arguments) meaningful('firstToolMs');
        const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
      if (choice.finish_reason) {
        if(choice.finish_reason==='length'){finishFailure='OUTPUT_LIMIT';finished=true;continue;}
        if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error(`Model stopped: ${choice.finish_reason}. Increase output limit or start a shorter conversation.`);
        finished = true;
      }
    }
  }}catch(error){
    if(options.signal?.aborted)throw error;
    const disconnected=error instanceof TypeError&&(/terminated|fetch failed|network/i.test(error.message)||/^UND_ERR_|ECONNRESET|ETIMEDOUT/.test(error.cause?.code||''));
    if(!disconnected)throw error;
    if(!finished){const interrupted=Error('Соединение с моделью оборвалось до завершения ответа. История сохранена.');interrupted.code='STREAM_INTERRUPTED';interrupted.usage=usage;throw interrupted;}
    // Chat finish_reason already finalized all calls. A lost trailing usage packet
    // must not cause those calls to be requested/executed a second time.
  }
  if(finishFailure){const error=new Error(`Модель исчерпала лимит ответа (${maxTokens} токенов, включая мышление). Незавершённые вызовы инструментов не выполнялись.`);error.code=finishFailure;error.usage=usage;error.metrics={durationMs:Date.now()-startedAt,actualModel:actualModel||null,usageKnown:!!usage,...marks};throw error;}
  if (!finished){const error=Error('API stream ended unexpectedly before completing the response.');error.code='STREAM_INTERRUPTED';throw error;}
  if (!responses) message.tool_calls = [...calls.values()];
  if (!message.tool_calls?.length) delete message.tool_calls;
  const last=options.attempts?.at(-1);if(last){last.durationMs=Date.now()-last.startedAt;last.usageKnown=!!usage;}
  return { message, usage, metrics: { durationMs: Date.now() - startedAt, firstEventMs: firstTokenAt ? firstTokenAt - startedAt : null, ...marks, actualModel:actualModel||null, cacheMode: explicitCache ? 'explicit' : options.disableExplicitCache ? 'implicit-fallback' : 'default', usageKnown:!!usage } };
}

async function complete(options) {
  const started=Date.now(), attempts=[];let credential=options.apiKey;
  for(let attempt=0;attempt<2;attempt++){
    let seen=false,timedOut=false;const controller=new AbortController();
    const timer=setTimeout(()=>{timedOut=true;controller.abort(new Error('Provider did not start streaming within the first-event timeout.'));},options.firstEventTimeoutMs??45000);
    try {
      const result=await completeOnce({...options,attempts,onCredential:value=>{credential=value;},signal:AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])]),onFirstEvent:()=>{seen=true;options.onFirstEvent?.();},onMeaningfulEvent:()=>{clearTimeout(timer);options.onMeaningfulEvent?.();}});
      const offset=Date.now()-started-result.metrics.durationMs;
      for(const key of ['firstEventMs','firstTextMs','firstReasoningMs','firstToolMs'])if(result.metrics[key]!=null)result.metrics[key]+=offset;
      result.metrics.durationMs=Date.now()-started;result.metrics.firstEventRetries=attempt;result.metrics.attempts=attempts;return result;
    }catch(error){const last=attempts.at(-1);if(last){last.durationMs=Date.now()-last.startedAt;last.error=timedOut?'first-meaningful-timeout':options.signal?.aborted?'aborted':'request-failed';}
      if(error.code==='STREAM_INTERRUPTED'&&attempt===0&&!options.signal?.aborted){options.onRetry?.({attempt:1,reason:'Поток модели оборвался; повторяю незавершённый запрос. Инструменты ещё не выполнялись.'});continue;}
      if(seen||!timedOut||options.signal?.aborted||attempt===1){const failure=new Error(credential?String(error.message||error).replaceAll(credential,'[redacted]').replaceAll(options.apiKey||credential,'[redacted]'):String(error.message||error));failure.name=error.name||'Error';failure.code=error.code;failure.usage=error.usage;failure.metrics={durationMs:Date.now()-started,attempts,...error.metrics,usageKnown:!!error.usage};throw failure;}}
    finally{clearTimeout(timer);}
  }
}

function glmParameters(model, options) {
  const supported = /^glm-(5(?:\.|$)|4\.[67])/.test(model);
  if (!supported) return {};
  const effort = ['low','high','max'].includes(options.reasoningEffort) ? options.reasoningEffort : 'low';
  return { thinking: { type: 'enabled', clear_thinking: false }, ...(/^glm-5\.[23]/.test(model) ? { reasoning_effort: effort } : {}) };
}

module.exports = { complete, events, endpoint, responsesInput, glmParameters, requestPayload };
