'use strict';
const { tasks } = require('./quality-fixtures');

const route = {
  id: 'http-agent-turn',
  kind: 'evidence',
  readOnly: true,
  files: {
    'http.js': "const {dispatch}=require('./agent');\nfunction post(req){\n  if(req.method!=='POST') return null;\n  return dispatch(req.body);\n}\nmodule.exports={post};\n",
    'agent.js': "const {runTurn}=require('./turn');\nfunction dispatch(body){\n  if(!body.enabled) return null;\n  return runTurn(body.text);\n}\nmodule.exports={dispatch};\n",
    'turn.js': 'function runTurn(text){return String(text).trim();}\nmodule.exports={runTurn};\n'
  },
  prompt: 'Trace the HTTP request through the code. Read the sources. Respond with only JSON: {"chain":["function names in order"],"calls":["file:line of each callsite in order"],"guards":["file:line of each early return before the calls in order"]}.',
  expectedJson: {
    chain: ['post', 'dispatch', 'runTurn'],
    calls: ['http.js:4', 'agent.js:4'],
    guards: ['http.js:3', 'agent.js:3']
  }
};

module.exports = { tasks: [tasks.find(task => task.id === 'data-zero-configuration'), route] };
