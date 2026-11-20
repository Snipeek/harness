'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SearchEvidence,searchIndex}=require('../src/tool-evidence');
const {ContextEngine}=require('../src/engine');

test('only complete local searches are reused, and workspace invalidation forces a new search',async()=>{
 const evidence=new SearchEvidence(), args={query:'client',regex:false};
 let runs=0;
 const run=(a=args,output={matches:[],nextOffset:null})=>evidence.run('search_files',a,['root','plan'],async()=>{runs++;return JSON.stringify(output);});
 await run();assert.equal(JSON.parse(await run({regex:false,query:'client'})).reusedSearch,true);
 assert.equal(runs,1);
 evidence.clear();await run();assert.equal(runs,2);
 for(const [query,result] of [['partial',{matches:[],scopeTruncated:true}],['error',{error:'failed'}]]){
  await run({query},result);assert.equal(JSON.parse(await run({query},result)).reusedSearch,undefined);
 }
 await run({query:'client',directory:'other'});await run({query:'client',directory:'other'});
 assert.equal(runs,8);
});

test('old tool output is recoverable verbatim and compacted searches remain visible',async()=>{
 const raw='long log '.repeat(1000)+'tail';
 const messages=[
  {role:'user',content:'User constraint '+ 'u'.repeat(6500)},
  {role:'assistant',tool_calls:[{id:'log',function:{name:'run_command',arguments:'{}'}},{id:'s',function:{name:'search_files',arguments:'{"query":"apiClient"}'}}]},
  {role:'tool',tool_call_id:'log',content:raw},
  {role:'tool',tool_call_id:'s',content:'{"matches":["client.ts:7: apiClient"],"nextOffset":null}'},
  {role:'assistant',tool_calls:[{id:'a'},{id:'b'}]},
  {role:'tool',tool_call_id:'a',content:'recent A'+ 'a'.repeat(1100)},
  {role:'tool',tool_call_id:'b',content:'recent B'},
  {role:'user',content:'Continue'}
 ];
 const original=JSON.stringify(messages), archives=new Map();
 const archiveToolOutput=async content=>{const id='archive-'+archives.size;archives.set(id,content);return id;};
 const engine=new ContextEngine({},async()=>({message:{content:'Diagnostic summary'}}));
 const visible=await engine.prepare({messages,archiveToolOutput});
 assert.match(visible.find(m=>m.tool_call_id==='log').content,/read_artifact with id=archive-0/);
 assert.equal(archives.get('archive-0'),raw);
 assert.equal(visible.find(m=>m.tool_call_id==='b').content,'recent B');
 const compacted=await engine.prepare({messages,archiveToolOutput,targetInputTokens:2048,forceCompact:true});
 assert(compacted.some(m=>m.content?.includes('Prior workspace search findings')&&m.content.includes('client.ts:7')));
 assert(compacted.some(m=>m.content?.includes('Archived tool output')&&m.content.includes('archive-0')));
 assert.deepEqual(searchIndex(messages,4).map(({complete,count})=>[complete,count]),[[true,1]]);
 assert.equal(JSON.stringify(messages),original);
 const reopened=new ContextEngine(JSON.parse(JSON.stringify(engine.state)));
 const restored=await reopened.prepare({messages,archiveToolOutput});
 assert(restored.some(m=>m.content?.includes('client.ts:7')));
 assert(restored.some(m=>m.content?.includes('archive-0')));
 assert.equal(archives.size,1);
});

test('a tool log has the same compact representation from its first request onward',async()=>{
 const engine=new ContextEngine();
 const messages=[{role:'user',content:'Inspect logs'},{role:'tool',tool_call_id:'log',content:'ordinary output '.repeat(500)+'PASS'}];
 let archives=0;
 const opts={archiveToolOutput:async()=>String(++archives)};
 const first=await engine.prepare({...opts,messages});
 const next=await engine.prepare({...opts,messages:[...messages,{role:'assistant',content:'Continue'}]});
 assert.deepEqual(next.slice(0,first.length),first);
 assert.match(first.at(-1).content,/read_artifact with id=1/);
 assert.match(first.at(-1).content,/PASS$/);
 assert.equal(archives,1);
});
