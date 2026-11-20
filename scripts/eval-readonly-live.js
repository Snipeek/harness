'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('./runtime-host');
const { key } = require('./eval-quality');

async function main() {
  const [root, task, output] = process.argv.slice(2);
  const apiKey = await key();
  if (!apiKey) throw Error('No GLM credential');
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-eval-'));
  const host = await createHost({ root, storage, apiKey, settings: { maxToolRounds: 10, maxOutputTokens: 4096 } });
  host.session.mode = 'plan';
  const start = Date.now();
  try {
    await host.send(await fs.readFile(task, 'utf8'));
    const { timeline, usage, metrics } = host.session;
    const report = {
      durationMs: Date.now() - start, usage,
      requests: metrics.filter(m => m.phase === 'generation').length,
      tools: timeline.filter(e => e.role === 'tool').map(({ name, status, input }) => ({ name, status, input })),
      answer: timeline.filter(e => e.role === 'assistant' && e.status === 'done').at(-1)?.text,
      notices: timeline.filter(e => e.role === 'notice').map(e => e.text)
    };
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await host.close();
    await fs.rm(storage, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
