'use strict';
const { spawn } = require('node:child_process');
const { access } = require('node:fs/promises');
const { constants } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

async function codexExecutable() {
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const directories = (process.env.PATH || '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
  const candidates = directories.map(directory => path.join(directory, name));
  if (process.platform === 'darwin') {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  }
  for (const executable of candidates) {
    if (await access(executable, constants.X_OK).then(() => true, () => false)) return executable;
  }
}

function quotaWindows(result) {
  const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!snapshot || (snapshot.limitId && snapshot.limitId !== 'codex')) return [];
  return [snapshot.primary, snapshot.secondary]
    .filter(window => Number.isFinite(window?.usedPercent) &&
      Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0)
    .map(window => ({
      pct: window.usedPercent,
      minutes: window.windowDurationMins,
      resetAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt * 1000 : undefined
    }))
    .sort((left, right) => left.minutes - right.minutes);
}

async function readCodexQuota(signal) {
  const executable = await codexExecutable();
  if (!executable || signal?.aborted) return [];
  const { OPENAI_API_KEY, ...env } = process.env;
  return new Promise(resolve => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: homedir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    });
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish([]), 10000);
    const abort = () => finish([]);
    let settled = false;
    function finish(windows) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
      resolve(windows);
    }
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', abort);
    child.once('close', abort);
    child.stdin.on('error', abort);
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.id === 1) {
        if (!message.result) return finish([]);
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message?.id === 2) {
        finish(quotaWindows(message.result));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'harness', version: '1.0.0' } } });
  });
}

module.exports = { readCodexQuota, quotaWindows };
