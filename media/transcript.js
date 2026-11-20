'use strict';
(function (root) {
  function groupTurns(timeline) {
    const turns = []; let turn;
    for (const event of timeline || []) {
      if (event.role === 'user' || !turn) { turn = { id: event.role === 'user' ? event.id : 'prelude:' + event.id, user: event.role === 'user' ? event : null, activity: [] }; turns.push(turn); }
      if (event.role !== 'user') turn.activity.push(event);
    }
    return turns;
  }
  function collectAgents(timeline) {
    const byId = new Map();
    function visit(events, parentId, rootEventId, depth) {
      for (const event of events || []) for (const agent of event.agents || []) {
        byId.set(agent.id, { agent, parentId, rootEventId: rootEventId || event.id, depth });
        visit(agent.timeline, agent.id, rootEventId || event.id, depth + 1);
      }
    }
    visit(timeline, null, null, 0); return [...byId.values()];
  }
  function lineRange(args) {
    const start = args.start_line ?? args.offset;
    const end = args.end_line ?? (Number.isInteger(start) && Number.isInteger(args.limit) && args.limit > 0 ? start + args.limit - 1 : undefined);
    if (!Number.isInteger(start) && !Number.isInteger(end)) return '';
    if (!Number.isInteger(end)) return start + '–…';
    return (start ?? 1) === end ? String(end) : (start ?? 1) + '–' + end;
  }
  function presentTool(event) {
    let args; try { args = typeof event.input === 'string' ? JSON.parse(event.input) : event.input || {}; } catch { args = {}; }
    args ||= {};
    const names = { read_file: 'Read', read_files: 'Read files', write_file: 'Write', edit_file: 'Edit', run_command: 'Bash', search_files: 'Search', search_batch: 'Search batch', list_files: 'Glob' };
    const label = names[event.name] || event.name;
    const file = args.path || args.file_path || '';
    const isBash = ['run_command','Bash'].includes(event.name);
    let input = isBash ? args.command || '' : args.content ?? args.old_text ?? JSON.stringify(args, null, 2);
    if (args.old_text !== undefined && args.new_text !== undefined) input = args.old_text + '\n→\n' + args.new_text;
    let description = args.description || args.query || args.pattern || args.glob || args.url || args.uri || args.skill || args.symbol || '';
    if (event.name === 'read_artifact' && args.id) {
      description = [args.id, args.offset != null && 'offset ' + args.offset, args.limit != null && 'limit ' + args.limit].filter(Boolean).join(' · ');
    }
    if (event.name === 'read_files' && Array.isArray(args.files)) {
      description = args.files.filter(file => file?.path).map(file => [file.path, lineRange(file)].filter(Boolean).join(' · ')).join(', ');
    }
    if (['Read','read_file'].includes(event.name)) {
      description = lineRange(args);
    }
    if (event.name === 'search_batch' && Array.isArray(args.queries)) {
      description = args.queries.map(query => query?.query).filter(Boolean).join(', ');
    }
    if (isBash) description ||= args.command || '';
    if (event.name === 'start_tasks' && Array.isArray(args.tasks)) {
      description = args.tasks.map(task => task?.title).filter(Boolean).join(', ');
    }
    if (event.name === 'update_plan') {
      const steps = Array.isArray(args.steps) ? args.steps.filter(Boolean) : [];
      const next = steps.find(step => step.status === 'running') || steps.find(step => step.status === 'pending');
      const progress = steps.length ? steps.filter(step => step.status === 'done').length + '/' + steps.length : '';
      description = [progress, next?.title || args.goal].filter(Boolean).join(' · ');
    }
    if (event.name.startsWith('mcp_browser_')) description ||= args.element || args.key || args.type || '';
    const output = event.result || '';
    if (event.repeatReads) description = [description, event.repeatReads > 1 ? 'Повтор ×' + event.repeatReads : 'Повтор'].filter(Boolean).join(' · ');
    const failed = event.status === 'error' || (isBash && /^Exit code: [1-9]\d*\b/.test(output));
    const preview = failed || event.status === 'waiting' || !!event.change ||
      ['edit_file', 'write_file', 'Edit', 'Write'].includes(event.name);
    return { label, file, target: file ? file.split(/[\\/]/).pop() : '', description, input, output, preview, isBash };
  }
  function outgoingTimeline(timeline, queue, pending) {
    const delivered = new Set(timeline.map(event => event.deliveryId).filter(Boolean));
    const waiting = new Map();
    for (const entry of pending) {
      if (!delivered.has(entry.deliveryId)) waiting.set(entry.deliveryId, entry);
    }
    for (const entry of queue) {
      const deliveryId = entry.deliveryId || entry.id;
      if (delivered.has(deliveryId)) continue;
      waiting.set(deliveryId, {
        ...waiting.get(deliveryId), ...entry, deliveryId, startedAt: entry.at,
        status: 'queued'
      });
    }
    return [...timeline, ...Array.from(waiting.values(), entry => ({
      ...entry, id: 'outgoing:' + entry.deliveryId, role: 'user'
    }))];
  }
  function followUpSuggestion(session) {
    if (!session) return '';
    const turn = groupTurns(session.timeline || []).at(-1);
    const reply = turn?.activity.filter(event => event.role === 'assistant' && event.text?.trim()).at(-1);
    if (!turn?.user || reply?.status !== 'done' || (session.queue || []).length) return '';
    const belongsToTask = item => !item?.taskId || !session.taskId || item.taskId === session.taskId;
    const plan = belongsToTask(session.plan) ? session.plan : null;
    const incomplete = session.completion?.status === 'incomplete' && belongsToTask(session.completion);
    const pending = plan?.steps?.find(step => step.status === 'running' || step.status === 'pending');
    const compact = text => typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
    const next = compact(pending?.title || ((!plan?.steps?.length || incomplete) ? plan?.next_action : ''));
    if (next && next.length <= 150) return 'Продолжим. Следующий шаг — ' + next;
    if (incomplete) {
      for (const gap of session.completion.gaps || []) {
        const match = /^(Open step|Unverified acceptance criterion|Confirm the observed reproduction after the patch): (.+)$/.exec(compact(gap));
        if (!match || match[2].length > 150) continue;
        const prefix = match[1] === 'Open step' ? 'Продолжим. Следующий шаг — '
          : match[1] === 'Unverified acceptance criterion' ? 'Проверь критерий — ' : 'Повтори проверку после правки — ';
        return prefix + match[2];
      }
    }
    const lastLine = reply.text.trim().split('\n').at(-1);
    const offer = /^(?:Если хочешь,\s*)?(?:я\s+)?могу\s+(.+?)[.!?]?$/iu.exec(lastLine)?.[1]?.trim();
    if (offer && offer.length <= 150 && !offer.includes('://')) return 'Давай ' + offer + '.';
    return '';
  }
  const api = { groupTurns, collectAgents, presentTool, outgoingTimeline, followUpSuggestion };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AITranscript = api;
})(typeof window !== 'undefined' ? window : globalThis);
