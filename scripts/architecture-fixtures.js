'use strict';
const fixture={
 'seed.json':'[{"id":2,"title":"B","hidden":false},{"id":1,"title":"A","hidden":true}]',
 'model.js':`function normalize(x){return {id:x.id,label:x.title};}module.exports={normalize};`,
 'view.js':`function labels(rows){return rows.map(x=>x.label);}module.exports={labels};`,
 'main.js':`const {normalize}=require('./model');const {labels}=require('./view');function screen(items){return labels(items.map(normalize));}module.exports={screen};`,
 'test.js':'// Protected evaluator smoke test. Run node test.js\n'
};
const tasks=[{id:'module-visibility-evolution',kind:'module',files:fixture,allowedFiles:['main.js','model.js','summary.js'],stages:[
 {prompt:'Understand this three-file module and fix screen(items): hidden===true rows must not appear; missing hidden means visible. Carry the existing flag through normalization. Preserve public exports, input order and seed.json. Keep view.js unchanged: labels(rows) projects every supplied row. Only main.js/model.js may change. Run node test.js. Choose the owner from the actual code, not a duplicate store.',checks:[['api.screen([{id:1,title:"A",hidden:true},{id:2,title:"B"}])',['B']],["typeof fixtureModule('model.js').normalize",'function'],["typeof fixtureModule('view.js').labels",'function'],["fixtureModule('view.js').labels([{label:'A',hidden:true},{label:'B'}])",['A','B']]]},
 {prompt:'Extend the module with exported countVisible(items) and visibleIds(items) on main.js, sharing the exact visibility policy used by screen. Do not duplicate policy in three consumers. Preserve normalization/label functions, old screen behavior, original order and seed.json. Run node test.js.',checks:[['api.countVisible([{id:1,title:"A",hidden:true},{id:2,title:"B"}])',1],['api.visibleIds([{id:7,title:"C"},{id:2,title:"B",hidden:false}])',[7,2]],['api.screen([])',[]]]},
 {prompt:'Create a new summary.js module exporting summarize(items), and expose main.js summary(items). Return {count,ids,labels} for visible items. Filter and normalize the items once. Use the existing labels(rows) projection on those rows; preserve its original behavior. Reuse the module\'s existing visibility policy and normalization; preserve prior public APIs, input order and seed.json. Avoid a dependency cycle or a second store. Run node test.js.',checks:[['api.summary([{id:9,title:"N"},{id:1,title:"A",hidden:true},{id:2,title:"B",hidden:false}])',{count:2,ids:[9,2],labels:['N','B']}],['api.summary([])',{count:0,ids:[],labels:[]}],["typeof fixtureModule('summary.js').summarize",'function'],
 ["(()=>{let calls=0;class Rows extends Array{filter(fn){calls++;return super.filter(fn);}}const items=Rows.from([{id:1,title:'A'},{id:2,title:'B',hidden:true}]);api.summary(items);return calls<=1;})()",true]]}
]}];
const reference={
 ...fixture,
 'model.js':[
  'function normalize(item){return {id:item.id,label:item.title,hidden:item.hidden};}',
  'function visibleRows(items){return items.map(normalize).filter(row=>row.hidden!==true);}',
  'module.exports={normalize,visibleRows};'
 ].join('\n'),
 'main.js':[
  "const {visibleRows}=require('./model');",
  "const {labels}=require('./view');",
  "const {summarize}=require('./summary');",
  'function screen(items){return labels(visibleRows(items));}',
  'function countVisible(items){return visibleRows(items).length;}',
  'function visibleIds(items){return visibleRows(items).map(row=>row.id);}',
  'module.exports={screen,countVisible,visibleIds,summary:summarize};'
 ].join('\n'),
 'summary.js':[
  "const {visibleRows}=require('./model');",
  "const {labels}=require('./view');",
  'function summarize(items){',
  '  const rows=visibleRows(items);',
  '  return {count:rows.length,ids:rows.map(row=>row.id),labels:labels(rows)};',
  '}',
  'module.exports={summarize};'
 ].join('\n')
};
module.exports={tasks,reference};
