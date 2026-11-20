'use strict';
const fs=require('node:fs');
function quantile(values,q){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p);return a[i]+(a[Math.ceil(p)]-a[i])*(p-i);}
function summarize(report){
 const variants=report.variants.map(v=>v.name),out={warning:'Pilot, not proof of parity or non-inferiority. Stage outcomes in a chain are correlated. Manual review remains separate.',fixtureHash:report.fixtureHash,variants:{},paired:[]};
 for(const name of variants){const rows=report.rows.filter(r=>r.variant===name),groups=new Map();for(const r of rows){const g=groups.get(r.runId)||[];g.push(r);groups.set(r.runId,g);}
  const complete=[...groups.values()].filter(g=>g.length===(report.tasks.find(t=>t.id===g[0].task)?.stages||1));
  out.variants[name]={runs:groups.size,completeRuns:complete.length,acceptedAutomatic:complete.filter(g=>g.every(r=>r.grade.passed)).length,manualReviewRuns:complete.filter(g=>g.some(r=>r.grade.manualReviewRequired)).length,medianFullRunMs:quantile(complete.map(g=>g.at(-1).totalRunMs),.5),observedTokens:rows.reduce((s,r)=>s+r.observedTokens,0),unknownUsageRequests:rows.flatMap(r=>r.metrics).filter(m=>m.phase!=='tool'&&!m.usageKnown).length,successWithinSeconds:Object.fromEntries([30,60,120,300].map(limit=>[limit,complete.filter(g=>g.every(r=>r.grade.passed)&&g.at(-1).totalRunMs<=limit*1000).length]))};
 }
 const units=new Map();for(const r of report.rows){const key=r.task+':'+r.trial;const unit=units.get(key)||{};unit[r.variant]=r;units.set(key,unit);}
 for(const [unit,arms]of units)if(variants.every(v=>arms[v]&&arms[v].stage===report.tasks.find(t=>t.id===arms[v].task).stages))out.paired.push({unit,arms:Object.fromEntries(variants.map(v=>[v,{durationMs:arms[v].totalRunMs,observedTokens:arms[v].cumulativeUsage.input+arms[v].cumulativeUsage.output,finalStagePassed:arms[v].grade.passed}]))});
 return out;
}
if(require.main===module){const report=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify(summarize(report),null,2));}
module.exports={summarize,quantile};
