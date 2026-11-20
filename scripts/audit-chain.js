'use strict';
const fs=require('node:fs'),vm=require('node:vm');const report=JSON.parse(fs.readFileSync('reports/chain.json'));const expected=[{id:'a',title:'A',availableAt:1000},{id:'b',title:'B'}];
report.postHocAudit={note:'Additional code audit after the predeclared behavior checks. This assertion was not part of the original scoring protocol; original passed/checks values are retained.',expectedInitialCards:expected,results:[]};
for(const arm of ['current','decision-brief'])for(let stage=1;stage<=3;stage++){const code=fs.readFileSync(`reports/chain/${arm}-${stage}.js`,'utf8');const cards=vm.runInNewContext(code+'\nstate.cards',{module:{exports:{}}},{timeout:500});report.postHocAudit.results.push({arm,stage,initialDataPreserved:JSON.stringify(cards)===JSON.stringify(expected),actualCards:cards});}
fs.writeFileSync('reports/chain.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report.postHocAudit,null,2));
