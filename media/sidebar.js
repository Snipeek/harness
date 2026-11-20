'use strict';
const api = acquireVsCodeApi(); const $ = id => document.getElementById(id);
const send = (type, data = {}) => api.postMessage({ type, ...data });
const saved = api.getState() || {}; let data, activeOnly = !!saved.activeOnly;
const collapsed = new Set(saved.collapsed || []);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const btn = (text, title, fn, cls) => { const b = el('button', cls, text); b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; return b; };
function icon(name) { return window.aiIcon(({edit:'pencil'})[name] || name); }
function persist() { api.setState({ activeOnly, collapsed: [...collapsed], account: !$('account-content').hidden, manager: !$('manager-content').hidden, archived: !$('archived-sessions').hidden, query: $('query').value, search: !$('search-box').hidden }); }
function age(time) { const m = Math.max(0, Math.floor((Date.now() - time) / 60000)); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : m < 43200 ? Math.floor(m / 1440) + 'd' : Math.floor(m / 43200) + 'mo'; }
function toggle(content, control) { const visible = $(content).hidden; $(content).hidden = !visible; $(control).setAttribute('aria-expanded', String(visible)); $(control).querySelector('.chevron')?.classList.toggle('expanded', visible); persist(); }
let renaming;
function renameInline(session, row, anchor) {
  if(renaming)return;
  const form=el('form','session-open session-rename');
  const input=el('input');input.value=session.title;input.maxLength=100;input.setAttribute('aria-label','Название сессии');
  form.append(el('span','dot'),input);
  renaming=form;row.classList.add('renaming');anchor.replaceWith(form);
  const finish=save=>{
    if(renaming!==form)return;
    renaming=undefined;
    const title=input.value.trim();
    if(save&&title&&title!==session.title){
      const item=data?.sessions.find(item=>item.id===session.id);if(item)item.title=title;
      send('rename',{id:session.id,title});
    }
    const restoreFocus=document.activeElement===input||!save;
    render();
    if(restoreFocus)[...document.querySelectorAll('.session-open')].find(item=>item.dataset.sessionId===session.id)?.focus();
  };
  form.onsubmit=event=>{event.preventDefault();finish(true);};
  form.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}};
  input.onblur=()=>finish(true);
  input.focus();input.select();
}
function row(s) {
  const n = el('div', 'session-row' + (s.active ? ' selected' : '') + (s.busy ? ' running' : '') + (s.waiting ? ' waiting' : ''));
  const b = btn('', `${s.title}\n${s.source} · ${s.project}${s.readonly ? '\nRead-only original; continue as a copy' : ''}`, () => send('open', { id: s.id }), 'session-open');
  b.dataset.sessionId=s.id;
  if (s.active) b.setAttribute('aria-current', 'true');
  b.append(el('span', 'dot'), el('span', 'session-title', s.title));
  if (data.multiRoot && s.project) b.append(el('span', 'age', s.project));
  const time = el('span', 'age', age(s.updated)); time.title = new Date(s.updated).toLocaleString();
  const actions = el('div', 'row-actions');
  for (const [name, title, type] of [['edit', 'Rename', 'rename'], ['archive', s.archived ? 'Restore session' : 'Archive session', 'archive']]) {
    const action = btn('', title, () => type==='rename'?renameInline(s,n,b):send(type, { id: s.id })); action.append(icon(name)); action.firstChild.setAttribute('width', '15'); action.firstChild.setAttribute('height', '15'); action.firstChild.setAttribute('fill', 'none'); action.firstChild.setAttribute('stroke', 'currentColor'); action.firstChild.setAttribute('stroke-width', '1.5');
    if (type === 'archive') action.disabled = s.busy; actions.append(action);
  }
  n.oncontextmenu = event => { event.preventDefault(); showSessionMenu(s,event.clientX,event.clientY,b); };
  b.onkeydown = event => { if(event.key==='F2'){event.preventDefault();renameInline(s,n,b);return;}if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();const r=b.getBoundingClientRect();showSessionMenu(s,r.left,r.bottom,b);} };
  n.classList.toggle('unread',!!s.unread);
  n.append(b, time, actions); return n;
}
let sessionMenu, menuAnchor;
function closeSessionMenu(restoreFocus=false){const previous=sessionMenu,anchor=menuAnchor;sessionMenu?.remove();sessionMenu=undefined;menuAnchor=undefined;if(previous)render();if(restoreFocus){const replacement=[...document.querySelectorAll('.session-open')].find(b=>b.dataset.sessionId===anchor?.dataset.sessionId);(replacement||anchor)?.focus();}}
function showSessionMenu(s,x,y,anchor){
  closeSessionMenu();menuAnchor=anchor;sessionMenu=el('div','session-context-menu');sessionMenu.setAttribute('role','menu');sessionMenu.setAttribute('aria-label','Session actions');
  const options=[['Switch to session','open'],['New group from session','newGroupFromSession'],['Move to group','move'],['Mark as unread','markUnread'],[s.archived?'Restore session':'Archive session','archive']];
  for(const [title,type]of options){const item=btn(title,title,()=>{closeSessionMenu();send(type,{id:s.id});});item.setAttribute('role','menuitem');item.disabled=type==='archive'&&s.busy;sessionMenu.append(item);}
  document.body.append(sessionMenu);const r=sessionMenu.getBoundingClientRect();sessionMenu.style.left=Math.max(4,Math.min(x,window.innerWidth-r.width-4))+'px';sessionMenu.style.top=Math.max(4,Math.min(y,window.innerHeight-r.height-4))+'px';
  sessionMenu.onkeydown=event=>{const items=[...sessionMenu.querySelectorAll('button:not(:disabled)')],i=items.indexOf(document.activeElement);if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();items[(i+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}else if(event.key==='Home'||event.key==='End'){event.preventDefault();items[event.key==='Home'?0:items.length-1]?.focus();}else if(event.key==='Escape'){event.preventDefault();closeSessionMenu(true);}else if(event.key==='Tab')closeSessionMenu();};sessionMenu.querySelector('button')?.focus();
}
document.addEventListener('pointerdown',event=>{if(sessionMenu&&!sessionMenu.contains(event.target))closeSessionMenu();});
window.addEventListener('blur',()=>closeSessionMenu());window.addEventListener('resize',()=>closeSessionMenu());document.addEventListener('scroll',event=>{if(!sessionMenu?.contains(event.target))closeSessionMenu();},true);
function render() {
  if (!data || sessionMenu || renaming) return;
  const query = $('query').value.toLowerCase();
  const matches = s => (!activeOnly || s.busy || s.waiting) && `${s.title} ${s.project}`.toLowerCase().includes(query);
  const sessions = data.sessions.filter(s => !s.archived && matches(s));
  const frag = document.createDocumentFragment();
  for (const group of [{ id: null, name: 'Ungrouped' }, ...data.groups]) {
    const rows = sessions.filter(s => s.groupId === group.id || (!group.id && !data.groups.some(g => g.id === s.groupId)));
    const key = group.id || 'ungrouped';
    if (!rows.length && (query || activeOnly)) continue;
    const heading = btn('', group.name, () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); render(); persist(); }, 'group-heading');
    heading.setAttribute('aria-expanded', String(!collapsed.has(key)));
    const arrow = el('span', 'chevron' + (collapsed.has(key) ? '' : ' expanded')); arrow.append(icon('chevron')); heading.append(arrow, el('span', 'name', group.name), el('span', 'count', String(rows.length)));
    if (group.id) heading.ondblclick = () => send('renameGroup', { id: group.id });
    frag.append(heading); if (!collapsed.has(key)) for (const s of rows) frag.append(row(s));
  }
  if (!sessions.length) frag.append(el('div', 'empty', query || activeOnly ? 'No matching sessions' : 'Start a new session'));
  $('sessions').replaceChildren(frag);
  const archived = data.sessions.filter(s => s.archived && matches(s));
  $('archived-count').textContent = data.sessions.filter(s => s.archived).length;
  $('archived-sessions').replaceChildren(...archived.map(row));
  $('active-count').textContent = data.sessions.filter(s => s.busy || s.waiting).length;
  $('active').classList.toggle('selected', activeOnly); $('active').setAttribute('aria-pressed', String(activeOnly));
  $('provider').textContent = !data.configured ? 'Select model' : `${data.provider.toUpperCase()} · ${data.model || 'Select model'}`;
  const limits = [
    ...(data.quota || []).map((quota, i) => ({ ...quota, label: i ? 'GLM · Weekly usage' : 'GLM · 5-hour usage' })),
    ...(data.codexQuota || []).map(quota => {
      const minutes = quota.minutes;
      const label = minutes === 10080 ? 'Weekly usage' : minutes === 1440 ? 'Daily usage' :
        minutes % 60 === 0 ? (minutes / 60) + '-hour usage' : minutes + '-minute usage';
      return { ...quota, label: 'Codex · ' + label };
    })
  ];
  const meters = limits.map(q => {
    const meter = el('div', 'meter'), title = el('div', 'meter-title'); title.append(el('span', '', q.label), el('span', '', q.pct + '% used'));
    const track = el('div', 'track'), fill = el('span'); fill.style.width = Math.max(0, Math.min(100, q.pct)) + '%'; track.append(fill);
    meter.append(title, track);
    const reset = new Date(q.resetAt);
    if (q.resetAt != null && Number.isFinite(reset.getTime())) meter.append(el('div', 'reset', 'Resets ' + reset.toLocaleString()));
    return meter;
  });
  $('meters').replaceChildren(...meters);
}
document.querySelectorAll('.chevron').forEach(n=>n.replaceChildren(icon('chevron')));
$('active-icon').append(window.aiIcon('bolt')); $('new-icon').append(window.aiIcon('plus')); $('group-icon').append(window.aiIcon('plus'));
$('search').append(icon('search'));
$('account-toggle').onclick = () => toggle('account-content', 'account-toggle');
$('manager-toggle').onclick = () => toggle('manager-content', 'manager-toggle');
$('new').onclick = () => send('new'); $('group').onclick = () => send('newGroup');
$('check-release').onclick = () => {
  $('check-release').disabled = true;
  $('release-check-status').textContent = 'Проверяем обновления…';
  send('checkHarnessUpdate');
};
$('active').onclick = () => { activeOnly = !activeOnly; render(); persist(); };
$('search').onclick = () => { $('search-box').hidden = !$('search-box').hidden; if (!$('search-box').hidden) $('query').focus(); else { $('query').value = ''; render(); } persist(); };
$('query').oninput = () => { render(); persist(); };
$('archived').onclick = () => { $('archived-sessions').hidden = !$('archived-sessions').hidden; $('archived').querySelector('.chevron').classList.toggle('expanded', !$('archived-sessions').hidden);$('archived').setAttribute('aria-expanded',String(!$('archived-sessions').hidden)); persist(); };
if (saved.account) toggle('account-content', 'account-toggle');
if (saved.manager === false) toggle('manager-content', 'manager-toggle');
$('archived-sessions').hidden = !saved.archived; $('archived').querySelector('.chevron').classList.toggle('expanded', !!saved.archived);$('archived').setAttribute('aria-expanded',String(!!saved.archived));
$('query').value = saved.query || ''; $('search-box').hidden = !saved.search;
function renderUpdate(update) {
  $('release-footer').hidden = !update;
  if (!update) return;
  const button = $('release-button');
  const installed = update.phase === 'installed';
  button.disabled = update.phase === 'installing';
  button.textContent = installed ? 'Перезагрузить VS Code' : button.disabled ? 'Обновляется…' : 'Обновиться';
  button.title = 'Harness ' + update.version;
  button.onclick = () => {
    button.disabled = true;
    send(installed ? 'reloadHarnessUpdate' : 'installHarnessUpdate');
  };
  $('release-error').hidden = !update.error;
  $('release-error').textContent = update.error || '';
}
window.addEventListener('message', ({ data: message }) => {
  if (message.type === 'state') { data = message; render(); }
  if (message.type === 'releaseUpdate') renderUpdate(message.update);
  if (message.type === 'releaseCheck') {
    $('check-release').disabled = false;
    $('release-check-status').textContent = {
      current: 'Установлена последняя версия.',
      available: 'Доступно обновление.',
      failed: 'Не удалось проверить обновления.',
      unavailable: 'Проверка доступна в локальном VS Code.'
    }[message.status] || '';
  }
  if (message.type === 'error') { $('error').hidden = false; $('error').textContent = message.text; }
});
setInterval(render, 30000); send('ready');
