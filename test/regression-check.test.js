'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assessRegression, checkProposedContracts, compareNodeRuns, counterexampleForDiff } = require('../src/regression-check');
const { executeTool } = require('../src/tools');
const { completionGaps, recordCheck } = require('../src/verification');

async function fixture(t, {file='src/value.js',before='module.exports=1;',after='module.exports=2;',testSource,testChanged=false}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'harness-checker-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const put=async(name,contents)=>{
    const target=path.join(root,name);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,contents);
  };
  await put(file,after);
  if(testSource!==undefined)await put('test/value.test.js',testSource);
  const session={mode:'manual',taskId:'task',turnId:'turn',turnChanges:[file],timeline:[
    {id:'edit',role:'tool',change:{file:path.join(root,file),before,after,existed:true}}
  ],changeLog:[{path:file,taskId:'task',turnId:'turn',eventId:'edit'}]};
  if(testChanged){
    session.timeline.push({id:'edit-test',role:'tool',change:{file:path.join(root,'test/value.test.js'),
      before:testSource+'\n// previous',after:testSource,existed:true}});
    session.changeLog.push({path:'test/value.test.js',taskId:'task',turnId:'turn',eventId:'edit-test'});
  }
  let approvals=0;
  const audit=()=>assessRegression({session,root,signal:new AbortController().signal,
    findFiles:async()=>testSource===undefined?[]:[path.join(root,'test/value.test.js')],
    approve:async command=>{approvals++;assert.match(command,/^node --test --test-reporter=tap -- test\/value\.test\.js$/);return true;}});
  return {root,session,audit,approvals:()=>approvals};
}

const assertTest=assertion=>[
  "const test=require('node:test');",
  "const assert=require('node:assert/strict');",
  "const value=require('../src/value.js');",
  "test('observable value',()=>{"+assertion+"});"
].join('\n');

test('the same named assertion fails on original code and passes on patched code; repeat reuses evidence',async t=>{
  const f=await fixture(t,{testSource:assertTest('assert.equal(value,2)')});
  const result=await f.audit();
  assert.equal(result.status,'confirmed',JSON.stringify(result));
  assert.deepEqual(result.assertions,['observable value']);
  assert.deepEqual(result.tests,['test/value.test.js']);
  assert.equal(await fs.readFile(path.join(f.root,'src/value.js'),'utf8'),'module.exports=2;');
  f.session.regressionAudit=result;
  assert.strictEqual(await f.audit(),result);
  assert.equal(f.approvals(),1);
  assert.deepEqual(completionGaps(f.session),[]);
});

test('a green but insensitive test and exit zero alone do not prove a regression is caught',async t=>{
  const f=await fixture(t,{testSource:assertTest('assert.equal(typeof value,"number")')});
  recordCheck(f.session,{command:'printf OK',output:'Exit code: 0\nOK'});
  assert.match(completionGaps(f.session).join(),/No current passing behavioral check/);
  f.session.regressionAudit=await f.audit();
  assert.equal(f.session.regressionAudit.status,'unproven');
  assert.match(completionGaps(f.session).join(),/did not demonstrate/);
  assert.equal(compareNodeRuns('Exit code: 0\nOK','Exit code: 0\nOK').status,'inconclusive');
});

test('setup failure before the patch is not accepted as a reproduced assertion',async t=>{
  const f=await fixture(t,{before:"throw Error('missing setup');",testSource:assertTest('assert.equal(value,2)')});
  assert.equal((await f.audit()).status,'inconclusive');
});

test('a relevant assertion failing on the patch is a blocking failure',async t=>{
  const f=await fixture(t,{testSource:assertTest('assert.equal(value,1)')});
  f.session.regressionAudit=await f.audit();
  assert.equal(f.session.regressionAudit.status,'failed');
  assert.match(completionGaps(f.session).join(),/failed on the patched/);
});

test('a required contract checks the selected patch in a temporary copy before any workspace write', async t => {
  const f = await fixture(t, {after:'module.exports=1;',testSource:"require('node:assert/strict').equal(require('../src/value.js'), 1);"});
  const file = path.join(f.root,'src/value.js');
  let writes = 0;
  const rules = [{paths:['src/'],script:'test/value.test.js'}];
  const host = {
    root:f.root, signal:new AbortController().signal, mode:'manual', checkDirty:async()=>{},
    approveEdit:async()=>true, approveContractCheck:async()=>true,
    checkContracts:(changes, approve)=>checkProposedContracts({root:f.root,changes,rules,signal:host.signal,approve}),
    applyPatchset:async changes=>{
      for (const item of changes) {
        if (item.file === file) assert.equal(await fs.readFile(file,'utf8'),'module.exports=1;');
        await fs.writeFile(item.file,item.after);
        writes++;
      }
    }
  };
  const patch = newText => executeTool('apply_patchset',{changes:[
    {path:'src/value.js',old_text:'module.exports=1;',new_text:newText},
    {path:'src/linked.js',create:true,new_text:'exports.linked=true;'}
  ]},host);
  await assert.rejects(patch('module.exports=2;'),/Contract check failed.*test\/value.test.js/);
  assert.equal(writes,0);
  await assert.rejects(fs.access(path.join(f.root,'src/linked.js')));
  const result = JSON.parse(await patch('module.exports = 1;'));
  assert.deepEqual(result.contracts.passed,['test/value.test.js']);
  assert.equal(writes,2);
});

test('docs, absent or unrelated tests, and modifications to existing tests have separate outcomes',async t=>{
  const docs=await fixture(t,{file:'README.md'});
  const empty=await fixture(t);
  const unrelated=await fixture(t,{testSource:"require('node:test')('unrelated',()=>{});"});
  const weakened=await fixture(t,{testSource:assertTest('assert.ok(value)'),testChanged:true});
  for(const [f,status] of [[docs,'not_needed'],[empty,'no_tests'],[unrelated,'no_replay'],[weakened,'test_modified']]){
    f.session.regressionAudit=await f.audit();
    assert.equal(f.session.regressionAudit.status,status,JSON.stringify(f.session.regressionAudit));
    assert.equal(f.approvals(),0);
    if(status!=='test_modified')assert.deepEqual(completionGaps(f.session),[]);
  }
  assert.match(completionGaps(weakened.session).join(),/Existing tests or fixtures changed/);
});

test('a related standalone project check stays pending after a refused run and becomes checked with a passing receipt', async t => {
  const {root,session} = await fixture(t);
  const script = 'train/value_check.mjs';
  await fs.mkdir(path.join(root,'train'));
  await fs.writeFile(path.join(root,script),"import assert from 'node:assert/strict'; import value from '../src/value.js'; assert.equal(value,2);");
  const indirect = 'train/wrapper_check.mjs';
  await fs.writeFile(path.join(root,'src/wrapper.mjs'),"import '../src/value.js';");
  await fs.writeFile(path.join(root,indirect),"import '../src/wrapper.mjs';");
  session.timeline.push({name:'related_tests',taskId:session.taskId,testPaths:[script,indirect]});
  const audit = () => assessRegression({session,root,signal:new AbortController().signal,
    findFiles:async()=>[],approve:async()=>assert.fail('Standalone scripts require the ordinary approval path')});
  const command = 'node '+script;
  recordCheck(session,{command,output:'User rejected the command.',category:'project-check'});
  session.regressionAudit = await audit();
  assert.equal(session.regressionAudit.status,'not_run');
  assert.deepEqual(session.regressionAudit.tests,[script]);
  assert.match(completionGaps(session).join(),/Existing checks found/);
  recordCheck(session,{command,output:'Exit code: 0\nOK',category:'project-check'});
  session.regressionAudit = await audit();
  assert.equal(session.regressionAudit.status,'checked');
  assert.deepEqual(completionGaps(session),[]);
});

test('counterexample flags cleanup inside an immediately invoked promise before registering it', async t => {
  const after = 'const pending = (async () => {try {return await execute();} finally {cache?.delete(key);}})(); cache?.set(key,pending);';
  const risky = await fixture(t,{after});
  assert.match(counterexampleForDiff(risky.session,risky.root),/throws synchronously/);
  const fixed = await fixture(t,{after:"const pending = (async () => {return await execute();})(); cache?.set(key,pending); try {return await pending;} finally {cache?.delete(key);}"});
  assert.equal(counterexampleForDiff(fixed.session,fixed.root),undefined);
  const suspended = await fixture(t,{after:after.replace('{try','{await null; try')});
  assert.equal(counterexampleForDiff(suspended.session,suspended.root),undefined);
  const unchanged = await fixture(t,{before:after,after:after+'\nconst other = 1;'});
  assert.equal(counterexampleForDiff(unchanged.session,unchanged.root),undefined);
});

test('shell changes can use a byte-matching Git baseline and reject an unrelated HEAD baseline',async t=>{
  const exec= require('node:util').promisify(require('node:child_process').execFile);
  const {fileState}=require('../src/workspace-changes');
  const f=await fixture(t,{before:'module.exports=1;',after:'module.exports=2;',testSource:assertTest('assert.equal(value,2)')});
  const file=path.join(f.root,'src/value.js');
  await fs.writeFile(file,'module.exports=1;');
  await exec('git',['init','-q'],{cwd:f.root});
  await exec('git',['add','.'],{cwd:f.root});
  await exec('git',['-c','user.name=Harness Fixture','-c','user.email=harness@example.invalid','commit','-qm','fixture'],{cwd:f.root});
  const before=await fileState(f.root,'src/value.js');
  await fs.writeFile(file,'module.exports=2;');
  const after=await fileState(f.root,'src/value.js');
  f.session.timeline=[];
  f.session.changeLog[0].commandChange={before,after};
  const report=await f.audit();
  assert.equal(report.status,'confirmed',JSON.stringify(report));
  f.session.changeLog[0].commandChange.before='file:0:'+'a'.repeat(64);
  const unknown=await f.audit();
  assert.equal(unknown.status,'no_replay');
  assert.match(unknown.reason,/pre-patch source/);
});

test('counterexample notices an exact match bypassing fallback eligibility', async t => {
 const before='exports.selected = (xs, id) => xs[0]?.id || null;';
 const after='exports.selected = (xs, id) => xs.find(x => x.id === id)?.id ?? xs.find(x => x.disabled !== true)?.id ?? null;';
 const goal='Select an eligible exact match, otherwise the first record with disabled !== true.';
 const risky=await fixture(t,{before,after});
 risky.session.initialGoal=goal;
 assert.match(counterexampleForDiff(risky.session,risky.root),/exact match that fails the disabled rule/);
 const fixed=await fixture(t,{before,after:after.replace('x.id === id','x.id === id && x.disabled !== true')});
 fixed.session.initialGoal=goal;
 assert.equal(counterexampleForDiff(fixed.session,fixed.root),undefined);
 const unchanged=await fixture(t,{before:after,after:after+'\nconst unrelated = true;'});
 unchanged.session.initialGoal=goal;
 assert.equal(counterexampleForDiff(unchanged.session,unchanged.root),undefined);
});

test('a new truthiness guard can discard the first thrown value',async t=>{
 const before='function run(fn){fn();}';
 const after='function run(fn){let first;try{fn()}catch(e){if(!first)first=e;}if(first)throw first;}';
 const risky=await fixture(t,{before,after});
 risky.session.initialGoal='Execute remaining callbacks and rethrow the first error.';
 assert.match(counterexampleForDiff(risky.session,risky.root),/throws undefined/);
 const flagged=await fixture(t,{before,after:'function run(fn){let seen=false, first;try{fn()}catch(e){if(!seen){seen=true;first=e;}}if(seen)throw first;}'});
 flagged.session.initialGoal=risky.session.initialGoal;
 assert.equal(counterexampleForDiff(flagged.session,flagged.root),undefined);
});

test('queue check identifies receiver guards and filters that lose new occurrences',async t=>{
 const before='function drain(q){for(const f of q)f()}';
 const receiver='if(this.running)return;';
 const deletion='q=q.filter(f=>!snapshot.includes(f));';
 const risky=await fixture(t,{before,after:'function drain(q,snapshot){'+receiver+deletion+'}'});
 risky.session.initialGoal='Preserve nested drain behavior and newly added callbacks.';
 const hint=counterexampleForDiff(risky.session,risky.root);
 assert.match(hint,/detached call/);
 assert.match(hint,/same callback function again/);
 const safe=await fixture(t,{before,after:'function drain(q){const snapshot=q.splice(0);for(const f of snapshot)f()}'});
 safe.session.initialGoal=risky.session.initialGoal;
 assert.equal(counterexampleForDiff(safe.session,safe.root),undefined);
});
