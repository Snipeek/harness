'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
// Fail closed when explicitly selected; never silently execute outside the sandbox.
async function sandboxExecution(root, execution, command, enabled) {
 if(!enabled)return execution;
 if(process.platform!=='darwin')throw new Error('Workspace sandbox currently requires macOS. Disable it explicitly to use normal reviewed commands.');
 const real=await fs.realpath(root),quote=s=>JSON.stringify(s);
 const home=await fs.realpath(os.homedir());
 const profile=`(version 1)(allow default)(deny network*)(deny file-write* (require-all (require-not (subpath ${quote(real)})) (require-not (subpath "/private/tmp")) (require-not (literal "/dev/null"))))(deny file-read-data (require-all (subpath ${quote(home)}) (require-not (subpath ${quote(real)}))))`;

 return {file:'/usr/bin/sandbox-exec',args:['-p',profile,execution?.file||'/bin/sh',...(execution?.args||['-c',command])],...(execution?.cwd?{cwd:execution.cwd}:{})};
}
module.exports={sandboxExecution};
