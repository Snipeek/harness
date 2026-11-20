'use strict';
// Fixed evaluator entry point, outside the agent workspace. No test mutation.
const fs=require('node:fs'),{gradeCode,gradeModules}=require('./quality-grader');
const [root,checkFile]=process.argv.slice(2);
const source=fs.readFileSync(require('node:path').join(root,'main.js'),'utf8'),checks=JSON.parse(fs.readFileSync(checkFile,'utf8'));
const result=checks.kind==='module'?gradeModules(Object.fromEntries(fs.readdirSync(root).filter(f=>/\.(js|json)$/.test(f)).map(f=>[f,fs.readFileSync(require('node:path').join(root,f),'utf8')])),checks.checks):gradeCode(source,checks);const cases=Array.isArray(checks)?checks:checks.checks;
const named=cases.some(([, ,name])=>name);
const output=named?result.map(({passed,error},index)=>({name:cases[index][2]||'Check '+(index+1),passed,...(error?{error}:{})})):result;
console.log(JSON.stringify(output));process.exitCode=result.every(r=>r.passed)?0:1;
