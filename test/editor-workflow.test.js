'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {editHunks,applyHunks}=require('../src/edit-review');
const {createAgentWorktree}=require('../src/agent-worktree');
const {ProjectMemory}=require('../src/project-memory');
const {configuredHooks}=require('../src/project-config');

test('hunk approval preserves unselected changes, CRLF, and an unterminated line',()=>{
  const before='first\r\nstable\r\nlast';
  const after='replacement\r\nstable\r\nnew last\r\n';
  const hunks=editHunks(before,after);
  assert.equal(hunks.length,2);
  assert.equal(applyHunks(before,hunks,[0]),'replacement\r\nstable\r\nlast');
  assert.equal(applyHunks(before,hunks,[1]),'first\r\nstable\r\nnew last\r\n');
  assert.equal(applyHunks(before,hunks,[0,1]),after);
});

test('isolated agent edits a detached checkout without modifying the main workspace',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'harness-worktree-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'repo');
  await fs.mkdir(root);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-q');
  await fs.writeFile(path.join(root,'example.txt'),'base');
  git('add','example.txt');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base');
  const worktree=await createAgentWorktree(root,path.join(directory,'agent-worktrees'),'agent1');
  assert.equal(await fs.readFile(path.join(worktree.directory,'example.txt'),'utf8'),'base');
  await fs.writeFile(path.join(worktree.directory,'example.txt'),'isolated edit');
  assert.equal(await fs.readFile(path.join(root,'example.txt'),'utf8'),'base');
  assert.match(git('worktree','list','--porcelain'),/detached/);
});

test('role memory remains separate from shared project memory',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-role-memory-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const memory=new ProjectMemory(path.join(root,'memory'));
  await memory.update(root,{action:'save',key:'known',note:'Project fact'});
  await memory.update(root,{action:'save',key:'known',note:'Reviewer fact'},'review');
  assert.deepEqual(await memory.list(root),[{key:'known',note:'Project fact'}]);
  assert.deepEqual(await memory.list(root,'review'),[{key:'known',note:'Reviewer fact'}]);
  assert.deepEqual(await memory.list(root,'explore'),[]);
});

test('scoped settings validate hooks against the project hook schema',()=>{
  const hooks=[{event:'afterToolError',command:'pwd',tool:'read_file'}];
  assert.equal(configuredHooks(hooks),hooks);
  assert.throws(()=>configuredHooks([{event:'invalid',command:'pwd'}]));
});

test('range attachments are bounded to the project and a checkpoint forks the prior conversation',async t=>{
  const {createHost}=require('../scripts/runtime-host');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'harness-checkpoint-'));
  const host=await createHost({root:directory,storage:path.join(directory,'storage')});
  t.after(async()=>{await host.close();await fs.rm(directory,{recursive:true,force:true});});
  await fs.writeFile(path.join(directory,'a b.js'),'ignore\ninclude\nignore');
  await fs.writeFile(path.join(directory,'.env'),'sensitive');
  const references=await host.app.messageReferences(directory,'Read @"a b.js"#2 @.env#1 @../outside.js#1',[]);
  assert.equal(references.length,1);
  const {suffix}=await host.app.prepareAttachments(directory,references);
  assert.match(suffix,/a b\.js:2-2\):\ninclude/);
  assert(!suffix.includes('ignore'));
  const session=host.session;
  session.messages=[{role:'user',content:'First question'},{role:'assistant',content:'First answer'},{role:'user',content:'Next question'}];
  session.timeline=[{id:'first',role:'user',text:'First question'},{id:'second',role:'user',checkpoint:{timeline:1,messages:2}}];
  host.app.openTab=id=>host.app.sessionOf(id);
  const copy=await host.app.forkCheckpoint(session,'second');
  assert.notEqual(copy.id,session.id);
  assert.deepEqual(copy.messages,session.messages.slice(0,2));
  assert(session.timeline.some(item=>item.id==='second'));
});
