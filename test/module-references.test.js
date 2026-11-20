'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {moduleReferences}=require('../src/repository-map');
test('module references resolve exact relative paths rather than matching duplicate basenames',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'harness-refs-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files={'src/old.mjs':'export const old=1;','src/active/old.mjs':'export const old=2;',
 'src/active/main.mjs':"// import '../old.mjs';\nimport './old.mjs';\nrequire('../old');\nimport(name);",
 'bin.mjs':"export {old} from './src/active/old.mjs';"};
 for(const [name,text] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),text);}
 const result=await moduleReferences(root,['src/old.mjs','src/active/old.mjs'],{findFiles:async()=>Object.keys(files).map(name=>path.join(root,name))});
 assert.deepEqual(result.modules.map(m=>m.count),[1,2]);
 assert.equal(result.modules[0].references[0].line,3);
 assert.equal(result.coverage.computedCallsObserved,1);
});
