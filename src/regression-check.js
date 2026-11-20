'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const git = require('node:util').promisify(execFile);
const { snapshotWorkspace, fileState } = require('./workspace-changes');
const { inside, protectedPath, runCommand, workspacePath, textFile } = require('./tools');
const { sandboxExecution } = require('./sandbox');
const { findEvent } = require('./agents');
const { currentChecks, projectCheckScript, requestedNodeChecks } = require('./verification');

const docs = /(?:^|\/)(?:docs?|documentation)\/.*\.(?:mdx?|rst|txt|adoc)$|\.(?:md|rst|adoc)$/i;
const testFile = /(?:^|\/)(?:tests?|__tests__|specs?)\/[^/]+\.(?:[cm]?[jt]sx?|py|rb|php|go|rs|java|kt|cs)$|(?:[._-](?:test|spec)|Test|Tests)\.(?:[cm]?[jt]sx?|py|rb|php|go|rs|java|kt|cs)$|(?:^|\/)test(?:_[^/]+)?\.(?:[cm]?[jt]s|py)$/i;
const testInput = name => testFile.test(name) || projectCheckScript.test(name) || /(?:^|\/)(?:tests?|__tests__|specs?|fixtures|__fixtures__|__snapshots__)(?:\/|$)/i.test(name);
const javascript = /\.[cm]?js$/i;
const ignored = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|\.next|\.cache|\.venv|\.git)(?:\/|$)/i;
const sensitive = /(?:^|\/)(?:secrets?|credentials)(?:[./_-]|$)|\.(?:key|pem|p12|pfx)$/i;
const safeCopy = name => !ignored.test(name) && !sensitive.test(name) && (!protectedPath(name) || /(^|\/)package\.json$/.test(name));
const notFound = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const digest = snapshot => createHash('sha256').update(JSON.stringify([...snapshot.files].sort(([a],[b])=>a.localeCompare(b)))).digest('hex');

function diffForRegression(session, root) {
  const changes = new Map();
  for (const record of session.changeLog || []) {
    if (record.taskId !== session.taskId) continue;
    const name = record.path.split(path.sep).join('/');
    if (!inside(root,path.resolve(root,name))) {
      changes.set(name,{name,unknown:true});
      continue;
    }
    const event = findEvent(session.timeline,record.eventId);
    if (event?.undone) continue;
    const edit = event?.change;
    const prior = changes.get(name);
    changes.set(name,{
      name,
      before:prior ? prior.before : edit ? edit.existed ? edit.before : null : record.commandChange?.before===null ? null : undefined,
      beforeState:prior ? prior.beforeState : record.commandChange?.before,
      after:edit ? edit.after : undefined,
      afterState:record.commandChange?.after,
      unknown: prior?.unknown || (!edit && !record.commandChange)
    });
  }
  for (const name of session.turnChanges || []) if (!changes.has(name) && !(session.changeLog||[])
    .some(record=>record.taskId===session.taskId&&record.path===name&&findEvent(session.timeline,record.eventId)?.undone)) {
    changes.set(name,{name,unknown:true});
  }
  return [...changes.values()].filter(change=>change.unknown || change.before===undefined || change.before!==change.after);
}

function asymmetricSelection(source, field) {
  const predicates = [...(source || '').matchAll(/\b(\w+)\.find\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*([^;\n)]{1,280})/g)];
  const hasField = ([, , value, predicate]) => new RegExp('\\b'+value+'\\s*\\??\\.\\s*'+field+'\\b').test(predicate);
  return predicates.filter((entry, index) => predicates.slice(index + 1)
    .some(other => entry[1] === other[1] && hasField(entry) !== hasField(other))).map(entry=>entry[0]);
}

function truthyFirstException(source) {
  return [...(source || '').matchAll(/\bcatch\s*\(\s*([\w$]+)\s*\)\s*\{\s*if\s*\(\s*!\s*([\w$]+)\s*\)\s*\{?\s*([\w$]+)\s*=\s*([\w$]+)\b/g)]
    .filter(([, caught, guard, target, assigned])=>caught===assigned && guard===target)
    .map(([, , guard])=>guard);
}

function counterexampleForDiff(session, root) {
  const check = source => [...(source || '').matchAll(
    /\bconst\s+(\w+)\s*=\s*\(async\s*\(\s*\)\s*=>\s*\{([\s\S]{1,2200}?)\}\)\(\)\s*;?\s*(\w+)(?:\?\.|\.)set\(\s*(\w+)\s*,\s*\1\s*\)/g
  )].filter(([, , body, store, key]) =>
    !/^\s*await\s+(?:null|undefined|0)\s*;/.test(body) &&
    new RegExp('\\b' + store + '(?:\\?\\.|\\.)delete\\(\\s*' + key + '\\s*\\)').test(body) &&
    /\bawait\s+(?!Promise\.)[\w$.]+\s*\(/.test(body)
  );
  for (const {name,before,after} of diffForRegression(session,root)) {
    const goal = session.initialGoal || '';
    if (/\.[cm]?[jt]sx?$/i.test(name) &&
        /\bfirst (?:thrown (?:value|error)|(?:caught )?(?:error|exception|failure))\b|перв\p{L}*\s+ошиб\p{L}*/iu.test(goal)) {
      const existing = new Set(truthyFirstException(before));
      if (truthyFirstException(after).some(guard=>!existing.has(guard))) {
        return name + ': Trace a callback that throws undefined followed by one that throws an Error. The current truthiness check cannot distinguish an empty slot from the first thrown value. Track whether an exception was caught separately from its value, and rethrow that first value after the remaining callbacks. Keep the guard in the same queue instance as the existing state so callers can still invoke the original function without binding a receiver.';
      }
    }
    if (/\.[cm]?[jt]sx?$/i.test(name) &&
        /\bre-?entran|\b(?:nested|recursive) (?:call|drain)\b|вложенн\p{L}*\s+(?:вызов\p{L}*|drain)/iu.test(goal)) {
      const receiverGuard = /\bif\s*\(\s*this\.[\w$]+\s*\)\s*\{?\s*return\b/;
      const filteringByIdentity = /\.filter\(\s*(\w+)\s*=>\s*!\s*\w+\.includes\(\s*\1\s*\)\s*\)/;
      const hazards = [];
      if (receiverGuard.test(after || '') && !receiverGuard.test(before || '') && !/\bthis\./.test(before || '')) {
        hazards.push('The patch introduces a receiver-dependent reentry guard. Check a detached call and a callback that drains another queue instance. Preserve detached calls supported by the original code and keep reentry state local to each queue instance.');
      }
      if (filteringByIdentity.test(after || '') && !filteringByIdentity.test(before || '')) {
        hazards.push('Check an event that enqueues the same callback function again. Filtering the remaining queue by callback identity discards the new occurrence. Remove the original batch before calling its callbacks so new occurrences survive to the next drain.');
      }
      if (hazards.length) return name + ': ' + hazards.join(' ');
    }
    const field = /\b(disabled|hidden|visible)\b/i.exec(goal)?.[1]?.toLowerCase();
    if (field && /(?:fallback|otherwise|иначе|в противном случае)/iu.test(goal) && /\.[cm]?[jt]sx?$/i.test(name)) {
      const existing = new Set(asymmetricSelection(before,field));
      if (asymmetricSelection(after,field).some(predicate=>!existing.has(predicate))) {
        return name + ': The exact-match and fallback searches use different eligibility predicates. Trace an exact match that fails the '+field+' rule and a later eligible record. Verify that the exact branch applies the user’s eligibility requirement before returning, including when no eligible record exists.';
      }
    }
    const previous = new Set(check(before).map(match => match[0]));
    if (check(after).some(match => !previous.has(match[0]))) {
      return name + ': Trace a dependency that throws synchronously before returning a promise. The async IIFE can run its cleanup before the later Map.set stores its rejected promise. Ensure registration precedes cleanup, then check that the next call retries. If safe, show the exact ordering that prevents the race.';
    }
  }
}

async function recoverGitBaseline(root, change, signal) {
  if(change.before!==undefined || !change.beforeState?.startsWith('file:'))return;
  try {
    const {stdout}=await git('git',['show','HEAD:./'+change.name],{
      cwd:root,signal,encoding:'buffer',timeout:5000,maxBuffer:1024*1024
    });
    const text=stdout.toString('utf8');
    const hash=createHash('sha256').update(stdout).digest('hex');
    if(change.beforeState.endsWith(':'+hash) && !text.includes('\0') && Buffer.from(text).equals(stdout))change.before=text;
  } catch {
    signal.throwIfAborted();
  }
}

async function findRegressionTests(root, names, candidates, signal) {
  const targets = new Set(names.map(name=>name.replace(/\.[^./]+$/,'')));
  const ancestry = new Map();
  const read = async name => {
    signal.throwIfAborted();
    const file=await workspacePath(root,name);
    if(await fs.realpath(file)!==file)return '';
    return textFile(file);
  };
  const imports = async name => {
    if(ancestry.has(name))return ancestry.get(name);
    const source = await read(name).catch(()=> '');
    const children=[...source.matchAll(/\b(?:require\s*\(\s*|from\s+|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"\n]+)['"]/g)]
      .map(match=>path.posix.normalize(path.posix.join(path.posix.dirname(name),match[1])));
    const result={source,children};
    ancestry.set(name,result);
    return result;
  };
  const hits = async (name, depth, seen=new Set()) => {
    if (depth<0 || seen.has(name) || !safeCopy(name) || ancestry.size>=240) return new Set();
    seen.add(name);
    const {children}=await imports(name);
    const reached=new Set();
    for(const child of children){
      const stem=child.replace(/\.[^./]+$/,'');
      for(const target of targets)if(stem===target || stem+'/index'===target)reached.add(target);
      if(depth===0 || reached.size===targets.size)continue;
      for(const form of /\.[cm]?js$/i.test(child)?[child]:[child+'.js',child+'.cjs',child+'.mjs',child+'/index.js']){
        if(!safeCopy(form))continue;
        const result=await hits(form,depth-1,seen);
        for(const hit of result)reached.add(hit);
      }
    }
    return reached;
  };
  const selected=[];
  for(const file of candidates.filter(name=>javascript.test(name)).slice(0,100)){
    const {source,children}=await imports(file);
    const replay = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s+)['"]node:test['"]/.test(source);
    if(!replay && !projectCheckScript.test(file))continue;
    const reached=await hits(file,2);
    const direct=children.some(child=>targets.has(child.replace(/\.[^./]+$/,'')));
    if(reached.size)selected.push({file,reached:[...reached],replay,direct});
  }
  return selected.sort((a,b)=>b.reached.length-a.reached.length || a.file.localeCompare(b.file)).slice(0,4);
}

function nodeResult(output) {
  const exit = /^Exit code: (0|1)\n/.exec(output);
  const count = Number(/^# tests (\d+)\s*$/m.exec(output)?.[1]);
  const skipped = Number(/^# skipped (\d+)\s*$/m.exec(output)?.[1] || 0);
  const assertions = [];
  const passing = [];
  const lines = output.split('\n');
  let nonAssertionFailures = false;
  for (let i=0;i<lines.length;i++) {
    const row=/^\s*(ok|not ok) \d+ - (.+)$/.exec(lines[i]);
    if(!row || /\s+#\s+(?:SKIP|TODO)\b/i.test(row[2]))continue;
    if(row[1]==='ok'){passing.push(row[2]);continue;}
    const next=lines.slice(i+1,i+40).join('\n').split(/^\s*(?:not )?ok \d+ - /m)[0];
    if(/^\s*code: ['"]?ERR_ASSERTION['"]?\s*$/m.test(next) && /failureType: ['"]?testCodeFailure['"]?/.test(next))assertions.push(row[2]);
    else if (!/failureType: ['"]?(?:subtestsFailed|testFailed)['"]?/.test(next)) nonAssertionFailures=true;
  }
  return { exit:exit ? Number(exit[1]) : null, tests:count || 0, skipped, assertions, passing, nonAssertionFailures,
    complete:Boolean(exit && count && !output.includes('[Output truncated]')) };
}

function compareNodeRuns(beforeOutput, afterOutput) {
  const before=nodeResult(beforeOutput),after=nodeResult(afterOutput);
  if(!after.complete || after.tests<=after.skipped)return {status:'inconclusive',reason:'No complete result from a recognized test runner.'};
  if(after.exit!==0) {
    return after.assertions.length
      ? {status:'failed',assertions:after.assertions,reason:'An assertion failed on the patched source.'}
      : {status:'inconclusive',reason:'The patched suite did not run to a passing result.'};
  }
  if(!before.complete || before.tests<=before.skipped || before.nonAssertionFailures ||
     before.tests!==after.tests || before.skipped!==after.skipped){
    return {status:'inconclusive',reason:'The two revisions did not execute comparable test cases.'};
  }
  const caught=before.assertions.filter(name=>before.assertions.filter(item=>item===name).length===1 &&
    after.passing.filter(item=>item===name).length===1);
  return before.exit===1 && caught.length && caught.length===before.assertions.length
    ? {status:'confirmed',assertions:caught,reason:'The same assertions failed on the old source and passed on the patch.'}
    : {status:'unproven',reason:'The test run did not demonstrate a named assertion failing before and passing after.'};
}

async function stageSnapshots(current, changes, parent, signal, proposed = false) {
  const before=proposed ? null : path.join(parent,'before'),after=path.join(parent,'after');
  if(before)await fs.mkdir(before);
  await fs.mkdir(after);
  const versions = before ? [before, after] : [after];
  let bytes=0, count=0;
  const overlay=new Map(changes.map(change=>[change.name,proposed ? change.after : change.before]));
  const overlayRoot=proposed ? after : before;
  for (const [name,state] of current.files) {
    signal.throwIfAborted();
    if(!state?.startsWith('file:') || !safeCopy(name))continue;
    const original=path.resolve(current.root,name);
    if(!inside(current.root,original) || await fs.realpath(original)!==original)throw Error('Workspace path changed during the audit.');
    const stat=await fs.stat(original);
    bytes+=stat.size;
    if(++count>4000 || bytes>64*1024*1024)throw Error('Project exceeds the isolated replay limits.');
    for(const base of versions){
      if(base===overlayRoot&&overlay.has(name))continue;
      const dest=path.join(base,name);
      await fs.mkdir(path.dirname(dest),{recursive:true});
      await fs.copyFile(original,dest);
      if(await fileState(base,name)!==state)throw Error('Workspace changed during the audit.');
    }
  }
  for(const [name,contents] of overlay){
    if(contents===null)continue;
    const dest=path.join(overlayRoot,name);
    await fs.mkdir(path.dirname(dest),{recursive:true});
    await fs.writeFile(dest,contents);
    const mode=current.files.get(name)?.split(':')[1];
    if(mode)await fs.chmod(dest,0o600|Number(mode));
  }
  return {before,after};
}

async function checkProposedContracts({ root, changes, rules, signal, approve, sandbox }) {
  if (!rules?.length) return;
  const realRoot = await fs.realpath(root);
  const relative = file => path.relative(realRoot, file).split(path.sep).join('/');
  const targets = changes.filter(change => inside(realRoot, change.file))
    .map(change => ({ ...change, name: relative(change.file) }));
  const matches = (name, target) => target.endsWith('/') ? name.startsWith(target) : name === target;
  const scripts = new Map();
  for (const rule of rules) {
    if (!targets.some(change => rule.paths.some(target => matches(change.name,target)) || change.name === rule.script)) continue;
    const file = await workspacePath(root, rule.script);
    if (relative(file) !== rule.script || !safeCopy(rule.script) || await fs.realpath(file) !== file) {
      throw Error('Invalid contract check script: ' + rule.script);
    }
    if (targets.some(change => change.file === file)) {
      throw Error('The patch modifies its contract check. Update the check separately: ' + rule.script);
    }
    scripts.set(rule.script, rule.timeout_seconds ?? 30);
  }
  if (!scripts.size) return;
  if (targets.length !== changes.length || targets.some(({name}) => !safeCopy(name))) {
    throw Error('The full patch must use copyable project files for its contract checks.');
  }
  for (const script of scripts.keys()) {
    if (!await approve('node ' + script)) throw Error('Contract check declined. No files were changed: ' + script);
  }
  signal.throwIfAborted();
  const current = await snapshotWorkspace(realRoot);
  for (const change of targets) {
    const expected = createHash('sha256').update(change.before).digest('hex');
    const observed = current.files.get(change.name);
    if (change.existed ? !observed?.startsWith('file:') || !observed.endsWith(':' + expected) : observed) {
      throw Error('Source changed before contract checks. Rebuild the fragment: ' + change.name);
    }
  }
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'harness-contract-'));
  try {
    const {after} = await stageSnapshots(current,targets,parent,signal,true);
    // Reuse installed packages for Node resolution. The runner keeps the user's sandbox policy.
    const dependencies = await fs.realpath(path.join(realRoot,'node_modules')).catch(error => {
      if (!notFound(error)) throw error;
    });
    if (dependencies) await fs.symlink(dependencies,path.join(after,'node_modules'),'junction');
    const env = { PATH: process.env.PATH, HOME: parent, TMPDIR: parent,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: parent, TMP: parent } : {}) };
    for (const [script, timeout] of scripts) {
      const command = 'node ' + script;
      const execution = await sandboxExecution(after,{file:'node',args:['--','./'+script]},command,sandbox);
      const output = await runCommand(command,after,timeout,signal,undefined,{...execution,env});
      signal.throwIfAborted();
      if (!output.startsWith('Exit code: 0\n')) {
        const relevant = output.split('\n').find(line => /AssertionError|FAIL|Error:/.test(line));
        throw Error('Contract check failed on the proposed files. No files were changed: ' + script + '\n' +
          (relevant ? relevant + '\n' : '') + output.slice(-850));
      }
      for (const {name,after:expected} of targets) {
        if (await textFile(path.join(after,name)) !== expected) {
          throw Error('Contract check modified the proposed file: ' + name + '. No files were changed.');
        }
      }
    }
    if (digest(await snapshotWorkspace(realRoot)) !== digest(current)) {
      throw Error('Workspace changed while checking the proposal. Retry against the current files.');
    }
  } finally {
    await fs.rm(parent,{recursive:true,force:true});
  }
  return { passed: [...scripts.keys()] };
}

async function assessRegression({session,root,findFiles,approve,signal,sandbox=false}) {
  const revision=(session.changeLog||[]).length;
  const changes=diffForRegression(session,root);
  const paths=changes.map(change=>change.name);
  const result=(status,reason,extra={})=>({taskId:session.taskId,revision,status,reason,paths,...extra});
  if(!paths.length)return result('not_needed','No net workspace changes were recorded.');
  const source=changes.filter(change=>!docs.test(change.name)&&!testInput(change.name));
  if(changes.every(change=>docs.test(change.name)))return result('not_needed','Documentation-only change.');
  if(changes.some(change=>testInput(change.name)&&change.before!==null))return result('test_modified','Existing tests or fixtures changed. Review their assertions before treating a pass as regression evidence.');
  if(!source.length)return result('test_only','Only new tests or fixtures changed. No production diff to replay.');
  const hinted = (session.timeline || []).filter(event => event.taskId === session.taskId && event.name === 'related_tests')
    .flatMap(event => event.testPaths || []);
  const found = (await findFiles('**/*.{js,jsx,mjs,cjs,ts,tsx,py,go,rs,java,kt,cs,rb,php}'))
    .map(file=>path.relative(root,file).split(path.sep).join('/'));
  const candidates=[...new Set(found)]
    .filter(name=>!name.startsWith('../') && !ignored.test(name)&&(testFile.test(name) || projectCheckScript.test(name)));
  for (const name of new Set(hinted)) {
    if (candidates.includes(name) || !safeCopy(name) || !inside(root,path.resolve(root,name))) continue;
    const file = await workspacePath(root,name).catch(()=>null);
    if (file && await fs.stat(file).then(stat=>stat.isFile(),()=>false)) candidates.push(name);
  }
  if(!candidates.length)return result('no_tests','No existing test files were discovered. No tests were created.');
  const related=await findRegressionTests(root,source.map(change=>change.name),candidates,signal);
  const selected=related.filter(item=>item.replay);
  const requested = requestedNodeChecks(session.initialGoal);
  const requestedScripts = related.filter(item=>requested.includes('node '+item.file));
  const scripts = requestedScripts.length ? requestedScripts : related.filter(item=>item.direct);
  if (!selected.length && scripts.length) {
    const tests=scripts.map(item=>item.file);
    const commands=tests.map(file=>'node '+file);
    const receipts=currentChecks(session);
    const failed=commands.find(command=>receipts.some(check=>check.command.trim()===command && !check.commandPassed));
    if (failed) return result('failed','Existing check failed: '+failed,{tests,commands});
    const pending=commands.filter(command=>!receipts.some(check=>check.command.trim()===command && check.commandPassed));
    if (pending.length) return result('not_run','Existing checks found. Run the exact command on the saved revision: '+pending.join(' or ')+'.',{tests,commands});
    return result('checked','Existing checks passed on the saved revision. No before/after replay was performed.',{tests,commands});
  }
  const tests=selected.map(item=>item.file);
  if(!tests.length)return result('no_replay','No related Node test using node:test was found. Existing project checks can still be run.',{tests:candidates});
  const covered=new Set(selected.flatMap(item=>item.reached));
  const unchecked=source.filter(change=>!covered.has(change.name.replace(/\.[^./]+$/,''))).map(change=>change.name);
  if(unchecked.length)return result('no_replay','Selected tests do not cover all changed source paths through known imports.',{tests,unchecked});
  for(const change of source)if(safeCopy(change.name))await recoverGitBaseline(root,change,signal);
  if(source.some(change=>change.unknown || change.before===undefined||!safeCopy(change.name)||!javascript.test(change.name))) {
    return result('no_replay','The pre-patch source could not be reconstructed safely for every changed file.',{tests});
  }

  const current=await snapshotWorkspace(root);
  for(const {name,after,afterState} of changes){
    if(afterState!==undefined && (current.files.get(name)??null)!==afterState)return result('inconclusive','On-disk contents differ from the recorded command diff.',{tests});
    if(after!==undefined && (await textFile(await workspacePath(root,name)).catch(error=>{
      if(notFound(error))return undefined;
      throw error;
    }))!==after)return result('inconclusive','On-disk contents differ from the recorded diff.',{tests});
  }
  const signature=digest(current);
  const prior=session.regressionAudit;
  if(prior?.taskId===session.taskId && prior.revision===revision && prior.digest===signature)return prior;
  const finish=(status,reason,extra={})=>result(status,reason,{tests,digest:signature,...extra});
  const args=['--test','--test-reporter=tap','--',...tests];
  const command='node '+args.map(arg=>/^[\w./=-]+$/.test(arg)?arg:JSON.stringify(arg)).join(' ');
  if(!await approve(command))return finish('declined','The two runs on isolated copies were not approved.');
  signal.throwIfAborted();

  const parent=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'harness-regression-'));
  try {
    const copies=await stageSnapshots(current,source,parent,signal);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
      !['NODE_TEST_CONTEXT','NODE_OPTIONS','NODE_PATH'].includes(key)));
    const run=async directory=>runCommand(command,directory,30,signal,undefined,{
      ...await sandboxExecution(directory,{file:'node',args},command,sandbox),env
    });
    const patched=await run(copies.after);
    signal.throwIfAborted();
    const original=await run(copies.before);
    signal.throwIfAborted();
    if(digest(await snapshotWorkspace(root))!==signature)return finish('inconclusive','Workspace changed during the regression audit.');
    const {status,reason,...details}=compareNodeRuns(original,patched);
    return finish(status,reason,details);
  } finally {
    await fs.rm(parent,{recursive:true,force:true});
  }
}

module.exports={assessRegression,checkProposedContracts,compareNodeRuns,diffForRegression,counterexampleForDiff};
