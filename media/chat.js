'use strict';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const send = (type, values = {}) => vscode.postMessage({ type, ...values });
let current, busy = false, approval, attachments = [];
let dismissedEditorContext;
let stopRequested = false;
let displayedQuestionId;
let lastPromptEdit = -Infinity, composingPrompt = false, approvalTimer;
const approvalTypingPause = 700;
const restored = vscode.getState() || {};
const drafts = restored.drafts || {};
const outgoing = restored.outgoing || {};
for (const entries of Object.values(outgoing)) {
  for (const entry of entries) if (entry.status === 'sending') entry.status = 'unconfirmed';
}
const expanded = new Set();
const toolDisclosure = new Map(), expandedIO = new Set();
const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const glyph = name => window.aiIcon(name);
const button = (text, callback, className) => { const n = node('button', className, text); n.addEventListener('click', callback); return n; };
function inline(parent, text, links = true, bold = true) {
  // Render nested spans as DOM; markup inside a code span remains literal.
  const code = /(?<!`)(`+)(?!`)([^\n]+?)(?<!`)\1(?!`)/;
  function strong(text) {
    let start = -1;
    const tokens = new RegExp(code.source + '|\\*\\*|\\n', 'g');
    for (const match of text.matchAll(tokens)) {
      if (match[1]) continue;
      if (match[0] === '\n') { start = -1; continue; }
      if (start !== -1 && match.index > start + 2) {
        const end = match.index + 2;
        return Object.assign([text.slice(start,end),text.slice(start+2,match.index)],{index:start});
      }
      start = match.index;
    }
  }
  const link = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;
  const patterns = [[value=>code.exec(value), 'code'], ...(bold ? [[strong, 'strong']] : []), ...(links ? [[value=>link.exec(value), 'a']] : [])];
  while (text) {
    let best, tag;
    for (const [pattern, kind] of patterns) {
      const match = pattern(text);
      if (match && (!best || match.index < best.index)) { best = match; tag = kind; }
    }
    if (!best) break;
    parent.append(document.createTextNode(text.slice(0, best.index)));
    const element = node(tag);
    if (tag === 'code') {
      const value = best[2];
      element.textContent = /^ .* $/.test(value) && value.trim() ? value.slice(1, -1) : value;
    } else if (tag === 'a') {
      element.href = best[2]; element.target = '_blank'; element.rel = 'noopener noreferrer';
      inline(element, best[1], false, bold);
    } else inline(element, best[1], links, false);
    parent.append(element);
    text = text.slice(best.index + best[0].length);
  }
  parent.append(document.createTextNode(text));
}
// Tokenize visible lines only. Insert source through text nodes, including markup.
const diffCodeTokens = /(?<comment>\/\/.*|\/\*.*?(?:\*\/|$))|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?<keyword>\b(?:as|async|await|break|case|catch|class|const|continue|default|else|enum|export|extends|finally|for|from|function|if|implements|import|in|interface|let|new|of|package|private|protected|public|return|static|super|switch|throw|try|type|typeof|var|while|yield)\b)|(?<literal>\b(?:true|false|null|undefined|0[xX][0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?)\b)|(?<call>\b[A-Za-z_][\w$]*(?=\s*\())/g;

function syntaxCode(text, tokens) {
  const code = node('code', '');
  if (!tokens || text.length > 4096) {
    code.textContent = text;
    return code;
  }
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    code.append(document.createTextNode(text.slice(offset, match.index)));
    const kind = Object.keys(match.groups).find(key => match.groups[key] !== undefined);
    code.append(node('span', 'diff-syntax-' + kind, match[0]));
    offset = match.index + match[0].length;
  }
  code.append(document.createTextNode(text.slice(offset)));
  return code;
}

function diffCode(text, file) {
  const supported = /\.(?:[cm]?[jt]sx?|jsonc?|java|css|scss)$/i.test(file || '');
  return syntaxCode(text, supported ? diffCodeTokens : null);
}

const scriptCodeTokens = /(?<comment>#.*)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<keyword>\b(?:and|as|async|await|break|case|class|continue|def|do|done|elif|else|except|export|fi|finally|for|from|function|if|import|in|lambda|local|match|not|or|pass|raise|return|then|try|while|with|yield)\b)|(?<literal>\b(?:True|False|None|true|false|[0-9]+)\b)|(?<call>\b[A-Za-z_]\w*(?=\s*\())/g;
function codeBlock(text, language) {
  const block = node('div', 'code-block');
  const copy = button('', async () => {
    try { await navigator.clipboard.writeText(text); copy.title = 'Скопировано'; copy.setAttribute('aria-label', copy.title); }
    catch { showNotice('Не удалось скопировать код. Выдели его вручную.'); }
  }, 'code-copy');
  copy.title = 'Копировать код';
  copy.setAttribute('aria-label', copy.title);
  copy.append(glyph('copy'));
  const pre = node('pre');
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', language || 'Код');
  const tokens = /^(?:js|javascript|jsx|ts|typescript|tsx|jsonc?|java|css|scss)$/i.test(language) ? diffCodeTokens
    : /^(?:py|python|python3|sh|bash|zsh|shell)$/i.test(language) ? scriptCodeTokens : null;
  pre.append(syntaxCode(text, tokens));
  block.append(pre, copy);
  return block;
}

function markdown(text) {
  const result = node('div', 'message-body');
  function prose(chunk) {
    let paragraph = [], list, item, itemIndent = 0;
    const flush = () => { if (paragraph.length) { const p = node('p'); inline(p, paragraph.join('\n')); result.append(p); paragraph = []; } list = undefined; item = undefined; };
    const lines=chunk.split('\n');
    function cells(line){const output=[];let cell='',code=false,escaped=false;line=line.trim();if(line.startsWith('|'))line=line.slice(1);if(line.endsWith('|')&&!line.endsWith('\\|'))line=line.slice(0,-1);for(const char of line){if(escaped){cell+=char;escaped=false;continue;}if(char==='\\'){escaped=true;continue;}if(char==='`')code=!code;if(char==='|'&&!code){output.push(cell.trim());cell='';}else cell+=char;}if(escaped)cell+='\\';output.push(cell.trim());return output;}
    for(let index=0;index<lines.length;index++){
      const line = lines[index];
      const fence = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/.exec(line);
      if (fence && (fence[2][0] !== '`' || !fence[3].includes('`'))) {
        const indent = fence[1].length;
        const parent = item && indent >= itemIndent ? item : result;
        if (parent === result) flush();
        const close = new RegExp('^[ \t]*' + fence[2][0] + '{' + fence[2].length + ',}[ \t]*$');
        const code = [];
        while (index + 1 < lines.length) {
          const next = lines[++index];
          if (close.test(next) || (index === lines.length - 1 && next === '')) break;
          const leading = /^[ \t]*/.exec(next)[0].length;
          code.push(next.slice(Math.min(indent, leading)));
        }
        parent.append(codeBlock(code.join('\n'), fence[3].trim().split(/\s+/)[0]));
        continue;
      }
      const divider=cells(lines[index+1]||'');
      if(line.includes('|')&&cells(line).length===divider.length&&divider.length>1&&divider.every(c=>/^:?-{3,}:?$/.test(c))){
        flush();const headers=cells(line),wrapper=node('div','markdown-table'),table=node('table'),head=node('thead'),header=node('tr'),body=node('tbody');wrapper.tabIndex=0;wrapper.setAttribute('role','region');wrapper.setAttribute('aria-label','Таблица');
        const align=divider.map(c=>c.startsWith(':')&&c.endsWith(':')?'center':c.endsWith(':')?'right':c.startsWith(':')?'left':null);
        const row=(values,tag)=>{const tr=node('tr');headers.forEach((_,column)=>{const cell=node(tag);if(tag==='th')cell.setAttribute('scope','col');if(align[column])cell.style.textAlign=align[column];inline(cell,values[column]||'');tr.append(cell);});return tr;};
        head.append(row(headers,'th'));index+=2;
        while(index<lines.length&&lines[index].trim()&&lines[index].includes('|')){body.append(row(cells(lines[index]),'td'));index++;}index--;
        table.append(head,body);wrapper.append(table);result.append(wrapper);continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)/), li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
      if(/^\s*(?:---+|\*\*\*+)\s*$/.test(line)){flush();result.append(node('hr'));}
      else if(/^>\s?/.test(line)){flush();const quote=node('blockquote');inline(quote,line.replace(/^>\s?/,''));result.append(quote);}
      else if (heading) { flush(); const h = node(heading[1].length < 3 ? 'h2' : 'h3'); inline(h, heading[2]); result.append(h); }
      else if (li) {
        if (paragraph.length) flush();
        const ordered=/^\s*\d/.test(line);if(!list||list.tagName!==(ordered?'OL':'UL')) { list = node(ordered ? 'ol' : 'ul');if(ordered)list.start=Number(line.match(/\d+/)[0]);result.append(list); }
        item = node('li'); itemIndent = li[0].length - li[1].length; inline(item, li[1]); list.append(item);
      } else if (!line.trim()) { if (paragraph.length) flush(); }
      else { list = undefined; item = undefined; paragraph.push(line); }
    }
    flush();
  }
  prose(text.replace(/\r\n?/g, '\n'));
  return result;
}
const toolNames = { read_file: 'Read', read_files: 'Read files', write_file: 'Write', edit_file: 'Edit', run_command: 'Bash', search_files: 'Search', search_batch: 'Search batch', list_files: 'Glob', delegate_tasks: 'Agent' };
const marks = new Set(restored.bookmarks || []);
const rendered = new Map();
const expandedUserMessages = new Set();
function updateUserMessageFold(body) {
  const viewport = body.parentElement;
  const wrapper = viewport?.parentElement;
  if (!wrapper?.isConnected) return;
  wrapper.lastElementChild.hidden = wrapper.dataset.expanded !== 'true' && body.scrollHeight <= viewport.clientHeight;
}
const userMessageSizes = new ResizeObserver(entries => requestAnimationFrame(() => {
  for (const {target} of entries) updateUserMessageFold(target);
}));
let focusView = !!restored.focusView;
const parsed = event => { try { return typeof event.input === 'string' ? JSON.parse(event.input) : event.input || {}; } catch { return {}; } };
const duration = event => { if (!event.startedAt) return ''; const sec = Math.max(0, Math.floor(((event.finishedAt || Date.now()) - event.startedAt) / 1000)); return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`; };
const statusLabel = status => ({ running: 'Working', done: 'Completed', error: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted', limited: 'Limit reached' }[status] || status || '');
function disclosure(tag, cls, id) {
  const n = node(tag, cls); n.open = expanded.has(id);
  n.addEventListener('toggle', () => { if (!n.isConnected) return; if (n.open) expanded.add(id); else expanded.delete(id); });
  return n;
}
function clock(event) { const n = node('span', 'elapsed', duration(event)); if (!event.finishedAt && event.status === 'running' && event.startedAt) n.dataset.start = event.startedAt; return n; }
function copyText(text, target) { navigator.clipboard.writeText(text).then(() => { target.textContent = 'Copied'; }).catch(() => showNotice('Select and copy the text manually.')); }
function agentCard(agent) {
  const item=node('section','inline-agent '+agent.status);item.dataset.agentId=agent.id;
  const open=()=>{showAgentTree();openAgentDetail(agent.id);};
  const heading=button('',open,'inline-agent-heading');heading.setAttribute('aria-label',`Agent: ${agent.title}`);
  heading.append(node('strong','','Agent:'),node('span','inline-agent-title',agent.title));
  const state=node('span','inline-agent-state',agent.status==='running'?`Working · ${agent.toolCount||0} tools · `:'');state.append(clock(agent));heading.append(state);item.append(heading);
  if(agent.status==='running')return item;
  const preview=button('',open,'agent-io-preview');preview.setAttribute('aria-label',`View ${agent.title} task and result`);
  const input=node('div','agent-io-row');input.append(node('span','agent-io-label','IN'),node('pre','',agent.prompt||''));preview.append(input);
  const output=agent.result||[...(agent.timeline||[])].reverse().find(e=>e.role==='assistant'&&e.text)?.text;
  if(output){const row=node('div','agent-io-row');row.append(node('span','agent-io-label','OUT'),node('pre','',output));preview.append(row);}
  item.append(preview);return item;
}

function editPreview(event) {
  const args=parsed(event);
  const change=event.change;
  const before=change?.before??args.old_text;
  const after=change?.after??args.new_text??(event.name==='write_file'?args.content:undefined);
  if(typeof after!=='string')return null;
  const lines=text=>text?text.split(/\r?\n/):[];
  const left=lines(before),right=lines(after);
  let start=0,end=0;
  while(start<Math.min(left.length,right.length)&&left[start]===right[start])start++;
  while(end<Math.min(left.length,right.length)-start&&left[left.length-1-end]===right[right.length-1-end])end++;
  const panel=node('div','edit-preview');
  const status=event.undone?'Правка отменена':event.status==='error'?'Ошибка правки':event.status==='cancelled'?'Правка не применена':change?'Правка применена':event.status==='done'?'Результат правки':'Предложение';
  panel.append(node('div','edit-status',status));
  const columns=node('div','edit-columns');
  for(const [label,source,style] of [['До',left,'removed'],['После',right,'added']]){
    const side=node('section','edit-side');side.append(node('div','edit-label',label));
    const viewport=node('div','edit-lines');viewport.tabIndex=0;viewport.setAttribute('aria-label',label);
    const first=Math.max(0,start-2),last=Math.min(source.length,source.length-end+2);
    for(let index=first;index<Math.min(last,first+100);index++){
      const modified=index>=start&&index<source.length-end;
      const line=node('div','edit-line'+(modified?' '+style:''));
      line.append(node('span','edit-line-number',change?String(index+1):modified?(style==='added'?'+':'−'):''),diffCode(source[index]||' ',change?.file??args.path));viewport.append(line);
    }
    if(last-first>100)viewport.append(node('div','edit-label','Показаны первые 100 строк фрагмента'));
    if(!source.length)viewport.append(node('div','edit-label',before===undefined&&style==='removed'?'Исходник недоступен':'Пусто'));
    side.append(viewport);columns.append(side);
  }
  panel.append(columns);
  if(event.result&&(!change||event.status!=='done'))panel.append(node('div','edit-status',event.result));
  return panel;
}

function animatedDots() {
  const dots = node('span','loader-dots');
  dots.setAttribute('aria-hidden','true');
  for (let index=0; index<3; index++) dots.append(node('span','','.'));
  return dots;
}
function renderEvent(event, finalReply = false) {
  if (event.agents?.length) {
    const batch=node('section','agent-batch inline-agent-batch '+event.status);
    for(const agent of event.agents)batch.append(agentCard(agent));
    return batch;
  }
  if (event.role === 'tool') {
    const view=window.AITranscript.presentTool(event), details=node('details','tool tool-call '+event.status), summary=node('summary');
    const initialOpen = toolDisclosure.get(event.id) ?? view.preview;
    details.open = initialOpen;
    details.addEventListener('toggle', () => {
      if (details.isConnected && (toolDisclosure.has(event.id) || details.open !== initialOpen)) {
        toolDisclosure.set(event.id, details.open);
      }
      if (details.open && details.childElementCount === 1) appendDetails();
    });
    summary.append(node('span','tool-name',view.label));
    if(view.file){const file=button(view.target,e=>{e.preventDefault();e.stopPropagation();send('openFile',{path:view.file});},'tool-file');file.title=view.file;file.setAttribute('aria-label','Open '+view.target);summary.append(file);}
    if(view.description&&(!view.file||['Read','read_file','read_files'].includes(event.name))){const args=node('span','tool-description',view.description);args.title=view.description;summary.append(args);}
    if(event.canBackground&&event.status==='running'){
      const move=button('Run in background',e=>{e.preventDefault();e.stopPropagation();send('backgroundCommand',{id:event.id});},'tool-background-action');
      summary.append(move);
    }
    if(event.background&&event.status==='running')summary.append(node('span','tool-state','Background'));
    summary.append(node('span','tool-chevron'));details.append(summary);
    if (initialOpen) appendDetails();
    const wrapper=node('div','tool-wrapper');wrapper.append(details);return wrapper;

    function appendDetails() {
      const preview=event.change||['edit_file','write_file','Edit','Write'].includes(event.name)?editPreview(event):null;
      const frame=node('div','tool-io-frame'+(expandedIO.has(event.id)?' expanded':''));frame.tabIndex=0;frame.setAttribute('role','button');frame.setAttribute('aria-label','Expand '+view.label+' input and output');frame.setAttribute('aria-expanded',String(expandedIO.has(event.id)));
      function row(label,text){const r=node('div','tool-io-row');r.append(node('span','tool-io-label',label),node('pre','',String(text)));return r;}
      frame.append(row('IN',view.input));
      if(view.output)frame.append(row('OUT',view.output));
      else if(event.status==='waiting')frame.append(row('OUT','Waiting for approval…'));
      else if(event.status==='running')frame.append(row('OUT',event.background?'Running in background…':'Running…'));
      const toggle=()=>{if(expandedIO.has(event.id))expandedIO.delete(event.id);else expandedIO.add(event.id);frame.classList.toggle('expanded',expandedIO.has(event.id));frame.setAttribute('aria-expanded',String(expandedIO.has(event.id)));};
      frame.onclick=toggle;frame.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}};
      details.append(preview||frame);
      if(event.change){const actions=node('div','tool-actions');actions.append(button('View diff',()=>send('diff',{id:event.id})),button(event.undone?'Reverted':'Undo change',()=>send('undo',{id:event.id})));actions.lastChild.disabled=!!event.undone||busy;details.append(actions);}
    }
  }
  if (event.role === 'thinking') {
    const details=disclosure('details','thinking '+(event.status||'done'),event.id),summary=node('summary');
    const running = event.status === 'running';
    const elapsed = event.finishedAt && event.startedAt ? duration(event) : '';
    let label = running ? 'Thinking' : elapsed ? 'Thought for ' + (elapsed === '0s' ? '<1s' : elapsed) : 'Thought';
    if (Number.isFinite(event.tokens)) label += ` · ${event.tokens.toLocaleString()} tokens`;
    else if (Number.isFinite(event.estimatedTokens)) label += ` · ≈${event.estimatedTokens.toLocaleString()} tokens`;
    const caption = node('span','thinking-label',label);
    if (running) caption.append(animatedDots());
    summary.append(caption,node('span','tool-chevron'));details.append(summary,node('pre','',event.text||''));return details;
  }
  if (event.role === 'notice') return node('div', 'notice '+(event.status||''), event.text);
  if (!['user', 'assistant'].includes(event.role) || (event.role === 'assistant' && !event.text)) return null;
  const message = node('article', 'message ' + event.role + ' ' + (event.status || ''));
  const timestamp = finalReply ? event.finishedAt || event.startedAt : event.startedAt;
  if ((event.role === 'user' || finalReply) && timestamp) {
    const time = new Date(timestamp);
    const label = node('time', 'message-time', time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    label.dateTime = time.toISOString();
    message.append(label);
    if (finalReply) message.classList.add('has-reply-time');
  }
  if (event.text || event.attachments?.length) {
    const body = markdown(event.text || '');
    if (event.attachments?.length) {
      const files = node('div', 'attachments message-attachments');
      files.append(...event.attachments.map(item => attachmentChip(item)));
      body.prepend(files);
    }
    if (event.role === 'user') {
      const key = event.deliveryId || event.id;
      const wrapper = node('div', 'user-message-fold');
      const viewport = node('div', 'user-message-viewport');
      viewport.id = 'user-message-' + event.id;
      viewport.append(body);
      const toggle = button('', () => {
        if (expandedUserMessages.has(key)) expandedUserMessages.delete(key);
        else expandedUserMessages.add(key);
        update();
        if (!expandedUserMessages.has(key)) toggle.scrollIntoView({block:'nearest'});
        updateScrollFade();
      }, 'user-message-toggle');
      toggle.setAttribute('aria-controls', viewport.id);
      function update() {
        const open = expandedUserMessages.has(key);
        wrapper.dataset.expanded = String(open);
        toggle.textContent = open ? 'Show less' : 'Show more';
        toggle.setAttribute('aria-expanded', String(open));
      }
      update();
      toggle.hidden = !expandedUserMessages.has(key);
      wrapper.append(viewport, toggle);
      message.append(wrapper);
      userMessageSizes.observe(body);
    } else message.append(body);
  }
  else { const loading = node('span', 'busy-placeholder', 'Working… '); loading.append(clock(event)); message.append(loading); }
  if(event.role==='user' && event.checkpoint && !current?.readonly){
    message.tabIndex=0;
    message.setAttribute('aria-haspopup','menu');
    message.addEventListener('contextmenu',e=>{
      e.preventDefault();
      openCheckpointMenu(message,event.id,e.clientX,e.clientY);
    });
    message.addEventListener('keydown',e=>{
      if(e.target!==message || (e.key!=='ContextMenu' && !(e.shiftKey&&e.key==='F10')))return;
      e.preventDefault();
      const bounds=message.getBoundingClientRect();
      openCheckpointMenu(message,event.id,bounds.left,bounds.bottom);
    });
  }
  if (event.role === 'user' && ['sending','queued','failed','unconfirmed'].includes(event.status)) {
    const labels = {sending:'Отправляется…',queued:'В очереди',failed:'Не отправлено',unconfirmed:'Ожидает подтверждения'};
    const status = node('div','outgoing-status',labels[event.status] + (event.error ? ' · ' + event.error : ''));
    status.setAttribute('role','status');
    if (['failed','unconfirmed'].includes(event.status)) {
      status.append(button('Вернуть в поле ввода', () => {
        if ($('prompt').value.trim() || attachments.length) {
          showNotice('Сначала отправь или очисти текущий черновик.');
          return;
        }
        outgoing[current.session.id] = (outgoing[current.session.id] || []).filter(item => item.deliveryId !== event.deliveryId);
        $('prompt').value = event.text;
        attachments = event.attachments || [];
        $('prompt').dispatchEvent(new Event('input'));
        $('prompt').focus();
        renderAttachments();
        renderMessages(current.session);
      }));
    }
    message.append(status);
  }
  if (event.role === 'assistant' && event.text && event.status !== 'running') {
    const actions = node('div', 'message-actions');
    const copy = button('', e => copyText(event.text, e.currentTarget)); copy.title = 'Copy response'; copy.setAttribute('aria-label','Copy response'); copy.append(glyph('copy')); const save = button('', e => { if (marks.has(event.id)) marks.delete(event.id); else marks.add(event.id); e.currentTarget.setAttribute('aria-pressed',String(marks.has(event.id))); persist(); }); save.title = 'Bookmark response'; save.setAttribute('aria-label','Bookmark response'); save.setAttribute('aria-pressed',String(marks.has(event.id))); save.append(glyph('bookmark')); actions.append(copy,save); message.append(actions);
  }
  return message;
}
const checkpointMenu=$('checkpoint-menu');
let checkpointAnchor;
function closeCheckpointMenu(restoreFocus=false){
  if(checkpointMenu.hidden)return;
  checkpointMenu.hidden=true;
  if(restoreFocus && checkpointAnchor?.isConnected)checkpointAnchor.focus({preventScroll:true});
  checkpointAnchor=null;
}
function openCheckpointMenu(message,id,x,y){
  if(!current || current.readonly)return;
  closePopup();
  checkpointAnchor=message;
  const sessionId=current.session.id;
  const actions=[['Ветка отсюда',false],['Ветка с откатом кода',true]];
  checkpointMenu.replaceChildren(...actions.map(([label,restoreCode])=>{
    const item=button(label,()=>{
      closeCheckpointMenu(true);
      if(!busy && current?.session.id===sessionId)send('checkpoint',{id,...(restoreCode?{restoreCode:true}:{})});
    },'popup-item');
    item.setAttribute('role','menuitem');
    item.setAttribute('aria-disabled',String(busy));
    return item;
  }));
  checkpointMenu.hidden=false;
  const bounds=checkpointMenu.getBoundingClientRect();
  checkpointMenu.style.left=Math.max(4,Math.min(x,window.innerWidth-bounds.width-4))+'px';
  checkpointMenu.style.top=Math.max(4,Math.min(y,window.innerHeight-bounds.height-4))+'px';
  checkpointMenu.firstElementChild.focus({preventScroll:true});
}
document.addEventListener('pointerdown',e=>{
  if(!checkpointMenu.contains(e.target))closeCheckpointMenu();
});
document.addEventListener('focusin',e=>{
  if(!checkpointMenu.contains(e.target))closeCheckpointMenu();
});
$('conversation').addEventListener('scroll',()=>closeCheckpointMenu(true),{passive:true});
window.addEventListener('resize',()=>closeCheckpointMenu(true));
document.addEventListener('keydown',e=>{
  if(checkpointMenu.hidden)return;
  if(e.key==='Tab'){closeCheckpointMenu(true);return;}
  if(!['Escape','ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
  e.preventDefault();e.stopImmediatePropagation();
  if(e.key==='Escape'){closeCheckpointMenu(true);return;}
  const items=[...checkpointMenu.children],index=items.indexOf(document.activeElement);
  items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:items.length-1))%items.length].focus();
},true);

function positionTimelineRail(activity) {
  const top = activity.getBoundingClientRect().top;
  function dotPosition(row, edge) {
    if (!row) return 0;
    const dot = row.matches('.tool-wrapper, .inline-agent-batch') ? row[edge] : row;
    const style = getComputedStyle(dot, '::before');
    return dot.getBoundingClientRect().top - top + parseFloat(style.top) + parseFloat(style.height) / 2;
  }
  activity.style.setProperty('--rail-start', dotPosition(activity.firstElementChild, 'firstElementChild') + 'px');
  activity.style.setProperty('--rail-end', dotPosition(activity.lastElementChild, 'lastElementChild') + 'px');
}
const timelineRailSizes = new ResizeObserver(entries => requestAnimationFrame(() => {
  for (const {target} of entries) if (target.isConnected && !target.hidden) positionTimelineRail(target);
}));

function renderMessages(session, scrollToLatest = false) {
  const scroller = $('conversation'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100, previousScroll = scroller.scrollTop;
  const timeline = window.AITranscript.outgoingTimeline(session.timeline, session.queue || [], outgoing[session.id] || []);
  const container = $('messages'), valid = new Set(), turns = window.AITranscript.groupTurns(timeline);
  container.classList.toggle('starts-with-user', !!turns[0]?.user);
  const changedRails = new Set();
  for (const turn of turns) {
    let group = [...container.children].find(n => n.dataset.turnId === turn.id);
    if (!group) { group = node('section', 'turn'); group.dataset.turnId = turn.id; group.setAttribute('aria-label','Conversation turn'); group.append(node('div','turn-user'), node('div','turn-activity')); container.append(group); }
    const activity = group.querySelector('.turn-activity'), user = group.querySelector('.turn-user');
    timelineRailSizes.observe(activity);
    for (const event of [...(turn.user ? [turn.user] : []), ...turn.activity]) {
      const finalReply = event === turn.activity.at(-1) && event.role === 'assistant' &&
        event.status !== 'running' && !!event.text;
      valid.add(event.id); const signature = JSON.stringify(event) + String(busy) + String(finalReply);
      let cached = rendered.get(event.id);
      if (!cached || cached.signature !== signature) {
        if (event.role !== 'user') changedRails.add(activity);
        const oldBody = cached?.element?.querySelector('.user-message-viewport > .message-body');
        if (oldBody) userMessageSizes.unobserve(oldBody);
        const element = renderEvent(event, finalReply);
        if (cached?.element && element){const oldPre=[...cached.element.querySelectorAll('pre, .markdown-table')].map(n=>[n.scrollTop,n.scrollLeft]);cached.element.replaceWith(element);[...element.querySelectorAll('pre, .markdown-table')].forEach((n,i)=>{if(oldPre[i]){n.scrollTop=oldPre[i][0];n.scrollLeft=oldPre[i][1];}});} else cached?.element?.remove();
        cached = { signature, element }; rendered.set(event.id, cached);
      }
      const target = event.role === 'user' ? user : activity;
      if (cached.element && cached.element.parentNode !== target) target.append(cached.element);
      if (event.role === 'user' && cached.element && (!cached.foldMeasured || !cached.element.isConnected)) {
        const body = cached.element.querySelector('.user-message-viewport > .message-body');
        if (body) updateUserMessageFold(body);
        cached.foldMeasured = true;
      }
    }
    activity.hidden = !turn.activity.some(e => rendered.get(e.id)?.element);
  }
  for (const [id, cached] of rendered) if (!valid.has(id)) {
    const body = cached.element?.querySelector('.user-message-viewport > .message-body');
    if (body) userMessageSizes.unobserve(body);
    if (cached.element?.parentElement?.matches('.turn-activity')) changedRails.add(cached.element.parentElement);
    cached.element?.remove(); rendered.delete(id);
  }
  const turnIds = new Set(turns.map(t=>t.id)); for (const group of [...container.children]) if(!turnIds.has(group.dataset.turnId)){
    timelineRailSizes.unobserve(group.querySelector('.turn-activity'));
    group.remove();
  }
  const empty = timeline.length === 0;
  const needsModel = empty && !current?.readonly && !current?.provider.configured && !current?.modelConnections?.length;
  $('welcome').hidden = !empty;
  $('empty-brand').hidden = !empty;
  $('setup').hidden = !needsModel;
  $('welcome-title').hidden = $('welcome-hint').hidden = needsModel;
  $('app').classList.toggle('needs-model', needsModel);
  requestAnimationFrame(() => {
    for (const activity of changedRails) if (activity.isConnected && !activity.hidden) positionTimelineRail(activity);
    scroller.scrollTop = scrollToLatest || nearBottom ? scroller.scrollHeight : previousScroll;
    updateScrollFade();
  });
}

let activitySince = 0;
let workingRail;
const activityWords = ['Herding','Wibbling','Baking','Working'];
const activityWordInterval = 10000;
function updateActivity() {
  const active=busy&&!stopRequested&&!approval&&!current?.readonly;
  $('activity-indicator').hidden=!active;
  const latestTurn = active && [...$('messages').children].findLast(turn => !turn.dataset.turnId.startsWith('outgoing:'));
  const rail = latestTurn ? latestTurn.querySelector('.turn-activity:not([hidden])') : undefined;
  if (rail !== workingRail) {
    workingRail?.classList.remove('working');
    rail?.classList.add('working');
    workingRail = rail;
  }
  if(active&&!activitySince)activitySince=Date.now();else if(!active)activitySince=0;
  if (!active) return;
  const waiting = current?.waitingForBackground;
  const word = waiting ? 'Waiting for background work' : activityWords[Math.floor((Date.now()-activitySince)/activityWordInterval)%activityWords.length];
  const label = $('activity-label');
  if (label.dataset.word !== word) {
    label.dataset.word = word;
    label.replaceChildren(node('span','activity-word',word),animatedDots());
  }
}
function persist() {
  if (current) drafts[current.session.id] = { text: $('prompt').value, attachments, dismissedEditorContext };
  vscode.setState({ sessionId: current?.session.id || restored.sessionId, chatPreferences:current?.session.chatPreferences ?? restored.chatPreferences, modelProfileId:restored.modelProfileId, root:current?.session.root, drafts, outgoing, bookmarks: [...marks], focusView });
}
function attachmentChip(item, removeAttachment) {
  const tag = node('div', 'attachment' + (item.kind === 'image' ? ' attachment-image' : ''));
  const label = item.label || (item.kind === 'image' ? 'Скриншот' : 'Файл');
  const dimensions = item.width && item.height ? `${item.width}×${item.height}` : '';
  const thumbnail = item.thumbnail || item.dataUrl;
  const showImage = item.kind === 'image' && /^data:image\/(?:png|jpeg|webp);base64,/.test(thumbnail || '');
  const preview = showImage ? node('img') : glyph(item.kind === 'selection' ? 'selection' : 'file');
  if (showImage) { preview.src = thumbnail; preview.alt = ''; }
  tag.title = [label, dimensions].filter(Boolean).join(' · ');
  tag.append(preview, node('span', 'attachment-name', label));
  if (dimensions) tag.append(node('span', 'attachment-size', dimensions));
  if (removeAttachment) {
    const remove = button('', removeAttachment);
    remove.title = 'Удалить вложение';
    remove.setAttribute('aria-label', `Удалить ${label}`);
    remove.append(glyph('close'));
    tag.append(remove);
  }
  return tag;
}
function renderAttachments() {
  const editor = attachedEditorContext();
  const chips = attachments.map((item, index) => attachmentChip(item, () => {
    attachments.splice(index, 1);
    renderAttachments();
    updateComposerInput(false);
    $('prompt').focus();
  }));
  if (editor) {
    const chip = attachmentChip(editor, () => {
      dismissedEditorContext = editor.key;
      renderAttachments();
      persist();
      $('prompt').focus();
    });
    chip.classList.add('editor-context-attachment');
    chips.unshift(chip);
  }
  $('attachments').replaceChildren(...chips);
}
function attachedEditorContext() {
  const editor = current?.editorContext;
  return editor?.key !== dismissedEditorContext ? editor : undefined;
}
async function describeImage(item) {
  const image = new Image();
  image.src = item.dataUrl;
  await image.decode();
  const { naturalWidth: width, naturalHeight: height } = image;
  const scale = Math.min(1, 160 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ...item, width, height };
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { ...item, width, height, thumbnail: canvas.toDataURL('image/webp', 0.78) };
}
async function addPickerAttachment(file) {
  const sessionId = current?.session.id;
  try {
    const item = file.kind === 'image' ? await describeImage(file) : file;
    if (!sessionId || current?.session.id !== sessionId || current.readonly) return;
    if (attachments.length >= 8) throw Error('Можно прикрепить до 8 файлов.');
    if (!item.path || !attachments.some(a => a.path === item.path && a.kind === item.kind)) attachments.push(item);
    renderAttachments();
    updateComposerInput(false);
    $('prompt').focus();
  } catch (error) {
    if (current?.session.id === sessionId) showNotice(error.message || 'Не удалось прикрепить файл.', 'error');
  }
}
function resize() { $('prompt').style.height = 'auto'; $('prompt').style.height = Math.min(230, $('prompt').scrollHeight) + 'px'; }
function showNotice(text, kind = 'info') {
  const notice = $('notice');
  const close = button('', () => {
    notice.hidden = true;
    if (!$('prompt').disabled && !$('prompt').closest('[hidden]')) $('prompt').focus();
  }, 'notice-dismiss');
  close.title = 'Закрыть уведомление';
  close.setAttribute('aria-label', close.title);
  close.append(glyph('close'));
  const message = node('div', 'notice-message');
  message.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  notice.dataset.kind = kind;
  notice.replaceChildren(message, close);
  notice.hidden = false;
  if (kind === 'error') message.append(node('strong', 'notice-heading', 'Ошибка'));
  message.append(node('div', 'notice-text', text));
}
function state(data) {
  const changed = current?.session.id !== data.session.id;
  const editorChanged = current?.editorContext?.key !== data.editorContext?.key;
  if(changed || data.readonly || data.busy!==busy)closeCheckpointMenu(true);
  if (changed && current) persist();
  const acknowledged = new Set([...data.session.timeline,...(data.session.queue||[])].map(item=>item.deliveryId).filter(Boolean));
  if (outgoing[data.session.id]) {
    const pending = outgoing[data.session.id].filter(item=>!acknowledged.has(item.deliveryId));
    if (pending.length) outgoing[data.session.id] = pending;
    else delete outgoing[data.session.id];
  }
  current = data; busy = data.busy;
  stopRequested = busy && (data.stopping || (!changed && stopRequested));
  if (changed) {
    lastPromptEdit = -Infinity;
    composingPrompt = false;
    closeCommands();
    closePopup();
    const draft = drafts[data.session.id]; attachments = draft?.attachments || []; $('prompt').value = draft?.text || '';
    dismissedEditorContext = draft?.dismissedEditorContext;
    $('notice').hidden = true; timelineRailSizes.disconnect(); rendered.clear(); $('messages').replaceChildren(); renderAttachments(); resize();
  } else if (editorChanged) renderAttachments();
  $('title').textContent = data.session.title; document.querySelector('.composer').dataset.mode = data.session.mode;
  document.querySelector('footer').hidden = false; $('prompt').disabled = !!data.readonly; updateComposerPlaceholder(); $('attach').disabled = !!data.readonly; $('commands').disabled = !!data.readonly; $('model').disabled = !!data.readonly;
  $('source').hidden = !data.readonly;
  $('source-text').textContent = data.source ? `${data.source} · только чтение` : '';
  $('brand').disabled = !!data.readonly;
  $('mode').replaceChildren(glyph(modeOptions.find(m => m.id === data.session.mode)?.icon || 'manual'), node('span', '', modeOptions.find(m => m.id === data.session.mode)?.name || 'Manual')); $('mode').disabled = !!data.readonly;
  $('send').replaceChildren(glyph(busy ? 'stop' : 'send'));
  $('send').classList.toggle('stop', busy);
  updateSendButton();
  $('model').textContent = !data.provider.configured ? 'Select model' : `${data.provider.label || data.provider.model || 'Select model'}${data.provider.name==='chatgpt'?' · ChatGPT':''}`;
  $('model').title = data.provider.configured ? data.provider.baseUrl : '';syncModelControls?.();
  $('workspace').textContent = data.workspace;
  const usage = data.contextUsage;
  const contextButton = $('context-usage');
  contextButton.hidden = !usage || !!data.readonly;
  if (usage) {
    const percent = Math.min(100, Math.round(100 * usage.used / usage.window));
    const remaining = Math.max(0, usage.compactAt - usage.used);
    const description = `Контекст ≈ ${percent}% · ${usage.used.toLocaleString()} из ${usage.window.toLocaleString()} токенов · до автосжатия ≈ ${remaining.toLocaleString()}`;
    contextButton.style.setProperty('--context-fill', percent + '%');
    contextButton.title = description;
    contextButton.setAttribute('aria-label', description + '. Открыть отчёт о контексте');
  }
  $('tokens').textContent = data.session.usage.input + data.session.usage.output ? `${((data.session.usage.input + data.session.usage.output) / 1000).toFixed(1)}k tokens` : '';
  const modelRequests = (data.session.metrics || []).filter(row => row.turnId === data.session.turnId && row.phase === 'generation' && row.actor === 'main');
  const lastReported = modelRequests.filter(row => row.usage).at(-1)?.usage;
  const requestInput = lastReported?.input_tokens ?? lastReported?.prompt_tokens;
  const cacheRead=lastReported?.input_tokens_details?.cached_tokens??lastReported?.prompt_tokens_details?.cached_tokens??lastReported?.cache_read_input_tokens;
  const cacheWrite=lastReported?.input_tokens_details?.cache_write_tokens??lastReported?.prompt_tokens_details?.cache_write_tokens??lastReported?.cache_creation_input_tokens;
  const compactions=(data.session.metrics||[]).filter(row=>row.turnId===data.session.turnId&&row.phase==='compaction').length;
  $('tokens').title = [
    `За чат: вход ${data.session.usage.input} · выход ${data.session.usage.output} · кэш ${data.session.usage.cached || 0}`,
    modelRequests.length ? `Последний ход: ${modelRequests.length} запросов основной модели` : '',
    requestInput != null ? `Вход последнего запроса: ${requestInput}` : '',
    cacheRead!=null ? `Чтение кэша: ${cacheRead}` : '',
    cacheWrite!=null ? `Запись кэша: ${cacheWrite}` : 'Запись кэша: провайдер не сообщил',
    compactions ? `Запросов на сжатие в последнем ходе: ${compactions}` : ''
  ].filter(Boolean).join('\n');
  $('quota').hidden = !data.quota?.length;
  if (data.quota?.length) {
    $('quota-label').textContent = `GLM 5h · ${data.quota[0].pct}%`;
    $('quota-fill').style.width = Math.min(100, Math.max(0, data.quota[0].pct)) + '%';
    $('quota-week').textContent = data.quota[1] ? `Неделя ${data.quota[1].pct}%` : '';
    $('quota').title = `Использовано. Сброс: ${new Date(data.quota[0].resetAt).toLocaleString()}. Обновить`;
  }
  updateApproval();
  updateQueueButton();
  renderPlan(data.session.plan);
  renderMessages(data.session); updateActivity(); updateAgentControl(); if ($('agent-map').open) renderAgentTree(); if ($('agent-detail').open) renderAgentDetail(); persist();
}
function updateApproval() {
  clearTimeout(approvalTimer);
  const data = current;
  if (!data) return;
  const request = stopRequested ? undefined : data.approval;
  const previous = approval;
  const hadPanelFocus = $('approval').contains(document.activeElement);
  const editing = document.activeElement === $('prompt');
  const delay = approvalTypingPause - (Date.now() - lastPromptEdit);
  const defer = request && approval?.id !== request.id && editing &&
    (composingPrompt || delay > 0);
  approval = defer ? undefined : request;
  if (defer && !composingPrompt) approvalTimer = setTimeout(updateApproval, delay);
  $('run-status').textContent = (stopRequested ? 'Останавливаю…' : request ? (request.kind === 'question' ? 'Жду ответа' : 'Жду разрешения') : busy ? 'Работаю…' : '') +
    (data.session.queue?.length ? ` · В очереди: ${data.session.queue.length}` : '');
  $('approval').hidden = !approval; document.querySelector('.composer').hidden = !!approval;
  const question = approval?.kind === 'question';
  $('action-approval').hidden = !!question;
  $('question-panel').hidden = !question;
  $('approval').setAttribute('aria-label', question ? 'Вопрос агента' : 'Подтверждение действия');
  if (question && displayedQuestionId !== approval.id) {
    const id = approval.id;
    displayedQuestionId = id;
    $('question-title').textContent = approval.question;
    $('question-why').textContent = approval.why || '';
    $('question-why').hidden = !approval.why;
    $('question-other').value = '';
    $('question-send').disabled = true;
    $('question-editor').hidden = true;
    $('question-custom').setAttribute('aria-expanded', 'false');
    $('question-options').replaceChildren(...approval.options.map((label,choice)=>{
      const item = button('',()=>send('answerQuestion',{id,choice}));
      item.type = 'button';
      const text=node('span','question-option-copy');
      const title=node('span','question-option-title',label);
      const recommended=approval.recommendation?.choice===choice;
      if(recommended)title.append(node('span','question-option-badge','Рекомендую'));
      text.append(title);
      if(approval.optionDetails?.[choice])text.append(node('span','question-option-detail',approval.optionDetails[choice]));
      if(recommended && approval.recommendation.reason)text.append(node('span','question-option-detail',approval.recommendation.reason));
      item.append(node('span','choice-number',String(choice+1)),text);
      return item;
    }));
  } else if (!question) {
    displayedQuestionId = undefined;
  }
  if (approval && !question) {
    $('approval-title').textContent = approval.kind==='command'?'Bash command':approval.kind==='mcp'?'MCP tool':approval.title||'Edit file'; $('approval-queue').textContent = data.approvalCount>1?`${data.approvalCount} pending`:''; $('approval-reason').textContent = [approval.agent,approval.reason].filter(Boolean).join(' · '); $('allow-auto').hidden = current.session.mode==='auto'||['hook','memory'].includes(approval.kind); $('approval-detail').textContent = approval.detail;
    $('approval-cwd').textContent = approval.cwd || approval.title;
    $('review').hidden = approval.kind !== 'edit';
    const remember=$('remember-command');
    if(previous?.id!==approval.id)remember.open=false;
    remember.hidden=!approval.rememberable;
    const hunks=$('hunk-review');
    hunks.hidden=!approval.hunks?.length;
    if(hunks.dataset.approvalId!==approval.id){
      hunks.dataset.approvalId=approval.id;
      hunks.open=false;
      $('hunk-list').replaceChildren(...(approval.hunks||[]).map((hunk,index)=>{
        const row=node('label','hunk-selection');
        const check=node('input');check.type='checkbox';check.checked=true;check.value=String(index);
        check.onchange=()=>{$('apply-hunks').disabled=!$('hunk-list').querySelector('input:checked');};
        row.append(check,node('span','','Строка '+hunk.line));
        if(hunk.before)row.append(node('pre','hunk-before',hunk.before));
        if(hunk.after)row.append(node('pre','hunk-after',hunk.after));
        return row;
      }));
      $('apply-hunks').disabled=false;
    }
  }
  if (approval && previous?.id !== approval.id && !$('agent-map').open && !$('agent-detail').open) {
    const first = question ? $('question-options').querySelector('button') : $('allow');
    first?.focus({preventScroll:true});
  } else if (!approval && previous && hadPanelFocus && !data.readonly) {
    $('prompt').focus({preventScroll:true});
  }
  updateActivity();
}
function updateSendButton() {
  const sendButton = $('send');
  sendButton.disabled = !!current?.readonly || stopRequested || (!busy && !hasComposerInput());
  sendButton.title = stopRequested ? 'Останавливаю…' : busy ? 'Остановить' : 'Отправить · Enter';
  sendButton.setAttribute('aria-label', sendButton.title);
}
function requestStop() {
  if (!busy || stopRequested) return;
  stopRequested = true;
  send('stop');
  updateSendButton();
  updateComposerPlaceholder();
  updateQueueButton();
  updateApproval();
}
function submit() {
  if ($('app').classList.contains('needs-model')) return;
  if (stopRequested) return;
  if (busy && !hasComposerInput()) return requestStop();
  if (!hasComposerInput()) return;
  const text = $('prompt').value.trim() || 'Посмотри вложение.';
  $('notice').hidden = true; closeCommands();
  if(text==='/settings'){$('prompt').value='';showProviderSetup();persist();return;}
  if (text === '/model' || text === '/permissions') { $('prompt').value = ''; text === '/model' ? showModels() : showModes(); persist(); return; }
  if (text === '/retro' && current) {
    $('prompt').value = '';
    $('prompt').dispatchEvent(new Event('input'));
    send('retro');
    return;
  }
  if (text === '/context' && current) {
    $('prompt').value = '';
    $('prompt').dispatchEvent(new Event('input'));
    send('contextReport');
    return;
  }
  if (text === '/resume') { send('resumeTask'); $('prompt').value=''; persist(); return; }
  if (text === '/focus') { $('focus-view').click(); $('prompt').value = ''; persist(); return; }
  if (text === '/agents') { showAgentTree(); $('prompt').value = ''; persist(); return; }
  if (text === '/plan') { send(current?.session.plan ? 'openPlan' : 'mode', { mode: 'plan' }); $('prompt').value = ''; persist(); return; }
  if (!current || current.readonly) return;
  const deliveryId = crypto.randomUUID();
  const submittedAttachments = attachments;
  const editorContextKey = attachedEditorContext()?.key;
  if (!['/new','/clear'].includes(text) && !/^\/goal(?:\s+(?:status|pause|resume))?$/.test(text)) {
    (outgoing[current.session.id] ||= []).push({
      deliveryId,text,attachments:submittedAttachments,startedAt:Date.now(),status:'sending'
    });
  }
  $('prompt').value = '';
  attachments = [];
  renderAttachments();
  $('prompt').dispatchEvent(new Event('input'));
  renderMessages(current.session, true);
  send('send', { text, attachments:submittedAttachments, deliveryId, editorContextKey });
}
const modeOptions = [
  { id: 'manual', name: 'Manual', icon: 'manual', description: 'AI will ask for approval before making each edit' },
  { id: 'acceptEdits', name: 'Edit automatically', icon: 'edit', description: 'AI will edit your selected text or the whole file' },
  { id: 'plan', name: 'Plan', icon: 'plan', description: 'AI will explore the code and present a plan before editing' },
  { id: 'auto', name: 'Auto', icon: 'auto', description: 'Run ordinary edits and Bash commands automatically. Ask before running rm.' }
];
let codexCatalogHandler;
let popupKind, agentTreeSignature, syncModelControls,popupAnchor,integrationData;
function closePopup(restoreFocus=false) {const anchor=popupAnchor;popupAnchor=null;syncModelControls=null;codexCatalogHandler=null;$('popup').querySelectorAll('input[type="password"]').forEach(input=>input.value=''); if(popupKind==='provider'){chatgptUiCancel?.();chatgptUiHandler=null;chatgptUiCancel=null;$('popup').querySelectorAll('input[type="password"]').forEach(n=>n.value='');$('popup').replaceChildren();connectionRequestId=null;} $('popup').hidden = true; popupKind = null;if(restoreFocus&&anchor)$(anchor)?.focus(); for (const id of ['mode','model','attach','agents']) if(id!=='agents'||!$('agent-map').open)$(id).setAttribute('aria-expanded','false'); }
function menu(kind, title, anchor) {
  if (!$('popup').hidden && popupKind === kind) { closePopup(); return null; }
  closePopup(); popupKind = kind;popupAnchor=anchor; const popup = $('popup'); popup.replaceChildren(); popup.setAttribute('role','menu');
  const header = node('div','popup-heading',title); popup.append(header); popup.hidden = false; popup.className = 'popup popup-' + kind;popup.style.maxHeight=Math.max(64,Math.min(kind==='provider'?420:320,document.documentElement.clientHeight*.48||320,document.querySelector('.composer').getBoundingClientRect().top-12))+'px';
  if (anchor) {
    const trigger = $(anchor);
    trigger.setAttribute('aria-expanded','true');
    void Promise.resolve().then(() => {
      if (popupKind !== kind || popup.hidden || popup.getAttribute('role') !== 'menu' ||
          document.activeElement !== trigger) return;
      (popup.querySelector('[data-selected="true"]:not(:disabled)') ||
       popup.querySelector('[role="menuitem"]:not(:disabled)'))?.focus({preventScroll:true});
    });
  }
  return popup;
}
function menuItem(parent, name, description, icon, chosen, callback) {
  const b = button('', event => { event.stopPropagation();closePopup(true); callback(); }, 'popup-item'); b.setAttribute('role','menuitem');
  b.append(glyph(icon)); const text = node('span','popup-item-text'); text.append(node('span','popup-item-name', name)); if(description) text.append(node('span','popup-item-description', description)); b.append(text);
  if(chosen) { b.dataset.selected = 'true'; b.append(glyph('check')); } parent.append(b); return b;
}
function showModes() {
  const popup = menu('modes','Modes','mode'); if (!popup) return;
  popup.firstChild.append(node('span','popup-shortcut','⇧ + tab to switch'));
  for(const mode of modeOptions) menuItem(popup,mode.name,mode.description,mode.icon,current?.session.mode === mode.id,()=>send('mode',{mode:mode.id}));
}
function showModels() {
  if(!current)return;
  const popup = menu('models','Select model','model'); if(!popup) return;
  for(const model of current.modelConnections||(current.provider.configured?[{id:'legacy',label:current.provider.model,model:current.provider.model,provider:current.provider.name}]:[])){
    const item=menuItem(popup,model.label||model.model,`${model.provider.toUpperCase()} · ${model.model}`,'agents',model.id===(current.provider.connectionId||'legacy'),()=>send('selectModelConnection',{id:model.id}));item.disabled=busy;
  }
  menuItem(popup,'Добавить модель…','','plus',false,()=>showProviderSetup()).disabled=busy;
  const isChatgpt = current.provider.name === 'chatgpt';
  if(isChatgpt){
    const plan=node('div','model-plan-status');plan.append(node('span','','Подписка ChatGPT · '+(current.chatgptAccounts?.find(a=>a.id===current.provider.accountId)?.email||'аккаунт')));
    const link=node('a','','Управлять лимитами');link.href='https://chatgpt.com/settings/usage';link.target='_blank';plan.append(link);popup.append(plan);

    const row = node('label','model-choice-row');
    const label = node('span','model-choice-label','Модель Codex');
    const select = node('select','codex-model-select');
    const status = node('div','model-plan-status');
    status.setAttribute('role','status');
    row.append(label,select);popup.append(row,status);
    const fill = models => {
      const active = current.provider.model;
      const entries = models.some(model=>model.id===active) ? models : [{id:active,label:current.provider.label||active},...models];
      select.replaceChildren(...entries.map(model=>{
        const option = node('option','',model.label);
        option.value=model.id;
        return option;
      }));
      select.value=active;
      select.disabled=busy||current.readonly||entries.length<2;
    };
    fill(current.provider.chatgptModels||[]);
    select.onchange=()=>{
      if(select.disabled||select.value===current.provider.model)return;
      send('selectChatgptModel',{model:select.value});
      closePopup(true);
    };
    if(current.provider.accountId){
      const requestId=crypto.randomUUID();
      codexCatalogHandler=data=>{
        if(data.requestId!==requestId)return;
        status.textContent=data.error||'';
        status.hidden=!data.error;
        if(data.models)fill(data.models);
      };
      status.textContent='Загружаем модели Codex…';
      send('chatgptCatalog',{requestId});
    }else status.hidden=true;
  }
  popup.append(node('div','popup-divider'));
  if((current.provider.name==='glm'&&current.provider.configured)||isChatgpt){
    const levelsForModel=()=>isChatgpt ? current.provider.effortLevels||[] : ['low','high','max'];
    const effortRow=node('div','model-choice-row'),effortLabel=node('span','model-choice-label');effortRow.append(effortLabel);
    const track=node('div','effort-track');track.setAttribute('role','radiogroup');track.setAttribute('aria-label','Глубина мышления');
    const choose=value=>{current.provider.reasoningEffort=value;syncModelControls?.();send('selectEffort',{effort:value,...(isChatgpt?{model:current.provider.model}:{})});};
    track.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const levels=levelsForModel();
      if(!levels.length||track.firstElementChild?.disabled)return;
      event.preventDefault();event.stopPropagation();
      const index=Math.max(0,levels.indexOf(current.provider.reasoningEffort));
      const next=event.key==='Home'?0:event.key==='End'?levels.length-1:(index+(event.key==='ArrowRight'?1:levels.length-1))%levels.length;
      choose(levels[next]);track.children[next].focus();
    };
    effortRow.append(track);popup.append(effortRow);
    const architecture=button('',event=>{event.stopPropagation();const profile=current.provider.workProfile==='architecture'?'balanced':'architecture';current.provider.workProfile=profile;syncModelControls?.();send('selectProfile',{profile});},'model-choice-row architecture-toggle');architecture.setAttribute('role','switch');architecture.title='Architecture — усиленный профиль для проектирования; выключено — Balanced';architecture.append(node('span','model-choice-label','Architecture'),node('span','model-switch'));popup.append(architecture);
    const effortLabelFor=value=>value==='xhigh'?'XHigh':value.charAt(0).toUpperCase()+value.slice(1);
    let signature;
    syncModelControls=()=>{
      const levels=levelsForModel(), nextSignature=levels.join(',');
      if(signature!==nextSignature){
        signature=nextSignature;
        track.replaceChildren(...levels.map(value=>{
          const dot=button('',event=>{event.stopPropagation();choose(value);},'effort-dot');
          dot.dataset.effort=value;dot.title=effortLabelFor(value);
          dot.setAttribute('role','radio');dot.setAttribute('aria-label',dot.title);
          return dot;
        }));
      }
      effortRow.hidden=!levels.length;
      const effort=levels.includes(current.provider.reasoningEffort)?current.provider.reasoningEffort:levels[0];
      effortLabel.textContent=effort?'Мышление ('+effortLabelFor(effort)+')':'';
      for(const dot of track.children){
        const selected=dot.dataset.effort===effort;
        dot.setAttribute('aria-checked',String(selected));dot.tabIndex=selected?0:-1;
        dot.disabled=!!current.readonly;
      }
      architecture.setAttribute('aria-checked',String(current.provider.workProfile==='architecture'));
    };syncModelControls();
    popup.append(node('div','popup-divider'));
  }
  menuItem(popup,'Skills and MCP…','','agents',false,()=>{integrationData=null;showIntegrations();send('integrations');});

}
let connectionRequestId=null,pendingSetupUi=false,chatgptUiHandler=null,chatgptUiCancel=null;
function showProviderSetup(preferredProvider){
  if(!current){pendingSetupUi=true;return;}
  if(popupKind==='provider'){document.getElementById('connection-model')?.focus();return;}
  const popup=menu('provider','Добавить модель',preferredProvider==='chatgpt'?'connect-codex':preferredProvider?'connect':'model');if(!popup)return;popup.setAttribute('role','dialog');popup.setAttribute('aria-label','Добавить модель');
  const close=button('',()=>{closePopup();$('prompt').focus();},'icon');close.title='Закрыть';close.setAttribute('aria-label','Закрыть');close.append(glyph('close'));popup.firstChild.append(close);
  const form=node('form','connection-form'),field=(title,input)=>{const label=node('label','connection-field');label.append(node('span','',title),input);form.append(label);return input;};
  const input=(id,type='text')=>{const n=node('input');n.id=id;n.type=type;n.autocomplete='off';n.spellcheck=false;return n;};
  const label=field('Название',input('connection-label'));label.placeholder='Необязательно — по умолчанию ID модели';label.maxLength=80;
  const provider=node('select');provider.id='connection-provider';for(const [id,name]of [['glm','GLM · z.ai'],['openai','OpenAI · API-ключ'],['chatgpt','ChatGPT · подписка Codex'],['custom','Custom API']]){const option=node('option','',name);option.value=id;provider.append(option);}field('Провайдер',provider);provider.value=current.provider.name;
  const model=field('ID модели',input('connection-model'));model.value=current.provider.model||'';model.required=true;model.placeholder='ID модели, доступной в вашем аккаунте';
  const contextWindow=field('Окно контекста',input('connection-context-window','number'));
  contextWindow.min='8192';contextWindow.max='10000000';contextWindow.step='1';contextWindow.placeholder='По настройкам Harness';
  const base=field('API URL',input('connection-base'));base.value=current.provider.baseUrl||'';base.required=true;
  const protocol=node('select');protocol.id='connection-protocol';for(const [id,name]of [['chat','Chat Completions'],['responses','Responses']]){const option=node('option','',name);option.value=id;protocol.append(option);}const protocolLabel=node('label','connection-field');protocolLabel.append(node('span','','Протокол'),protocol);form.append(protocolLabel);protocol.value=current.provider.protocol||'chat';
  const reuseLabel=node('label','connection-reuse'),reuse=input('connection-reuse','checkbox');reuseLabel.append(reuse,node('span','','Использовать ключ текущего подключения'));form.append(reuseLabel);
  const key=field('API-ключ',input('connection-key','password'));key.autocomplete='new-password';key.placeholder='Ключ хранится в SecretStorage VS Code';
  const error=node('div','connection-error');error.id='connection-error';error.setAttribute('role','status');form.append(error);
  const actions=node('div','connection-actions'),cancel=button('Отмена',()=>closePopup(true)),save=button('Добавить модель',()=>{},'connection-save');cancel.type='button';save.type='submit';actions.append(cancel,save);form.append(actions);popup.append(form);
  const chatgpt=node('div','connection-chatgpt');form.insertBefore(chatgpt,error);
  const account=node('select');account.id='connection-account';account.setAttribute('aria-label','Аккаунт ChatGPT');
  const accountRow=node('div','connection-chatgpt-account');const login=button('Continue with ChatGPT',()=>authorize(true),'connection-login');login.type='button';login.setAttribute('data-oai-siwc-button','');accountRow.append(account,login);chatgpt.append(accountRow);
  const note=node('div','connection-chatgpt-note','Используется доступный лимит подписки ChatGPT. Доступ к моделям зависит от аккаунта. '),usage=node('a','','Лимиты и доступ');usage.href='https://chatgpt.com/settings/usage';usage.target='_blank';note.append(usage);chatgpt.append(note);
  const planModel=node('select');planModel.id='connection-plan-model';const planLabel=node('label','connection-field');planLabel.append(node('span','','Модель подписки'),planModel);chatgpt.append(planLabel);
  let accounts=current.chatgptAccounts||[],authRequest=null,modelsAccount=null;
  const renderAccounts=selected=>{account.replaceChildren();const empty=node('option','','Добавить аккаунт…');empty.value='';account.append(empty);for(const a of accounts){const o=node('option','',a.email);o.value=a.id;account.append(o);}account.value=selected||'';};renderAccounts(current.provider.accountId);
  const eligible=()=>provider.value!=='chatgpt'&&current.provider.configured&&provider.value===current.provider.name&&base.value.trim().replace(/\/+$/,'')===(current.provider.baseUrl||'').replace(/\/+$/,'')&&protocol.value===current.provider.protocol;
  const refresh=()=>{const plan=provider.value==='chatgpt';chatgpt.hidden=!plan;model.parentElement.hidden=plan;model.disabled=plan;base.parentElement.hidden=plan;base.disabled=plan;protocolLabel.hidden=provider.value!=='custom';base.readOnly=provider.value==='openai';reuseLabel.hidden=!eligible();if(!eligible())reuse.checked=false;key.parentElement.hidden=plan;key.disabled=plan||reuse.checked;key.required=!plan&&!reuse.checked;planModel.required=plan;planModel.disabled=!plan||!modelsAccount;save.disabled=plan&&!modelsAccount;};
  const authorize=async signIn=>{
    if(authRequest)return;
    authRequest=String(Date.now())+'-'+Math.random().toString(16).slice(2);login.disabled=true;save.disabled=true;planModel.replaceChildren();modelsAccount=null;error.textContent=signIn?'Завершите вход и разрешите использование подписки в браузере…':'Загружаю модели…';
    send(signIn?'chatgptSignIn':'chatgptModels',{requestId:authRequest,accountId:account.value||undefined});
  };
  chatgptUiCancel=()=>{if(authRequest)send('chatgptCancel',{requestId:authRequest});};
  chatgptUiHandler=data=>{
    if(data.requestId!==authRequest)return;authRequest=null;login.disabled=false;
    if(data.type==='chatgptAuthError'){error.textContent=data.text;refresh();return;}
    if(data.firstSignIn){const welcome=node('div','connection-welcome');welcome.setAttribute('role','status');welcome.append(node('strong','','Вы используете подписку ChatGPT'),node('p','','Запросы этого подключения расходуют доступный лимит вашего плана. Лимитами и доступом можно управлять в настройках ChatGPT.'));const got=button('Понятно',()=>{send('chatgptWelcomeSeen');welcome.remove();});got.type='button';welcome.append(got);chatgpt.prepend(welcome);}
    accounts=data.accounts;renderAccounts(data.account.id);modelsAccount=data.account.id;planModel.replaceChildren();
    for(const m of data.models){const o=node('option','',m.label);o.value=m.id;planModel.append(o);}planModel.value=data.models.some(m=>m.id===current.provider.model)?current.provider.model:data.models[0].id;error.textContent='';refresh();
  };
  account.onchange=()=>{modelsAccount=null;planModel.replaceChildren();refresh();if(account.value)authorize(false);};
  reuse.checked=!!eligible();reuse.onchange=refresh;base.oninput=refresh;protocol.onchange=refresh;
  provider.onchange=()=>{key.value='';reuse.checked=false;base.value=['openai','chatgpt'].includes(provider.value)?'https://api.openai.com/v1':provider.value==='glm'?'https://api.z.ai/api/coding/paas/v4':'';protocol.value=['openai','chatgpt'].includes(provider.value)?'responses':'chat';model.value=provider.value===current.provider.name?current.provider.model:'';error.textContent='';refresh();if(provider.value==='chatgpt'&&account.value&&!modelsAccount)authorize(false);};
  if (preferredProvider) { provider.value=preferredProvider; provider.onchange(); }
  else { refresh(); if(provider.value==='chatgpt'&&account.value)authorize(false); }
  if (preferredProvider==='chatgpt' && !account.value) authorize(true);
  form.onsubmit=event=>{event.preventDefault();if(busy){error.textContent='Дождитесь завершения текущего ответа';return;}if(provider.value==='chatgpt'&&(!modelsAccount||modelsAccount!==account.value)){error.textContent='Войдите в ChatGPT и выберите модель';return;}if(!form.checkValidity()){form.reportValidity();return;}connectionRequestId=String(Date.now())+'-'+Math.random().toString(16).slice(2);save.disabled=true;save.textContent='Сохраняю…';error.textContent='';send('saveModelConnection',{requestId:connectionRequestId,profile:{label:label.value,provider:provider.value,model:provider.value==='chatgpt'?planModel.value:model.value.trim(),accountId:provider.value==='chatgpt'?modelsAccount:undefined,baseUrl:base.value.trim(),protocol:protocol.value,reuseKey:reuse.checked,apiKey:reuse.checked?'':key.value,contextWindow:contextWindow.value?Number(contextWindow.value):undefined}});key.value='';};(provider.value==='chatgpt'?account:model).focus();
}
function updateAgentControl() {
  if (!current) return;
  const agents = window.AITranscript.collectAgents(current.session.timeline);
  const active = agents.filter(n=>n.agent.status === 'running').length;
  const trigger = $('agents');
  let count = trigger.querySelector('.agent-tree-count');
  if (!count) {
    count = node('span','agent-tree-count');
    trigger.append(node('span','agent-chip-dot'),count);
  }
  const label = `${active} ${active===1?'agent':'agents'}`;
  if (count.textContent !== label) count.textContent = label;
  trigger.classList.toggle('has-active', active > 0);
  trigger.title = `${agents.length} subagents${active ? ` · ${active} working` : ''}`;
}
let selectedAgentId = null, mapSignature = '', detailSignature = '';
function showAgentTree() {
  if (!current || $('agent-map').open) return;
  closePopup(); selectedAgentId = null; mapSignature = ''; renderAgentTree();
  if (!$('agent-map').open) $('agent-map').showModal();
  $('agents').setAttribute('aria-expanded','true');
}
function closeAgentMap() { if($('agent-detail').open)$('agent-detail').close(); if($('agent-map').open)$('agent-map').close(); selectedAgentId=null; $('agents').setAttribute('aria-expanded','false'); $('agents').focus(); }
function openAgentDetail(id) { selectedAgentId=id;detailSignature='';renderAgentDetail();if(!$('agent-detail').open)$('agent-detail').showModal(); }
function renderAgentTree() {
  if(!current)return;
  const nodes=window.AITranscript.collectAgents(current.session.timeline);
  const signature=JSON.stringify([busy,current.session.title,current.session.usage,...nodes.map(n=>[n.agent.id,n.parentId,n.agent.title,n.agent.status,n.agent.toolCount,n.agent.finishedAt,n.agent.usage])]);
  if(signature===mapSignature)return;mapSignature=signature;
  $('agent-map-caption').textContent=`${nodes.length} ${nodes.length===1?'agent':'agents'} · click an agent for details`;
  const graph=node('div','agent-map-graph'), root=node('div','agent-map-root');
  root.append(node('span','agent-indicator '+(busy?'is-running':'')),node('div','agent-map-root-text'));
  root.lastChild.append(node('strong','',current.session.title),node('span','muted',`${current.session.model||current.provider.model} · ${((current.session.usage.input+current.session.usage.output)/1000).toFixed(1)}k tokens used`));
  graph.append(root);
  function branch(parentId) {
    const group=node('div','agent-map-children');
    for(const item of nodes.filter(n=>n.parentId===parentId)) {
      const agent=item.agent, wrap=node('div','agent-map-node'), card=button('',()=>openAgentDetail(agent.id),'agent-map-card '+agent.status);
      card.setAttribute('aria-label',`${agent.title} · ${statusLabel(agent.status)}`);
      const text=node('span','agent-map-card-text'), meta=node('span','agent-map-meta');
      text.append(node('span','agent-map-name',agent.title));meta.append(clock(agent),node('span','',` · ${(((agent.usage?.input||0)+(agent.usage?.output||0))/1000).toFixed(1)}k tokens`));text.append(meta);
      card.append(node('span','agent-indicator'),text);wrap.append(card);
      if(nodes.some(n=>n.parentId===agent.id))wrap.append(branch(agent.id));group.append(wrap);
    }return group;
  }
  graph.append(nodes.length?branch(null):node('div','agent-map-empty','No subagents in this conversation.'));
  $('agent-map-content').replaceChildren(graph);
}
function renderAgentDetail() {
  if(!current||!selectedAgentId)return;
  const nodes=window.AITranscript.collectAgents(current.session.timeline),item=nodes.find(n=>n.agent.id===selectedAgentId);if(!item)return;
  const agent=item.agent, resumable=current.session.resumableAgents?.includes(agent.id);
  const signature=JSON.stringify([agent,resumable]);if(signature===detailSignature)return;detailSignature=signature;
  $('agent-detail-title').textContent=agent.title;$('agent-detail-dot').className='agent-indicator '+agent.status;
  const body=$('agent-detail-content'),scroll=body.scrollTop,atBottom=body.scrollHeight-body.clientHeight-scroll<60;
  const meta=node('div','agent-detail-meta');meta.append(node('div','',`${statusLabel(agent.status)} · ${agent.agentType} · ${agent.model||current.session.model||current.provider.model}${agent.background?' · background':''}`),node('div','',item.parentId?'Spawned by '+(nodes.find(n=>n.agent.id===item.parentId)?.agent.title||'a subagent'):'Spawned by the main agent'));
  if(agent.worktree)meta.append(node('div','','Git worktree · '+agent.worktree.directory));
  const metrics=node('div');metrics.append(clock(agent),node('span','',` · ${(((agent.usage?.input||0)+(agent.usage?.output||0))/1000).toFixed(1)}k tokens · ${agent.toolCount||0} tool uses`));meta.append(metrics);
  const lastText=[...(agent.timeline||[])].reverse().find(e=>e.role==='assistant'&&e.text)?.text;
  const report=node('div','agent-detail-report',agent.result||lastText||(agent.status==='running'?'Working…':'No text result.'));
  const task=disclosure('details','agent-detail-section',agent.id+':task');task.append(node('summary','','Task'),node('div','agent-detail-task',agent.prompt||''));
  const activity=disclosure('details','agent-detail-section',agent.id+':activity');activity.append(node('summary','',`Tool activity · ${agent.toolCount||0}`));const thread=node('div','agent-detail-activity');
  for(const event of agent.timeline||[]){const element=renderEvent(event);if(element)thread.append(element);}activity.append(thread);
  body.replaceChildren(meta,report,task,activity);
  if(agent.status==='running'&&!current.readonly){const stop=button('Stop agent',()=>send('stopAgent',{id:agent.id}),'agent-detail-stop');body.prepend(stop);}
  if(resumable&&agent.status!=='running'&&!current.readonly) {
    body.prepend(button('Продолжить',()=>{
      closeAgentMap();
      const prompt=$('prompt');
      prompt.value='Продолжи субагента '+agent.id+' с уже собранными доказательствами: '+prompt.value;
      prompt.dispatchEvent(new Event('input'));
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length,prompt.value.length);
    },'agent-detail-stop'));
  }
  body.scrollTop=atBottom&&agent.status==='running'?body.scrollHeight:scroll;
}

function showIntegrations(data){
 if(popupKind!=='integrations'){const popup=menu('integrations','Skills and MCP','model');if(!popup)return;}
 if(data)integrationData=data;const popup=$('popup');popup.replaceChildren();
 const header=node('div','popup-heading','Skills and MCP');const actions=node('div','integration-actions');for(const [icon,title,type]of [['refresh','Обновить список','integrationsRefresh'],['settings','Настроить MCP-серверы','integrationSettings']]){const b=button('',()=>send(type),'icon');b.title=title;b.setAttribute('aria-label',title);b.append(glyph(icon));actions.append(b);}header.append(actions);popup.append(header);
 const search=node('input','integration-search');search.type='search';search.placeholder='Найти навык или MCP-сервер';search.setAttribute('aria-label',search.placeholder);popup.append(search);
 const status=node('div','integration-status');status.id='integration-status';status.setAttribute('role','status');popup.append(status);const list=node('div','integration-list');popup.append(list);
 if(!integrationData){status.textContent='Загружаю список…';return;}
 const render=()=>{list.replaceChildren();const query=search.value.toLowerCase();const heading=text=>list.append(node('div','integration-section',text));
  heading('Веб-инструменты');list.append(node('div','integration-description','web_search и web_fetch · поиск использует отдельный ключ GLM; не расходует подписку ChatGPT.'));
  heading('MCP');for(const server of integrationData.servers.filter(s=>(s.name+' '+s.source).toLowerCase().includes(query))){const row=node('div','integration-row'),info=node('div','integration-info');info.append(node('strong','',server.name),node('span','integration-description',`${server.source} · ${server.status} · ${server.toolCount} tools`));row.append(info);if(server.transport==='in-process'){row.append(button('Настроить',()=>send('setupBrowser'),'integration-connect'));list.append(row);continue;}const connect=button(server.status==='connected'?'Обновить':'Подключить',()=>{connect.disabled=true;status.textContent='Подключаю '+server.name+'…';send('connectIntegration',{name:server.name});},'integration-connect');row.append(connect);const token=button('Токен',()=>{const form=node('form','integration-token'),input=node('input');input.type='password';input.autocomplete='new-password';input.placeholder='Токен → SecretStorage';input.setAttribute('aria-label','MCP token');const save=button('Сохранить',()=>{});save.type='submit';form.append(input,save);form.onsubmit=e=>{e.preventDefault();send('integrationToken',{name:server.name,token:input.value});input.value='';form.remove();status.textContent='Сохраняю токен…';};row.after(form);input.focus();});row.append(token);list.append(row);}
  if(!integrationData.servers.length)list.append(node('div','integration-description','Нет настроенных MCP-серверов. Откройте настройки шестерёнкой.'));
  heading('Навыки');for(const skill of integrationData.skills.filter(s=>(s.name+' '+s.description+' '+s.source).toLowerCase().includes(query))){const item=menuItem(list,skill.name,skill.description||skill.source,'file',false,()=>send('openIntegrationSkill',{id:skill.id}));item.title=[skill.source,skill.limitations].filter(Boolean).join(' · ');}
 };search.oninput=render;render();search.focus();
}
function integrationConsent(data){
 if(popupKind!=='integrations')return;const status=$('integration-status');status.replaceChildren(node('strong','','Подключить '+data.name+'?'),node('p','',`${data.source||'MCP'} · ${data.target}. ${data.local?'Будет запущен локальный процесс сервера.':'Будет подключён внешний сервер.'}`));const yes=button('Подключить',()=>{yes.disabled=true;send('connectIntegration',{name:data.name,consent:data.consent});},'connection-save'),no=button('Отмена',()=>showIntegrations(integrationData));status.append(yes,no);
}
function showAdd() {
  const popup = menu('add','Add to conversation','attach'); if(!popup)return;
  menuItem(popup,'Files…','Attach files from your workspace','file',false,()=>send('attach'));
  menuItem(popup,'Ссылка на строки','Вставить @файл#строки из последнего редактора','selection',false,()=>send('attachReference'));
  menuItem(popup,'Вывод терминала','Прикрепить вывод последней команды','file',false,()=>send('attachTerminal'));
  menuItem(popup,'Сбросить разрешения проекта','','settings',false,()=>send('forgetCommandApprovals'));
  menuItem(popup,'Открывать чат сбоку','','settings',false,()=>send('placeChat',{placement:'beside'}));
  menuItem(popup,'Открывать чат в текущей группе','','settings',false,()=>send('placeChat',{placement:'active'}));
  menuItem(popup,'Selection','Add the selected code','selection',false,()=>send('attachSelection'));
  menuItem(popup,'Focus view','Fold tool activity in the conversation','eye',focusView,()=>$('focus-view').click());
  menuItem(popup,'Subagents','Run independent project investigations','agents',false,()=>send('delegate'));
}
$('approval-icon').replaceChildren(glyph('manual')); $('activity-spinner').replaceChildren(glyph('spinner'));
for(const [id,icon] of [['attach','plus'],['commands','slash'],['send','send'],['focus-view','eye'],['new','plus'],['settings','settings']]) $(id).replaceChildren(glyph(icon));
function closeCommands() {
  $('slash-menu').hidden = true;
  $('commands').setAttribute('aria-expanded', 'false');
}
function showCommands(query = '', preserveDraft = true) {
  const commands = [['/new','Новый разговор'],['/model','Выбрать модель'],['/permissions','Режим разрешений'],
    ['/plan','План и комментарии'],['/goal','Цель с автопродолжением и независимой приёмкой'],['/resume','Продолжить сохранённую задачу'],['/context','Контекст и расход'],['/retro','Метрики и повторы последнего хода'],['/agents','Субагенты'],
    ['/focus','Режим фокуса'],['/settings','Настроить подключение']].filter(([name])=>name.startsWith(query));
  if (!commands.length) return closeCommands();
  closePopup();
  $('slash-menu').replaceChildren(...commands.map(([command,label])=>{
    const item = button(command, ()=>{
      const draft = $('prompt').value;
      const draftAttachments = attachments;
      if (preserveDraft) attachments = [];
      $('prompt').value = command;
      submit();
      if (preserveDraft) {
        $('prompt').value = draft;
        attachments = draftAttachments;
        renderAttachments();
        updateComposerInput(false);
        closeCommands();
      }
    });
    item.append(node('span','',label));
    return item;
  }));
  $('slash-menu').hidden = false;
  $('commands').setAttribute('aria-expanded', 'true');
}
document.addEventListener('click', e=>{
  if(!e.target.closest('#popup,#model,#mode,#attach,#agents,#settings,#connect,#connect-codex,#slash-menu,#commands'))closePopup();
  if(!e.target.closest('#slash-menu,#commands,#prompt'))closeCommands();
});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&!$('slash-menu').hidden){e.preventDefault();closeCommands();$('prompt').focus();return;}
 if(e.key==='Escape'&&!$('agent-map').open&&!$('agent-detail').open){if(!$('popup').hidden){e.preventDefault();e.stopPropagation();closePopup(true);}return;}
 if($('popup').hidden||popupKind==='provider'||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
 if(e.key==='Tab'){if(popupKind!=='integrations')closePopup();return;}
 if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const items=[...$('popup').querySelectorAll('button:not(:disabled)')].filter(n=>n.tabIndex!==-1),index=items.indexOf(document.activeElement);const at=e.key==='Home'?0:e.key==='End'?items.length-1:index<0?(e.key==='ArrowDown'?0:items.length-1):(index+(e.key==='ArrowDown'?1:items.length-1))%items.length;const next=items[at];next?.focus();next?.scrollIntoView?.({block:'nearest'});}
});
$('send').onclick = ()=>busy?requestStop():submit();
$('prompt').addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && $('slash-menu').hidden && $('popup').hidden) {
    const suggestion = composerSuggestion();
    if (suggestion) {
      e.preventDefault();
      $('prompt').value = suggestion;
      updateComposerInput(false);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  if (e.key === 'Escape') { closeCommands(); closePopup(); }
  if (e.key === 'Tab' && e.shiftKey && current && !current.readonly) { e.preventDefault(); const at = modeOptions.findIndex(m => m.id === current.session.mode); send('mode', {mode:modeOptions[(at+1)%modeOptions.length].id}); }
});
function composerSuggestion() {
  if (!current || current.readonly || busy || current.approval || $('prompt').value || attachments.length || (outgoing[current.session.id] || []).length) return '';
  return window.AITranscript.followUpSuggestion(current.session);
}
function updateComposerPlaceholder() {
  const suggestion = composerSuggestion();
  $('prompt').classList.toggle('has-follow-up',!!suggestion && !stopRequested);
  $('prompt').placeholder = current?.readonly ? 'Read-only session · Continue as a copy to reply'
    : stopRequested ? 'Останавливаю текущую задачу…'
    : busy ? 'Уточни задачу — сообщение попадёт в текущую работу…'
      : suggestion || '⌘ Esc to focus or unfocus Harness';
}
function updateComposerInput(suggest = true) {
  resize(); persist(); updateQueueButton(); updateComposerPlaceholder(); if (!busy) $('send').disabled = !!current?.readonly || !hasComposerInput(); const value = $('prompt').value;
  if (suggest && /^\/[^\s]*$/.test(value)) showCommands(value,false);
  else closeCommands();
}
function hasComposerInput() {
  return !!$('prompt').value.trim() || attachments.length > 0;
}
async function attachLocalFiles(files, sessionId) {
  for (const file of files) {
    if (current?.session.id !== sessionId || current.readonly) return;
    if (attachments.length >= 8) { showNotice('Можно прикрепить до 8 файлов.'); return; }
    try {
      let item;
      if (/^image\//.test(file.type)) {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw Error('Поддерживаются изображения PNG, JPEG и WebP.');
        if (!file.size || file.size > 5 * 1024 * 1024) throw Error('Изображение должно быть не больше 5 МБ.');
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        item = { kind:'image', label:file.name || 'Скриншот', dataUrl };
      } else {
        if (file.size > 64 * 1024) throw Error('Текстовый файл должен быть не больше 64 КБ.');
        const bytes = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch {}
        if (text === undefined || text.includes('\0')) throw Error('Поддерживаются текстовые файлы UTF-8.');
        item = {kind:'droppedText',label:file.name,text};
      }
      if (current?.session.id !== sessionId || current.readonly) return;
      await addPickerAttachment(item);
    } catch (error) {
      if (current?.session.id === sessionId) showNotice(error?.message || 'Не удалось прикрепить файл.', 'error');
    }
  }
}
$('prompt').addEventListener('paste', event => {
  const clipboard = event.clipboardData;
  const files = clipboard?.files.length
    ? Array.from(clipboard.files)
    : Array.from(clipboard?.items || [], item => item.kind === 'file' ? item.getAsFile() : null);
  const images = files.filter(file => file?.type.startsWith('image/'));
  if (!images.length || !current || current.readonly) return;
  event.preventDefault();
  void attachLocalFiles(images, current.session.id);
});
const fileDragTypes = ['files','codefiles','codeeditors','application/vnd.code.uri-list','text/uri-list'];
function isFileDrag(transfer) {
  return Array.from(transfer?.types||[]).some(type=>fileDragTypes.includes(type.toLowerCase()));
}
function droppedPaths(transfer) {
  const uris = transfer.getData('application/vnd.code.uri-list') || transfer.getData('text/uri-list');
  const paths = uris.split(/\r?\n/).filter(uri=>uri.startsWith('file:')).slice(0,8);
  for (const type of ['CodeFiles','CodeEditors']) {
    if (paths.length) break;
    try {
      const entries = JSON.parse(transfer.getData(type));
      if (!Array.isArray(entries)) continue;
      for (const entry of entries.slice(0,8)) {
        if (type === 'CodeFiles' && typeof entry === 'string') paths.push(entry);
        if (type === 'CodeEditors' && entry?.resource?.scheme === 'file' && typeof entry.resource.path === 'string') {
          const resource = entry.resource;
          if (!resource.authority) paths.push('file://' + resource.path.split('/').map(encodeURIComponent).join('/'));
        }
      }
    } catch {}
  }
  return paths;
}
document.addEventListener('dragover', event => {
  if (!isFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = current&&!current.readonly ? 'copy' : 'none';
  document.body.classList.toggle('file-drag-over',!!current&&!current.readonly);
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget || !document.body.contains(event.relatedTarget)) document.body.classList.remove('file-drag-over');
});
document.addEventListener('drop', event => {
  document.body.classList.remove('file-drag-over');
  if (!isFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  if (!current || current.readonly) return;
  const sessionId = current.session.id;
  const paths = droppedPaths(event.dataTransfer);
  if (paths.length) send('attachDroppedFiles',{sessionId,paths});
  else {
    const files = Array.from(event.dataTransfer.files);
    if (files.length) void attachLocalFiles(files,sessionId);
  }
});
$('prompt').addEventListener('input', event => {
  if (event.isTrusted) {
    lastPromptEdit = Date.now();
    if (current?.approval && !approval) updateApproval();
  }
  updateComposerInput();
});
$('prompt').addEventListener('compositionstart', () => {
  composingPrompt = true;
  if (current?.approval && !approval) updateApproval();
});
$('prompt').addEventListener('compositionend', () => {
  composingPrompt = false;
  lastPromptEdit = Date.now();
  if (current?.approval && !approval) updateApproval();
});
$('new').onclick = () => send('new');
$('brand').onclick = () => send('rename');
$('copy').onclick = () => send('copy');
$('settings').onclick = () => showProviderSetup();
$('connect').onclick = () => showProviderSetup(current?.provider.name === 'chatgpt' ? 'glm' : current?.provider.name || 'glm');
$('connect-codex').onclick = () => showProviderSetup('chatgpt');
$('model').onclick = () => showModels();
$('attach').onclick = () => showAdd();
$('agents').onclick = showAgentTree;
$('commands').onclick = () => {
  if ($('slash-menu').hidden) showCommands();
  else closeCommands();
};
$('focus-view').onclick = () => { focusView = !focusView; document.body.classList.toggle('focus-view', focusView); $('focus-view').setAttribute('aria-pressed', String(focusView)); persist(); };
$('mode').onclick = () => showModes();
$('context-usage').onclick = () => send('contextReport');
$('quota').onclick = () => send('refreshQuota');
for(const scope of ['chat','project'])$('remember-'+scope).onclick=()=>{
  if(approval?.rememberable)send('approval',{id:approval.id,allow:true,remember:scope});
};
$('apply-hunks').onclick=()=>{
  if(!approval?.hunks)return;
  const hunks=Array.from($('hunk-list').querySelectorAll('input:checked'),input=>Number(input.value));
  if(hunks.length)send('approval',{id:approval.id,allow:true,hunks});
};
$('allow').onclick = () => { if (approval) send('approval', { id: approval.id, allow: true }); };
$('allow-auto').onclick = () => { if (approval) send('approval', { id: approval.id, allow: true, auto: true }); };
$('agent-map-close').replaceChildren(glyph('close')); $('agent-detail-close').replaceChildren(glyph('close')); $('agent-detail-back').replaceChildren(glyph('back'));
$('agent-map-close').onclick=closeAgentMap; $('agent-detail-close').onclick=closeAgentMap; $('agent-detail-back').onclick=()=>{ $('agent-detail').close();selectedAgentId=null; };
$('agent-map').addEventListener('click',e=>{if(e.target===$('agent-map')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeAgentMap();}});
$('agent-map').addEventListener('close',()=>{$('agents').setAttribute('aria-expanded','false');});
$('agent-detail').addEventListener('cancel',()=>{selectedAgentId=null;});
$('question-panel').onsubmit = event => {
  event.preventDefault();
  const text = $('question-other').value.trim();
  if (approval?.kind === 'question' && text) send('answerQuestion',{id:approval.id,text});
};
$('question-custom').onclick = () => {
  const editor = $('question-editor');
  editor.hidden = !editor.hidden;
  $('question-custom').setAttribute('aria-expanded', String(!editor.hidden));
  if (!editor.hidden) $('question-other').focus();
};
$('question-other').oninput = () => { $('question-send').disabled = !$('question-other').value.trim(); };
$('question-skip').onclick = () => {
  if (approval?.kind === 'question') send('answerQuestion',{id:approval.id,skip:true});
};
document.addEventListener('keydown',e=>{
  if (approval?.kind !== 'question' || $('agent-map').open || $('agent-detail').open) return;
  if (e.key === 'Escape' && $('popup').hidden && $('slash-menu').hidden) {
    e.preventDefault();
    $('question-skip').click();
    return;
  }
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  const choice = Number(e.key);
  if (/^[1-4]$/.test(e.key) && choice <= approval.options.length) {
    e.preventDefault();
    send('answerQuestion',{id:approval.id,choice:choice-1});
  }
});
document.addEventListener('keydown',e=>{if(approval&&approval.kind!=='question'&&$('popup').hidden&&!['TEXTAREA','INPUT','SELECT'].includes(document.activeElement.tagName)&&!$('agent-map').open){if(e.key==='1')$('allow').click();if(e.key==='2'&&!$('allow-auto').hidden)$('allow-auto').click();if(e.key==='3'||e.key==='Escape')$('deny').click();}});
$('approval').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || !approval) return;
  const button = event.target.closest?.('button');
  if (!button || button.disabled || button.type === 'submit') return;
  event.preventDefault();
  if (!event.repeat) button.click();
});
$('deny').onclick = () => { if (approval) send('approval', { id: approval.id, allow: false }); };
$('review').onclick = () => { if (approval) send('diff', { id: approval.id }); };
document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => { $('prompt').value = b.dataset.prompt; resize(); persist(); $('prompt').focus(); }));
window.addEventListener('message', ({ data }) => {
  if (data.type === 'editorContext' && data.sessionId === current?.session.id) {
    current.editorContext = data.context;
    renderAttachments();
  }
  if (data.type === 'state'){
    const delta=data.session.timelineDelta;
    if(delta){
      if(current?.sequence!==delta.base || current.session.id!==data.session.id){send('ready');return;}
      const timeline=current.session.timeline.slice(0,delta.length);
      for(const [index,event] of delta.updates)timeline[index]=event;
      data.session.timeline=timeline;
    }
    state(data);if(data.integrationsRequested){showIntegrations();send('integrations');}if(data.providerSetupRequested||pendingSetupUi){pendingSetupUi=false;showProviderSetup();}}
  if(data.type==='showProviderSetup')showProviderSetup();
  if(data.type==='modelConnectionSaved'&&data.requestId===connectionRequestId){closePopup();showNotice('Модель добавлена');}
  if(data.type==='integrationsState'){integrationData=data;if(popupKind==='integrations')showIntegrations(data);return;}
  if(data.type==='integrationConsent'){integrationConsent(data);return;}
  if(data.type==='integrationsError'&&popupKind==='integrations'){$('integration-status').textContent=data.text;$('popup').querySelectorAll('button').forEach(b=>b.disabled=false);return;}
  if(data.type==='integrationTokenSaved'&&popupKind==='integrations'){$('integration-status').textContent='Токен сохранён. Переподключите сервер, чтобы использовать его.';return;}
  if(data.type==='chatgptCatalog')codexCatalogHandler?.(data);
  if(['chatgptAuthorized','chatgptAuthError'].includes(data.type))chatgptUiHandler?.(data);
  if(data.type==='modelConnectionError'&&data.requestId===connectionRequestId){$('connection-error').textContent=data.text;const save=$('popup').querySelector('.connection-save');save.disabled=false;save.textContent='Добавить модель';}
  if (data.type === 'notice' && (!data.sessionId || data.sessionId === current?.session.id)) showNotice(data.text, data.kind);
  if (data.type === 'retro' && data.sessionId === current?.session.id) showNotice(data.text, 'retro');
  if(data.type==='insertReference'&&data.sessionId===current?.session.id){
    const prompt=$('prompt');
    prompt.setRangeText(data.text+' ',prompt.selectionStart,prompt.selectionEnd,'end');
    prompt.focus();updateComposerInput(false);
  }
  if (data.type === 'attachment'  && (!data.sessionId || data.sessionId === current?.session.id)) addPickerAttachment(data.file);
  if (data.type === 'sendFailed') {
    const entry = outgoing[data.sessionId]?.find(item=>item.deliveryId===data.deliveryId);
    if (entry) { entry.status = 'failed'; entry.error = data.text; }
    if (current?.session.id===data.sessionId) {
      if (entry) renderMessages(current.session);
      showNotice(data.text, 'error');
    }
    persist();
  }
});
document.body.classList.toggle('focus-view', focusView); $('focus-view').setAttribute('aria-pressed', String(focusView));
setInterval(() => { updateActivity(); document.querySelectorAll('[data-start]').forEach(n => { n.textContent = duration({ startedAt: Number(n.dataset.start) }); }); }, 1000);
send('ready');

function renderPlan(plan) {
  let box=document.getElementById('task-plan');
  if(!box){box=node('details','task-plan');box.id='task-plan';$('messages').before(box);}
  if(!plan){box.hidden=true;return;}box.hidden=false;
  const summary=node('summary','',`План · ${plan.steps.filter(s=>s.status==='done').length}/${plan.steps.length} · ${plan.goal}`);
  const list=node('ol');for(const step of plan.steps){const li=node('li','',`${step.status==='done'?'✓':step.status==='running'?'●':'○'} ${step.title}`);if(step.evidence)li.title=step.evidence;list.append(li);}const open=button('Открыть план в редакторе',()=>send('openPlan'),'open-plan-editor');
  box.replaceChildren(summary,list,open);
}

function updateQueueButton(){let b=document.getElementById('queue-send');if(!b){b=button('',submit,'queue-send');b.id='queue-send';b.title='Отправить уточнение в текущую работу · Enter';b.setAttribute('aria-label',b.title);b.append(glyph('send'));$('send').before(b);}b.hidden=!busy||stopRequested||!hasComposerInput()||current?.readonly;}

function updateScrollFade(){const c=$('conversation');document.body.classList.toggle('scrollback',c.scrollHeight-c.scrollTop-c.clientHeight>24);}
$('conversation').addEventListener('scroll',updateScrollFade,{passive:true});
new ResizeObserver(updateScrollFade).observe($('conversation'));

// Reserve room for the last message while older messages can scroll behind the input.
new ResizeObserver(()=>{
  const c=$('conversation'),atBottom=c.scrollHeight-c.scrollTop-c.clientHeight<24;
  $('app').style.setProperty('--composer-height',`${Math.ceil(document.querySelector('footer').getBoundingClientRect().height)}px`);
  requestAnimationFrame(()=>{if(atBottom)c.scrollTop=c.scrollHeight;updateScrollFade();});
}).observe(document.querySelector('footer'));
