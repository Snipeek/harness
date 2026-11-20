'use strict';
// Headless VS Code adapter. The model loop, policy dispatch, tools, context,
// plans, queue, agents and persistence are the extension's production code.
// UI/editor I/O is adapted; evaluator permissions are deliberately narrower.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {searchNative}=require('../src/services');
let current;
const vscode={get extensions(){return {all:current?.installedExtensions||[]};},workspace:{isTrusted:true,get workspaceFolders(){return current?.workspaceFolders;},getConfiguration:()=>({get:(key,fallback)=>current?.settings[key]??fallback})},window:{get showInformationMessage(){return current?.showInformationMessage;},createOutputChannel:()=>({appendLine(){},dispose(){}})}};
const load=Module._load;
let AIWorkspace;
try{Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};({AIWorkspace}=require(process.env.HARNESS_EVAL_EXTENSION || '../extension'));}finally{Module._load=load;}
async function createHost({root,storage,settings={},generateTitles=false,apiKey='local-test',approveCommand,allowedFiles=['main.js'],installedExtensions=[],showInformationMessage}){
  root=await fs.realpath(root);
  current={workspaceFolders:[{uri:{scheme:'file',fsPath:root}}],installedExtensions,showInformationMessage,settings:{provider:'glm',glmModel:'glm-5.3',importClaudeIntegrations:false,attachOpenFile:false,reasoningEffort:'low',maxToolRounds:12,maxOutputTokens:4096,contextWindow:128000,...settings}};
  const globalState=new Map();
  const context={globalStorageUri:{fsPath:storage},globalState:{get:(key,fallback)=>globalState.get(key)??fallback,update:async(key,value)=>globalState.set(key,value)},secrets:{get:async()=>apiKey},subscriptions:[]};
  const app=new AIWorkspace(context),session=app.newSession(),view={postMessage(){}};
  app.views.set(view,{sessionId:session.id});session.root=root;session.mode='manual';
  if(!generateTitles)app.nameSession=()=>{};
  app.broadcast=()=>{};app.refreshQuota=()=>{};app.rootForSession=async()=>root;
  const realHost=app.toolHost.bind(app);
  app.toolHost=(...args)=>{
    const host=realHost(...args);
    return {...host,findFiles:async(_glob,directory=root)=> (await fs.readdir(directory,{recursive:true})).map(f=>path.join(directory,f)).filter(f=>!f.includes('/.')),
      searchFiles:async(args,directory=root,candidates)=>searchNative(directory,candidates??(await fs.readdir(directory)).map(f=>path.join(directory,f)),args,host.signal),
      checkDirty:async()=>{},approveEdit:async file=>allowedFiles.includes(path.relative(root,file)),
      approveCommand:async command=>approveCommand?approveCommand(command):false,
      applyPatchset:async changes=>{
        if(changes.some(({file})=>!allowedFiles.includes(path.relative(root,file))))throw Error('Evaluator protects a file in this patchset');
        for(const change of changes){
          await fs.writeFile(change.file,change.after);
          const [session, directory, signal, entry, agent, turnId, owners]=args;
          const step=app.event(session,{role:'tool',name:'edit_file',status:'done',input:change.path,result:'Applied in patchset'});
          realHost(session,directory,signal,step,agent,turnId,owners).onEdit(change);
          entry.patchApplied=true;
        }
      },
      applyEdit:async(file,after)=>{if(!allowedFiles.includes(path.relative(root,file)))throw Error('Evaluator protects this file');await fs.writeFile(file,after);}
    };
  };
  return {app,session,view,settings:current.settings,send:raw=>app.send(view,raw,[]),close:async()=>{clearTimeout(app.broadcastTimer);app.services.close();app.tasks.close();await Promise.allSettled([...app.tasks.batches.values()].map(b=>b.promise));app.web.close();for(const s of app.integrationScopes.values())await s.mcp.close();await app.store.queue;}};
}
module.exports={createHost};
