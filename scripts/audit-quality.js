'use strict';
const fs=require('node:fs'),path=require('node:path'),{hash,gradeCode}=require('./quality-grader'),{tasks,chains}=require('./quality-fixtures'),{summarize}=require('./summarize-quality');
function audit(inputs,output){
 const reports=inputs.map(file=>({file:path.resolve(file),data:JSON.parse(fs.readFileSync(file,'utf8'))})),base=reports[0].data,seen=new Set(),rows=[],corrections=[],apiAudit=[];
 for(const {file,data}of reports){if(data.runtimeHash!==base.runtimeHash||data.configuredModel!==base.configuredModel||data.endpoint!==base.endpoint)throw Error('Do not merge different runtime/model/endpoint conditions');for(const row of data.rows){const id=[row.task,row.trial,row.variant,row.stage].join(':');if(seen.has(id))throw Error('Duplicate trial '+id);seen.add(id);rows.push({...row,reportFile:file});}}
 const merged={...base,rows,sources:reports.map(r=>r.file),finishedAt:reports.at(-1).data.finishedAt,kind:'Merged frozen-runtime pilot; original outcomes retained',observedTokens:rows.reduce((s,r)=>s+r.observedTokens,0)};
 const corrected=structuredClone(merged);
 for(const row of corrected.rows){const task=[...tasks,...chains].find(t=>t.id===row.task);if(!task)continue;
  if(row.task==='data-persist-order'){
   const source=fs.readFileSync(path.join(path.dirname(row.reportFile),row.runId,'workspace/main.js'),'utf8');if(hash(source)!==row.sourceHash)throw Error('Source changed after trial');const replacement=gradeCode(source,[task.checks[1]])[0],bad=row.grade.checks.findIndex(c=>c.error&&c.expression?.startsWith('decode('));
   corrections.push({runId:row.runId,reason:'Original hidden assertion contained invalid JavaScript quoting. Corrected assertion evaluated on unchanged saved source; no new model run.',old:row.grade.checks[bad],corrected:replacement,sourceHash:row.sourceHash});row.grade.checks[bad]=replacement;row.grade.passed=row.grade.checks.every(c=>c.passed);
  }
  const stages=task.stages?.length||1;if(!task.files?.['main.js']||row.stage!==stages)continue;
  const source=fs.readFileSync(path.join(path.dirname(row.reportFile),row.runId,'workspace/main.js'),'utf8');if(hash(source)!==row.sourceHash)continue;
  const checks=task.stages?task.stages.flatMap(s=>s.checks):task.checks||[];
  apiAudit.push({runId:row.runId,postHoc:true,reason:'Additional exported-API audit; original grader exposed lexical helpers',checks:gradeCode(source,checks)});
 }
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'merged-original.json'),JSON.stringify(merged,null,2));fs.writeFileSync(path.join(output,'summary-original.json'),JSON.stringify(summarize(merged),null,2));
 fs.writeFileSync(path.join(output,'evaluator-corrections.json'),JSON.stringify({corrections,apiAudit,warning:'Corrections and extra audits are explicit; original report outcomes remain unchanged.'},null,2));fs.writeFileSync(path.join(output,'merged-corrected.json'),JSON.stringify(corrected,null,2));fs.writeFileSync(path.join(output,'summary-corrected.json'),JSON.stringify(summarize(corrected),null,2));
 const blind=[],mapping=[];
 for(const task of tasks.filter(t=>['evidence','web'].includes(t.kind))){const pair=rows.filter(r=>r.task===task.id);if(pair.length!==2)continue;pair.sort((a,b)=>hash(a.runId).localeCompare(hash(b.runId)));const answers=pair.map((r,i)=>{const folder=path.join(path.dirname(r.reportFile),r.runId,'storage/ai-sessions'),file=fs.readdirSync(folder).find(f=>f.endsWith('.json')),s=JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));mapping.push({task:task.id,label:i?'B':'A',variant:r.variant});return {label:i?'B':'A',text:s.timeline.filter(e=>e.role==='assistant'&&e.status==='done'&&e.text).at(-1)?.text||''};});blind.push({task:task.id,prompt:task.prompt,answers});}
 fs.writeFileSync(path.join(output,'blind-answers.json'),JSON.stringify(blind,null,2));fs.writeFileSync(path.join(output,'blind-key.json'),JSON.stringify(mapping,null,2));
 return summarize(corrected);
}
if(require.main===module){const args=process.argv.slice(2),output=args.pop();console.log(JSON.stringify(audit(args,output),null,2));}
module.exports={audit};
