'use strict';
const fs = require('node:fs/promises');
const { workspacePath } = require('./tools');
const { validateCall } = require('./validation');

const roleNames = ['explore', 'plan', 'review', 'general'];
const hookEvents = ['turnStart', 'beforeTool', 'afterTool', 'afterToolError', 'afterEdit', 'subagentStart', 'subagentStop', 'beforeFinish'];
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const list = (items, maxItems) => ({ type: 'array', items, maxItems });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const role = object({ prompt: string(8000), model: string(160), tools: list(string(160), 60), effort: { enum:['low','medium','high','xhigh','max','ultra'] }, max_rounds: { type:'integer',minimum:1,maximum:100 }, token_budget: { type:'integer',minimum:1000,maximum:2000000 }, memory: { type:'boolean' }, isolation: { enum:['shared','worktree'] } });
const hook = object({
  event: { enum: hookEvents },
  tool: string(160),
  command: string(1000),
  timeout_seconds: { type: 'integer', minimum: 1, maximum: 120 },
  required: { type: 'boolean' },
  parallel_review: { type: 'boolean' },
  inputs: list(string(600), 20),
  criteria: list(string(600), 20)
}, ['event', 'command']);
const schema = { function: { parameters: object({
  roles: object(Object.fromEntries(roleNames.map(name => [name, role]))),
  memory: object({ enabled: { type: 'boolean' }, auto_save: {type:'boolean'} }),
  hooks: list(hook, 30),
  contract_checks: list(object({
    paths: { ...list(string(600), 30), minItems: 1 },
    script: { type: 'string', pattern: '^[\\w./-]+\\.[cm]?js$', maxLength: 600 },
    timeout_seconds: { type: 'integer', minimum: 1, maximum: 120 }
  }, ['paths', 'script']), 12)
}) } };

async function loadProjectConfig(root) {
  try {
    const file = await workspacePath(root, '.harness/config.json');
    if ((await fs.stat(file)).size > 65536) throw Error('Configuration exceeds 64 KiB');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    validateCall(schema, config);
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Error('.harness/config.json: ' + error.message);
  }
}

function configuredHooks(hooks) {
  validateCall(schema, {hooks});
  return hooks;
}

module.exports = { loadProjectConfig, roleNames, configuredHooks };
