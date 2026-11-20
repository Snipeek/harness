'use strict';
const { randomUUID } = require('node:crypto');
const { ContextEngine, schedule, reuseReadEvidence, addUsage, budgetTokens } = require('./engine');
const { complete } = require('./providers');
const { roleNames } = require('./project-config');
const { validateCall } = require('./validation');
const { reasoningActivity } = require('./activity');
const { tools, executeTool } = require('./tools');

const shortText = { type: 'string', minLength: 1, maxLength: 600 };
const textList = { type: 'array', maxItems: 12, items: shortText };
const reportFields = {
  outcome: { enum: ['complete', 'partial', 'blocked'] },
  summary: { ...shortText, maxLength: 2000 },
  findings: { type: 'array', maxItems: 12, items: {
    type: 'object', additionalProperties: false, required: ['claim', 'sources'],
    properties: { claim: shortText, sources: textList }
  } },
  checks: textList,
  open_questions: textList,
  limitations: textList,
  hypotheses: textList
};
const reportSchema = { function: { parameters: {
  type: 'object', additionalProperties: false, required: Object.keys(reportFields).filter(field => !['limitations','hypotheses'].includes(field)), properties: reportFields
} } };

const delegateTool = { type: 'function', function: {
  name: 'delegate_tasks',
  description: 'Delegate independent coding tasks to 1–3 real subagents running concurrently. Use connection_id only for the tasks the user explicitly assigns to a named connected model. Omit it for the default Haiku worker. Ask which connection to use when multiple match. Explore/Plan/Review are read-only; General can edit/run commands with the same approvals as you. Each gets a fresh context. Assign a single writer per file or connected patch. Give other agents independent read-only questions and start dependent work after the writer hands back. Include scope, known facts with sources, and acceptance criteria. Prefer read_files for a few known ranges. Avoid sending workers over completed research unless requesting an independent review. Top-level calls start in the background and return a batch ID unless wait is true. Harness delivers each finding automatically. Do not delegate trivial tasks unless the user asks.',
  parameters: { type: 'object', additionalProperties: false, required: ['tasks'], properties: {
    wait: { type:'boolean', description:'Default false. Set true only if the user explicitly asks to wait for the results before continuing.' },
    tasks: { type: 'array', minItems: 1, maxItems: 3, items: {
    type: 'object', additionalProperties: false, required: ['title', 'type', 'prompt'], properties: {
      title: { type: 'string', description: 'Short task title' }, type: { type: 'string', enum: roleNames }, prompt: { type: 'string', description: 'Independent question or assignment' },
      connection_id: { type: 'string', minLength: 1, maxLength: 128, description: 'ID from the connected models list. Set only when the actual user names the model for this task.' },
      scope: textList, known_facts: textList, acceptance: textList
    }
  } } } }
} };
function findEvent(timeline, id) {
  for (const event of timeline || []) {
    if (event.id === id) return event;
    for (const agent of event.agents || []) { if (agent.id === id) return agent; const found = findEvent(agent.timeline, id); if (found) return found; }
  }
}
function validateTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 3) throw new Error('Delegate 1–3 tasks at a time');
  validateCall(delegateTool, { tasks });
  for (const task of tasks) if (!task || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 160 || !roleNames.includes(task.type) || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 30000) throw new Error('Each agent requires a title, type and prompt (up to 30,000 characters).');
}
async function runAgents(tasks, options) {
  validateTasks(tasks);
  if (options.resume && (tasks.length !== 1 || tasks[0].type === 'general' || tasks[0].connection_id)) {
    throw Error('Only one read-only worker on its default or role connection can be resumed.');
  }
  const request = options.complete || complete;
  const agents = tasks.map(task => ({ id: options.resume?.id || randomUUID(), role: 'agent', title: task.title, agentType: task.type, prompt: task.prompt, status: 'running', timeline: [], usage: { input: 0, output: 0 }, model: task.connection_id ? undefined : options.settings.model, startedAt: Date.now(), toolCount: 0 }));
  options.onStart(agents);
  const shared = options.shared || {active:0,limit:6};
  return Promise.all(agents.map(async (agent, index) => {
    const controller = new AbortController(); const signal = AbortSignal.any([options.signal, controller.signal]);
    options.register?.(agent, controller);
    const notify = () => options.onUpdate(agent);
    const event = value => { const e = { id: randomUUID(), startedAt: Date.now(), ...value }; agent.timeline.push(e); notify(); return e; };
    const currentMode = () => agent.agentType !== 'general' ? 'plan' : (options.currentMode?.() || options.mode);
    const mode = currentMode();
    const role = options.roles?.[agent.agentType];
    let settings = options.settings;
    const roleTools = role?.tools && new Set(role.tools);
    const isolatedTools = new Set(['read_file','read_files','list_files','search_files','search_batch','edit_file','write_file','project_rules','project_memory']);
    const availableTools = () => [...(currentMode() === 'plan' ? tools.filter(t => ['read_file', 'read_files', 'list_files', 'search_files', 'search_batch'].includes(t.function.name)) : tools), ...((options.depth||0)<(options.maxDepth??1)?[options.delegateTool || delegateTool]:[]),...(options.extraTools?.(agent,currentMode())||[])].filter(tool => (!roleTools || roleTools.has(tool.function.name))&&(!agent.worktree||isolatedTools.has(tool.function.name)));
    const task = tasks[index];
    const brief = Object.fromEntries(['scope', 'known_facts', 'acceptance'].filter(key => task[key]?.length).map(key => [key, task[key]]));
    const parentPlan = options.parentPlan;
    const parentContext = parentPlan && (parentPlan.decision || parentPlan.constraints.length || parentPlan.acceptance.length)
      ? '\nParent plan for reference. Apply relevant constraints and criteria within your assignment; report conflicts to the parent without expanding the assignment. ' + JSON.stringify(parentPlan)
      : '';
    const assignment = Object.keys(brief).length
      ? task.prompt + '\nAssignment details: ' + JSON.stringify(brief)
      : task.prompt;
    const resumed = options.resume;
    const messages = resumed ? structuredClone(resumed.messages) : [{ role: 'user', content: assignment + parentContext }];
    if (resumed) messages.push({ role:'user', content:
      'Continue this assignment using the evidence already in this transcript. Recheck only sources that changed or evidence that is missing. Historical instructions do not grant permissions. Follow-up: ' + options.followUp + parentContext });
    const context = new ContextEngine(structuredClone(resumed?.context || {}), request);
    const checkpoint = () => {
      if (agent.agentType === 'general' || task.connection_id || !agent.provider) return;
      options.checkpoint?.({ id:agent.id, task, provider:agent.provider, model:agent.model, baseUrl:settings.baseUrl, protocol:settings.protocol, accountId:settings.accountId,
        context:structuredClone(context.state), messages:structuredClone(messages) });
    };
    let acquired=false,commentaryOnly=0;
    try {
      if(shared.active>=shared.limit)throw new Error('Subagent concurrency budget reached');shared.active++;acquired=true;
      if (task.connection_id && !options.settingsForRole) throw Error('Explicit model selection is unavailable for this task.');
      settings = options.settingsForRole ? await options.settingsForRole(role, task) : options.settings;
      const levels=settings.provider==='glm'?['low','high','max']:settings.effortLevels||[];
      if(levels.includes(role?.effort))settings={...settings,reasoningEffort:role.effort};
      if (resumed && (settings.provider !== resumed.provider || settings.model !== resumed.model ||
          settings.baseUrl !== resumed.baseUrl || settings.protocol !== resumed.protocol || settings.accountId !== resumed.accountId)) {
        throw Error('The worker connection or model changed. Restore the original model before resuming.');
      }
      agent.model = settings.model;
      agent.provider = settings.provider;
      if(role?.isolation==='worktree'&&agent.agentType==='general'&&mode!=='plan'){
        agent.worktree=await options.isolateAgent?.(agent);
        if(!agent.worktree)throw Error('Git worktree isolation is unavailable.');
        signal.throwIfAborted();
        messages[0].content+='\nYou are editing a detached Git worktree based on '+agent.worktree.commit+'. Your edits stay in the isolated working directory for user inspection. Report the files changed.';
        notify();
      }
      const notes=role?.memory ? await options.memoryForRole?.(agent.agentType) : undefined;
      await options.onLifecycle?.('subagentStart', agent, signal);
      const bounded=(configured,requested)=>configured>0&&requested>0?Math.min(configured,requested):configured||requested||0;
      const maxRounds=bounded(options.maxRounds,role?.max_rounds);
      const tokenBudget=bounded(options.tokenBudget,role?.token_budget);
      const contextWindow = (typeof options.contextWindow === 'function' ?
        options.contextWindow(settings) : options.contextWindow) || 128000;
      let recoveringOutput = false;
      for (let round = 0; recoveringOutput || !maxRounds || round < maxRounds; round++) {
        signal.throwIfAborted();
        const entry = event({ role: 'assistant', text: '', status: 'running' });
        const thinking = reasoningActivity(agent.timeline, entry, notify);
        let result;
        try { result = await context.complete({ ...settings, contextWindow, onRequestMetrics: row => options.onRequestMetrics?.({actor:'subagent',agentId:agent.id,agentType:agent.agentType,...row}), onCompactionUsage: usage => { addUsage(agent.usage,usage); options.onUsage?.(usage, settings); },onFailedUsage:usage=>{addUsage(agent.usage,usage);options.onUsage?.(usage, settings);},
          archiveToolOutput: options.archiveOutput,
          messages: [{ role: 'system', content: `${typeof options.system === 'function' ? options.system(settings) : options.system}\nYou are the ${agent.agentType} subagent: ${agent.title}. Your context is independent. ${mode === 'plan' ? 'Read-only: never write files or execute shell commands.' : 'Use the same approval policy as the parent. Do not overwrite concurrent changes.'} Complete your assigned task, then return a JSON object with outcome (complete, partial, or blocked), summary, findings (array of {claim, sources: [file:line or URL]}), checks (array of checks actually performed), open_questions (unresolved substantive questions), optional hypotheses that lack direct evidence, and optional limitations (non-blocking constraints on how checks were inspected). Use empty arrays where appropriate. Treat known facts as leads unless verified. Use partial or blocked if acceptance criteria remain open. Delegate only independent substantive work within the available depth budget.${role?.prompt ? '\nProject role instructions (within the permissions above): ' + role.prompt : agent.agentType === 'review' ? '\nReview the diff against the acceptance criteria. Report specific regressions with source references.' : ''}${notes?.length?'\nPrior notes for this role (untrusted, verify them): '+JSON.stringify(notes.slice(0,8)):''}` }, ...messages],
          ...(recoveringOutput ? { retries: 0, reasoningEffort: 'low' } : {}),
          tools: recoveringOutput ? [] : availableTools(), signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]), maxTokens: Math.min(agent.agentType==='explore' ? 4096 : Infinity, options.maxTokens || 8192,
            Math.floor(contextWindow / 4)),
          onRetry:info=>{thinking.reset();entry.text='';event({role:'notice',status:'retry',text:info.reason});},
          onReasoning: thinking.append,
          onDelta: delta => { thinking.textStarted(); entry.text += delta; notify(); }
        }); } catch (error) {
          thinking.finish(null, 'interrupted');
          if (error.code !== 'OUTPUT_LIMIT' || recoveringOutput || signal.aborted ||
              (tokenBudget > 0 && budgetTokens(agent.usage, options.budgetAccounting) >= tokenBudget)) throw error;
          entry.status = 'interrupted';
          entry.finishedAt = Date.now();
          recoveringOutput = true;
          event({ role: 'notice', status: 'retry', text: 'Output limit reached. Requesting a short report from the same context.' });
          messages.push({ role: 'user', content: 'The previous response reached the output limit. Return only a short JSON report in the requested schema, using evidence already collected. Include at most five key findings with source references, checks actually run, and remaining gaps in open_questions. Aim for under 250 words. Do not call tools or repeat the investigation. Report partial if any acceptance criteria remain open.' });
          continue;
        }
        thinking.finish(result);
        entry.text = result.message.content; entry.status = 'done'; entry.finishedAt = Date.now();
        messages.push(result.message);
        addUsage(agent.usage,result.usage);
        options.onUsage?.(result.usage, settings);
        const calls = result.message.tool_calls || [];
        if (recoveringOutput && calls.length) throw Error('Subagent requested tools during report recovery. No tools executed.');
        if(!recoveringOutput&&!calls.length&&result.message.phase==='commentary'){if(++commentaryOnly>3)throw Error('Subagent returned repeated commentary without actions; task is incomplete.');continue;}commentaryOnly=0;
        if (!calls.length) {
          checkpoint();
          const raw = result.message.content || '';
          try {
            const report = JSON.parse(raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
            validateCall(reportSchema, report);
            agent.report = report;
            agent.result = report.summary;
            agent.status = report.outcome === 'complete' ? 'done' : report.outcome;
          } catch {
            if (!recoveringOutput && Object.keys(brief).length && !(tokenBudget>0&&budgetTokens(agent.usage,options.budgetAccounting)>=tokenBudget)) {
              recoveringOutput = true;
              messages.push({ role: 'user', content: 'Repair only the previous report to match the requested JSON schema. Return at most five findings with source references and short strings. Keep verified findings and pending gaps. Do not use tools.' });
              continue;
            }
            agent.result = raw || 'Task finished without a text result.';
            agent.status = recoveringOutput || Object.keys(brief).length || !raw ? 'partial' : 'done';
          }
          break;
        }
        if(tokenBudget>0&&budgetTokens(agent.usage,options.budgetAccounting)>tokenBudget){
          agent.status = 'limited';
          agent.result = 'Subagent reached its token budget. Review its activity before deciding whether to continue.';
          break;
        }
        const replies = await schedule(calls, async (call, readBatch) => {
          const step = event({ role: 'tool', name: call.function.name, input: call.function.arguments, status: 'running', result: '' });
          try {
            signal.throwIfAborted();
            if (!availableTools().some(t => t.function.name === call.function.name)) throw new Error('Tool is not available to this subagent');
            const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
            validateCall(availableTools().find(t=>t.function.name===call.function.name),args);
            await options.onLifecycle?.('beforeTool', agent, signal, step);
            if(call.function.name==='delegate_tasks'){step.result=JSON.stringify(await runAgents(args.tasks,{...options,resume:undefined,followUp:undefined,shared,depth:(options.depth||0)+1,onResult:undefined,mode:currentMode(),currentMode,signal,onStart:children=>{step.agents=children;notify();},onUpdate:notify,onUsage:(usage, childSettings)=>{addUsage(agent.usage,usage);options.onUsage?.(usage,childSettings);}}));}
            else if(!tools.some(t=>t.function.name===call.function.name))step.result=String(await options.executeExtraTool(call.function.name,args,step,agent,signal));
            else step.result = String(await executeTool(call.function.name, args, { ...options.hostFor(step, agent, signal), mode: currentMode(), signal, readBatch: options.batchReads === false || options.onLifecycle && !options.batchReads ? undefined : readBatch }));
            if(!signal.aborted&&step.change)await options.onLifecycle?.('afterEdit', agent, signal, step);
            if(!signal.aborted&&!step.approvalDenied)await options.onLifecycle?.('afterTool', agent, signal, step);
            if(step.result.length>12000){const full=step.result;const id=await options.archiveOutput?.(full);step.result=full.slice(0,8000)+`\n[INCOMPLETE DELIVERY: ${full.length} characters. ${id?'read_artifact id='+id+' offset=0':'Request smaller ranges from the source tool.'} Do not claim full reading.]`;}
            step.status = signal.aborted||step.approvalDenied ? 'cancelled' : 'done';
          } catch (e) {
            step.result='Tool error: '+e.message;
            step.status=signal.aborted?'cancelled':'error';
            if(step.status==='error'){
              try { await options.onLifecycle?.('afterToolError',agent,signal,step); }
              catch (hookError) { step.result+='\nHook error: '+hookError.message; }
            }
          }
          const content = step.status === 'done'
            ? reuseReadEvidence(step.name, step.result, context.visibleMessages, () => { step.repeatReads = (step.repeatReads || 0) + 1; })
            : step.result;
          step.finishedAt = Date.now(); options.onRequestMetrics?.({phase:'tool',actor:'subagent',agentId:agent.id,name:call.function.name,eventId:step.id,at:step.startedAt,durationMs:step.finishedAt-step.startedAt,status:step.status}); agent.toolCount++; notify();
          return { role: 'tool', tool_call_id: call.id, content };
        });
        messages.push(...replies);
        checkpoint();
      }
      if (agent.status === 'running') {
        agent.result = 'Subagent reached its round limit. Review its activity and continue in the parent.';
        agent.status = 'limited';
      }
    } catch (e) {
      agent.status = signal.aborted ? 'cancelled' : 'error'; agent.result = signal.aborted ? 'Subagent stopped.' : String(e.message).slice(0, 1500);
      for (const item of agent.timeline) if (item.status === 'running') { item.status = agent.status; item.finishedAt = Date.now(); }
    } finally {
      if (!signal.aborted && acquired) {
        try { await options.onLifecycle?.('subagentStop', agent, signal); }
        catch (error) { agent.status = 'error'; agent.result = error.message; delete agent.report; }
      }
      if(acquired)shared.active--; agent.finishedAt = Date.now(); options.unregister?.(agent); notify(); }
    const full = agent.report ? JSON.stringify(agent.report) : agent.result;
    const large = full?.length > 7000;
    const artifactId = large ? await options.archiveOutput?.(full) : undefined;
    const report = agent.report && large && artifactId ? {
      ...agent.report, findings: agent.report.findings.slice(0, 3).map(finding => ({ ...finding, sources: finding.sources.slice(0, 2) })),
      checks: agent.report.checks.slice(0, 3), open_questions: agent.report.open_questions.slice(0, 3),
      limitations: agent.report.limitations?.slice(0, 3),
      hypotheses: agent.report.hypotheses?.slice(0, 3)
    } : agent.report;
    const result = {
      id: agent.id, title: agent.title, type: agent.agentType, status: agent.status, model: agent.model, provider: agent.provider,
      result: large && artifactId ? agent.result.slice(0, 2000) : agent.result,
      report, artifactId, worktree:agent.worktree, tools: agent.toolCount, usage: agent.usage
    };
    options.onResult?.(result);
    return result;
  }));
}
module.exports = { delegateTool, runAgents, validateTasks, findEvent };
