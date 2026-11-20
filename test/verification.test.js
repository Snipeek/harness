'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{checkCategory,recordCheck,hasCurrentCheck}=require('../src/verification');
test('test receipts remove duplicate verification while later edits and failures invalidate them',()=>{
 const s={taskId:'task',turnId:'turn',turnChanges:['main.js'],changeLog:[{path:'main.js'}]};
 assert.equal(checkCategory('node test.js'),'project-check');assert.equal(checkCategory('echo "npm test"'),null);assert.equal(checkCategory('npm test; echo done'),null);assert.equal(checkCategory('npm test || true'),null);
 recordCheck(s,{command:'node test.js',output:'Exit code: 0\npassed',category:checkCategory('node test.js')});assert.equal(hasCurrentCheck(s),true);assert.equal(s.checks[0].acceptance,'not_independently_evaluated');
 s.changeLog.push({path:'main.js'});assert.equal(hasCurrentCheck(s),false);recordCheck(s,{command:'node test.js',output:'Exit code: 1\nfailed',category:'project-check'});assert.equal(hasCurrentCheck(s),false);
 recordCheck(s,{command:'node --check main.js',output:'Exit code: 0\n',category:'syntax'});assert.equal(hasCurrentCheck(s),false);
 recordCheck(s,{command:'node test.js',output:'Exit code: 0\npassed',category:'project-check'});assert.equal(hasCurrentCheck(s),true);recordCheck(s,{command:'node test.js',output:'Exit code: 1\nfailed',category:'project-check'});assert.equal(hasCurrentCheck(s),false);
 s.turnId='other';assert.equal(hasCurrentCheck(s),false);
});

test('completion requires current behavioral evidence for each planned criterion', () => {
 const { completionGaps } = require('../src/verification');
 const criterion = 'Restores interrupted work';
 const session = {
  taskId: 'task', turnId: 'turn', turnChanges: ['main.js'], changeLog: [{ taskId: 'task' }],
  plan: { steps: [{ title: 'Verify reload', status: 'running' }], acceptance: [criterion] }
 };
 const pass = { output: 'Exit code: 0\n' };
 recordCheck(session, { ...pass, command: 'npm run build', category: checkCategory('npm run build'), criteria: [criterion] });
 assert.equal(completionGaps(session).length, 3);
 session.plan.steps[0].status = 'done';
 const receipt = recordCheck(session, { ...pass, command: 'npm test', category: 'project-check', fingerprints: {'main.js':'original'} });
 assert.deepEqual(completionGaps(session), ['Unverified acceptance criterion: ' + criterion]);
 const { linkCheck } = require('../src/verification');
 assert.throws(() => linkCheck(session, {id:receipt.id, criteria:[criterion]}), /coverage/);
 const count = session.checks.length;
 linkCheck(session, {id:receipt.id, criteria:[criterion], coverage:'Integration fixture interrupted the task and verified its saved state after reload.'});
 assert.equal(session.checks.length, count);
 assert.deepEqual(completionGaps(session), []);
 session.turnId = 'follow-up';
 session.turnChanges = [];
 assert.deepEqual(completionGaps(session), []);
 session.changeLog.push({ taskId: 'task' });
 assert.throws(() => linkCheck(session, {id:receipt.id, criteria:[criterion], coverage:'Old run'}), /current/);
 recordCheck(session, { ...pass, command: 'npm test', category: 'project-check', criteria: [criterion], changeRevision: 1 });
 assert.equal(completionGaps(session).length, 2);
});

test('a passing syntax receipt closes a command-only criterion without certifying behavior',()=>{
 const {completionGaps}=require('../src/verification');
 const s={taskId:'task',turnId:'turn',turnChanges:['main.js'],plan:{acceptance:['`node --check main.js` passes','loads old data']}};
 recordCheck(s,{command:'node --check main.js',output:'Exit code: 0\n',category:'syntax'});
 const gaps=completionGaps(s);
 assert(gaps.includes('Unverified acceptance criterion: loads old data'));
 assert(gaps.some(gap=>gap.includes('behavioral check')));
 assert(gaps.every(gap=>!gap.includes('node --check')));
});

test('a staged contract requires a passing receipt on the saved revision',()=>{
 const {completionGaps}=require('../src/verification');
 const s={taskId:'task',turnId:'turn',turnChanges:['main.js'],changeLog:[{taskId:'task'}],
  prewriteChecks:{taskId:'task',scripts:['test.mjs']},regressionAudit:{taskId:'task',revision:1,status:'no_tests'}};
 assert.deepEqual(completionGaps(s),['Verify the saved revision with verify_revision: node test.mjs']);
 recordCheck(s,{command:'node test.mjs',output:'Exit code: 0\n',changeRevision:0});
 assert.match(completionGaps(s).join(),/saved revision/);
 recordCheck(s,{command:'node test.mjs',output:'Exit code: 0\n'});
 assert.deepEqual(completionGaps(s),[]);
});

test('criterion IDs survive receipt annotations while changed requirements need fresh coverage',()=>{
 const {completionGaps,planCriteria,resolveCriteria}=require('../src/verification');
 const behavior='The late peer is closed';
 const command='node --check main.js passes';
 const session={taskId:'task',turnId:'turn',turnChanges:['main.js'],plan:{acceptance:[behavior,command]}};
 const [{id}]=planCriteria(session.plan);
 recordCheck(session,{criteria:[id],command:'node test.js',category:'project-check',output:'Exit code: 0\n'});
 recordCheck(session,{command:'node --check main.js',category:'syntax',output:'Exit code: 0\n'});
 session.plan.acceptance=[behavior+' (verified: receipt 2c496701)',command+' (verified: receipt f48b9336)'];
 assert.deepEqual(resolveCriteria(session.plan,[behavior,id]),[id]);
 assert.deepEqual(completionGaps(session),[]);
 session.plan.acceptance[0]='The late peer is closed exactly once';
 assert.throws(()=>resolveCriteria(session.plan,[id]),/Unknown acceptance criterion/);
 assert.deepEqual(completionGaps(session),['Unverified acceptance criterion: The late peer is closed exactly once']);
});

test('an unanswered user decision only gates its dependent task',()=>{
 const {completionGaps}=require('../src/verification');
 const decision={id:'decision',taskId:'task',status:'skipped',step:'Configure deployment',question:'Which mode?'};
 const session={taskId:'task',mode:'plan',decisions:[decision]};
 assert.deepEqual(completionGaps(session),['Awaiting user decision for Configure deployment: Which mode?']);
 session.taskId='other';
 assert.deepEqual(completionGaps(session),[]);
 session.taskId='task';
 decision.status='answered';
 assert.deepEqual(completionGaps(session),[]);
});

test('a requested Node check must pass even when automatic diff replay has no related tests', () => {
 const {completionGaps}=require('../src/verification');
 const session={taskId:'task',turnId:'turn',mode:'manual',initialGoal:'Fix the outcome. Запусти node check.cjs. Не меняй проверки.',turnChanges:['chat/story.js'],changeLog:[],regressionAudit:{taskId:'task',revision:0,status:'no_tests'}};
 assert.match(completionGaps(session).join('\n'),/Run the requested check.*node check.cjs/);
 assert.deepEqual(completionGaps({...session,initialGoal:'Fix the outcome. Do not run node check.cjs.'}),[]);
 recordCheck(session,{command:'node check.cjs',output:'Exit code: 1\nAssertionError: duplicate event id',category:checkCategory('node check.cjs')});
 assert.match(completionGaps(session).join('\n'),/Required check failed[\s\S]*duplicate event id/);
 recordCheck(session,{command:'node check.cjs',output:'Exit code: 0\npassed',category:checkCategory('node check.cjs')});
 assert.deepEqual(completionGaps(session),[]);
});
