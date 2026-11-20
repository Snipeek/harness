'use strict';
const {randomUUID,createHash}=require('node:crypto');
// Receipt annotations are presentation, while edits to the requirement create new identities.
function criterionText(value) {
 return value.trim().replace(/\s*\(verified:\s*receipt\s+[0-9a-f-]{8,36}\)\s*$/i,'').trim();
}
function criterionId(text) {
 return 'criterion-' + createHash('sha256').update(criterionText(text)).digest('hex').slice(0,20);
}
function planCriteria(plan) {
 return (plan?.acceptance||[]).map(text=>({id:criterionId(text),text}));
}
function partitionCriteria(plan, references=[]){
 const available=planCriteria(plan);
 const linked=[],unlinked=[];
 for(const reference of new Set(references)){
  const found=available.some(item=>item.id===reference||criterionText(item.text)===criterionText(reference));
  (found?linked:unlinked).push(reference);
 }
 return {linked,unlinked};
}
function resolveCriteria(plan, references=[]) {
 if(!references.length)return [];
 const available=planCriteria(plan);
 return [...new Set(references.map(reference=>{
  const entry=available.find(item=>item.id===reference||criterionText(item.text)===criterionText(reference));
  if(!entry){
   const choices=available.slice(0,5).map(({id,text})=>id+' '+text.slice(0,100)).join('\n');
   throw Error('Unknown acceptance criterion: '+reference.slice(0,150)+
    (choices ? '\nUse an active criterion ID:\n'+choices : '\nNo active acceptance criteria. Omit criteria to run the check without linking it.'));
  }
  return entry.id;
 }))];
}
const {blockedDecisionSteps}=require('./task-state');
const projectCheckScript = /^(?:[\w.-]+\/)*train\/[\w.-]+(?:[-_.](?:check|test|spec))\.[cm]?js$/i;
function checkCategory(command){
 if(typeof command!=='string'||command.length>500||/[;&|`$<>\n\r]/.test(command))return null;
 if(/^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+build(?:\s|$)/.test(command.trim()))return 'build';
 if(/^(?:(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+check|cargo\s+check)(?:\s|$)/.test(command.trim()))return 'static-check';
 if(/^node\s+(?:[\w.-]+\/)*(?:check|test|spec)(?:[-.][\w.-]+)?\.[cm]?js$/.test(command.trim()))return 'project-check';
 if (command.trim().startsWith('node ') && projectCheckScript.test(command.trim().slice(5))) return 'project-check';
 if(/^node\s+--check\s+\S+\s*$/.test(command.trim()))return 'syntax';
 return /^(?:npm\s+(?:test(?:\s|$)|run\s+(?:test|check|build)(?:\s|$))|pnpm\s+(?:test|check|build)(?:\s|$)|yarn\s+(?:test|check|build)(?:\s|$)|node\s+(?:--test(?:\s|$)|\S*(?:test|spec)[^\s]*\.js(?:\s|$))|pytest(?:\s|$)|python3?\s+-m\s+pytest(?:\s|$)|cargo\s+(?:test|check)(?:\s|$)|go\s+test(?:\s|$)|dotnet\s+test(?:\s|$))/.test(command.trim())?'project-check':null;
}
function recordCheck(session,{command,description,output,entryId,startedAt=Date.now(),category='declared-check',criteria=[],scenarios=[],fingerprints,changeRevision=(session.changeLog||[]).length}){
 const check={id:randomUUID(),taskId:session.taskId,turnId:session.turnId,command,description,paths:[...(session.turnChanges||[])],changeRevision,entryId,category,criteria,criterionIds:resolveCriteria(session.plan,criteria),scenarios,fingerprints,startedAt,finishedAt:Date.now(),executed:/^(?:(?:Cancelled|Timed out)\. )?Exit code:/.test(output),commandPassed:/^Exit code: 0\n/.test(output),acceptance:'not_independently_evaluated',output};
 check.passed=check.commandPassed;(session.checks||=[]).push(check);return check;
}
function currentChecks(session, sameTurn=false){
 const latest=new Map();
 for(const check of session.checks||[]){
  if(!check.reproduction && (!sameTurn||check.turnId===session.turnId)&&check.taskId===session.taskId&&check.changeRevision===(session.changeLog||[]).length&&check.executed&&!check.stale)latest.set(check.command,check);
 }
 return [...latest.values()];
}
function hasCurrentCheck(session, sameTurn=true){
 const checks=currentChecks(session,sameTurn);
 return !checks.some(check=>!check.commandPassed)&&checks.some(isBehaviorCheck);
}
function isBehaviorCheck(check){
 return check.commandPassed&&(check.category==='project-check'||(check.category==='declared-check'&&Boolean(check.baselineId)));
}
function linkCheck(session,{id,criteria,coverage}){
 const checks=currentChecks(session,true).filter(isBehaviorCheck);
 if(!id)return checks.map(({id,command,criteria,output})=>({id,command,criteria,output:output.slice(0,1200)}));
 const check=checks.find(item=>item.id===id);
 if(!check?.fingerprints)throw Error('Choose a current passing behavioral receipt with recorded file fingerprints.');
 if(!criteria?.length||!coverage?.trim())throw Error('Provide active criterion IDs and observed test coverage.');
 const ids=resolveCriteria(session.plan,criteria);
 check.criteria=[...new Set([...(check.criteria||[]),...criteria])];
 check.criterionIds=[...new Set([...(check.criterionIds||[]),...ids])];
 check.coverageNotes={...check.coverageNotes,...Object.fromEntries(criteria.map(criterion=>[criterion,coverage.trim().slice(0,1200)]))};
 return {id,criteria:check.criteria,coverageNotes:check.coverageNotes,acceptance:check.acceptance};
}
function requestedNodeChecks(text){
  const required=new Set();
  for(const line of (text||'').split(/(?<=[.!?])\s+|\n/)){
   if (/(?:\b(?:do not|don't|never|must not)\s+(?:run|verify)|не\s+(?:запусти|выполни|проверь))/iu.test(line)) continue;
   if(!/(?:\brun\b|\bverify with\b|запусти|выполни|проверь)/iu.test(line))continue;
   for(const match of line.matchAll(/\bnode[ \t]+(?:[\w.-]+\/)*[\w.-]+\.[cm]?js(?=[\s`.,;!?)]|$)/g)){
    const command=match[0].replace(/[ \t]+/g,' ');
    if(checkCategory(command)==='project-check')required.add(command);
   }
  }
  return [...required];
}
function completionGaps(session, summarizedChecks){
 const decisions=blockedDecisionSteps(session).map(item=>'Awaiting user decision for '+item.step+': '+item.question);
 if(session.mode==='plan')return decisions; // Implementation steps are the deliverable, not work to execute in this turn.
 const gaps=decisions.concat((session.commandTrackingGaps || []).filter(item=>item.taskId===session.taskId).map(item=>item.message));
 const checks=currentChecks(session);
 if(session.prewriteChecks?.taskId===session.taskId){
  const passed=new Set(checks.filter(check=>check.commandPassed).map(check=>check.command.trim()));
  for(const script of session.prewriteChecks.scripts){
   if(!passed.has('node '+script))gaps.push('Verify the saved revision with verify_revision: node '+script);
  }
 }
 const baselines=new Map((session.checks || [])
  .filter(check=>check.taskId===session.taskId&&check.reproduction?.observed)
  .map(check=>[check.command,check]));
 for(const baseline of baselines.values()){
  if(!checks.some(check=>check.commandPassed&&check.baselineId===baseline.id)){
   gaps.push('Confirm the observed reproduction with verify_task and baseline_id '+baseline.id);
  }
 }
 gaps.push(...(session.plan?.steps||[]).filter(step=>step.status!=='done').map(step=>'Open step: '+step.title));
 const changed=session.turnChanges?.length||(session.changeLog||[]).some(change=>change.taskId===session.taskId);
 const audit=session.regressionAudit?.taskId===session.taskId &&
  session.regressionAudit?.revision===(session.changeLog||[]).length ? session.regressionAudit : null;
 if(changed){
  const required=requestedNodeChecks(session.initialGoal);
  for(const command of required){
   const receipt=checks.find(check=>check.command.trim().replace(/[ \t]+/g,' ')===command);
   if(receipt?.commandPassed)continue;
   const detail=summarizedChecks?.has(receipt?.id) ? '' : receipt?.output?.split('\n').slice(1).join('\n').trim().slice(0,900);
   gaps.push(receipt ? 'Required check failed on this revision: '+command+(detail?'\n'+detail:'') :
    'Run the requested check on the saved revision: '+command+' (the working directory is already the workspace).');
  }
 }
 if(changed && (audit ? checks.some(check=>!check.commandPassed) : !hasCurrentCheck(session,false))){
  gaps.push('No current passing behavioral check or a current check failed.');
 }
 if(audit && ['failed','unproven','test_modified','inconclusive','not_run','declined'].includes(audit.status)){
  gaps.push('Diff regression check: '+audit.reason);
 }
 if(changed){
  const covered=new Set(checks.filter(isBehaviorCheck).flatMap(check=>[...(check.criterionIds||[]),...(check.criteria||[]).map(criterionId)]));
  const passingCommands=new Set(checks.filter(check=>check.commandPassed).map(check=>check.command.trim()));
  for(const criterion of session.plan?.acceptance||[]){
   const commandOnly=/^`?([^`]+?)`?\s+(?:passes|succeeds|exits (?:with )?(?:code )?0)\.?$/i.exec(criterionText(criterion))?.[1];
   const hasApplicableGate=!audit || ['confirmed','failed','unproven','test_modified','inconclusive'].includes(audit.status);
   if((commandOnly || hasApplicableGate) && !covered.has(criterionId(criterion))&&!passingCommands.has(commandOnly)){
    gaps.push('Unverified acceptance criterion: '+criterion);
   }
  }
 }
 return gaps;
}
function reproductionOptions(session, args, pinned, revision) {
 const { reproduction, baseline_id: baselineId, command, inputs = [] } = args;
 if(!reproduction && !baselineId)return {};
 if(reproduction && baselineId)throw Error('Choose reproduction or baseline_id for a check, not both.');
 if(Object.values(pinned).some(digest=>digest===null))throw Error('Pin existing reproduction tests and fixtures using inputs.');
 if(reproduction){
  if(!inputs.length && !reproduction.inline)throw Error('Pin test files and fixtures in inputs, or set reproduction.inline for assertions embedded in the command.');
  const { exit_code: exitCode, output_contains: marker } = reproduction;
  if(!Number.isInteger(exitCode)||exitCode<1||exitCode>255||!marker?.trim())throw Error('Specify the expected nonzero exit code and a distinctive failure marker.');
  return { exitCode, marker, inline: Boolean(reproduction.inline) };
 }
 const baseline = (session.checks || []).find(check=>check.id===baselineId && check.taskId===session.taskId && check.reproduction?.observed);
 if(!baseline || baseline.command!==command || baseline.changeRevision>=revision){
  throw Error('Use the same command and an observed baseline from before the patch in this task.');
 }
 const previous = baseline.reproduction.inputs;
 if(Object.keys(previous).length!==Object.keys(pinned).length || Object.entries(previous).some(([name,digest])=>pinned[name]!==digest)){
  throw Error('The reproduction test or fixtures changed. Establish a baseline with the same pinned inputs.');
 }
 const changedFiles = new Set((session.changeLog || []).slice(baseline.changeRevision,revision).filter(change=>change.taskId===session.taskId).map(change=>change.path));
 if(![...changedFiles].some(name=>!Object.hasOwn(pinned,name)))throw Error('A source change outside the pinned test inputs is required.');
 return { baseline };
}

function recordReproduction(check, options, pinned, output, scopeChanged) {
 if(options.baseline){
  if(check.commandPassed && !scopeChanged)check.baselineId=options.baseline.id;
 }else if(options.marker){
  const firstLine = 'Exit code: ' + options.exitCode + '\n';
  check.reproduction={exitCode:options.exitCode, marker:options.marker, inputs:pinned, inline:options.inline,
   observed:!scopeChanged && output.startsWith(firstLine) && output.slice(firstLine.length).includes(options.marker)};
 }
}
module.exports={planCriteria,resolveCriteria,partitionCriteria,reproductionOptions,recordReproduction,checkCategory,projectCheckScript,recordCheck,hasCurrentCheck,requestedNodeChecks,completionGaps,currentChecks,linkCheck};
