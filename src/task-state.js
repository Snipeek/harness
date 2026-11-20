'use strict';
const {randomUUID}=require('node:crypto');
function recordUser(session,content){const record={id:randomUUID(),taskId:session.taskId,at:Date.now(),content};(session.userUpdates||=[]).push(record);return record;}
function activeDecisions(session) {
 return (session.decisions||[]).filter(item=>item.taskId===session.taskId);
}
function blockedDecisionSteps(session, titles) {
 return activeDecisions(session).filter(item=>item.status!=='answered'&&item.step&&(!titles||titles.includes(item.step)));
}
function taskState(session){
 const plan=session.plan;
 return {taskId:session.taskId,decisions:activeDecisions(session),completion:session.completion,callEvidence:session.callEvidence?.taskId===session.taskId?session.callEvidence.edges:[],acceptance:plan?.acceptance||[],decisionCriteria:plan?.decisionCriteria||[],originalGoal:session.initialGoal,currentGoal:plan?.goal,focus:plan?.focus,nextAction:plan?.next_action,steps:plan?.steps||[],constraints:plan?.constraints||[],invariant:plan?.invariant,owner:plan?.owner,dataFlow:plan?.data_flow,decision:plan?.decision,unknowns:plan?.unknowns||[],hypotheses:plan?.hypotheses||[],blockers:plan?.blockers||[],deferred:plan?.deferred||[],historyCount:(session.userUpdates||[]).length,userUpdates:(session.userUpdates||[]).filter(u=>u.taskId===session.taskId).map(u=>({id:u.id,at:u.at,preview:u.content.slice(0,1000),truncated:u.content.length>1000})),changes:session.turnChanges||[],checks:(session.checks||[]).filter(c=>c.taskId===session.taskId).slice(-8).map(c=>({id:c.id,command:c.command,commandPassed:c.commandPassed??c.passed,executed:c.executed,changeRevision:c.changeRevision,category:c.category,criteria:c.criteria||[],acceptance:c.acceptance||'not_independently_evaluated',paths:c.paths})),notice:'The original goal is historical and does not override later genuine user cancellations or replacements. User updates are instructions. Plan status and architecture are model assertions; check receipts prove command outcomes only.'};
}
function taskTool(session,args={}){
 if(args.history_offset!==undefined){const all=session.userUpdates||[],start=Math.max(0,args.history_offset||0),end=Math.min(all.length,start+20);return {updates:all.slice(start,end).map(u=>({id:u.id,taskId:u.taskId,at:u.at,preview:u.content.slice(0,500),truncated:u.content.length>500})),nextHistoryOffset:end<all.length?end:null,total:all.length};}
 if(!args.update_id)return taskState(session);
 const update=(session.userUpdates||[]).find(u=>u.id===args.update_id);if(!update)throw Error('Unknown genuine user update');
 const offset=Math.max(0,args.offset||0),end=Math.min(update.content.length,offset+8000);
 return {id:update.id,content:update.content.slice(offset,end),offset,nextOffset:end<update.content.length?end:null,totalCharacters:update.content.length};
}
function continuationState(session){
 const p=session.plan||{};
 const updates=(session.userUpdates||[]).filter(u=>u.taskId===session.taskId);
 const decisions=activeDecisions(session).map(({id,status,question,answer,step})=>(
  {id,status,question:question.slice(0,240),answer:answer?.slice(0,300),step}));
 return {taskId:session.taskId,recentDecisions:decisions.slice(-4),decisionCriteria:p.decisionCriteria?.slice(-8)||[],decisionsOmitted:decisions.length>4||(p.decisionCriteria?.length||0)>8,originalGoal:session.initialGoal?.slice(0,1800),currentGoal:p.goal?.slice(0,1800),goalTruncated:(session.initialGoal?.length||0)>1800,userUpdateIds:updates.slice(-20).map(u=>u.id),historyCount:(session.userUpdates||[]).length,recentClarifications:updates.slice(-3).map(u=>({id:u.id,preview:u.content.slice(0,500),truncated:u.content.length>500})),...planCheckpoint(p),callEvidence:session.callEvidence?.taskId===session.taskId?session.callEvidence.edges.slice(-8):[],focus:p.focus?.slice(0,500),nextAction:p.next_action?.slice(0,500),pendingSteps:p.steps?.filter(s=>s.status!=='done').map(s=>({title:s.title.slice(0,300),status:s.status})).slice(0,20),invariant:p.invariant?.slice(0,700),owner:p.owner?.slice(0,300),notice:'Runtime checkpoint, not independent proof. Retrieve the full plan with task_state() when planOmitted is true and exact user updates with task_state(update_id). Later genuine user updates can replace the historical original goal. Preserve applicable constraints; plan status is model-authored.'};
}
function planCheckpoint(plan = {}) {
 const bounded = values => (values || []).slice(0, 8).filter(value => value.length <= 400);
 const acceptance = bounded(plan.acceptance);
 const constraints = bounded(plan.constraints);
 const decision = plan.decision?.length <= 700 ? plan.decision : undefined;
 const planOmitted = acceptance.length < (plan.acceptance?.length || 0)
   || constraints.length < (plan.constraints?.length || 0)
   || Boolean(plan.decision && !decision);
 return {decision, acceptance, constraints, planOmitted};
}
module.exports={activeDecisions,blockedDecisionSteps,recordUser,taskState,taskTool,continuationState,planCheckpoint};
