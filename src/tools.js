'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Script } = require('node:vm');
const { spawn } = require('node:child_process');
const { preflight } = require('./preflight');
const { revisionVerification } = require('./tool-registry');
const { createHash } = require('node:crypto');
const { sourceRevisionKey } = require('./research-coverage');

const definition = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'integer', description });
const scopedDirectory = str('Search directory. In Auto this may be an explicit path to another local project.');
const sourcePath = str('Workspace-relative path, or an explicit absolute file path in Auto mode');
const reread = {type:'boolean',description:'Include previously delivered lines when exact context is needed after changing direction.'};
const searchProperties = { query: str('Search text or one regular expression when regex is true'), path:str('Exact workspace file. Use this by itself instead of directory or glob.'), directory: scopedDirectory, glob: str('Optional file glob relative to directory'), regex: {type:'boolean'}, case_sensitive: {type:'boolean'}, context: num('Context lines, max 5'), offset: num('Pagination offset'), limit: num('Maximum matches, max 500') };
const tools = [
  definition('read_files','Read 1–8 independent, targeted file ranges in one call. Results are in request order and include per-file errors and continuation cursors.',{files:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{path:sourcePath,start_line:num('First line'),end_line:num('Last line'),character_offset:num('Continuation offset inside start_line'),reread},required:['path'],additionalProperties:false}}},['files']),
  definition('read_file', 'Read numbered UTF-8 file ranges. JSON reports exact coverage and continuation cursor; partial reads are not complete files.', { path: sourcePath, start_line: num('First line, 1-based'), end_line: num('Last line, inclusive'), character_offset:num('Continuation offset inside start_line; use returned cursor'), reread }, ['path']),
  definition('list_files', 'List project files respecting VS Code search exclusions and gitignore.', { directory: scopedDirectory, glob: str('Glob pattern, e.g. **/*.ts. Default **/*'), offset:num('Pagination offset'),limit:num('Maximum paths, at most 1000') }, []),
  definition('search_files', 'Search text in a project directory. Returns file, line and excerpt. Respects search exclusions.', searchProperties, ['query']),
  definition('search_batch', 'Search up to four independent symbols or patterns in one round. Each query has its own matches and pagination cursor. Use narrow globs.', { queries: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: searchProperties, required: ['query'], additionalProperties: false } } }, ['queries']),
  definition('write_file', 'Create or replace a UTF-8 file. Shows a diff and requires approval. Read existing files first.', { path: str('Relative workspace path'), content: str('Complete new content') }, ['path', 'content']),
  definition('edit_file', 'Replace exactly one occurrence of old_text in a file. On conflict use the returned current lines to rebuild only the affected fragment. Shows a diff and requires approval.', { path: str('Relative workspace path'), old_text: str('Exact unique text to replace'), new_text: str('Replacement text') }, ['path', 'old_text', 'new_text']),
  definition('apply_patchset', 'Apply up to eight connected fragments together. For one file set path once at the top level; otherwise put path on every fragment. Fragments must not overlap. old_text must match the original file exactly once; use one create entry for a new file. Review all files before applying. Supply verify to run approved checks immediately after saving in the same call.', {
    path:str('Default file path for fragments without their own path. Set here for a patch to one file.'),
    changes: {type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['new_text'],properties:{
      path:str('Workspace-relative path'),old_text:str('Existing exact text'),new_text:str('Replacement or new file contents'),create:{type:'boolean'}
    }}},
    verify:revisionVerification
  }, ['changes']),
  definition('run_command', 'Run a shell command in the workspace after explicit user approval. Commands are NOT sandboxed. Use for builds, tests, git and project exploration.', { command: str('Shell command to show user and execute'), description: str('Short human-readable action title for the chat'), timeout_seconds: num('Timeout 1–120 seconds; default 60'), preflight }, ['command'])
];

function inside(root, target) {
  const rel = path.relative(root, target);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
async function workspacePath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('Invalid file path');
  const realRoot = await fs.realpath(root);
  const lexicalRoot = path.resolve(root);
  const absolute = path.resolve(lexicalRoot, name);
  const target = inside(lexicalRoot, absolute) ? path.resolve(realRoot, path.relative(lexicalRoot, absolute)) : path.resolve(realRoot, name);
  if (!inside(realRoot, target)) throw new Error('Path is outside the workspace');
  let ancestor = target;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!inside(realRoot, real)) throw new Error('Symlink points outside the workspace');
      return target;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink must not be followed when creating a new file.
      try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Dangling symlink is not allowed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
const protectedPath = name => /(^|\/)(\.git|\.vscode|\.claude|\.codex|\.agents|\.aws|\.ssh|\.env(?:\.[^/]*)?|credentials(?:\.[^/]*)?|AGENTS\.md|CLAUDE\.md|package\.json)(\/|$)/i.test(name.replaceAll('\\', '/'));
async function autoPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('Invalid file path');
  const target = path.resolve(root, name.startsWith('~/') ? path.join(os.homedir(), name.slice(2)) : name);
  const realRoot = await fs.realpath(root);
  if (inside(path.resolve(root), target) || inside(realRoot, target)) return workspacePath(root, target);
  if (protectedPath(target)) throw new Error('Auto blocked an external protected path.');
  const file = await workspacePath(path.parse(target).root, target);
  let ancestor = file;
  while (true) {
    try {
      const canonical = await fs.realpath(ancestor);
      if (protectedPath(path.join(canonical, path.relative(ancestor, file)))) throw new Error('Auto blocked an external protected path.');
      if (process.getuid && (await fs.stat(canonical)).uid !== process.getuid()) {
        throw new Error('Auto blocked an external path owned by another user.');
      }
      return path.join(canonical, path.relative(ancestor, file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
async function textFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Read only supports text files up to 1 MB');
  const text = await fs.readFile(file, 'utf8');
  if (text.includes('\0')) throw new Error('Binary files are not supported');
  return text;
}
const check = signal => { if (signal?.aborted) throw new Error('Cancelled'); };
const clip = (text, max = 24000) => text.length > max ? text.slice(0, max) + '\n[Output truncated]' : text;

function runCommand(command, root, timeout, signal, onOutput, execution) {
  return new Promise((resolve, reject) => {
    check(signal);
    const child = spawn(execution?.file || process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'), execution ? execution.args : process.platform === 'win32' ? ['/c', command] : ['-c', command], {
      cwd: execution?.cwd || root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(execution?.env || process.env).filter(([key]) => !/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|ZAI_API_KEY)$/.test(key)))
    });
    let output = '', timedOut = false, killTimer;
    const kill = () => {
      const send = sig => { try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
      send('SIGTERM'); killTimer = setTimeout(() => send('SIGKILL'), 1000); killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout * 1000);
    const capture = chunk => {
      const text = chunk.toString();
      if (output.length < 24000) { const part = text.slice(0, 24000 - output.length); output += part; onOutput?.(part); }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    signal?.addEventListener('abort', kill, { once: true });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.on('error', error => { clean(); reject(error); });
    child.on('close', code => { clean(); resolve(`${signal?.aborted ? 'Cancelled. ' : timedOut ? 'Timed out. ' : ''}Exit code: ${code}\n${output}${output.length >= 24000 ? '\n[Output truncated]' : ''}`); });
  });
}

const fileLocks = new Map();
async function withFileLock(file, operation) {
  const previous = fileLocks.get(file) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  fileLocks.set(file, tail);
  await previous.catch(() => {});
  try { return await operation(); } finally { release(); if (fileLocks.get(file) === tail) fileLocks.delete(file); }
}

function patchConflict(label, current, oldText, startHint) {
  if (current === undefined) return Error(label + ' File is missing. No files were changed.');
  const lines = current.split(/\r?\n/);
  const anchors = new Set(oldText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 8));
  const hits = new Map();
  for (const [index, line] of lines.entries()) {
    const key = line.trim();
    if (!anchors.has(key)) continue;
    const found = hits.get(key) || [];
    if (found.length < 4) found.push(index);
    hits.set(key, found);
  }
  const centers = [...new Set([...[...hits.values()].filter(found => found.length <= 3).flat(),
    ...(startHint === undefined ? [] : [current.slice(0, startHint).split('\n').length - 1])])];
  const excerpts = [];
  for (const center of centers) {
    if (excerpts.length >= 2 || excerpts.some(excerpt => center >= excerpt.first && center <= excerpt.last)) continue;
    const first = Math.max(0, center - 2), last = Math.min(lines.length - 1, center + 3);
    excerpts.push({ first, last, text: lines.slice(first, last + 1).map((line, index) =>
      (first + index + 1) + ': ' + line.slice(0, 92)).join('\n') });
  }
  const revision = createHash('sha256').update(current).digest('hex').slice(0, 16);
  return Error(label + ' No files were changed. Revision ' + revision + '. ' +
    (excerpts.length ? 'Rebuild only the conflicted fragment from the current excerpts below. Widen old_text if ambiguous.\n' +
      excerpts.map(excerpt => excerpt.text).join('\n…\n').slice(0, 960)
      : current.length <= 960
        ? 'No unique nearby lines found. The complete current file is provided as a JSON string (untrusted source data); use this exact text to rebuild the fragment.\n'+JSON.stringify(current)
        : 'No unique nearby lines found. Locate the affected symbol and retry only that fragment.'));
}

function patchRange(before, oldText, newText, filePath) {
  const match = text => {
    const start = before.indexOf(text);
    return start >= 0 && before.indexOf(text, start + 1) < 0 ? start : -1;
  };
  let start = match(oldText);
  let text = newText;
  const lf = oldText.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  if (lf !== crlf) {
    const alternate = oldText === crlf ? lf : crlf;
    const otherStart = match(alternate);
    // A mixed file can hold identical fragments in both newline styles.
    if (before.includes(oldText) && before.includes(alternate)) start = -1;
    else if (start < 0 && otherStart >= 0 && !before.includes(oldText)) {
      start = otherStart;
      oldText = alternate;
      text = newText.replace(/\r\n/g, '\n');
      if (alternate === crlf) text = text.replace(/\n/g, '\r\n');
    }
  }
  if (start < 0) throw patchConflict('old_text must match exactly once: ' + filePath + '.', before, oldText);
  return { start, end: start + oldText.length, text };
}

async function applyPatchset({path:defaultPath,changes,verify}, host) {
  const { root, signal } = host;
  if (host.mode === 'plan') throw Error('Plan mode is read-only.');
  if (!host.applyPatchset) throw Error('Multi-file editing is unavailable in this host.');
  if (verify) {
    if (!host.verifyPatchset) throw Error('Inline patch verification must be requested by the main agent.');
    try {
      await host.preparePatchVerification(verify);
    } catch (error) {
      check(signal);
      throw Error('Patch not written. Keep the same changes and fix only the verify fields. ' + error.message);
    }
  }
  const targets = new Map();
  for (const change of changes) {
    const filePath=change.path??defaultPath;
    if(!filePath)throw Error('Set path on the patchset or on each fragment. No files were changed.');
    const file = await workspacePath(root, filePath);
    const parent = await fs.realpath(path.dirname(file));
    if (parent !== path.dirname(file) || /(^|[\\/])\.git([\\/]|$)/i.test(path.relative(root,file))) {
      throw Error('Patch paths must use real workspace directories outside Git metadata.');
    }
    const stat = await fs.lstat(file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('Patch paths must be regular files.');
    const target = targets.get(file) || { file, path:filePath, fragments:[] };
    target.fragments.push(change);
    targets.set(file,target);
  }
  const paths = [...targets.keys()].sort();
  const lock = (index, action) => index === paths.length
    ? action() : withFileLock(paths[index], () => lock(index + 1, action));
  let contracts;
  const updated = await lock(0, async () => {
    const prepared = [];
    for (const target of targets.values()) {
      check(signal);
      await host.checkProjectRules?.(target.path);
      await host.checkDirty(target.file);
      const before = await textFile(target.file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      const existed = before !== undefined;
      let after;
      if (!existed) {
        const [fragment] = target.fragments;
        if (target.fragments.length!==1 || !fragment.create || fragment.old_text!==undefined) {
          throw Error('Use one create:true entry without old_text for a new file: ' + target.path);
        }
        after=fragment.new_text;
      } else {
        const ranges=target.fragments.map(fragment=>{
          if(fragment.create||!fragment.old_text)throw Error('Provide old_text for an existing file: '+target.path);
          return patchRange(before,fragment.old_text,fragment.new_text,target.path);
        }).sort((a,b)=>a.start-b.start);
        if(ranges.some((range,index)=>index>0&&ranges[index-1].end>range.start)) {
          throw Error('Patch fragments overlap in the original file: '+target.path);
        }
        after=before;
        for(const range of ranges.reverse())after=after.slice(0,range.start)+range.text+after.slice(range.end);
      }
      if (Buffer.byteLength(after) > 1024*1024) throw Error('New contents exceed 1 MiB: ' + target.path);
      if (after !== before) prepared.push({file:target.file,path:target.path,before:before ?? '',after,existed});
    }
    for (const change of prepared) {
      if (host.mode === 'acceptEdits') continue;
      check(signal);
      const decision = await host.approveEdit(change.file,change.before,change.after);
      if (!decision) return host.denialReason?.() || 'Patchset rejected. No files were changed.';
      if (typeof decision.replacement === 'string') {
        change.after = decision.replacement;
        if(change.before===change.after)change.skipped=true;
      }
    }
    const selected = prepared.filter(change => !change.skipped);
    if (!selected.length) return [];
    for (const change of selected) {
      check(signal);
      if (await workspacePath(root,change.path) !== change.file || await fs.realpath(path.dirname(change.file)) !== path.dirname(change.file)) {
        throw Error('File path changed while reviewing: ' + change.path);
      }
      await host.checkDirty(change.file);
      const stat = await fs.lstat(change.file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      const current = stat?.isFile() ? await textFile(change.file) : undefined;
      if (stat ? !stat.isFile() || !change.existed || current !== change.before : change.existed) {
        const fragment = targets.get(change.file).fragments[0];
        throw patchConflict('File changed while reviewing: ' + change.path + '.', current,
          fragment.old_text || '', Math.max(0,change.before.indexOf(fragment.old_text || '')));
      }
    }
    contracts = await host.checkContracts?.(selected, host.approveContractCheck);
    check(signal);
    await host.applyPatchset(selected);
    return selected.map(change=>change.path);
  });
  if (!Array.isArray(updated)) return updated;
  if (verify) {
    check(signal);
    const verification=await host.verifyPatchset(verify);
    return JSON.stringify({updated,contracts,verification:JSON.parse(verification)});
  }
  return updated.length ? JSON.stringify({updated,contracts,next:'Run verify_revision with the relevant behavior checks.'}) : 'No changes needed.';
}

async function loadFileRange(args, host, loaded = new Map()) {
  const { root, signal } = host;
  check(signal);
  const file = await (host.mode === 'auto' && !host.isolated ? autoPath : workspacePath)(root, args.path);
  if(host.isolated&&path.relative(root,await fs.realpath(file))==='.git')throw Error('Git metadata is outside the agent assignment.');
  if (!loaded.has(file)) {
    loaded.set(file, textFile(file).then(text => ({
      lines: text.split('\n'),
      revision: createHash('sha256').update(text).digest('hex').slice(0, 16)
    })));
  }
  const { lines, revision } = await loaded.get(file);
  const start = Math.max(1, Number(args.start_line) || 1);
  const end = Math.min(lines.length, Number(args.end_line) || start + 399);
  const offset=Math.max(0,args.character_offset||0);
  if(start>lines.length || end<start || offset>lines[start-1].length)throw new Error('File range is outside the file');
  const realRoot = await fs.realpath(root);
  const name=inside(realRoot,file)?path.relative(realRoot,file):file;
  const knownLines=!args.reread&&!offset ? host.sourceLines?.get(sourceRevisionKey(name,revision)) : undefined;
  return { lines, revision, path:name, start, end, offset, knownLines };
}

function renderFileRange({ lines, revision, path, start, end, offset, knownLines }, contentLimit) {
  let content='',line=start,character=offset;
  const previouslyRead=[];
  while(line<=end){
    if(knownLines?.has(line)){
      const last=previouslyRead.at(-1);
      if(last?.[1]===line-1)last[1]=line;
      else previouslyRead.push([line,line]);
      line++;
      continue;
    }
    const prefix=`${line}${character?`+${character}`:''}: `,room=contentLimit-content.length-prefix.length-1;
    if(room<=0)break;
    let part=lines[line-1].slice(character,character+room);
    if(part.length && /[\uD800-\uDBFF]/.test(part.at(-1)))part=part.slice(0,-1);
    content+=prefix+part+'\n';character+=part.length;
    if(character<lines[line-1].length)break;
    line++;character=0;
  }
  const next=line<=lines.length?{start_line:line,character_offset:character}:null;
  return {path,revision,totalLines:lines.length,startLine:start,startCharacter:offset,endLine:character?line:line-1,content,
    ...(previouslyRead.length?{previouslyRead}:{}),complete:start===1&&offset===0&&next===null&&!previouslyRead.length,truncated:next!==null,next};
}

async function executeTool(name, args, host) {
  const { root, signal } = host;
  if (!root) throw new Error('Open a workspace folder first');
  check(signal);
  if (!args || typeof args !== 'object') throw new Error('Invalid tool arguments');
  if(host.searchEvidence && ['search_files','search_batch'].includes(name)){
    const {searchEvidence,...uncached}=host;
    return searchEvidence.run(name,args,[root,host.mode,!!host.isolated],()=>executeTool(name,args,uncached));
  }
  const directory = ['list_files', 'search_files'].includes(name) && args.directory
    ? await fs.realpath(await (host.mode === 'auto' && !host.isolated ? autoPath : workspacePath)(root, args.directory)) : root;
  const external = directory !== root && !inside(await fs.realpath(root), directory);
  const relativeBase = directory === root && args.path !== undefined ? await fs.realpath(root) : root;
  const formatPath = file => directory === root ? path.relative(relativeBase, file) : file;
  if (name === 'list_files') {
    const candidates = await host.findFiles(args.glob || '**/*', directory);
    const files = candidates.filter(file => inside(directory, file) && (!external || !protectedPath(file)));
    const offset = Math.max(0, args.offset || 0), limit = Math.max(1, Math.min(1000, args.limit || 200));
    return JSON.stringify({ files: files.slice(offset, offset + limit).map(formatPath), nextOffset: offset + limit < files.length ? offset + limit : null, scopeTruncated: candidates.length >= 20000 });
  }
  if (name === 'read_files') {
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 8) {
      throw new Error('Read 1–8 files');
    }
    const loaded = host.readBatch || new Map();
    const ranges = await Promise.all(args.files.map(async item => {
      try {
        return await loadFileRange(item, host, loaded);
      } catch (error) {
        check(signal);
        return { path: item?.path, error: String(error.message || error) };
      }
    }));
    check(signal);
    const previews = ranges.map(range => range.error ? range : renderFileRange(range, 8000));
    // Short ranges and failed reads return their unused share to larger ranges.
    const sizes = previews.filter(result => !result.error).map(result => result.content.length).sort((a, b) => a - b);
    let remaining = 8000;
    let share = 8000;
    for (const [index, size] of sizes.entries()) {
      share = Math.floor(remaining / (sizes.length - index));
      if (size >= share) break;
      remaining -= size;
    }
    const files = previews.map((result, index) => result.error || result.content.length <= share
      ? result
      : renderFileRange(ranges[index], share));
    return JSON.stringify({ files });
  }
  if (name === 'search_batch') {
    if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 4) {
      throw new Error('Search batch requires 1–4 queries');
    }
    const scopes = new Map();
    const findFiles = host.findFiles && ((glob, directory) => {
      const key = JSON.stringify([directory, glob]);
      if (!scopes.has(key)) scopes.set(key, host.findFiles(glob, directory));
      return scopes.get(key);
    });
    const readHost = { ...host, findFiles, readBatch: host.readBatch || new Map() };
    if (host.searchFiles && findFiles) readHost.searchFiles = async (query, directory, files) =>
      host.searchFiles(query,directory,files ?? await findFiles(query.glob||'**/*',directory));
    const results = await Promise.all(args.queries.map(async query => {
      try {
        const output = await executeTool('search_files', {
          ...query, limit: Math.min(12, query.limit ?? 8), maxCharacters: 2200
        }, readHost);
        const result = JSON.parse(output);
        const locations = result.matches.slice(0, 2).map(match => /^(.+?):(\d+): /.exec(match)).filter(Boolean);
        const excerpts = locations.length ? await executeTool('read_files', {files:locations.map(([, name, line])=>({
          path:name, start_line:Math.max(1, Number(line)-2), end_line:Number(line)+2
        }))}, readHost).then(data=>JSON.parse(data).files) : [];
        return {...result, excerpts:excerpts.filter(excerpt=>!excerpt.error).map(({path,revision,startLine,content,next,previouslyRead})=>({
          path,revision,startLine,content:content.slice(0,800),...(next?.character_offset?{next}:{}),...(previouslyRead?{previouslyRead}:{})
        }))};
      } catch (error) {
        check(signal);
        return { error: String(error.message || error).slice(0, 500) };
      }
    }));
    check(signal);
    return JSON.stringify({ results });
  }
  if (name === 'search_files') {
    if (typeof args.query !== 'string' || !args.query) throw new Error('Search text is empty');
    let exactFiles;
    if (args.path !== undefined) {
      if (args.directory || args.glob) throw Error('Choose path for one file, or directory/glob for a wider search.');
      exactFiles = [await workspacePath(root,args.path)];
    }
    if (host.searchFiles) return host.searchFiles({ ...args, absolutePaths: directory !== root, excludeProtected: external }, directory, exactFiles);
    const limit = Math.max(1, Math.min(500, args.limit || 100));
    const offset = Math.max(0, args.offset || 0);
    const budget = args.maxCharacters ?? 10000;
    const files = exactFiles ?? await host.findFiles(args.glob || '**/*', directory);
    const needle = args.case_sensitive === false ? args.query.toLowerCase() : args.query;
    if (args.regex || args.context) throw new Error('Regex and surrounding context require the native search engine');
    const matches = [];
    let seen = 0;
    let characters = 0;
    for (const file of files) {
      check(signal);
      let lines;
      try {
        const resolved = await fs.realpath(await workspacePath(directory, file));
        if (external && protectedPath(resolved)) continue;
        lines = (await textFile(file)).split('\n');
      } catch {
        check(signal);
        continue;
      }
      for (const [index, line] of lines.entries()) {
        const candidate = args.case_sensitive === false ? line.toLowerCase() : line;
        if (!candidate.includes(needle)) continue;
        if (seen++ < offset) continue;
        const match = `${formatPath(file)}:${index + 1}: ${line.slice(0, 500)}`;
        const cost = JSON.stringify(match).length + 1;
        if (matches.length >= limit || (matches.length && characters + cost > budget)) {
          return JSON.stringify({ matches, offset, nextOffset: offset + matches.length, truncated: true, scopeTruncated: files.length >= 20000 });
        }
        matches.push(match);
        characters += cost;
      }
    }
    return JSON.stringify({ matches, offset, nextOffset: null, truncated: false, scopeTruncated: files.length >= 20000 });
  }
  if (name === 'read_file') return JSON.stringify(renderFileRange(await loadFileRange(args, host, host.readBatch), 8000));
  if (name === 'apply_patchset') return applyPatchset(args, host);
  if (name === 'write_file' || name === 'edit_file') {
    if (host.mode === 'plan') throw new Error('Plan mode is read-only. Ask the user to switch to Manual or Accept edits.');
    const resolve = host.mode === 'auto' && !host.isolated ? autoPath : workspacePath;
    const file = await resolve(root, args.path);
    if(host.isolated&&(path.relative(root,file)==='.git'||path.relative(root,await fs.realpath(file).catch(()=>file))==='.git'))throw Error('Git metadata cannot be edited.');
    return withFileLock(file, async () => {
    check(signal);
    await host.checkProjectRules?.(args.path);
    await host.checkDirty(file);
    let before = '', existed = true;
    try { before = await textFile(file); } catch (e) { if (e.code !== 'ENOENT') throw e; existed = false; }
    let after = args.content;
    if (name === 'edit_file') {
      if (!existed || typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string') throw new Error('edit_file requires an existing file, nonempty old_text and new_text');
      const range = patchRange(before,args.old_text,args.new_text,args.path);
      after = before.slice(0, range.start) + range.text + before.slice(range.end);
    }
    if (typeof after !== 'string' || Buffer.byteLength(after) > 1024 * 1024) throw new Error('New file content must be text under 1 MB');
    if (before === after) return 'No changes needed.';
    if (name === 'edit_file' && host.checkScopedSyntax && /\.c?js$/i.test(file) &&
        before.length <= 8192 && after.length <= 8192 && /\b(?:module\.exports|exports\.)/.test(before) &&
        /\b(?:module\.exports|exports\.)/.test(after)) {
      const wrapper = text => '(function(exports, require, module, __filename, __dirname) {\n'+text+'\n})';
      let commonJs = true;
      try { new Script(wrapper(before)); } catch { commonJs = false; }
      if (commonJs) {
        try { new Script(wrapper(after)); } catch (error) {
          if (!/Cannot use import statement|Unexpected token ['\"<]*(?:export|<)/.test(error.message)) {
            throw Error('The proposed JavaScript does not parse: '+error.message+'. No files were changed. Check the structure of the replacement against the source.');
          }
        }
      }
    }
    if (host.mode !== 'acceptEdits') {
      const decision = await host.approveEdit(file, before, after);
      if (!decision) return host.denialReason?.() || 'User rejected this edit. Do not repeat it without a new instruction.';
      if (typeof decision.replacement === 'string') {
        after = decision.replacement;
        if (before === after) return 'The selected changes leave the file unchanged.';
      }
    }
    check(signal);
    if (await resolve(root, args.path) !== file) throw Error('File path changed while preparing the edit. Read and retry.');
    await host.checkDirty(file);
    let current;
    try { current = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if ((existed && current !== before) || (!existed && current !== undefined)) {
      throw patchConflict('File changed while reviewing: ' + args.path + '.', current,
        args.old_text || '', args.old_text ? Math.max(0,before.indexOf(args.old_text)) : undefined);
    }
    const contracts = await host.checkContracts?.([{file, before, after, existed}], host.approveContractCheck);
    check(signal);
    await host.applyEdit(file, after, existed, before);
    host.onEdit?.({ file, before, after, existed });
    return `Updated ${args.path}` + (contracts ? '. Contract checks passed: ' + contracts.passed.join(', ') : '');
    });
  }
  if (name === 'run_command') {
    if (host.mode === 'plan') throw new Error('Plan mode does not run shell commands. Use read/search tools.');
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000) throw new Error('Invalid command');
    const approval = await host.approveCommand(args.command);
    if (!approval || approval.allow === false) return host.denialReason?.() || 'User rejected the command. Do not retry without a new instruction.';
    check(signal);
    const finish = await host.trackCommand?.(approval.execution?.cwd || root);
    try {
      return await runCommand(args.command, root, Math.max(1, Math.min(120, args.timeout_seconds || 60)), signal, host.onOutput, approval.execution);
    } finally {
      await finish?.();
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}
module.exports = { tools, executeTool, workspacePath, autoPath, protectedPath, inside, textFile, runCommand };
