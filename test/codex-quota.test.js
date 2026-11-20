'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { quotaWindows } = require('../src/codex-quota');

test('the sidebar displays actual GLM and Codex limits and omits unavailable windows', () => {
  const { window, document } = parseHTML(fs.readFileSync('media/sidebar.html', 'utf8'));
  const context = vm.createContext({
    window, document, setInterval() {},
    acquireVsCodeApi: () => ({ getState: () => ({}), postMessage() {} })
  });
  for (const file of ['media/icons.js', 'media/sidebar.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const render = codexQuota => {
    const event = new window.Event('message');
    event.data = {
      type: 'state', provider: 'chatgpt', configured: true, sessions: [], groups: [], usageByProvider: {},
      quota: [{ pct: 1, resetAt: 1795384978000 }], codexQuota
    };
    window.dispatchEvent(event);
    return [...document.querySelectorAll('#meters .meter')];
  };
  const weekly = { usedPercent: 53, windowDurationMins: 10080, resetsAt: 1795384978 };
  const snapshot = { limitId: 'codex', primary: weekly, secondary: null };
  const windows = quotaWindows({ rateLimitsByLimitId: { codex: snapshot } });
  assert.deepEqual(windows, [{ pct: 53, minutes: 10080, resetAt: 1795384978000 }]);
  const meters = render(windows);
  assert.equal(meters.length, 2);
  assert.match(meters[0].textContent, /GLM · 5-hour usage.*1% used/);
  assert.match(meters[1].textContent, /Codex · Weekly usage.*53% used.*Resets/);
  assert.equal(meters[1].querySelector('.track span').style.width, '53%');
  assert.equal(render([]).length, 1);
});
