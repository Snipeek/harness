'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {researchCoverage}=require('../src/research-coverage');

test('coverage counts delivered whole lines and attributes only new references to each pivot',()=>{
  const result=(content,next)=>JSON.stringify({path:'src/main.js',content,next});
  const events=[
    {name:'read_file',status:'done',startedAt:1,finishedAt:2,result:result('10: owner\n11: partial\n',{start_line:11,character_offset:7})},
    {name:'apply_patchset',status:'error',startedAt:3,finishedAt:4,result:'Contract rejected'},
    {name:'read_file',status:'done',startedAt:5,finishedAt:6,result:result('10: owner\n11: caller\n12+8: continuation\n')},
    {name:'update_plan',status:'done',startedAt:7,finishedAt:8,planBranch:{from:'change owner',to:'change caller'}},
    {name:'search_batch',status:'done',startedAt:9,finishedAt:10,result:JSON.stringify({results:[
      {excerpts:[{path:'src/main.js',content:'11: caller\n12: test edge\n13: clipped'}]}
    ]})},
    {name:'apply_patchset',status:'done',patchApplied:true,startedAt:11,finishedAt:12},
    {name:'read_file',status:'done',startedAt:13,finishedAt:14,result:result('13: shifted after edit\n')}
  ];
  const resultCoverage=researchCoverage(events,[{path:'src/main.js',start:10,end:13}]);
  assert.deepEqual(resultCoverage.required,{total:4,initial:1,addedAfterBranches:2});
  assert.deepEqual(resultCoverage.branches.map(({kind,newRequired})=>[kind,newRequired]),[['error',1],['plan',1]]);
});
