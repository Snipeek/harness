'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { inside, protectedPath } = require('./tools');
class Services {
  constructor(directory) { this.directory = directory; this.processes = new Map(); }
  async artifact(text) { const id = randomUUID(); await fs.mkdir(this.directory, {recursive:true,mode:0o700}); await fs.writeFile(path.join(this.directory,id),text,{mode:0o600}); return id; }
  async readArtifact(id, offset = 0, limit = 16000) {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid artifact ID');
    const handle = await fs.open(path.join(this.directory,id),'r');
    try {
      const stat=await handle.stat(),start=Math.max(0,offset);
      if(!Number.isInteger(start)||start>stat.size)throw new Error('Invalid artifact offset');
      const buffer=Buffer.alloc(Math.max(4,Math.min(8000,limit))),{bytesRead}=await handle.read(buffer,0,buffer.length,start);
      if(bytesRead&&(buffer[0]&0xC0)===0x80)throw new Error('Offset must be a UTF-8 character boundary; use nextOffset');
      let end=bytesRead;
      if(start+end<stat.size){let lead=end-1;while(lead>=0&&(buffer[lead]&0xC0)===0x80)lead--;if(lead>=0){const b=buffer[lead],needed=b<0x80?1:b<0xE0?2:b<0xF0?3:4;if(end-lead<needed)end=lead;}}
      return JSON.stringify({text:buffer.subarray(0,end).toString('utf8'),offset:start,nextOffset:start+end<stat.size?start+end:null,totalBytes:stat.size,truncated:start+end<stat.size,complete:start===0&&start+end===stat.size});
    } finally { await handle.close(); }
  }
  owned(id, owner) { const p = this.processes.get(id); if (!p || p.owner !== owner) throw new Error('Unknown process for this conversation'); return p; }
  async start(args, host, owner) {
    if (host.mode === 'plan') throw new Error('Plan mode cannot execute commands');
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000) throw new Error('Invalid command');
    const approval = await host.approveCommand(args.command);
    if (!approval || approval.allow === false) return host.denialReason?.() || 'User rejected the command. Do not retry without a new instruction.';
    host.signal?.throwIfAborted();
    if ([...this.processes.values()].filter(p=>p.owner===owner && p.status==='running').length >= 4) throw new Error('At most four background processes per conversation');
    const execution = approval.execution;
    const id = randomUUID(); const logId=await this.artifact(''); const logPath=path.join(this.directory,logId); let written=0,writeTail=Promise.resolve(); host.signal?.throwIfAborted();
    const finishTracking = await host.trackCommand?.(execution?.cwd || host.root);
    host.signal?.throwIfAborted();
    const child = spawn(execution?.file || process.env.SHELL || (process.platform==='win32'?'cmd.exe':'/bin/sh'), execution?.args || (process.platform==='win32'?['/c',args.command]:['-c',args.command]), {cwd:execution?.cwd||host.root,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:Object.fromEntries(Object.entries(execution?.env||process.env).filter(([key])=> !/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|ZAI_API_KEY)$/.test(key)))});
    const p = {id,owner,turnId:host.turnId,child,status:'running',output:'',startedAt:Date.now(),command:args.command,artifact:logId,events:new EventEmitter()}; this.processes.set(id,p);
    if(host.promotion)p.foregroundOutput='';
    let escalation;
    p.stop = () => { if(p.status!=='running'||p.finishing||escalation)return; const send=s=>{try{process.platform==='win32'?child.kill(s):process.kill(-child.pid,s);}catch{}}; send('SIGTERM'); escalation=setTimeout(()=>send('SIGKILL'),1000);escalation.unref(); };
    const timer=setTimeout(()=>{p.timedOut=true;p.stop();},Math.max(1,Math.min(3600,args.timeout_seconds||600))*1000);timer.unref();
    const capture=b=>{const text=b.toString();host.onOutput?.(text);p.output=(p.output+text).slice(-200000);if(p.foregroundOutput!=null&&p.foregroundOutput.length<24000)p.foregroundOutput+=text.slice(0,24000-p.foregroundOutput.length);if(written<10*1024*1024){const chunk=b.subarray(0,10*1024*1024-written);written+=chunk.length;writeTail=writeTail.then(()=>fs.appendFile(logPath,chunk)).catch(()=>{p.logError=true;});}else p.logTruncated=true;}; child.stdout.on('data',capture);child.stderr.on('data',capture);
    const finish=async(code,error,signal)=>{
      if(p.finishing)return;
      p.finishing=true;clearTimeout(timer);clearTimeout(escalation);host.signal?.removeEventListener('abort',p.stop);
      try { await writeTail; await finishTracking?.(); }
      catch(e){ p.trackingError=String(e?.message||e); }
      p.status=error?'error':'done';p.exitCode=code;p.exitSignal=signal;p.error=error?.message;p.finishedAt=Date.now();
      p.events.emit('finished');
    };
    child.once('error',e=>finish(null,e));child.once('close',(code,signal)=>finish(code,undefined,signal));host.signal?.addEventListener('abort',p.stop,{once:true});
    return JSON.stringify({process_id:id,status:p.status});
  }
  async runInBackground(args,host,owner){
    const launch=await this.start(args,host,owner);
    if(!launch.startsWith('{'))return launch;
    const {process_id:id}=JSON.parse(launch);
    const childProcess=this.owned(id,owner);
    const result=this.commandResult(id,host,owner);
    if(!host.promotion)return result;
    let promote;
    const promoted=new Promise(resolve=>{promote=()=>resolve('promoted');});
    const cleanup=host.promotion(promote);
    try {
      const winner=await Promise.race([result.then(output=>({output})),promoted]);
      if(winner==='promoted')return host.onPromoted({id,result,stop:childProcess.stop});
      const prefix=childProcess.timedOut?'Timed out. ':'';
      return `${prefix}Exit code: ${childProcess.exitCode}\n${childProcess.foregroundOutput}`+
        (childProcess.foregroundOutput.length>=24000?'\n[Output truncated; full log artifact: '+childProcess.artifact+']':'');
    } finally {delete childProcess.foregroundOutput;cleanup();}
  }
  async commandResult(id,host,owner){
    const result=JSON.parse(await this.execute('wait_process',{id,limit:24000},host,owner));
    if(result.status==='running'){
      this.owned(id,owner).stop();
      throw Error('Turn deadline while waiting for the background command. Stop requested; output artifact: '+result.artifact);
    }
    if(result.error)throw Error(result.error+'; output artifact: '+result.artifact);
    return (result.timedOut?'Timed out. ':'')+'Exit code: '+result.exitCode+'\n'+result.output+
      '\n[Background process '+id+'; full log artifact: '+result.artifact+(result.logTruncated?' (log truncated)':'')+']';
  }

  async execute(name,args,host,owner) {
    if(name==='read_artifact')return this.readArtifact(args.id,args.offset,args.limit);
    if(name==='start_process')return this.start(args,host,owner);
    const p=this.owned(args.id,owner);
    if(name==='stop_process'){p.stop();return 'Stop requested';}
    // Old clients calling read_process also wait unless they explicitly ask for a live log.
    const wait = name==='wait_process'||(name==='read_process'&&!args.preview);
    if(wait && p.status==='running'){
      host.signal?.throwIfAborted();
      const requested=args.timeout_ms??Infinity;
      const maxWait=Math.min(requested,(host.deadline??Infinity)-Date.now());
      if(maxWait>0){
        const deadline=Number.isFinite(maxWait)?AbortSignal.timeout(Math.min(3600000,Math.ceil(maxWait))):undefined;
        const signal=host.signal&&deadline?AbortSignal.any([host.signal,deadline]):host.signal||deadline;
        try { await once(p.events,'finished',{signal}); }
        catch(e){ host.signal?.throwIfAborted(); if(!deadline?.aborted)throw e; }
      }
    }
    return JSON.stringify({process_id:p.id,turnId:p.turnId,status:p.status,exitCode:p.exitCode,exitSignal:p.exitSignal,error:p.error,trackingError:p.trackingError,timedOut:p.timedOut||false,output:p.output.slice(-Math.min(24000,args.limit||8000)),artifact:p.artifact,logTruncated:p.logTruncated||false,logError:p.logError||false,durationMs:(p.finishedAt||Date.now())-p.startedAt});
  }
  close(owner) { for(const p of this.processes.values())if(!owner||p.owner===owner)p.stop(); }
}
async function vscodeRipgrep(appRoot) {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const platform = `${process.platform}-${process.arch}`;
  if (appRoot) {
    for (const modules of ['node_modules.asar.unpacked', 'node_modules']) {
      for (const parts of [['ripgrep-universal', 'bin', platform], ['ripgrep', 'bin']]) {
        const candidate = path.join(appRoot, modules, '@vscode', ...parts, binary);
        try {
          await fs.access(candidate, fs.constants.X_OK);
          return candidate;
        } catch {}
      }
    }
  }
  return binary;
}
async function searchNative(root,files,args,signal,rgPath='rg') {
  const realRoot=await fs.realpath(root);
  const limit=Math.max(1,Math.min(500,args.limit||100)),offset=Math.max(0,args.offset||0),results=[]; let seen=0,truncated=false,characters=0;
  // Explicit candidate paths retain the host's excludes and never traverse symlinks outside root.
  for(let start=0;start<files.length;start+=200){
    signal?.throwIfAborted();
    const selected=(await Promise.all(files.slice(start,start+200).map(async f=>{try{const real=await fs.realpath(f);return inside(realRoot,real)&&(!args.excludeProtected||!protectedPath(real)&&!protectedPath(f))&&(await fs.stat(real)).isFile()?real:null;}catch{return null;}}))).filter(Boolean);
    if(!selected.length)continue;
    const result=await new Promise((resolve,reject)=>{
      const argv=['--json','--max-columns','1000',...(args.regex?[]:['--fixed-strings']),...(args.case_sensitive===false?['--ignore-case']:[]),...(args.context?['--context',String(Math.min(5,args.context))]:[]),'--',args.query,...selected];
      const child=spawn(rgPath,argv,{cwd:root,stdio:['ignore','pipe','pipe']});let pending='',error='',capped=false;
      const stop=()=>child.kill();signal?.addEventListener('abort',stop,{once:true});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',b=>{if(capped)return;pending+=b;let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);let event;try{event=JSON.parse(line);}catch{continue;}if(!['match','context'].includes(event.type))continue;if(seen++<offset)continue;const match=`${args.absolutePaths ? event.data.path.text : path.relative(realRoot,event.data.path.text)}:${event.data.line_number}: ${event.data.lines.text.trimEnd().slice(0,600)}`,cost=JSON.stringify(match).length+1;if(results.length>=limit||(results.length&&characters+cost>(args.maxCharacters??10000))){truncated=capped=true;child.kill();break;}results.push(match);characters+=cost;}});
      child.stderr.on('data',b=>error=(error+b).slice(0,1500));child.once('error',reject);child.once('close',code=>{signal?.removeEventListener('abort',stop);if(signal?.aborted)return reject(signal.reason);if(code>1&&!capped)return reject(new Error(error||'Search failed'));resolve();});
    });
    if(truncated)break;
  }
  return JSON.stringify({matches:results,offset,nextOffset:truncated?offset+results.length:null,truncated,scopeTruncated:files.length>=20000});
}
module.exports={Services,searchNative,vscodeRipgrep};
