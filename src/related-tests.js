'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inside, protectedPath, textFile, workspacePath } = require('./tools');

const codePath = /[\w.-]+(?:\/[\w.-]+)+\.(?:[cm]?[jt]sx?|py|go|rs|java|swift)\b/g;
const testName = /[._-](?:test|spec)\.[^/]+$|(?:^|\/)(?:tests?|specs|__tests__|train)\//i;
const stripExtension = name => name.replace(/\.[^./]+$/, '');

function mentionedCodePaths(request) {
  const expanded = request.replace(/([\w./-]+\/)\{([\w.-]+(?:,[\w.-]+)+)\}(\.\w+)/g,
    (_, folder, names, extension) => names.split(',').map(name=>folder+name+extension).join(' '));
  return [...new Set(expanded.match(codePath)||[])];
}

function relatedSymbols(lines, test, sourcePaths) {
  const targets = new Set(sourcePaths.map(stripExtension));
  const names = new Set();
  for(const line of lines){
    const specifier = line.match(/['"](\.\.?\/[^'"\n]+)['"]/)?.[1];
    if(!specifier || !targets.has(stripExtension(path.posix.join(path.posix.dirname(test),specifier))))continue;
    const group = line.match(/\{([^{}]+)\}/)?.[1];
    for(const member of group?.split(',')||[]){
      const symbol = member.trim().split(/\s+(?:as\s+)?|:\s*/).at(-1);
      if(/^[A-Za-z_$][\w$]{2,}$/.test(symbol||''))names.add(symbol);
    }
  }
  return names;
}

function assertionWindow(lines, symbols) {
  const width = Math.min(lines.length,38);
  const matches = lines.map(line=>{
    if(/^\s*(?:import|\/\/)/.test(line)||/\b(?:import|require)\s*\(/.test(line))return 0;
    const names=line.match(/[A-Za-z_$][\w$]*/g)||[];
    const assertion=/\b(?:assert|expect|ok)\b/.test(line);
    return names.some(name=>symbols.has(name)) ? assertion?7:4 : assertion?1:0;
  });
  let start=0,best=-1,score=matches.slice(0,width).reduce((sum,value)=>sum+value,0);
  for(let i=0;i<=lines.length-width;i++){
    if(score>best){best=score;start=i;}
    score+=(matches[i+width]||0)-matches[i];
  }
  return {start,end:start+width};
}

async function relatedTestEvidence(root, sourcePaths, configured, {findFiles,signal}) {
  const realRoot=await fs.realpath(root);
  const isTest=name=>testName.test(name)&&/\.[cm]?[jt]sx?$/.test(name);
  const targets=sourcePaths.filter(name=>!isTest(name));
  const hints=[...new Set([...configured,...sourcePaths.filter(isTest)])];
  if(!targets.length && !hints.length)return [];
  const rankName=name=>{
    const stem=stripExtension(path.posix.basename(name)).replace(/(?:[._-](?:test|spec|check))+$/i,'');
    const key=stem.toLowerCase().replaceAll('_','-');
    return targets.some(target=>stripExtension(path.posix.basename(target)).toLowerCase().replaceAll('_','-')===key)?1:0;
  };
  const stems = [...new Set(targets.slice(0,8).flatMap(target=>{
    const name=stripExtension(path.posix.basename(target));
    return [name,name.replaceAll('-','_'),name.replaceAll('_','-')];
  }))];
  const names=stems.flatMap(stem=>[stem,...['.test','_test','-test','.spec','_spec','-spec','_check'].map(suffix=>stem+suffix)]);
  const candidates=hints.length?hints.slice(0,3):(await findFiles(`**/{${names.join(',')}}.{js,mjs,cjs,ts,tsx}`))
    .filter(file=>inside(realRoot,file))
    .map(file=>path.relative(realRoot,file).split(path.sep).join('/'))
    .filter(name=>isTest(name)&&rankName(name)).sort().slice(0,12);
  const results=[];
  let remaining=4400;
  for(const name of candidates){
    signal?.throwIfAborted();
    if(results.length>=2 || remaining<500)break;
    if(protectedPath(name)||/(?:^|\/)(?:node_modules|vendor|dist|build)\//.test(name))continue;
    const file=await workspacePath(realRoot,name).catch(()=>null);
    if(!file||await fs.realpath(file).catch(()=>null)!==file)continue;
    const text=await textFile(file).catch(()=>null);
    if(!text)continue;
    const lines=text.split('\n');
    const symbols=relatedSymbols(lines,name,targets);
    const {start,end}=assertionWindow(lines,symbols);
    let content='';
    for(let i=start;i<end;i++){
      const line=(i+1)+': '+lines[i]+'\n';
      if(content.length+line.length>remaining)break;
      content+=line;
    }
    if(!content)continue;
    results.push({path:name,revision:createHash('sha256').update(text).digest('hex').slice(0,16),content});
    remaining-=content.length;
  }
  return results;
}

module.exports={mentionedCodePaths,relatedTestEvidence};
