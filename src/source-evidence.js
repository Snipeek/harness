'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { workspacePath, autoPath, inside, textFile } = require('./tools');

const hash = value => createHash('sha256').update(value).digest('hex');

async function fingerprints(root, paths, recordedPaths = []) {
  const recorded = new Set(recordedPaths);
  return Object.fromEntries(await Promise.all([...new Set(paths)].map(async name => {
    const file = await (recorded.has(name) ? autoPath : workspacePath)(root, name);
    try { return [name, hash(await fs.readFile(file))]; }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error; }
  })));
}

async function verifySourceEdges(root, edges) {
  const files = new Map();
  const locate = async reference => {
    if (!files.has(reference.path)) {
      files.set(reference.path, workspacePath(root, reference.path).then(textFile).then(text => ({
        lines: text.split(/\r?\n/), sha256: hash(text)
      })));
    }
    const { lines, sha256 } = await files.get(reference.path);
    const location = { path: reference.path, line: reference.line };
    const line = lines[reference.line - 1];
    if (line === undefined) return { ...location, status: 'out_of_range', totalLines: lines.length };
    const excerpt = line.trim();
    const supplied = reference.excerpt?.trim();
    const status = supplied && !line.includes(supplied) ? 'excerpt_mismatch' : 'located';
    return { ...location, status, excerpt: excerpt.slice(0, 360), ...(excerpt.length > 360 ? { truncated: true } : {}), sha256 };
  };
  const resolve = async reference => {
    try { return await locate(reference); }
    catch (error) { return { path: reference.path, line: reference.line, status: 'unavailable', error: error.message }; }
  };
  return Promise.all(edges.map(async edge => ({
    caller: edge.caller,
    callee: edge.callee,
    call: await resolve(edge.call),
    definition: await resolve(edge.definition),
    ...(edge.condition ? { condition: await resolve(edge.condition) } : {})
  })));
}

async function reviewSourceChange(root, { path: name, line, before, after }) {
  if (!Number.isInteger(line) || line < 1 || typeof before !== 'string' ||
      !before.trim() || before.length > 2400 || before.split('\n').length > 24 ||
      typeof after !== 'string' || after.length > 2400) {
    throw Error('Provide a line number and a small exact before/after replacement.');
  }
  const file = await workspacePath(root, name);
  const lines = (await textFile(file)).replace(/\r\n/g, '\n').split('\n');
  const original = before.replace(/\r\n/g, '\n').trimEnd();
  const replacement = after.replace(/\r\n/g, '\n').trimEnd();
  const start = line - 1;
  const count = original.split('\n').length;
  const current = lines.slice(start, start + count).join('\n').trimEnd();
  const location = { path: name, line };
  const context = () => lines.slice(Math.max(0, start - 3), start + count + 3)
    .map((text, index) => ({ line: Math.max(0, start - 3) + index + 1, text: text.slice(0, 240) }));
  if (current !== original) return { ...location, status: 'source_mismatch', context: context() };

  // An exact duplicate wrapper can slip in even when the old text matches.
  const at = replacement.indexOf(original.trimStart());
  const prefix = at > 0 ? replacement.slice(0, at).trim() : '';
  const guard = prefix.match(/^(if\s*\(.+\))\s*\{?$/)?.[1];
  const compactGuard = guard?.replace(/^if\s*/, 'if');
  const sameGuardAt = text => compactGuard && text.trimStart().replace(/^if\s*/, 'if').startsWith(compactGuard);
  const immediateParent = start > 0 && lines[start - 1].trimEnd().endsWith('{') && lines[start - 1].match(/^\s*/)[0].length < lines[start].match(/^\s*/)[0].length
    ? lines[start - 1] : '';
  if (replacement === original || sameGuardAt(original) || sameGuardAt(immediateParent)) {
    return { ...location, status: 'already_present', context: context() };
  }
  return { ...location, status: 'distinct_source_change', notice: 'The replacement is distinct at this location. Check equivalent behavior in callers and helpers before recommending it.' };
}

async function nestedRules(root, target, external = false) {
  const file = await (external ? autoPath : workspacePath)(root, target);
  let realRoot = await fs.realpath(root);
  const outside = !inside(realRoot, file);
  if (outside) {
    let directory = path.dirname(file);
    while (path.dirname(directory) !== directory) {
      try { await fs.stat(path.join(directory, '.git')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = path.dirname(directory);
    }
    realRoot = path.dirname(directory) === directory ? path.dirname(file) : directory;
    while (true) {
      try { await fs.access(realRoot); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      realRoot = path.dirname(realRoot);
    }
  }
  const relative = path.relative(realRoot, path.dirname(file));
  const rules = [];
  let directory = '';
  for (const part of [...(outside ? [''] : []), ...relative.split(path.sep).filter(Boolean)]) {
    directory = path.join(directory, part);
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      const name = path.join(directory, filename);
      try {
        const rule = await workspacePath(realRoot, name);
        rules.push({ path: outside ? rule : name, content: await textFile(rule) });
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return rules;
}

module.exports = { fingerprints, verifySourceEdges, reviewSourceChange, nestedRules, hash };
