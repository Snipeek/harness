'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inside } = require('./tools');

const git = promisify(execFile);
const skippedDirectories = new Set(['.git', 'node_modules', '.venv', '.next', '.cache']);
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);

async function standaloneFiles(root) {
  const files = [];
  const walk = async (directory, relative) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (skippedDirectories.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else files.push(name);
      if (files.length > 20000) throw Error('Workspace exceeds the 20,000-file command tracking limit.');
    }
  };
  await walk(root, '');
  return files;
}

async function fileState(root, name) {
  const file = path.resolve(root, name);
  if (!inside(root, file)) throw Error('Git returned a path outside the workspace.');
  try {
    const parent = await fs.realpath(path.dirname(file));
    if (parent !== path.dirname(file)) throw Error('Workspace file has a symbolic parent directory.');
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return 'symlink:' + createHash('sha256').update(await fs.readlink(file)).digest('hex');
    if (stat.isDirectory()) return 'directory';
    if (!stat.isFile()) return 'special:' + stat.mode;
    const digest = createHash('sha256');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw Error('Workspace file changed type while tracking.');
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) digest.update(chunk);
      return 'file:' + (opened.mode & 0o111) + ':' + digest.digest('hex');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function snapshotWorkspace(directory) {
  const root = await fs.realpath(directory);
  let names;
  let scope = 'git-visible files';
  try {
    const { stdout } = await git('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
      cwd: root, encoding: 'buffer', timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true
    });
    const paths = stdout.toString('utf8');
    if (!Buffer.from(paths).equals(stdout)) throw Error('Git returned a path that is not valid UTF-8.');
    names = [...new Set(paths.split('\0').filter(Boolean))];
  } catch (error) {
    if (error.code !== 'ENOENT' && !/not a git repository/i.test(error.stderr || '')) throw error;
    names = await standaloneFiles(root);
    scope = 'workspace files excluding dependency and cache directories';
  }
  if (names.length > 20000) throw Error('Workspace exceeds the 20,000-file command tracking limit.');
  const files = new Map();
  for (let start = 0; start < names.length; start += 32) {
    const group = names.slice(start, start + 32);
    const states = await Promise.all(group.map(name => fileState(root, name)));
    group.forEach((name, index) => files.set(name, states[index]));
  }
  return { root, files, scope };
}

function workspaceChanges(before, after) {
  return [...new Set([...before.files.keys(), ...after.files.keys()])].sort().flatMap(name => {
    const previous = before.files.get(name) ?? null;
    const current = after.files.get(name) ?? null;
    return previous === current ? [] : [{ path: name, before: previous, after: current }];
  });
}

module.exports = { snapshotWorkspace, workspaceChanges, fileState };
