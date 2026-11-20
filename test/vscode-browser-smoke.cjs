'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-browser-fixture-'));
  let stage = 0;
  let pageId;
  let failure;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Harness MCP fixture</title><button id="check" onclick="this.textContent=\'MCP click verified\'">Check</button><div style="height:1200px"></div><main style="height:200px;overflow:auto"><div style="height:800px"></div><section id="target"><h2>Target chart</h2><p>Chart caption</p></section></main><section id="collapsed" style="width:0;height:20px"><h2>Collapsed section</h2></section>');
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { messages, tools } = JSON.parse(body);
      const toolOutput = messages.findLast(message => message.role === 'tool')?.content;
      let delta;
      const call = (name, args) => {
        assert(tools.some(tool => tool.function.name === name), name + ' was not available');
        return { tool_calls: [{ index: 0, id: 'browser-' + stage, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] };
      };
      switch (stage++) {
        case 0:
          delta = call('search_tools', { query: 'integrated browser' });
          break;
        case 1:
          delta = call('mcp_browser_open', { url: 'http://127.0.0.1:' + server.address().port });
          break;
        case 2:
          pageId = toolOutput.match(/Page ID:\s*(\S+?)\\n/)?.[1];
          assert(pageId, toolOutput);
          assert(vscode.window.tabGroups.all.some(group => group.viewColumn === 2 &&
            group.tabs.some(tab => tab.label === 'Harness MCP fixture')), 'Integrated tab was not visible in the right editor group');
          delta = call('mcp_browser_click', { pageId, selector: '#check', element: 'Check button' });
          break;
        case 3:
          assert.match(toolOutput, /MCP click verified/);
          assert.doesNotMatch(toolOutput, /Timeout|Call log/);
          delta = call('mcp_browser_read', { pageId });
          break;
        case 4:
          assert.match(toolOutput, /MCP click verified/);
          delta = call('mcp_browser_screenshot', { pageId });
          break;
        case 5:
          assert.match(toolOutput, /Screenshot captured/);
          assert(messages.some(message => Array.isArray(message.content) &&
            message.content.some(part => /^data:image\/jpeg;base64,/.test(part.image_url?.url))));
          delta = { content: 'Browser click and screenshot verified.' };
          break;
        default:
          throw Error('Unexpected model request');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      failure = error;
      response.writeHead(400).end('Browser fixture validation failed');
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const app = await vscode.extensions.getExtension('snipeek.glm-token-usage').activate();
    app.rootForSession = async () => root;
    app.sessionSettings = async () => ({ provider: 'custom', protocol: 'chat', model: 'fixture',
      apiKey: 'local-fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' });
    const browserSettings = vscode.workspace.getConfiguration('workbench.browser');
    assert.equal(browserSettings.inspect('newTabPlacement').globalValue, undefined);
    assert.equal(browserSettings.get('newTabPlacement'), 'sideGroup');
    await browserSettings.update('enableChatTools', true, vscode.ConfigurationTarget.Global);
    const waitUntil = async predicate => {
      for (let i = 0; i < 120; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('VS Code did not finish initializing');
    };
    await waitUntil(() => vscode.lm.tools.some(tool => tool.name === 'open_browser_page'));
    const session = app.newSession();
    session.mode = 'auto';
    const panel = app.openTab(session.id);
    await waitUntil(() => app.views.has(panel.webview));
    await app.send(panel.webview, 'Open the localhost fixture in the integrated browser and verify the button visually.', []);
    if (failure) throw failure;
    assert.equal(stage, 6, JSON.stringify(session.timeline.map(({ name, result, text }) => ({ name, result, text }))));
    assert.equal(session.timeline.at(-1).text, 'Browser click and screenshot verified.');
    const scope = await app.integrationsFor(root);
    const browser = async (name, args) => JSON.parse(await scope.mcp.call('mcp_browser_' + name,
      {pageId, ...args}, new AbortController().signal, session.id));
    const snapshot = await browser('inspect', {query:'Target chart'});
    assert.equal(snapshot.isError, undefined, JSON.stringify(snapshot));
    assert.deepEqual(JSON.parse(snapshot.content[0].text).sections, [{ title:'Target chart', selector:'#target' }]);
    const section = await browser('screenshot', {selector:'#target'});
    assert.equal(section.content[0].type, 'image', JSON.stringify(section.content[0]).slice(0,200));
    assert.deepEqual(JSON.parse(section.content[1].text), { title:'Target chart', element:'section' });
    const collapsed = await browser('screenshot', {selector:'#collapsed'});
    assert.equal(collapsed.isError, true);
    assert.match(collapsed.content[0].text, /no visible layout/);
    const full = await browser('screenshot', {fullPage:true});
    assert.equal(full.content[0].type, 'image', JSON.stringify(full.content[0]).slice(0,200));
    const jpegSize = data => {
      const bytes = Buffer.from(data, 'base64');
      for (let i = 2; i < bytes.length - 8;) {
        if ([0xc0, 0xc1, 0xc2].includes(bytes[i + 1])) return bytes.readUInt16BE(i + 5);
        i += 2 + bytes.readUInt16BE(i + 2);
      }
      return 0;
    };
    assert(jpegSize(full.content[0].data) >= 1200, 'Full-page screenshot should include off-screen content');
    assert(jpegSize(section.content[0].data) < 300, 'Targeted screenshot should be cropped to the element');
    for (const key of ['PageDown','PageUp','PageUp']) assert.equal((await browser('type',{key})).isError, undefined);
    assert.match((await browser('type',{key:'PageDown'})).content[0].text, /scroll limit/);
    const denied = JSON.parse(await scope.mcp.call('mcp_browser_read', { pageId }, new AbortController().signal, 'another-session'));
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /different conversation/);
    await browserSettings.update('newTabPlacement', 'activeGroup', vscode.ConfigurationTarget.Global);
    const reopened = JSON.parse(await scope.mcp.call('mcp_browser_open', {
      url: 'http://127.0.0.1:' + server.address().port + '/with-custom-placement'
    }, new AbortController().signal, session.id));
    assert.equal(reopened.isError, undefined);
    assert.match(reopened.content[0].text, /Page ID:/);
    console.log('HARNESS_BROWSER_SMOKE_OK: section snapshot, nested-scroll capture, full-page capture, scroll limit, conversation isolation');
    panel.dispose();
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await fs.rm(root, { recursive: true, force: true });
  }
};
