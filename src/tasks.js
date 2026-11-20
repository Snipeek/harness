'use strict';
const { randomUUID } = require('node:crypto');
const { runAgents, validateTasks, delegateTool } = require('./agents');
const { def } = require('./tool-registry');

const taskTools = [
  def('resume_agent', 'Continue a saved read-only subagent in this chat by its agent ID. Provide a narrow follow-up that uses the earlier tool evidence. Returns a background batch ID.', {
    id:{type:'string'}, prompt:{type:'string',minLength:1,maxLength:4000}
  }, ['id','prompt']),
  { ...delegateTool, function: { ...delegateTool.function, name: 'start_tasks', description: 'Start 1–3 independent subagents in the background. Use connection_id from the models listed on delegate_tasks only when the user names a model for this assignment. Omit it for the default Haiku worker. Returns a batch ID immediately. Continue your own independent work. Reports arrive as each agent finishes. Assign one writer per file or connected patch. Delegate read-only research in parallel and start dependent review after the patch is ready.' } },
  def('task_status', 'Read status and newly completed results of a background subagent batch.', { id: { type: 'string' } }, ['id']),
  def('wait_task', 'Wait up to 10 seconds for the next result or batch completion. Only wait again while status is running. Reports already injected into the conversation are not repeated.', { id: { type: 'string' }, timeout_ms: { type: 'integer' } }, ['id']),
  def('stop_task', 'Cancel one background batch.', { id: { type: 'string' } }, ['id'])
];

class TaskPool {
  constructor() { this.batches = new Map(); }

  remember(owner, journal) {
    for (const [id, saved] of Object.entries(journal || {})) {
      this.batches.set(id, {
        ...saved, id, owner, controller:new AbortController(), listeners:new Set(),
        status:saved.status === 'running' ? 'interrupted' : saved.status,
        agents:saved.agents || [],
        journal
      });
    }
  }

  checkpoint(batch) {
    if (!batch.journal) return;
    const {id,taskId,turnId,status,results,deliveredCount,delivered,error} = batch;
    const agents = batch.agents.map(({id,title,status,toolCount}) => ({id,title,status,toolCount}));
    batch.journal[id] = {taskId,turnId,status,results,deliveredCount,delivered,error,agents};
  }

  create(owner, options) {
    const id = randomUUID();
    const batch = {id, owner, controller:new AbortController(), status:'running', agents:[],
      taskId:options.taskId, turnId:options.turnId, journal:options.journal,
      results:[], deliveredCount:0, delivered:false, listeners:new Set()};
    this.batches.set(id, batch);
    this.checkpoint(batch);
    return batch;
  }

  notify(batch, onChange) {
    this.checkpoint(batch);
    onChange?.();
    for (const listener of batch.listeners) listener();
  }

  async start(tasks, options, owner) {
    validateTasks(tasks);
    if (this.matching(owner).filter(batch => batch.status === 'running' && !batch.external).length >= 2) throw Error('At most two active agent batches');
    const batch = this.create(owner, options);
    const {id, controller} = batch;
    const notify = () => this.notify(batch, options.onChange);
    batch.promise = runAgents(tasks, {
      ...options,
      signal: AbortSignal.any([options.signal, controller.signal]),
      onStart: agents => { batch.agents = agents; options.onStart(agents); this.checkpoint(batch); },
      onResult: result => {
        batch.results.push(result);
        if (batch.results.length === tasks.length) {
          batch.status = batch.results.every(item => item.status === 'done') ? 'done'
            : batch.results.every(item => item.status === 'cancelled') ? 'cancelled' : 'partial';
        }
        notify();
      }
    }).catch(error => { batch.status = 'error'; batch.error = error.message; notify(); });
    return JSON.stringify({ id, status: batch.status, background:true,
      instruction:'Continue independent work. Harness delivers reports as agents finish. If you have nothing else to do, end this response and Harness will resume on completion. Do not poll.' });
  }

  startExternal(name, callId, run, options, owner) {
    if (this.matching(owner).filter(batch => batch.status === 'running' && batch.external).length >= 6) {
      throw Error('At most six active MCP tasks');
    }
    const batch = this.create(owner, options);
    batch.external = true;
    batch.promise = Promise.resolve().then(async () => {
      const signal = AbortSignal.any([options.signal, batch.controller.signal]);
      try {
        await options.beforeStart?.();
        signal.throwIfAborted();
        const output = await run(signal);
        batch.results.push({tool:name, callId, ...output});
        batch.status = output.status;
      } catch (error) {
        batch.status = signal.aborted ? 'cancelled' : 'error';
        batch.results.push({tool:name, callId, status:batch.status,
          error:error.message, outcome:'unknown'});
      }
      this.notify(batch, options.onChange);
    });
    return {id:batch.id, tool:name, callId, status:batch.status};
  }

  matching(owner, turnId) {
    return [...this.batches.values()].filter(batch => batch.owner === owner && (turnId === undefined || batch.turnId === turnId));
  }

  ready(batch) {
    return batch.deliveredCount < batch.results.length || (!batch.delivered && batch.status !== 'running');
  }

  take(batch) {
    const results = batch.results.slice(batch.deliveredCount);
    batch.deliveredCount = batch.results.length;
    if (batch.status !== 'running') batch.delivered = true;
    this.checkpoint(batch);
    return { id: batch.id, status: batch.status, results, error: batch.error };
  }

  outstanding(owner, turnId) {
    return this.matching(owner, turnId).some(batch => !batch.delivered);
  }

  collect(owner, turnId) {
    return this.matching(owner, turnId).filter(batch => this.ready(batch)).map(batch => this.take(batch));
  }

  collectTask(owner, taskId) {
    return this.matching(owner).filter(batch => batch.taskId === taskId && this.ready(batch)).map(batch => this.take(batch));
  }

  wait(batches, timeout, signal) {
    signal?.throwIfAborted();
    if (batches.some(batch => this.ready(batch)) || !timeout || !batches.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const complete = () => finish(resolve);
      const abort = () => finish(reject, signal.reason);
      const timer = Number.isFinite(timeout) ? setTimeout(complete, timeout) : undefined;
      function finish(callback, value) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        for (const batch of batches) batch.listeners.delete(complete);
        callback(value);
      }
      for (const batch of batches) batch.listeners.add(complete);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  waitForChange(owner, turnId, timeout, signal) {
    return this.wait(this.matching(owner, turnId).filter(batch => !batch.delivered), Math.max(0, timeout), signal);
  }

  async execute(name, args, owner, signal) {
    const batch = this.batches.get(args.id);
    if (!batch || batch.owner !== owner) throw Error('Unknown task batch');
    if (name === 'stop_task') batch.controller.abort();
    if (name === 'wait_task' && batch.status === 'running') {
      await this.wait([batch], Math.min(10000, Math.max(0, args.timeout_ms ?? 1000)), signal);
    }
    const snapshot = name === 'stop_task' ? { id: batch.id, status: batch.status, results: [] } : this.take(batch);
    return JSON.stringify({ ...snapshot, agents: batch.agents.map(agent => ({ id: agent.id, title: agent.title, status: agent.status, tools: agent.toolCount })) });
  }

  close(owner) {
    for (const batch of this.batches.values()) if (!owner || batch.owner === owner) batch.controller.abort();
  }

  forget(owner) {
    this.close(owner);
    for (const batch of this.matching(owner)) this.batches.delete(batch.id);
  }
}

module.exports = { TaskPool, taskTools };
