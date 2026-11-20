'use strict';

const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const browserServerName = 'VS Code Browser';
const operations = {
  browser_open: 'open_browser_page',
  browser_read: 'read_page',
  browser_navigate: 'navigate_page',
  browser_click: 'click_element',
  browser_type: 'type_in_page',
  browser_screenshot: 'screenshot_page',
  browser_inspect: 'run_playwright_code'
};
const isBrowserTool = name => name.startsWith('mcp_') && Object.hasOwn(operations, name.slice(4));
const browserQuery = /browser|браузер|playwright|\blocalhost\b|scr[ee]+nshot|скриншот/i;
const integratedBrowserQuery = /integrated browser|vs code browser|встроенн\p{L}* браузер/iu;
const browserSettings = vscode => vscode.workspace.getConfiguration('workbench.browser');
const scrollKeys = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Control+Home', 'Control+End', 'Meta+Home', 'Meta+End']);

// This program is owned by Harness. The model supplies a selector as data.
const inspectPage = (selector, query, limit) => `return await page.evaluate(({ selector, query, limit }) => {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: 'No element matches the selector' };
  const selectorOf = node => {
    const parts = [];
    while (node && node !== document.body) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      const tag = node.localName;
      const peers = Array.from(node.parentElement?.children || []).filter(el => el.localName === tag);
      parts.unshift(peers.length > 1 ? tag + ':nth-of-type(' + (peers.indexOf(node) + 1) + ')' : tag);
      node = node.parentElement;
    }
    return ['body', ...parts].join(' > ');
  };
  const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
    .filter(node => node.getClientRects().length && node.textContent.trim())
    .map(node => {
      const section = node.closest('section,article,[role="region"]') || node;
      const { width, height } = section.getBoundingClientRect();
      return { title: node.textContent.trim().replace(/\\s+/g, ' ').slice(0, 140), selector: selectorOf(section),
        ...(width < 1 || height < 1 ? { layout: 'collapsed' } : {}) };
    });
  const selected = new Map();
  for (const item of headings) {
    if ((!query || item.title.toLowerCase().includes(query.toLowerCase())) && !selected.has(item.selector)) {
      selected.set(item.selector, item);
    }
  }
  const filtered = Array.from(selected.values());
  return {
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, scrollY, documentHeight: document.scrollingElement?.scrollHeight },
    sections: filtered.slice(0, limit), total: filtered.length,
    ...(selector ? { text: root.innerText?.trim().slice(0, 5000) } : {})
  };
}, ${JSON.stringify({ selector, query, limit })});`;

const fullPageCapture = `
  const size = await page.evaluate(() => {
    const root = document.scrollingElement;
    return { width: root.scrollWidth, height: root.scrollHeight, viewportHeight: innerHeight,
      innerScroll: Array.from(document.querySelectorAll('main, section, article, div')).some(el =>
        el.clientHeight >= innerHeight * 0.75 && el.scrollHeight > el.clientHeight * 1.5 &&
        /auto|scroll/.test(getComputedStyle(el).overflowY)) };
  });
  if (size.height > 12000 || size.width * size.height > 12000000)
    return { error: 'Page is too tall for a single model image. Inspect sections and capture them individually.' };
  if (size.height <= size.viewportHeight + 1 && size.innerScroll)
    return { error: 'Content scrolls inside a separate container. Capture the required sections individually.' };
  const bytes = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 75, scale: 'css' });
  if (bytes.length > 4 * 1024 * 1024) return { error: 'Full page image exceeds 4 MB. Capture sections individually.' };
  return { image: bytes.toString('base64') };
`;

const sectionCapture = selector => `
  const locator = page.locator(${JSON.stringify(selector)});
  const target = await locator.evaluate(async node => {
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { width, height } = node.getBoundingClientRect();
    if (width < 1 || height < 1) {
      return { error: 'The element has no visible layout at the current browser width (' + innerWidth +
        ' px). Widen the browser editor or use the page’s own controls to expand the content before taking a screenshot.' };
    }
    const headings = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
    const heading = node.matches(headings) ? node : node.querySelector(headings);
    return { title: heading?.textContent.trim().slice(0, 160) || node.getAttribute('aria-label'), element: node.localName };
  }, undefined, { timeout: 8000 });
  if (target.error) return { error: target.error };
  const bytes = await locator.screenshot({ type: 'jpeg', quality: 80, scale: 'css', timeout: 8000 });
  if (bytes.length > 4 * 1024 * 1024) return { error: 'Section image exceeds 4 MB. Capture a smaller element.' };
  return { image: bytes.toString('base64'), target };
`;

function playwrightResult(content) {
  const result = content.find(part => typeof part.value === 'string' && part.value.startsWith('Result: '));
  if (!result) throw Error(content[0]?.value || 'Browser returned no data.');
  const value = JSON.parse(result.value.slice('Result: '.length));
  if (value?.error) throw Error(value.error);
  return value;
}

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error('Use an HTTP(S) URL without embedded credentials.');
  }
  return url.href;
}

function browserMcp(vscode) {
  const pages = new Map();
  const nativeTools = () => vscode.lm?.tools ?? [];
  const ready = () => browserSettings(vscode).get('enableChatTools') &&
    nativeTools().some(tool => tool.name === operations.browser_open);
  return {
    name: browserServerName,
    source: 'Harness · Integrated Browser',
    type: 'in-process',
    ready,
    async transport() {
      const server = new Server({ name: 'harness-vscode-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(operations).flatMap(([name, nativeName]) => {
          const native = nativeTools().find(tool => tool.name === nativeName);
          if (!native?.inputSchema || !ready()) return [];
          const { forceNew, ...properties } = native.inputSchema.properties;
          let inputSchema = { ...native.inputSchema, properties, additionalProperties: false };
          if (name === 'browser_open') inputSchema.required = ['url'];
          if (name === 'browser_inspect') inputSchema = {
            type: 'object', additionalProperties: false, required: ['pageId'], properties: {
              pageId: { type: 'string' }, selector: { type: 'string', maxLength: 1200, description: 'Optional section selector to read its visible text.' },
              query: { type: 'string', maxLength: 140, description: 'Filter heading titles by substring.' },
              limit: { type: 'integer', minimum: 1, maximum: 80 }
            }
          };
          if (name === 'browser_screenshot' && nativeTools().some(tool => tool.name === operations.browser_inspect)) {
            inputSchema.properties.fullPage = { type: 'boolean', description: 'Capture the full document. Incompatible with selector or ref.' };
          }
          const description = name === 'browser_open'
            ? 'Open an HTTP(S) page. Reuse its page ID. Use browser_inspect to locate sections.'
            : name === 'browser_inspect'
              ? 'Cheap text snapshot: list headings and section selectors, or inspect one section. Use before taking images or scrolling.'
              : name === 'browser_screenshot'
                ? 'Capture one element in one call: supply its selector or ref and Harness scrolls it into view automatically. Use fullPage for a document overview.'
                : native.description;
          return [{ name, description, inputSchema }];
        })
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
        const { name, arguments: args = {} } = request.params;
        const owner = request.params._meta?.harnessConversation;
        const token = new vscode.CancellationTokenSource();
        const cancel = () => token.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          signal.throwIfAborted();
          if (!owner || !Object.hasOwn(operations, name) || !ready() || !vscode.workspace.isTrusted) {
            throw Error('Integrated browser tools are unavailable in this workspace.');
          }
          const open = name === 'browser_open';
          const page = pages.get(args.pageId);
          if (!open && page?.owner !== owner) {
            throw Error('This page belongs to a different conversation or has expired. Open a page in this conversation.');
          }
          const input = open ? { url: httpUrl(args.url), forceNew: true } : { ...args };
          if (name === 'browser_navigate' && (!args.type || args.type === 'url')) input.url = httpUrl(args.url);
          const scrolling = name === 'browser_type' && !args.selector && !args.ref && scrollKeys.has(args.key);
          if (scrolling && page.scrollAttempts >= 3) {
            throw Error('Browser scroll limit reached. Use browser_inspect to locate a named section, then browser_screenshot with its selector. More repeated key presses will be blocked.');
          }
          const takeScreenshot = name === 'browser_screenshot';
          const targeted = takeScreenshot && !!(args.ref || args.selector);
          const fullPage = takeScreenshot && args.fullPage === true;
          if (targeted && fullPage) throw Error('Choose either a section selector or fullPage.');
          const invoke = (tool, input) => vscode.lm.invokeTool(tool, { input, toolInvocationToken: undefined }, token.token);
          const exactCapture = targeted && nativeTools().some(tool => tool.name === operations.browser_inspect);
          if (name === 'browser_inspect' || fullPage || exactCapture) {
            const code = fullPage ? fullPageCapture : exactCapture
              ? sectionCapture(args.ref ? 'aria-ref=' + args.ref : args.selector)
              : inspectPage(args.selector, args.query, args.limit ?? 60);
            const result = await invoke(operations.browser_inspect, { pageId: args.pageId, code, timeoutMs: 15000 });
            signal.throwIfAborted();
            const data = playwrightResult(result.content);
            if (fullPage || exactCapture) {
              if (typeof data?.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.image)) throw Error('Browser returned no screenshot.');
              const content = [{ type: 'image', mimeType: 'image/jpeg', data: data.image }];
              if (exactCapture) {
                page.scrollAttempts = 0;
                content.push({ type: 'text', text: JSON.stringify(data.target) });
              }
              return { content };
            }
            return { content: [{ type: 'text', text: JSON.stringify(data) }] };
          }
          if (takeScreenshot) {
            delete input.fullPage;
            if (targeted) input.scrollIntoViewIfNeeded = true;
          }
          if (scrolling) page.scrollAttempts++;
          const result = await invoke(operations[name], input);
          signal.throwIfAborted();
          const content = result.content.flatMap(part => {
            if (typeof part.value === 'string') return [{ type: 'text', text: part.value }];
            if (part.data instanceof Uint8Array && /^image\/(png|jpeg|webp)$/.test(part.mimeType) && part.data.length <= 4 * 1024 * 1024) {
              return [{ type: 'image', mimeType: part.mimeType, data: Buffer.from(part.data).toString('base64') }];
            }
            return [];
          });
          const summary = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (open) {
            const id = summary.match(/^Page ID:\s*(\S+)/m)?.[1];
            if (!id) throw Error(summary || 'VS Code returned no browser page ID.');
            pages.set(id, { owner, scrollAttempts: 0 });
            if (pages.size > 200) pages.delete(pages.keys().next().value);
          }
          if (!content.length) throw Error('VS Code returned no usable browser result.');
          if (takeScreenshot && !content.some(part => part.type === 'image')) throw Error(summary || 'Browser returned no screenshot.');
          if (name === 'browser_navigate' || targeted) page.scrollAttempts = 0;
          if (scrolling && page.scrollAttempts === 3) {
            content.push({ type: 'text', text: 'Switch to browser_inspect and target a section. The accessibility tree does not describe scroll movement.' });
          }
          return { content };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error.message }] };
        } finally {
          signal.removeEventListener('abort', cancel);
          token.dispose();
        }
      });
      await server.connect(serverTransport);
      return clientTransport;
    }
  };
}

module.exports = { browserMcp, browserServerName, browserSettings, browserQuery, integratedBrowserQuery, isBrowserTool };
