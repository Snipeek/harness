'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
for(const dir of ['src','media','scripts','test'])for(const f of fs.readdirSync(dir))if(/\.(js|cjs)$/.test(f)){const r=spawnSync(process.execPath,['--check',path.join(dir,f)],{stdio:'inherit'});if(r.status)process.exit(r.status);}
const r=spawnSync(process.execPath,['--check','extension.js'],{stdio:'inherit'});process.exit(r.status);
