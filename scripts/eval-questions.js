'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('./runtime-host');
const { key } = require('./eval-quality');

const cases = [
  {
    id: 'conflict-policy',
    fixture: 'exports.save = note => note;\n// Existing notes have an id and text. No sync or conflict policy exists.\n',
    prompt: 'Read notes.js and plan offline sync for notes edited on two devices at the same time. We have not decided what the user should see after conflicting edits. Do not edit files.'
  },
  {
    id: 'specific-label',
    fixture: 'exports.label = "Retry";\n',
    prompt: 'Read notes.js and describe the one-line change to replace the exact label Retry with Try again. Do not edit files.'
  }
];

async function run(output) {
  const apiKey = await key();
  if (!apiKey) throw Error('GLM key unavailable');
  const results = [];
  for (const fixture of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-question-eval-'));
    const started = Date.now();
    try {
      await fs.writeFile(path.join(root, 'notes.js'), fixture.fixture);
      const host = await createHost({
        root, storage: path.join(root,'.storage'), apiKey,
        settings: {glmModel:'glm-5.3',glmBaseUrl:'https://api.z.ai/api/paas/v4',
          reasoningEffort:'low', effortPolicy:'fixed', maxToolRounds:10, turnTimeoutSeconds:120}
      });
      host.session.mode = 'plan';
      const questions = [];
      host.app.approve = async (_session, details) => {
        if (details.kind !== 'question') return false;
        questions.push({question:details.question, options:details.options, after:host.session.timeline
          .filter(event=>event.role==='tool'&&event.status==='done').map(event=>event.name)});
        return fixture.id === 'conflict-policy' && questions.length === 1
          ? {answer:'Keep both conflicting versions visible so neither edit disappears; let the user choose later.',source:'custom'}
          : false;
      };
      const timer = setTimeout(() => host.app.runs.get(host.session.id)?.abort(Error('Question evaluation timed out')), 120000);
      try {
        await host.send(fixture.prompt);
        const {timeline,usage,plan,metrics} = host.session;
        results.push({task:fixture.id,questions,usage,durationMs:Date.now()-started,
          models:[...new Set(metrics.map(metric=>metric.actualModel).filter(Boolean))],
          answer:timeline.filter(event=>event.role==='assistant'&&event.text).at(-1)?.text,
          notices:timeline.filter(event=>event.role==='notice').map(event=>event.text),plan});
      } finally {
        clearTimeout(timer);
        await host.close();
      }
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  }
  await fs.writeFile(output,JSON.stringify(results,null,2));
  console.log(results.map(row=>({task:row.task,questions:row.questions.length,durationMs:row.durationMs,models:row.models})));
}

if (!process.argv[2]) throw Error('Provide a report path for the live evaluation');
run(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
