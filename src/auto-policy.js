'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { autoPath, protectedPath, workspacePath } = require('./tools');
function words(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\n\r\0$`;|&><()*?\[\]{}!~]/.test(command)) return null;
  const result = []; let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { if (c === quote) quote = ''; else if (c === '\\' && quote === '"') return null; else word += c; started = true; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { result.push(word); word = ''; started = false; } }
    else if (c === '\\') return null;
    else { word += c; started = true; }
  }
  if (quote) return null; if (started) result.push(word); return result;
}
const specs = {
  pwd: { file: '/bin/pwd', flag: /^-[LP]$/ },
  ls: { file: '/bin/ls', flag: /^-[aAlhRrtSdFp1]+$/ },
  cat: { file: '/bin/cat', flag: /^-[bensTuv]+$/ },
  head: { file: '/usr/bin/head', flag: /^-(?:n\d{1,5}|\d{1,5})$/ },
  tail: { file: '/usr/bin/tail', flag: /^-(?:n\d{1,5}|\d{1,5})$/ },
  wc: { file: '/usr/bin/wc', flag: /^-[clmw]+$/ }
};
const { diagnosticExecution, tokens, shellQuote } = require('./diagnostic-policy');
async function readExecution(args, root, piped = false) {
  if (args?.[0] === 'sed' && process.platform !== 'win32') {
    const [, flag, script, ...files] = args;
    if (flag !== '-n' || !/^\d{1,9}(?:,\d{1,9})?p$/.test(script) || files.length !== 1 || files[0].startsWith('-')) {
      throw Error('Auto allows sed only for printing a numeric line range from one file.');
    }
    const file = await checkedReadPath(root, files[0], true);
    return { file: '/usr/bin/sed', args: ['-n', script, file] };
  }
  const spec = args && Object.hasOwn(specs, args[0]) ? specs[args[0]] : null;
  if (!spec || process.platform === 'win32') throw Error('This command may execute code, modify data, or use shell features.');
  const operands = [];
  for (let i = 1; i < args.length; i++) {
    if (['head', 'tail'].includes(args[0]) && args[i] === '-n' && /^\d{1,5}$/.test(args[i + 1] || '')) { i++; continue; }
    if (args[i].startsWith('-')) {
      if (!spec.flag.test(args[i])) throw Error('This command option needs review.');
    } else operands.push(args[i]);
  }
  if (args[0] === 'pwd' && operands.length) throw Error('Unexpected pwd arguments.');
  if (['cat', 'head', 'tail', 'wc'].includes(args[0]) && !operands.length && !piped) throw Error('An explicit workspace file is required.');
  const realRoot = await fs.realpath(root);
  for (const operand of operands) {
    const resolved = await checkedReadPath(realRoot, operand, args[0] !== 'ls');
    if (operand.startsWith('~/')) args = args.map(arg => arg === operand ? resolved : arg);
  }
  return { file: spec.file, args: args.slice(1) };
}
async function checkedReadPath(root, operand, regular) {
  const resolved = await fs.realpath(await autoPath(root, operand));
  if (protectedPath(operand) || protectedPath(resolved)) throw Error('The command reads settings or credential files.');
  if (regular && !(await fs.stat(resolved)).isFile()) throw Error('A regular file is required.');
  return resolved;
}

const checkReason = 'Standard verification command in a trusted workspace.';
async function projectCheck(args, cwd, root) {
  if (!args || process.platform === 'win32') return null;
  const script = args.length === 2 && args[0] === 'npm' && args[1] === 'test' ? 'test' :
    args.length === 3 && args[0] === 'npm' && args[1] === 'run' ? args[2] : null;
  if (['test', 'test:unit', 'typecheck', 'type-check', 'check:types'].includes(script)) {
    const manifest = await workspacePath(root, path.join(cwd, 'package.json'));
    const { scripts } = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (typeof scripts?.[script] !== 'string' || !scripts[script].trim()) return null;
    return { file: 'npm', args: ['--ignore-scripts', 'run', script], cwd };
  }
  if (args[0] === 'node' && args[1] === '--test') {
    const files = args.slice(2);
    if (files.some(file => file.startsWith('-'))) return null;
    const paths = await Promise.all(files.map(async file => checkedReadPath(root, await workspacePath(root, path.resolve(cwd, file)), true)));
    return { file: 'node', args: ['--test', ...paths], cwd };
  }
  const invocation = args[0] === 'npx' ? args.slice(1) : args;
  if (invocation[0] !== 'tsc') return null;
  const flags = invocation.slice(1);
  if (flags.length !== 1 && flags.length !== 3) return null;
  const noEmit = flags.indexOf('--noEmit');
  if (noEmit < 0) return null;
  flags.splice(noEmit, 1);
  if (flags.length) {
    if (!['-p', '--project'].includes(flags[0]) || flags[1].startsWith('-')) return null;
    const config = await checkedReadPath(root, await workspacePath(root, path.resolve(cwd, flags[1])), false);
    flags[1] = (await fs.stat(config)).isDirectory() ?
      await checkedReadPath(root, await workspacePath(root, path.join(config, 'tsconfig.json')), true) : config;
  }
  const compiler = require.resolve('typescript/bin/tsc', { paths: [cwd] });
  const localCompiler = await checkedReadPath(root, await workspacePath(root, compiler), true);
  return { file: 'node', args: [localCompiler, '--noEmit', ...flags], cwd };
}

async function checkExecution(command, root) {
  const parsed = tokens(command, true);
  if (!parsed?.length) return null;
  const firstOperator = parsed.findIndex(part => part.op);
  if (firstOperator < 0) return projectCheck(words(command), root, root);
  if (firstOperator !== 2 || parsed[0].word !== 'cd' || parsed[1].word.startsWith('-') || parsed[2].op !== '&&') return null;
  const rest = parsed.slice(3);
  if (rest.some(part => part.op)) return null;
  const cwd = await checkedReadPath(root, await workspacePath(root, parsed[1].word), false);
  if (!(await fs.stat(cwd)).isDirectory()) return null;
  return projectCheck(rest.map(part => part.word), cwd, root);
}

async function readChain(command, root) {
  const parsed = tokens(command, true);
  if (!parsed?.some(part => part.op)) return null;
  const commands = [[]], operators = [];
  for (const part of parsed) {
    if (!part.op) { commands.at(-1).push(part.word); continue; }
    if (!commands.at(-1).length || commands.length >= 8) return null;
    operators.push(part.op);
    commands.push([]);
  }
  if (!commands.at(-1).length) return null;
  let cwd;
  if (commands[0][0] === 'cd') {
    if (commands[0].length !== 2 || operators[0] !== '&&' || commands[0][1].startsWith('-')) return null;
    cwd = await checkedReadPath(root, commands.shift()[1], false);
    if (!(await fs.stat(cwd)).isDirectory()) return null;
    operators.shift();
    root = cwd;
  }
  const validated = await Promise.all(commands.map((args, i) => readExecution(args, root, operators[i - 1] === '|')));
  if (validated.length === 1) return { ...validated[0], cwd };
  const script = validated.map(({ file, args }, i) => {
    const invocation = [file, ...args].map(shellQuote).join(' ');
    return invocation + (operators[i] ? ' ' + operators[i] + ' ' : '');
  }).join('');
  return { file: '/bin/sh', args: ['-c', script], ...(cwd ? { cwd } : {}) };
}
async function assessAction(details, root) {
  const ask = reason => ({ allow: false, reason });
  if (!root) return ask('No workspace is selected.');
  if (details.kind === 'edit') {
    try {
      const file = await autoPath(root, details.change?.file || '');
      const real = await fs.realpath(file).catch(error => { if (error.code === 'ENOENT') return file; throw error; });
      if (protectedPath(file) || protectedPath(real)) return ask('This file controls project settings or may contain credentials.');
      return { allow: true, reason: 'Ordinary project file edit.' };
    } catch (error) { return ask(error.message); }
  }
  if (details.kind !== 'command') return ask('This action needs review.');
  const diagnostic=diagnosticExecution(details.detail);if(diagnostic)return {allow:true,reason:'Read-only network diagnostic with fixed executables and no shell expansion.',execution:diagnostic};
  try {
    if (details.allowProjectChecks) {
      const check = await checkExecution(details.detail, root).catch(() => null);
      if (check) return { allow: true, reason: checkReason, execution: check };
    }
    const args = words(details.detail);
    const execution = args ? await readExecution(args, root) : await readChain(details.detail, root);
    if (!execution) return ask('This command may execute code, modify data, or use shell features.');
    return { allow: true, reason: 'Read-only command with validated arguments.', execution };
  } catch (error) { return ask(error.message); }
}

function callsRm(command) {
  const mentionsRm = text => /(?:^|[\s/;|&()<>=`$])rm(?=$|[\s;|&()<>`])/.test(text.replace(/\\\n/g, '').replace(/['"\\]/g, ''));
  const parsed = tokens(command, true);
  if (!parsed) return mentionsRm(command);
  let invocation = [];
  for (const part of [...parsed, {op:';'}]) {
    if (!part.op) {
      invocation.push(part.word);
      continue;
    }
    const head = invocation.findIndex(word => !/^(?:(?:if|then|elif|else|while|until|do|!)$|\w+=)/.test(word));
    const name = path.posix.basename(invocation[head] ?? '');
    const args = invocation.slice(head+1);
    if (name==='rm') return true;
    if (name==='git' && args.find((word,index)=>!word.startsWith('-') &&
        !['-C','-c','--git-dir','--work-tree','--namespace','--config-env'].includes(args[index-1]))==='rm') return true;
    if (name==='find' && args.some((word,index)=>['-exec','-execdir','-ok','-okdir'].includes(word) &&
        path.posix.basename(args[index+1] ?? '')==='rm')) return true;
    if (['sudo','env','time','timeout','nice','command','exec','xargs','nohup'].includes(name) &&
        args.some(word=>path.posix.basename(word)==='rm')) return true;
    if (['sh','bash','zsh','dash','ksh','fish','eval'].includes(name) &&
        args.some(mentionsRm)) return true;
    invocation = [];
  }
  return false;
}

async function assessAutoAction(details, root, trusted) {
  if (details.kind !== 'command') return assessAction(details, root);
  if (!root || !trusted) return {allow:false,reason:'Auto shell commands require a trusted workspace.'};
  if (callsRm(details.detail)) return {allow:false,reason:'Auto requires confirmation for rm.'};
  const validated = await assessAction({...details,allowProjectChecks:true},root);
  return validated.allow ? validated : {allow:true,reason:'Shell command allowed by Auto.'};
}

module.exports = { assessAction, assessAutoAction, words, protectedPath };
