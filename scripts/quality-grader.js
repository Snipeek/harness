'use strict';
const vm=require('node:vm'),{createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function gradeCode(source,checks){return checks.map(([expression,expected])=>{try{const module={exports:{}},context=vm.createContext({module,exports:module.exports});new vm.Script('(function(){\n'+source+'\n})();').runInContext(context,{timeout:1000});for(const [key,value]of Object.entries(module.exports))if(!['module','exports','process','require'].includes(key))context[key]=value;const actual=new vm.Script(expression).runInContext(context,{timeout:1000});return {expression,passed:JSON.stringify(actual)===JSON.stringify(expected)};}catch(e){return {expression,passed:false,error:e.message.slice(0,200)};}});}
function evaluateModules(files,expression){
 const cache=new Map(),posix=require('node:path').posix;
 const load=name=>{if(cache.has(name))return cache.get(name).exports;if(!(name in files)||typeof files[name]!=='string'||!/\.(js|json)$/.test(name))throw Error('Unknown fixture module '+name);const module={exports:{}};cache.set(name,module);if(name.endsWith('.json')){module.exports=JSON.parse(files[name]);return module.exports;}const context=vm.createContext({module,exports:module.exports,require:specifier=>{if(!specifier.startsWith('.'))throw Error('Only relative fixture modules allowed');let next=posix.normalize(posix.join(posix.dirname(name),specifier));if(!/\.(js|json)$/.test(next))next+='.js';if(next.startsWith('../'))throw Error('Outside fixture');return load(next);}});new vm.Script(files[name]).runInContext(context,{timeout:1000});return module.exports;};
 return vm.runInNewContext(expression,{api:load('main.js'),fixtureModule:load},{timeout:1000});
}
function gradeModules(files,checks){return checks.map(([expression,expected])=>{try{
 const actual=evaluateModules(files,expression);return {expression,passed:JSON.stringify(actual)===JSON.stringify(expected)};
 }catch(e){return {expression,passed:false,error:e.message.slice(0,200)};}});}
function gradeTask(task,source,session,files,checks=task.checks||[]){
 const results=task.kind==='module'?gradeModules(files,checks):gradeCode(source,checks),events=session.timeline||[],text=events.filter(e=>e.role==='assistant'&&e.status==='done').map(e=>e.text).join('\n');
 for(const [name,original]of Object.entries(task.files||{}))if(!(task.allowedFiles||(['code','chain'].includes(task.kind)?['main.js']:[])).includes(name))results.push({name:'preserve '+name,passed:files[name]===original});
 if(task.kind==='chain'&&task.seed)results.push(...gradeCode(source,[['seed',task.seed]]));
 if(task.expectedJson){
  let actual;
  try{actual=JSON.parse(events.filter(e=>e.role==='assistant'&&e.status==='done').at(-1)?.text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1'));}catch{}
  for(const [name,expected] of Object.entries(task.expectedJson))results.push({name,passed:JSON.stringify(actual?.[name])===JSON.stringify(expected)});
 }
 for(const expected of task.expected||[])results.push({name:'answer contains '+expected,passed:expected==='blue'?/blue|син/i.test(text):text.includes(expected)});
 for(const forbidden of task.forbidden||[])results.push({name:'avoid unsupported claim',passed:!text.toLowerCase().includes(forbidden.toLowerCase())});
 if(task.kind==='evidence')results.push({name:'read evidence',passed:events.some(e=>e.role==='tool'&&e.name==='read_file'&&e.status==='done')});
 if(task.id==='evidence-tail-coverage'){
  const lines=new Set();for(const e of events.filter(e=>e.name==='read_file'))try{const page=JSON.parse(e.result);for(const m of page.content.matchAll(/^(\d+)(?:\+\d+)?: /gm))lines.add(+m[1]);}catch{}
  results.push({name:'complete document coverage',passed:lines.size>=652});
 }
 if(task.kind==='web')for(const name of ['web_search','web_fetch'])results.push({name:'used '+name,passed:events.some(e=>e.name===name&&e.status==='done')});
 if(task.kind==='mcp')results.push({name:'actual MCP call',passed:events.some(e=>e.name?.startsWith('mcp_')&&e.status==='done')});
 const notices=events.filter(e=>e.role==='notice').map(e=>e.text);
 results.push({name:'completed without runtime limit/error',passed:!notices.length});
 return {passed:results.every(c=>c.passed),checks:results,notices,manualReviewRequired:['evidence','web'].includes(task.kind)||(task.kind==='module'&&!task.automaticAcceptance),rubric:['Factual support for each claim','Direct answer before detail','No repeated filler','Preserves uncertainty and user constraints',...(task.kind==='module'?['One owner for visibility policy','No dependency cycle or duplicate state','New module integrated through actual consumers']:[])],answer:text};
}
module.exports={gradeCode,gradeModules,evaluateModules,gradeTask,hash};
