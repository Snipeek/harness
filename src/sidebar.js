'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {hasConversationContent}=require('./store');
const {connections}=require('./model-connections');
const {readCodexQuota}=require('./codex-quota');
const codexQuotaInterval = 5 * 60_000;
function providerUsage(sessions,profiles=[]){
 const result={},byId=new Map(profiles.map(p=>[p.id,p]));
 const tally=(provider,usage)=>{
   const row=result[provider]||={input:0,output:0,cached:0,reasoning:0};
   for(const key of Object.keys(row))row[key]+=usage[key]||0;
 };
 for(const session of sessions){
   if(session.usageByProvider){for(const [provider,usage] of Object.entries(session.usageByProvider))tally(provider,usage);continue;}
   const provider=byId.get(session.modelProfileId)?.provider||session.provider||'unknown';
   const own={...session.usage};
   for(const [childProvider,usage] of Object.entries(session.delegatedUsage||{})){
     if(childProvider===provider)continue;
     tally(childProvider,usage);
     for(const key of ['input','output','cached','reasoning'])own[key]=Math.max(0,(own[key]||0)-(usage[key]||0));
   }
   tally(provider,own);
 }
 return result;
}
const { randomUUID, randomBytes } = require('node:crypto');

class SessionManager {
  constructor(app) {
    this.app = app;
    this.meta = app.context.globalState.get('ai.sessionManager', { groups: [], rows: {} });
    this.meta.groups ||= []; this.meta.rows ||= {};
    this.codexQuota = [];
    this.codexQuotaCheckedAt = 0;
  }
  row(id) { return this.meta.rows[id] || {}; }
  async save() { await this.app.context.globalState.update('ai.sessionManager', this.meta); this.refresh(); }
  refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.state().catch(e => this.app.output.appendLine(e.message)), 60);
  }
  async resolveWebviewView(view) {
    this.view = view.webview;
    const media = vscode.Uri.joinPath(this.app.context.extensionUri, 'media');
    this.view.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(18).toString('base64');
    const html = await fs.readFile(path.join(media.fsPath, 'sidebar.html'), 'utf8');
    this.view.onDidReceiveMessage(m => this.receive(m).catch(e => this.view?.postMessage({ type: 'error', text: e.message })));
    this.view.html = html.replaceAll('{{nonce}}', nonce).replaceAll('{{cspSource}}', this.view.cspSource)
      .replaceAll('{{version}}', this.app.context.extension?.packageJSON?.version ?? require('../package.json').version)
      .replace('{{css}}', this.view.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css')).toString())
      .replace('{{icons}}', this.view.asWebviewUri(vscode.Uri.joinPath(media, 'icons.js')).toString())
      .replace('{{js}}', this.view.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js')).toString());
    const refreshQuota = () => {
      if (view.visible) void this.refreshCodexQuota();
    };
    const poll = setInterval(refreshQuota, 60_000);
    view.onDidChangeVisibility(refreshQuota);
    view.onDidDispose(() => {
      clearInterval(poll);
      if (this.view !== view.webview) return;
      this.view = undefined;
      this.codexQuotaRequest?.abort();
      this.codexQuota = [];
      this.codexQuotaCheckedAt = 0;
      clearTimeout(this.timer);
    });
    refreshQuota();
    await this.state();
  }
  async refreshCodexQuota(force = false) {
    if (this.codexQuotaRequest || (!force && Date.now() - this.codexQuotaCheckedAt < codexQuotaInterval)) return;
    const request = new AbortController();
    this.codexQuotaRequest = request;
    this.codexQuotaCheckedAt = Date.now();
    try {
      const windows = await readCodexQuota(request.signal);
      if (!request.signal.aborted) this.codexQuota = windows;
    } catch {
      if (!request.signal.aborted) this.codexQuota = [];
    } finally {
      this.codexQuotaRequest = undefined;
      if (!request.signal.aborted) this.refresh();
    }
  }
  showUpdate() {
    this.view?.postMessage({ type: 'releaseUpdate', update: this.app.updates?.state });
  }
  async state() {
    if (!this.view) return;
    this.showUpdate();
    const settings = await this.app.settings();
    const all = [...this.app.sessions.values()].filter(s => !s.readonly&&hasConversationContent(s));
    const usage = all.reduce((a, s) => ({ input: a.input + (s.usage?.input || 0), output: a.output + (s.usage?.output || 0) }), { input: 0, output: 0 });
    const folders = this.app.localWorkspaceFolders();
    this.view?.postMessage({ type: 'state', multiRoot: folders.length > 1, groups: this.meta.groups, quota: this.app.quota, codexQuota: this.codexQuota, usage,usageByProvider:providerUsage(all,connections(this.app.context).profiles), claudeCost: this.app.claudeCost,
      provider: settings.provider, model: settings.model, configured: !!settings.apiKey,
      sessions: all.filter(s => this.app.isSessionInWorkspace(s, folders)).map(s => ({ id: s.id, title: this.row(s.id).alias || s.title, updated: s.updated,
        project: s.root ? path.basename(s.root) : s.project || '', source: s.readonly ? 'Claude Code' : 'AI',
        readonly: !!s.readonly, unread:!!this.row(s.id).unread, busy: this.app.runs.has(s.id), waiting: [...this.app.pending.values()].some(p => p.sessionId === s.id),
        active: this.app.lastPanel === this.app.panels.get(s.id) && !!this.app.lastPanel,
        archived: !!this.row(s.id).archived, groupId: this.row(s.id).groupId || null
      })).sort((a, b) => b.updated - a.updated)
    });
  }
  async receive(message) {
    if (!message || typeof message.type !== 'string') return;
    const id = message.id; const session = this.app.sessionOf(id);
    if (session && !this.app.isSessionInWorkspace(session)) return;
    switch (message.type) {
      case 'ready': return this.state();
      case 'checkHarnessUpdate': {
        const view = this.view;
        const updates = this.app.updates;
        const status = updates ? await updates.check() ?? (updates.state ? 'available' : 'failed') : 'unavailable';
        if (view === this.view) view?.postMessage({type:'releaseCheck', status});
        return;
      }
      case 'installHarnessUpdate': return this.app.updates?.apply();
      case 'reloadHarnessUpdate':
        if (this.app.updates?.state?.phase === 'installed') return vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      case 'chatgptUsage': return vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/settings/usage'));
      case 'new': { const s = this.app.newSession(); await this.app.save(s); return this.app.openTab(s.id); }
      case 'open': if(session){if(this.row(id).unread){this.meta.rows[id]={...this.row(id),unread:false};await this.save();}return this.app.openTab(id);} return;
      case 'markUnread': if(session){this.meta.rows[id]={...this.row(id),unread:true};return this.save();}return;
      case 'newGroupFromSession': {
        if(!session)return;const name=await vscode.window.showInputBox({title:'New group from session',value:session.title});
        if(name?.trim()){const group={id:randomUUID(),name:name.trim().slice(0,60)};this.meta.groups.push(group);this.meta.rows[id]={...this.row(id),groupId:group.id};await this.save();}return;
      }
      case 'refresh':
        void this.refreshCodexQuota(true);
        await this.app.reloadClaude();
        await this.app.refreshQuota();
        return this.state();
      case 'configure': await this.app.configure(); this.app.broadcast(); return this.state();
      case 'rename': {
        if (!session) return;
        if (!session.readonly&&typeof message.title==='string')return this.app.rename(id,message.title);
        const title = await vscode.window.showInputBox({ title: 'Rename in AI session manager (original unchanged)', value: this.row(id).alias || session.title });
        if (title?.trim()) { this.meta.rows[id] = { ...this.row(id), alias: title.trim().slice(0, 100) }; await this.save(); }
        return;
      }
      case 'archive': if (session && !this.app.runs.has(id)) { this.meta.rows[id] = { ...this.row(id), archived: !this.row(id).archived }; return this.save(); } return;
      case 'newGroup': {
        const name = await vscode.window.showInputBox({ title: 'New group', placeHolder: 'Group name' });
        if (name?.trim()) { this.meta.groups.push({ id: randomUUID(), name: name.trim().slice(0, 60) }); return this.save(); } return;
      }
      case 'renameGroup': {
        const group = this.meta.groups.find(g => g.id === id); if (!group) return;
        const name = await vscode.window.showInputBox({ title: 'Rename group', value: group.name });
        if (name?.trim()) { group.name = name.trim().slice(0, 60); return this.save(); } return;
      }
      case 'move': {
        if (!session) return;
        const choice = await vscode.window.showQuickPick([{ label: 'Ungrouped', id: null }, ...this.meta.groups.map(g => ({ label: g.name, id: g.id }))], { title: `Move “${session.title}” to group` });
        if (choice) { this.meta.rows[id] = { ...this.row(id), groupId: choice.id }; return this.save(); } return;
      }
    }
  }
  dispose() { clearTimeout(this.timer); }
}
module.exports = { SessionManager,providerUsage };
