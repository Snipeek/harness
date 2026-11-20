'use strict';

const editTools = new Set(['apply_patchset','edit_file','write_file']);
const lookupTools = new Set(['related_tests','repository_docs','read_file','read_files','search_files','search_batch','module_references',
  'navigate_symbols','trace_calls','trace_symbol','list_files','code_navigation','architecture_map']);
const branchTools = new Set([...editTools,...lookupTools,'verify_revision','verify_task','link_check','update_plan']);

function failedCheck(event) {
  if(event.status!=='done'||!['apply_patchset','verify_revision','verify_task'].includes(event.name))return false;
  try{
    const result=JSON.parse(event.result);
    if(event.name==='apply_patchset')return result.verification?.passed===false;
    if(event.name==='verify_task')return result.executed && result.commandPassed===false && !result.reproduction?.observed;
    return result.passed===false;
  }catch{return false;}
}

function completeLines(range) {
  if(typeof range?.path!=='string'||typeof range.content!=='string'||range.error)return [];
  return Array.from(range.content.matchAll(/^(\d+): [^\n]*\n/gm), match=>Number(match[1]))
    .filter(line=>range.next?.start_line!==line || !range.next.character_offset);
}

function sourceRanges(data) {
  return data?.files ?? data?.results?.flatMap(result=>result.excerpts||[]) ?? [data];
}

function deliveredLines(event) {
  if(event.status!=='done'||event.artifact||
    !['read_file','read_files','search_batch','related_tests'].includes(event.name))return [];
  try{return sourceRanges(JSON.parse(event.result)).flatMap(range=>completeLines(range).map(line=>[range.path,line]));}
  catch{return [];}
}

const sourceRevisionKey = (path, revision) => JSON.stringify([path,revision]);

function visibleSourceLines(messages, openingRanges) {
  const known=new Map();
  function addRange(range) {
    if(typeof range?.revision!=='string')return;
    const lines=completeLines(range);
    if(!lines.length)return;
    const key=sourceRevisionKey(range.path,range.revision);
    if(!known.has(key))known.set(key,new Set());
    for(const line of lines)known.get(key).add(line);
  }
  openingRanges.forEach(addRange);
  for(const message of messages||[]){
    if(message.role!=='tool')continue;
    try{sourceRanges(JSON.parse(message.content)).forEach(addRange);}catch{}
  }
  return known;
}

function researchCoverage(events, targets=[]) {
  const ordered=[...events].sort((a,b)=>a.startedAt-b.startedAt);
  const firstEdit=ordered.find(event=>editTools.has(event.name));
  const firstWrite=ordered.find(event=>event.change||event.patchApplied);
  const firstWriteAt=firstWrite?.finishedAt??firstWrite?.startedAt??Infinity;
  const initial=new Map(),followup=new Map(),seen=new Map();
  const branches=[];
  let branch;
  let initialLookups=0,followupLookups=0;
  const needed=new Map();
  for(const {path,start,end} of targets){
    const lines=needed.get(path)||new Set();
    for(let line=start;line<=end;line++)lines.add(line);
    needed.set(path,lines);
  }
  const size=files=>[...files.values()].reduce((count,lines)=>count+lines.size,0);
  const covered=files=>[...needed].reduce((count,[path,lines])=>
    count+[...lines].filter(line=>files.get(path)?.has(line)).length,0);
  for(const event of ordered){
    if(lookupTools.has(event.name)){
      const early=!firstEdit || (event.finishedAt??event.startedAt)<=firstEdit.startedAt;
      const files=early?initial:followup;
      if(early)initialLookups++;else followupLookups++;
      for(const [path,line] of deliveredLines(event)){
        if(!files.has(path))files.set(path,new Set());
        files.get(path).add(line);
        if(!seen.has(path))seen.set(path,new Set());
        if(branch && (event.finishedAt??event.startedAt)>branch.at && !seen.get(path).has(line)){
          branch.newLines++;
          if((event.finishedAt??event.startedAt)<=firstWriteAt && needed.get(path)?.has(line))branch.newRequired++;
        }
        seen.get(path).add(line);
      }
    }
    let detail;
    if(event.planBranch)detail={kind:'plan',...event.planBranch};
    if(event.status==='error'&&branchTools.has(event.name)){
      detail={kind:'error',name:event.name,result:String(event.result||'').split('\n')[0].slice(0,200)};
    }
    if(failedCheck(event))detail={kind:'error',name:event.name,result:'Проверка не прошла'};
    if(detail){
      branch={...detail,at:event.finishedAt??event.startedAt,newLines:0,newRequired:0};
      branches.push(branch);
    }
  }
  return {initialLookups,followupLookups,initialFiles:[...initial.keys()],followupFiles:[...followup.keys()],
    initialLines:size(initial),followupLines:size(followup),branches,
    ...(targets.length?{required:{total:size(needed),initial:covered(initial),
      addedAfterBranches:branches.reduce((count,item)=>count+item.newRequired,0)}}:{})};
}

module.exports={researchCoverage,visibleSourceLines,sourceRevisionKey,failedCheck};
