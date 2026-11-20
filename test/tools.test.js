'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { executeTool, workspacePath, runCommand } = require('../src/tools');
const { visibleSourceLines } = require('../src/research-coverage');
const { relatedTestEvidence, mentionedCodePaths } = require('../src/related-tests');
const { SessionStore } = require('../src/store');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-ai-test-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree');
  return { root, mode: 'manual', signal: new AbortController().signal, checkDirty: async () => {}, approveEdit: async () => true, approveCommand: async () => false, applyEdit: async (file, after) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, after); } };
}
test('file reads reject traversal, outside symlinks and dangling symlinks', async t => {
  const host = await fixture(t);
  await assert.rejects(workspacePath(host.root, '../secret'), /outside/);
  await fs.symlink(os.tmpdir(), path.join(host.root, 'escape'));
  await assert.rejects(workspacePath(host.root, 'escape/something'), /outside/);
  await fs.symlink(path.join(host.root, 'missing'), path.join(host.root, 'dangling'));
  await assert.rejects(workspacePath(host.root, 'dangling'), /Dangling/);
  const read=JSON.parse(await executeTool('read_file', { path: 'a.txt', start_line: 2, end_line: 2 }, host));assert.equal(read.content,'2: two\n');assert.equal(read.complete,false);assert.deepEqual(read.next,{start_line:3,character_offset:0});
});
test('test discovery prioritizes assertions tied to the source and respects the read budget', async t => {
  const host=await fixture(t);
  const file='train/audit_store_test.mjs';
  await fs.mkdir(path.join(host.root,'train'));
  const lines=[
    "const { recordAudit } = await import('../src/exec/audit_store.mjs');",
    ...Array.from({length:72},()=> 'assert.equal(unrelated(), true);'),
    'recordAudit(entry);',
    'assert.equal(recordAudit(secondEntry), false);',
  ];
  const filename=path.join(await fs.realpath(host.root),file);
  await fs.writeFile(filename,lines.join('\n'));
  const paths=mentionedCodePaths('Change src/exec/{audit,audit_store}.mjs');
  assert.deepEqual(paths,['src/exec/audit.mjs','src/exec/audit_store.mjs']);
  const ranges=await relatedTestEvidence(host.root,paths,[],{
    signal:host.signal,findFiles:async glob=>{assert.match(glob,/audit_store_test/);return [filename];}
  });
  assert.equal(ranges.length,1);
  assert.equal(ranges[0].path,file);
  assert.match(ranges[0].content,/75: assert.equal\(recordAudit/);
  assert.ok(ranges[0].content.length<4400);
  assert.doesNotMatch(ranges[0].content,/^1: /m);
});

test('follow-up ranges omit exact visible rows, including opening test evidence, until the file changes', async t => {
  const host=await fixture(t);
  const raw=await executeTool('read_file',{path:'a.txt',start_line:1,end_line:2},host);
  const range=JSON.parse(raw);
  const partial={...range,content:'2: tw\n',next:{start_line:2,character_offset:2}};
  host.sourceLines=visibleSourceLines([{role:'tool',content:JSON.stringify(partial)}],
    [{...range,content:'1: one\n'}]);
  const args={path:'a.txt',start_line:1,end_line:3};
  const read=async request=>JSON.parse(await executeTool('read_files',{files:[request]},host)).files[0];
  const delta=await read(args);
  assert.equal(delta.content,'2: two\n3: three\n');
  assert.deepEqual(delta.previouslyRead,[[1,1]]);
  assert.equal(delta.complete,false);
  assert.equal((await read({...args,reread:true})).content,'1: one\n2: two\n3: three\n');
  await fs.writeFile(path.join(host.root,'a.txt'),'changed\ntwo\nthree');
  assert.equal((await read(args)).content,'1: changed\n2: two\n3: three\n');
});
test('denied edit and plan mode never mutate files', async t => {
  const host = await fixture(t); host.approveEdit = async () => false;
  assert.match(await executeTool('write_file', { path: 'a.txt', content: 'modified' }, host), /rejected/);
  assert.equal(await fs.readFile(path.join(host.root, 'a.txt'), 'utf8'), 'one\ntwo\nthree');
  host.mode = 'plan';
  await assert.rejects(executeTool('write_file', { path: 'a.txt', content: 'modified' }, host), /read-only/);
  await assert.rejects(executeTool('run_command', { command: 'echo oops' }, host), /Plan mode/);
});
test('edit detects changed content while awaiting review', async t => {
  const host = await fixture(t);
  host.approveEdit = async () => { await fs.writeFile(path.join(host.root, 'a.txt'), 'user edit'); return true; };
  await assert.rejects(executeTool('edit_file', { path: 'a.txt', old_text: 'two', new_text: '2' }, host), /changed while reviewing/);
  assert.equal(await fs.readFile(path.join(host.root, 'a.txt'), 'utf8'), 'user edit');
});
test('unique replacement only, accept-edits changes file and reports undo snapshot', async t => {
  const host = await fixture(t); host.mode = 'acceptEdits';
  host.approveEdit = async () => { throw new Error('should not request approval'); };
  let snapshot; host.onEdit = change => snapshot = change;
  await executeTool('edit_file', { path: 'a.txt', old_text: 'two', new_text: '2' }, host);
  assert.equal(await fs.readFile(path.join(host.root, 'a.txt'), 'utf8'), 'one\n2\nthree');
  assert.equal(snapshot.before, 'one\ntwo\nthree'); assert.equal(snapshot.existed, true);
  await fs.writeFile(path.join(host.root, 'a.txt'), 'same same');
  await assert.rejects(executeTool('edit_file', { path: 'a.txt', old_text: 'same', new_text: 'x' }, host), /exactly once/);
});
test('denied commands do not execute; approved commands return exit code', async t => {
  const host = await fixture(t);
  assert.match(await executeTool('run_command', { command: 'touch forbidden' }, host), /rejected/);
  await assert.rejects(fs.access(path.join(host.root, 'forbidden')));
  host.approveCommand = async () => true;
  assert.match(await executeTool('run_command', { command: 'echo hello; exit 3' }, host), /Exit code: 3\nhello/);
});
test('batch search can locate symbols in individual workspace files', async t => {
  const host=await fixture(t);
  await fs.writeFile(path.join(host.root,'b.txt'),'two');
  host.findFiles=async()=>assert.fail('exact-file search must skip enumeration');
  const {results}=JSON.parse(await executeTool('search_batch',{queries:[
    {path:'a.txt',query:'two'},{path:'b.txt',query:'two'},{path:'../outside.txt',query:'two'}
  ]},host));
  assert.deepEqual(results.slice(0,2).map(r=>r.matches),[['a.txt:2: two'],['b.txt:1: two']]);
  assert.match(results[2].error,/outside/);
});
test('patch recovery preserves CRLF and returns current anchors for an actual conflict', async t => {
  const host = await fixture(t);
  const file = path.join(host.root, 'a.txt');
  await fs.writeFile(file, 'function work() {\r\n  return 1;\r\n}\r\n');
  await executeTool('edit_file', {
    path:'a.txt', old_text:'function work() {\n  return 1;', new_text:'function work() {\n  return 2;'
  }, host);
  assert.equal(await fs.readFile(file, 'utf8'), 'function work() {\r\n  return 2;\r\n}\r\n');
  await assert.rejects(executeTool('edit_file', {
    path:'a.txt', old_text:'function work() {\n  return 1;', new_text:'function work() {\n  return 3;'
  }, host), /Rebuild only the conflicted fragment[\s\S]*2: {3}return 2/);
  assert.match(await fs.readFile(file, 'utf8'), /return 2/);
});
test('stopping a command returns promptly', async t => {
  const host = await fixture(t); const controller = new AbortController();
  const result = runCommand('sleep 20', host.root, 30, controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.match(await result, /Cancelled/);
});
test('session store serializes writes and restores durable history', async t => {
  const host = await fixture(t); const store = new SessionStore(path.join(host.root, 'sessions'));
  const session = { id: 'aabb-0011', title: 'First', updated: 1, messages: [{role:'user',content:'Hello'}], timeline: [] };
  const first = store.save(session); session.title = 'Second'; const second = store.save(session);
  await Promise.all([first, second]);
  assert.equal((await store.load())[0].title, 'Second');
  await store.remove(session.id); assert.equal((await store.load()).length, 0);
});

test('concurrent agents serialize edits to the same file rather than overwriting each other', async t => {
  const host = await fixture(t); host.mode = 'acceptEdits';
  host.applyEdit = async (file, after) => { await new Promise(r => setTimeout(r, 10)); await fs.writeFile(file, after); };
  await Promise.all([
    executeTool('edit_file', { path: 'a.txt', old_text: 'one', new_text: '1' }, host),
    executeTool('edit_file', { path: 'a.txt', old_text: 'two', new_text: '2' }, host)
  ]);
  assert.equal(await fs.readFile(path.join(host.root, 'a.txt'), 'utf8'), '1\n2\nthree');
});

test('file coverage cursors reconstruct long Unicode lines without losing text',async t=>{const host=await fixture(t);const original='длинная строка 🌍'.repeat(3000)+'\nпоследняя';await fs.writeFile(path.join(host.root,'large.txt'),original);let cursor={},parts=[],rounds=0;do{const page=JSON.parse(await executeTool('read_file',{path:'large.txt',...cursor},host));assert(page.content.length<=8000);parts.push(page.content.replace(/^\d+(?:\+\d+)?: /gm,'').replace(/\n/g,''));cursor=page.next;assert(++rounds<20);assert.equal(page.complete,false);}while(cursor);assert.equal(parts.join(''),original.replace('\n',''));});

test('batch reads preserve order, successful ranges and exact continuation when a sibling fails', async t => {
  const host = await fixture(t);
  await fs.writeFile(path.join(host.root, 'long.txt'), 'x'.repeat(8000));
  const { files } = JSON.parse(await executeTool('read_files', {
    files: [{ path: 'a.txt', start_line: 2, end_line: 2 }, { path: 'missing.txt' }, { path: 'long.txt' }]
  }, host));
  assert.deepEqual(files.map(file => file.path), ['a.txt', 'missing.txt', 'long.txt']);
  assert.equal(files[0].content, '2: two\n');
  assert.match(files[1].error, /ENOENT/);
  const cursor = files[2].next;
  assert.equal(cursor.start_line, 1);
  assert(cursor.character_offset > 7000, 'unused space from short and failed reads goes to the longer range');
  const continued = JSON.parse(await executeTool('read_files', {
    files: [{ path: 'long.txt', ...cursor }]
  }, host));
  assert.equal(continued.files[0].startCharacter, cursor.character_offset);
  assert.equal(continued.files[0].next, null);
  await assert.rejects(executeTool('read_files', { files: [] }, host), /1–8/);
});

test('batch search returns independent cursors and keeps successful sibling queries', async t => {
  const host = await fixture(t);
  await fs.writeFile(path.join(host.root, 'a.txt'), 'alpha\nbeta\nALPHA');
  host.findFiles = async () => [path.join(host.root, 'a.txt')];
  const queries = [
    { query: 'alpha', case_sensitive: false, limit: 1 },
    { query: 'beta' },
    { query: '' }
  ];
  const { results } = JSON.parse(await executeTool('search_batch', { queries }, host));
  assert.deepEqual(results[0].matches, ['a.txt:1: alpha']);
  assert.equal(results[0].nextOffset, 1);
  assert.deepEqual(results[1].matches, ['a.txt:2: beta']);
  assert.equal(results[1].nextOffset, null);
  assert.match(results[2].error, /empty/);
  const continuation = JSON.parse(await executeTool('search_batch', {
    queries: [{ ...queries[0], offset: results[0].nextOffset }]
  }, host));
  assert.deepEqual(continuation.results[0].matches, ['a.txt:3: ALPHA']);
});

test('batch search reads source once when different queries match the same file', async t => {
  const host = await fixture(t);
  const readFile = fs.readFile.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'readFile', async (...args) => {
    if (String(args[0]).endsWith('/a.txt')) reads++;
    return readFile(...args);
  });
  let enumerations=0;
  const file=path.join(await fs.realpath(host.root),'a.txt');
  host.findFiles=async()=>{enumerations++;return [file];};
  host.searchFiles = async ({query},_directory,candidates) => {
    assert.deepEqual(candidates,[file]);
    return JSON.stringify({
    matches: [query === 'one' ? 'a.txt:1: one' : 'a.txt:3: three'],
    nextOffset: null
    });
  };
  const queries = [{query:'one'}, {query:'three'}];
  const {results} = JSON.parse(await executeTool('search_batch', {queries}, host));
  assert.equal(reads, 1);
  assert.equal(enumerations, 1);
  assert.deepEqual(results.map(result => result.matches[0]), ['a.txt:1: one', 'a.txt:3: three']);
  assert(results.every(result => result.excerpts[0].content.includes('3: three')));
});

test('Auto batches targeted searches in an explicit sibling project and returns usable absolute excerpts', async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'harness-sibling-search-'));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'jusp'), sibling=path.join(parent,'harness');
 await Promise.all([fs.mkdir(root),fs.mkdir(sibling)]);
 const file=path.join(await fs.realpath(sibling),'extension.js');
 await fs.writeFile(file,'function activate() {}\nfunction dispatch() {}\n');
 const secret=path.join(sibling,'.env');
 await fs.writeFile(secret,'activate secret\n');
 const host={root,mode:'auto',findFiles:async(_glob,directory)=>{assert.equal(directory,await fs.realpath(sibling));return [file,secret];}};
 const payload={queries:[{query:'activate',directory:sibling},{query:'dispatch',directory:sibling}]};
 const {results}=JSON.parse(await executeTool('search_batch',payload,host));
 assert.deepEqual(results.map(item=>item.excerpts[0].path),[file,file]);
 assert.equal(results[0].matches.length,1);
 const blocked=JSON.parse(await executeTool('search_batch',payload,{...host,mode:'manual'}));
 assert.match(blocked.results[0].error,/outside the workspace/);
});

test('adjacent range reads share one file snapshot and a write starts a new window', async t => {
  const host = await fixture(t);
  const { schedule } = require('../src/engine');
  let reads = 0;
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (...args) => {
    if (String(args[0]).endsWith('/a.txt')) reads++;
    return readFile(...args);
  });
  const calls = [1, 2, null, 3].map(line => ({
    line, function: { name: line ? 'read_file' : 'write_file' }
  }));
  const results = await schedule(calls, async (call, readBatch) => {
    if (!call.line) return fs.writeFile(path.join(host.root, 'a.txt'), 'one\ntwo\nchanged');
    const args = {path:'a.txt',start_line:call.line,end_line:call.line};
    return JSON.parse(await executeTool('read_file', args, {...host,readBatch}));
  });
  assert.equal(reads, 2);
  assert.match(results[0].content, /1: one/);
  assert.match(results[1].content, /2: two/);
  assert.match(results[3].content, /3: changed/);
});

test('a small conflicted file returns complete text, including trailing newline', async t => {
 const host=await fixture(t);
 const current='exports.value = {num: 1, text: "'+'a'.repeat(150)+'"};\n';
 const pathName='conflict.js';
 await fs.writeFile(path.join(host.root,pathName),current);
 await assert.rejects(
   executeTool('edit_file',{path:pathName,old_text:'exports.value = 2;',new_text:'exports.value = 3;'},host),
   error=>error.message.includes('No files were changed')&&error.message.endsWith(JSON.stringify(current))
 );
 assert.equal(await fs.readFile(path.join(host.root,pathName),'utf8'),current);
});

test('scoped CommonJS syntax validation keeps an invalid edit off disk', async t => {
 const host=await fixture(t);
 host.checkScopedSyntax=true;
 const file=path.join(host.root,'main.js');
 const prior='exports.value = 1;\n';
 await fs.writeFile(file,prior);
 let approvals=0;
 host.approveEdit=async()=>{approvals++;return true;};
 await assert.rejects(executeTool('edit_file',{path:'main.js',old_text:'1;',new_text:'{;'},host),/JavaScript does not parse/);
 assert.equal(await fs.readFile(file,'utf8'),prior);
 assert.equal(approvals,0);
 await executeTool('edit_file',{path:'main.js',old_text:'1;',new_text:'2;'},host);
 assert.equal(await fs.readFile(file,'utf8'),'exports.value = 2;\n');
 assert.equal(approvals,1);
});
