'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const path=require('node:path');
const git=promisify(execFile);

async function createAgentWorktree(root, storage, agentId) {
  const run=(args)=>git('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',root,...args],{timeout:60000,maxBuffer:1024*1024});
  const top=(await run(['rev-parse','--show-toplevel'])).stdout.trim();
  if(await fs.realpath(top)!==await fs.realpath(root)) throw Error('Worktree isolation requires opening the Git repository root.');
  const commit=(await run(['rev-parse','--verify','HEAD'])).stdout.trim();
  const directory=path.join(storage,agentId);
  await fs.mkdir(storage,{recursive:true,mode:0o700});
  await run(['worktree','add','--detach',directory,commit]);
  return {directory:await fs.realpath(directory),commit};
}

module.exports={createAgentWorktree};
