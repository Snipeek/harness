'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inside, protectedPath, workspacePath, textFile } = require('./tools');

const sourceGlob = '**/*.{js,jsx,mjs,cjs,ts,tsx,py,go,rs,java,kt,cs,rb,php,swift}';
const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx|py|go|rs|java|kt|cs|rb|php|swift)$/i;
const generatedPath = /(?:^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|__pycache__)(?:\/|$)|(?:\.min\.|\.generated\.|\.d\.ts$)/i;
const navigationWords = /архитектур|архитектон|architecture|call[ -]?(?:chain|graph)|data[ -]?flow|проследи|trace (?:the |a )?(?:flow|path|request|call)|(?:входн|точк.{0,4} входа|entry ?point).{0,60}(?:ответ|цепочк|owner|handler)|как.{0,120}(?:устроен|связан|превращается|проходит|попадает)|(?:найди|find).{0,120}(?:владел|координатор|owner|orchestrat)/is;
const commonWords = new Set(['architecture', 'source', 'function', 'files', 'code', 'current', 'where', 'trace', 'what', 'with', 'from', 'into', 'read', 'only', 'request', 'response', 'json', 'module', 'input', 'output']);

function wantsRepositoryMap(request) {
  return navigationWords.test(request);
}

function termsOf(value) {
  return [...new Set((value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])
    .filter(word => !commonWords.has(word)))];
}

function sourceOutline(text) {
  const symbols = [], links = new Map();
  const add = (name, index, kind) => symbols.push({ name, line: index + 1, kind });
  const lines = text.split('\n');
  const comments = /^\s*(?:\/\/|\/\*|\*|#|<!--)/;
  for (const [index, line] of lines.entries()) {
    // This is a navigation hint for common source forms, not a language parser.
    if (comments.test(line)) continue;
    const dependency = line.match(/(?:\bfrom\s*|^\s*import\s*|\brequire\s*\(\s*)['"](\.\.?\/[\w./@-]{1,120})['"]/);
    if (dependency) {
      const imported = links.get(dependency[1]) || new Set();
      const named = line.match(/\bimport\s*\{([^}]+)\}/)?.[1];
      for (const part of named?.split(',') || []) {
        const name = part.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];
        if (name) imported.add(name);
      }
      links.set(dependency[1], imported);
    }
    const endpoint = line.match(/\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"](\/[\w/:.-]{0,100})['"]/i);
    if (endpoint) add(endpoint[1].toUpperCase() + ' ' + endpoint[2], index, 'public');
    const direct = line.match(/^\s*(?:(?:export|default|async|pub|public|internal|static|abstract)\s+)*(?:function\*?|class|interface|type|enum|def|fn|func|struct)\s+([A-Za-z_$][\w$]{0,79})\b/);
    const exported = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]{0,79})\b/);
    const local = line.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]{0,79})\s*=\s*(?:async\s+)?(?:function\b|[^=;]{1,140}=>)/);
    if (exported || direct || local) {
      add((exported || direct || local)[1], index, exported || /^\s*(?:export|pub|public)\b/.test(line) ? 'public' : 'local');
    } else if (/^\s*export\s+default\b/.test(line)) {
      add('default export', index, 'public');
    }
  }
  return { symbols, links };
}

async function compactRepositoryMap(root, request, { findFiles, signal }) {
  const realRoot = await fs.realpath(root);
  const terms = new Set(termsOf(request));
  if (/публичн|public|json[ -]?ответ|json[ -]?response/i.test(request)) {
    terms.add('public');
    terms.add('payload');
  }
  const match = value => termsOf(value).filter(term => terms.has(term)).length;
  const candidates = [...new Set(await findFiles(sourceGlob))]
    .map(file => path.relative(realRoot, file).split(path.sep).join('/'))
    .filter(name => inside(realRoot, path.resolve(realRoot, name)) && sourceFile.test(name) && !generatedPath.test(name) && !protectedPath(name))
    .map(name => ({
      name,
      rank: 7 * match(name) + (/^(?:src\/)?(?:index|main|app|server)\.[^.]+$/i.test(name) ? 4 : 0) -
        (/\b(?:tests?|fixtures|benchmarks?)\b/i.test(name) ? 4 : 0),
      depth: name.split('/').length
    }))
    .sort((a, b) => b.rank - a.rank || a.depth - b.depth || a.name.localeCompare(b.name));
  const byStem = new Map(candidates.map(candidate => [candidate.name.replace(/\.[^.]+$/, ''), candidate]));
  const resolveLink = (record, link) => {
    const stem = path.posix.normalize(path.posix.join(path.posix.dirname(record.name), link)).replace(/\.[^./]+$/, '');
    return byStem.get(stem) || byStem.get(stem + '/index');
  };
  const readCandidate = async candidate => {
    signal?.throwIfAborted();
    try {
      const file = await workspacePath(realRoot, candidate.name);
      const canonical = path.relative(realRoot, file).split(path.sep).join('/');
      if (generatedPath.test(canonical) || protectedPath(canonical)) return null;
      const outline = sourceOutline(await textFile(file));
      return { ...candidate, ...outline, imported: new Set(), proximity: 0 };
    } catch { return null; }
  };
  const seen = new Set();
  const readBatch = async items => {
    for (const { name } of items) seen.add(name);
    return (await Promise.all(items.map(readCandidate))).filter(Boolean);
  };
  const records = await readBatch(candidates.slice(0, 24));
  const priority = record => record.rank + (record.symbols.some(symbol => symbol.name.includes('/') &&
    request.toLowerCase().includes(symbol.name.split(' ')[1].toLowerCase())) ? 12 : 0);
  let frontier = [...records].sort((a, b) => priority(b) - priority(a)).slice(0, 5);
  for (let depth = 0; depth < 2; depth++) {
    const close = new Map();
    for (const record of frontier) {
      for (const [link, imported] of record.links) {
        const target = resolveLink(record, link);
        if (!target) continue;
        const score = target.rank + priority(record) +
          6 * [...imported].reduce((best, symbol) => Math.max(best, match(symbol)), 0);
        if ((close.get(target.name)?.score ?? -Infinity) < score) close.set(target.name, { target, score });
      }
    }
    const nearby = [...close.values()].sort((a, b) => b.score - a.score);
    records.push(...await readBatch(nearby.filter(({ target }) => !seen.has(target.name)).slice(0, 8).map(x => x.target)));
    const indexed = new Map(records.map(record => [record.name, record]));
    frontier = nearby.slice(0, 12).map(({ target }) => indexed.get(target.name)).filter(Boolean);
  }
  signal?.throwIfAborted();

  const valid = records.filter(record => record.symbols.length || record.links.size);
  const targets = new Map(valid.map(record => [record.name, record]));
  for (const record of valid) {
    const bestMatch = record.symbols.reduce((best, symbol) => Math.max(best, match(symbol.name)), 0);
    record.score = record.rank + 6 * bestMatch +
      3 * record.symbols.filter(symbol => symbol.name.includes('/') && request.toLowerCase().includes(symbol.name.split(' ')[1].toLowerCase())).length;
  }
  for (const record of valid) {
    record.linked = [];
    for (const [link, imported] of record.links) {
      const target = targets.get(resolveLink(record, link)?.name);
      if (!target) continue;
      record.linked.push(target);
      for (const name of imported) target.imported.add(name);
      target.proximity = Math.max(target.proximity, Math.min(8, priority(record) / 2));
    }
  }
  const scored = valid.map(record => ({
    record, score: record.score + record.proximity + Math.min(8, Math.max(0, ...record.linked.map(target => target.score)) / 3)
  })).sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
  let result = '';
  for (const { record } of scored.slice(0, 8)) {
    const symbols = record.symbols
      .map(symbol => ({ ...symbol, rank: 6 * match(symbol.name) + (record.imported.has(symbol.name) ? 5 : 0) + (symbol.kind === 'public' ? 2 : 0) }))
      .sort((a, b) => b.rank - a.rank || a.line - b.line)
      .slice(0, 10)
      .sort((a, b) => a.line - b.line)
      .map(({ name, line }) => `${name}@${line}`);
    const imports = record.linked.slice(0, 4).map(target => target.name);
    const row = `${JSON.stringify(record.name)}: ${symbols.join(', ')}${imports.length ? '; imports ' + imports.join(', ') : ''}\n`;
    if (result.length + row.length <= 3100) result += row;
  }
  return result.trim();
}

module.exports = { wantsRepositoryMap, compactRepositoryMap };

// Bounded evidence for relative JS module references. Aliases and computed paths
// need separate inspection before treating a module as unused.
async function moduleReferences(root, paths, { findFiles, signal }) {
  const realRoot=await fs.realpath(root);
  const targets=new Map();
  for(const name of paths){
    const file=await fs.realpath(await workspacePath(realRoot,name));
    if(protectedPath(file)||!(await fs.stat(file)).isFile())throw Error('Choose an ordinary project source file.');
    targets.set(file,{path:path.relative(realRoot,file),references:[]});
  }
  const files=[...new Set(await findFiles('**/*.{js,jsx,mjs,cjs,ts,tsx}'))]
    .filter(file=>inside(realRoot,file)&&!protectedPath(file)&&!generatedPath.test(path.relative(realRoot,file)));
  let read=0,skipped=0,computed=0;
  for(const name of files.slice(0,320)){
    signal?.throwIfAborted();
    let file,source;
    try {
      file=await fs.realpath(await workspacePath(realRoot,name));
      if(protectedPath(file)||(await fs.stat(file)).size>400000){skipped++;continue;}
      source=await textFile(file);
    }catch{skipped++;continue;}
    read++;
    const lines=source.split('\n');
    for(const [index,line] of lines.entries()){
      if(/^\s*(?:\/\/|\/\*|\*)/.test(line))continue;
      if(/\b(?:import|require)\s*\(\s*[^'"\s]/.test(line))computed++;
      for(const match of line.matchAll(/(?:\bfrom\s*|^\s*import\s*|\b(?:import|require)\s*\(\s*)['"](\.\.?\/[^'"\s]+)['"]/g)){
        const base=path.resolve(path.dirname(file), match[1]);
        for(const [target,result] of targets){
          const stem=target.replace(/\.[^.\/]+$/,'');
          if(target!==base&&stem!==base&&stem!==path.join(base,'index'))continue;
          result.count=(result.count||0)+1;
          if(result.references.length<25)result.references.push({path:path.relative(realRoot,file),line:index+1,specifier:match[1]});
        }
      }
    }
  }
  return {modules:[...targets.values()].map(module=>({count:0,...module})),coverage:{sourceFilesFound:files.length,filesRead:read,
    filesSkipped:skipped+Math.max(0,files.length-320),computedCallsObserved:computed},
    limitation:'Text scan of relative JS/TS imports. Check aliases, symlinked imports, computed paths, scripts, configuration and external consumers separately before removal.'};
}
module.exports.moduleReferences=moduleReferences;

async function repositoryDocs(root, { query='', directory='.', limit=6 } = {}, { findFiles, signal }) {
  const realRoot = await fs.realpath(root);
  const scope = await fs.realpath(await workspacePath(realRoot,directory));
  const rel = file => path.relative(realRoot,file).split(path.sep).join('/');
  const words = text => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)||[])];
  const wanted = new Set(words(query));
  const relevance = text => words(text).filter(word=>wanted.has(word)).length;
  const mentions = [...query.matchAll(/(?:^|[^\p{L}\d_])([\w.-]+(?:\/[\w.-]+)+)/gu)].map(match=>match[1]);
  const candidates = [...new Set(await findFiles('**/{README,README.*,readme,readme.*,Readme,Readme.*}',scope))]
    .filter(file=>inside(scope,file) && !generatedPath.test(rel(file)) && !protectedPath(rel(file)) &&
      /^readme(?:(?:\.[\da-z_-]+)*\.(?:md|mdx|markdown|rst|txt))?$/i.test(path.basename(file)))
    .map(file=>({ file, name:rel(file), parent:path.posix.dirname(rel(file)) }))
    .map(item=>({ ...item, rank:(item.parent==='.'?14:0) + 4*relevance(item.name) +
      12*Number(item.parent!=='.' && mentions.some(value=>value===item.parent||value.startsWith(item.parent+'/'))) }))
    .sort((a,b)=>b.rank-a.rank || a.name.split('/').length-b.name.split('/').length || a.name.localeCompare(b.name));
  const docs = (await Promise.all(candidates.slice(0,16).map(async item=>{
    signal?.throwIfAborted();
    try{
      if(await fs.realpath(item.file)!==item.file || !(await fs.stat(item.file)).isFile())return null;
      const handle=await fs.open(item.file,'r');
      let text;
      try{
        const buffer=Buffer.alloc(8192);
        const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
        text=buffer.subarray(0,bytesRead).toString('utf8');
      }finally{await handle.close();}
      if(text.includes('\0'))return null;
      const headings=[];
      const links=new Set();
      let fence;
      for(const [index,line] of text.split('\n').entries()){
        const marker=line.trim().match(/^(`{3,}|~{3,})/)?.[1][0];
        if(marker){if(!fence)fence=marker;else if(fence===marker)fence=undefined;continue;}
        if(fence)continue;
        const heading=line.match(/^\s{0,3}#{1,6}\s+(\S.*)$/)?.[1]?.replace(/[<>]/g,'').trim().slice(0,95);
        if(heading && headings.length<24)headings.push({line:index+1,title:heading});
        for(const match of line.matchAll(/\]\(([^\s)#]+\.(?:md|mdx|rst))(?:#[^)]*)?\)/gi)){
          if(links.size>=8 || /^(?:[a-z]+:|\/)/i.test(match[1]))continue;
          const linked=path.posix.normalize(path.posix.join(item.parent,match[1]));
          if(linked.startsWith('../') || generatedPath.test(linked) || protectedPath(linked))continue;
          const target=path.join(realRoot,linked);
          if(await fs.realpath(target).catch(()=>null)===target)links.add(linked);
        }
      }
      headings.sort((a,b)=>relevance(b.title)-relevance(a.title)||a.line-b.line);
      return {path:item.name,rank:item.rank+Math.min(9,3*relevance(headings.slice(0,6).map(h=>h.title).join(' '))),
        headings:headings.slice(0,4).sort((a,b)=>a.line-b.line),links:[...links].slice(0,4)};
    }catch(error){signal?.throwIfAborted();return null;}
  }))).filter(Boolean).sort((a,b)=>b.rank-a.rank || a.path.localeCompare(b.path));
  signal?.throwIfAborted();
  const selected=docs.slice(0,Math.max(1,Math.min(12,limit)));
  return { found:candidates.length, scanned:docs.length, docs:selected.map(({rank,...doc})=>doc) };
}

module.exports.repositoryDocs=repositoryDocs;
