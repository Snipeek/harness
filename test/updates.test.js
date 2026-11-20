'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { HarnessUpdates } = require('../src/updates');
require('../scripts/runtime-host'); // Stub the VS Code host for the sidebar module.

test('clicking the sidebar version checks for updates and displays the outcome', async t => {
  const { window, document } = parseHTML(fs.readFileSync('media/sidebar.html', 'utf8'));
  const messages = [];
  const context = vm.createContext({
    window, document, setInterval() {},
    acquireVsCodeApi: () => ({ getState: () => ({}), postMessage: msg => messages.push(msg) })
  });
  for (const name of ['icons', 'sidebar']) vm.runInContext(fs.readFileSync('media/' + name + '.js', 'utf8'), context);
  const deliver = data => window.dispatchEvent(Object.assign(new window.Event('message'), { data }));
  const { SessionManager } = require('../src/sidebar');
  const app = { context: { globalState: { get: (_key, fallback) => fallback } }, sessionOf() {} };
  const manager = new SessionManager(app);
  manager.view = { postMessage: deliver };
  app.updates = new HarnessUpdates({version:'0.15.58', changed:() => manager.showUpdate(), log() {}});
  let version = '0.15.58', requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(JSON.stringify({version}));
  });
  assert.equal(document.querySelector('#usage, .account-summary'), null);
  const button = document.querySelector('.account #check-release');
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(messages.at(-1).type, 'checkHarnessUpdate');
  await Promise.all([app.updates.check(), manager.receive(messages.at(-1))]);
  assert.equal(requests, 1);
  assert.equal(button.disabled, false);
  assert.match(document.getElementById('release-check-status').textContent, /последняя версия/);
  assert.equal(document.getElementById('release-footer').hidden, true);

  version = '0.15.59';
  button.click();
  await manager.receive(messages.at(-1));
  assert.equal(requests, 2);
  assert.equal(document.getElementById('release-footer').hidden, false);
  assert.equal(document.getElementById('release-button').textContent, 'Обновиться');
});
