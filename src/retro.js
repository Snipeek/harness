'use strict';

const number = new Intl.NumberFormat('ru-RU');
const seconds = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const formatTime = ms => seconds.format(ms / 1000) + ' с';
const {researchCoverage}=require('./research-coverage');
const {usageOf}=require('./engine');

function signature(input) {
  if (typeof input !== 'string') return undefined;
  try {
    return JSON.stringify(JSON.parse(input), (_, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
        : value);
  } catch {
    return input;
  }
}

function summarizeRetro(session, { excludeTurnId } = {}) {
  const metrics = (session.metrics || []).filter(row=>row.phase!=='idle-compaction');
  const turnIds = [...new Set(metrics.map(row => row.turnId))].filter(id => id && id !== excludeTurnId);
  const turnId = turnIds.includes(session.turnId) ? session.turnId : turnIds.at(-1);
  if (!turnId) return null;

  const rows = metrics.filter(row => row.turnId === turnId);
  const tools = new Map();
  const model = new Map();
  const toolEntries = new Map();
  function indexTools(timeline) {
    for (const event of timeline || []) {
      if (event.role === 'tool') toolEntries.set(event.id, event);
      for (const agent of event.agents || []) indexTools(agent.timeline);
    }
  }
  indexTools(session.timeline);
  const legacyEntries = new Map((session.timeline || []).filter(event => event.role === 'tool')
    .map(event => [`${event.startedAt}:${event.name}`, event]));
  const starts = rows.map(row => row.at);
  const ends = rows.map(row => row.at + row.durationMs);
  let toolCount = 0;
  for (const row of rows) {
    if (row.phase === 'tool') {
      toolCount++;
      if (!tools.has(row.name)) tools.set(row.name, { name: row.name, calls: 0, time: 0, errors: 0, repeated: 0, inputs: new Set() });
      const group = tools.get(row.name);
      group.calls++;
      group.time += row.durationMs;
      if (row.status === 'error') group.errors++;
      const event = toolEntries.get(row.eventId) ||
        (row.actor === 'main' ? legacyEntries.get(`${row.at}:${row.name}`) : undefined);
      const input = signature(event?.input);
      if (input !== undefined) {
        const key = `${row.agentId || ''}:${input}`;
        if (group.inputs.has(key)) group.repeated++;
        group.inputs.add(key);
      }
      continue;
    }
    if (!['generation', 'compaction'].includes(row.phase)) continue;
    if (!model.has(row.actor)) model.set(row.actor, { actor: row.actor, requests: 0, time: 0, reported: 0, input: 0, output: 0, cacheReported: 0, cached: 0 });
    const group = model.get(row.actor);
    group.requests++;
    group.time += row.durationMs;
    if (!row.usage) continue;
    const usage = row.usage;
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    if (Number.isFinite(input) && Number.isFinite(output)) {
      group.reported++;
      group.input += input;
      group.output += output;
    }
    const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens;
    if (Number.isFinite(cached)) {
      group.cacheReported++;
      group.cached += cached;
    }
  }

  return {
    toolCount,
    span: Math.max(...ends) - Math.min(...starts),
    research:researchCoverage(rows.filter(row=>row.phase==='tool'&&row.actor==='main')
      .sort((a,b)=>a.at-b.at)
      .map(row=>toolEntries.get(row.eventId)||legacyEntries.get(`${row.at}:${row.name}`)).filter(Boolean)),
    model: [...model.values()].sort((a, b) => b.time - a.time),
    tools: [...tools.values()].sort((a, b) =>
      b.repeated - a.repeated || b.errors - a.errors || b.time - a.time)
      .slice(0, 3).map(({ name, calls, time, errors, repeated }) => ({ name, calls, time, errors, repeated })),
  };
}

function formatRetro(session, options) {
  const report = summarizeRetro(session, options);
  if (!report) return 'Ретроспектива появится после первого завершённого хода с метриками.';
  const lines = [`Последний завершённый ход · ${formatTime(report.span)} по событиям · вызовы инструментов ${report.toolCount}`];
  for (const group of report.model) {
    const actor = group.actor === 'subagent' ? 'Субагенты' : 'Основная модель';
    const usage = group.reported
      ? `вход ${number.format(group.input)} · выход ${number.format(group.output)}`
      : 'расход недоступен';
    const cache = group.cacheReported ? ` · кэш ${number.format(group.cached)}` : ' · кэш недоступен';
    const coverage = group.reported && group.reported < group.requests ? ` · расход по ${group.reported}/${group.requests} запросам` : '';
    const cacheCoverage = group.cacheReported && group.cacheReported < group.requests ? ` · кэш по ${group.cacheReported}/${group.requests}` : '';
    lines.push(`${actor} · запросы ${group.requests} · ${formatTime(group.time)} суммарно · ${usage}${cache}${coverage}${cacheCoverage}`);
  }
  for (const tool of report.tools) {
    const repeated = tool.repeated ? ` · повторов с теми же аргументами ${tool.repeated}` : '';
    const errors = tool.errors ? ` · ошибок ${tool.errors}` : '';
    lines.push(`${tool.name} · вызовы ${tool.calls} · ${formatTime(tool.time)} суммарно${repeated}${errors}`);
  }
  const trace=report.research;
  if(trace.initialLookups || trace.followupLookups){
    lines.push(`До первой попытки правки · поиск и чтение ${trace.initialLookups} · прочитано файлов ${trace.initialFiles.length} · строк ${trace.initialLines}`);
    if(trace.initialFiles.length)lines.push(trace.initialFiles.slice(0,6).join(' · '));
    if(trace.followupLookups)lines.push(`После первой попытки · поиск и чтение ${trace.followupLookups} · прочитано файлов ${trace.followupFiles.length} · строк ${trace.followupLines}`);
  }
  for(const branch of trace.branches.slice(-5)){
    const change = branch.kind==='plan'
      ? `Изменение плана · ${branch.from||'первичная гипотеза'} → ${branch.to||'требуется уточнение'}${branch.evidence?' · '+branch.evidence:''}`
      : `Сбой · ${branch.name} · ${branch.result}`;
    lines.push(change + ' · новых строк после развилки ' + branch.newLines);
  }
  const lastRequest = (session.metrics || []).findLast(row => row.phase === 'generation' &&
    row.actor === 'main' && row.turnId !== options?.excludeTurnId);
  if (lastRequest?.contextBreakdown) lines.push(contextDetails(lastRequest));
  return lines.join('\n');
}

const groups = {instructions:'инструкции',history:'история',taskState:'состояние задачи',
  skills:'скиллы',tools:'схемы инструментов',mcp:'схемы MCP',toolResults:'вывод инструментов'};

function contextDetails(request) {
  const lines = [];
  if (request.contextBreakdown) lines.push('Оценка контекста последнего запроса · ' +
    Object.entries(request.contextBreakdown).sort((a,b)=>b[1]-a[1])
      .map(([key,value])=>`${groups[key]} ≈${number.format(value)}`).join(' · '));
  if (request.prefix) {
    const {sameBlocks,comparedBlocks,firstChanged}=request.prefix;
    lines.push(`Общий префикс Harness · ${sameBlocks}/${comparedBlocks} блоков` +
      (firstChanged ? ` · первое отличие: ${groups[firstChanged]}` : ''));
  }
  return lines.join('\n');
}

function contextSpend(rows) {
  const requests = rows.filter(row => ['generation','compaction','idle-compaction'].includes(row.phase));
  if (!requests.length) return '';
  const bySource = new Map();
  const byActor = new Map();
  for (const row of requests) {
    const group = row.phase === 'generation'
      ? row.actor === 'subagent' ? 'Субагенты' : 'Основной агент'
      : row.phase === 'idle-compaction' ? 'Фоновое сжатие' : 'Сжатие';
    const name = [group, row.actualModel || row.configuredModel].filter(Boolean).join(' · ');
    const totals = byActor.get(name) || {requests:0, missing:0,input:0,cached:0,output:0};
    totals.requests++;
    if (row.usage) {
      const {input,cached,output} = usageOf(row.usage);
      totals.input += input;
      totals.cached += Math.min(input,cached);
      totals.output += output;
    } else totals.missing++;
    byActor.set(name, totals);
    for (const [source,tokens] of Object.entries(row.contextBreakdown || {})) {
      bySource.set(source, (bySource.get(source)||0)+tokens);
    }
  }
  const f = value => number.format(value);
  const lines = ['Последний ход · расход по данным провайдера'];
  for (const [name,{requests,missing,input,cached,output}] of byActor) {
    lines.push(`${name}: ${f(requests)} запросов · вход ${f(input)} · кэш ${f(cached)} · без кэша ${f(input-cached)} · выход ${f(output)}` +
      (missing ? ` · нет данных по ${f(missing)}` : ''));
  }
  if (bySource.size) lines.push('Оценка повторно отправленного контекста, сумма по запросам · ' +
    [...bySource].sort((a,b)=>b[1]-a[1]).map(([source,tokens])=>`${groups[source]||source} ≈${f(tokens)}`).join(' · '));
  return lines.join('\n');
}

function formatContext(session) {
  const request = (session.metrics || []).findLast(row => row.phase === 'generation' && row.actor === 'main');
  if (!request) return 'Метрики контекста появятся после первого запроса.';
  const usage=request.usage;
  const input=usage?.input_tokens ?? usage?.prompt_tokens;
  const cache=usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens;
  const actual=typeof input === 'number' ? `Провайдер · вход ${number.format(input)} · ` +
    (typeof cache === 'number' ? `из кэша ${number.format(cache)} · без кэша ${number.format(Math.max(0,input-cache))}` : 'кэш недоступен')
    : 'Провайдер не сообщил расход для этого запроса.';
  const idle=(session.metrics || []).filter(row=>row.phase==='idle-compaction');
  const compacted=idle.reduce((sum,row)=>sum+
    (row.usage?.input_tokens??row.usage?.prompt_tokens??0) +
    (row.usage?.output_tokens??row.usage?.completion_tokens??0),0);
  const scope = (session.metrics || []).filter(row => row.turnId === request.turnId);
  return [actual,contextDetails(request),contextSpend(scope),idle.length?
    `Фоновая компакция · запросы ${idle.length} · сообщено провайдером ${number.format(compacted)} токенов`:'']
    .filter(Boolean).join('\n');
}

module.exports = { summarizeRetro, formatRetro, formatContext };
