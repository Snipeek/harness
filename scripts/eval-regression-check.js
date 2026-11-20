'use strict';

const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');

const sentTest = assertion => (
  "const test=require('node:test');\nconst assert=require('node:assert/strict');\n" +
  "const value=require('./main');\ntest('observable value',()=>{"+assertion+"});\n"
);
const examples=[
  {id:'docs-only', file:'README.md'},
  {id:'no-tests'},
  {id:'command-exit-zero-without-assertion',command:'verify_task'},
  {id:'unrelated-suite',suite:"require('node:test')('unrelated feature',()=>{});"},
  {id:'insensitive-test',suite:sentTest("assert.equal(typeof value,'number')")},
  {id:'regression-caught',suite:sentTest('assert.equal(value,2)')},
  {id:'pre-patch-setup-error',before:"throw Error('module setup failed');",suite:sentTest('assert.equal(value,2)')},
  {id:'regression-introduced',suite:sentTest('assert.equal(value,1)')},
  {id:'weakened-existing-test',suite:sentTest('assert.equal(value,1)'), replacement:sentTest('assert.ok(value)')}
];
const packet=data=>'data: '+JSON.stringify(data)+'\n\n';

async function runExamples(){
  const {createHost}=require('./runtime-host');
  const originalFetch=global.fetch,rows=[];
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'harness-regression-eval-'));
  try{
    for(const example of examples){
      const dir=path.join(temp,example.id),root=path.join(dir,'workspace');
      await fs.mkdir(root,{recursive:true});
      const file=example.file||'main.js';
      const before=example.before||(example.file?'Old documentation.':'module.exports=1;');
      const after=example.file?'Updated documentation.':'module.exports=2;';
      await fs.writeFile(path.join(root,file),before);
      if(example.suite)await fs.writeFile(path.join(root,'value.test.js'),example.suite);
      const host=await createHost({root,storage:path.join(dir,'storage'),allowedFiles:[file,'value.test.js'],
        settings:{maxToolRounds:7},
        approveCommand:async command=>{
          if(command==='printf OK')return {allow:true,execution:{file:process.execPath,args:['-e','console.log("OK")']}};
          if(command==='node --test value.test.js')return {allow:true,execution:{file:process.execPath,args:['--test','value.test.js']}};
          if(command==='node --test --test-reporter=tap -- value.test.js')return true;
          throw Error('Unexpected command: '+command);
        }
      });
      const actions=[{name:'edit_file',args:{path:file,old_text:before,new_text:after}}];
      if(example.replacement)actions.push({name:'edit_file',args:{
        path:'value.test.js',old_text:example.suite,new_text:example.replacement
      }});
      if(example.suite)actions.push({name:'run_command',args:{command:'node --test value.test.js'}});
      if(example.command)actions.push({name:example.command,args:{command:'printf OK',description:'Print OK'}});
      let calls=0;
      global.fetch=async()=>{
        const action=actions[calls++];
        const delta=action?{tool_calls:[{index:0,id:'check-'+calls,function:{name:action.name,arguments:JSON.stringify(action.args)}}]}:{content:'Finished the requested edit.'};
        return new Response(packet({choices:[{delta,finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10}}));
      };
      try{
        const started=performance.now();
        await host.send('Apply the requested change to '+file+'.');
        const {completion}=host.session;
        const current=await fs.readFile(path.join(root,file),'utf8');
        if(current!==after)throw Error('The fixture edit was not applied: '+example.id);
        rows.push({id:example.id,completion:completion.status,gaps:completion.gaps,
          audit:completion.verification?.status||null,assertions:completion.verification?.assertions||[],
          selectedTests:completion.verification?.tests||[],
          modelRequests:calls,elapsedMs:Math.round(performance.now()-started)});
      }finally{await host.close();}
    }
    return rows;
  }finally{
    global.fetch=originalFetch;
    await fs.rm(temp,{recursive:true,force:true});
  }
}

async function main(){
  if(process.argv[2]==='--arm'){console.log(JSON.stringify(await runExamples()));return;}
  const [baselinePath,destination]=process.argv.slice(2);
  if(!baselinePath||!destination)throw Error('Usage: node scripts/eval-regression-check.js BASELINE_EXTENSION_JS REPORT_JSON');
  const run=extension=>{
    const child=spawnSync(process.execPath,[__filename,'--arm'],{encoding:'utf8',
      env:{...process.env,HARNESS_EVAL_EXTENSION:extension}});
    if(child.status!==0)throw Error(child.stderr||'Evaluation did not complete');
    return JSON.parse(child.stdout);
  };
  const before=run(path.resolve(baselinePath));
  const after=run(path.join(__dirname,'../extension.js'));
  const report={method:'Identical scripted model actions through both production completion loops. Tests execute locally. No provider requests.',
    baseline:require(path.join(path.dirname(path.resolve(baselinePath)),'package.json')).version,
    candidate:require('../package.json').version,rows:after.map((current,index)=>({id:current.id,before:before[index],after:current}))};
  await fs.writeFile(destination,JSON.stringify(report,null,2)+'\n');
  console.log(destination);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
