'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
function hasConversationContent(session){return (session.messages||[]).some(m=>m.role!=='system'&&(typeof m.content==='string'?m.content.trim():Array.isArray(m.content)&&m.content.length)||m.tool_calls?.length)||(session.timeline||[]).some(e=>['user','assistant','tool','agent-batch'].includes(e.role)&&(e.text?.trim()||e.result?.trim()||e.agents?.length));}
class SessionStore {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    const sessions = [];
    for (const file of (await fs.readdir(this.directory)).filter(f => /^[a-f0-9-]+\.json$/.test(f))) {
      try {
        const session = JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'));
        if (session.id && Array.isArray(session.messages) && Array.isArray(session.timeline)&&hasConversationContent(session)) sessions.push(session);
      } catch {}
    }
    return sessions.sort((a, b) => b.updated - a.updated);
  }
  save(session) {
    const populated=hasConversationContent(session);
    const text = JSON.stringify(session);
    const file = path.join(this.directory, session.id + '.json');
    const operation = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      if(!populated){await fs.rm(file,{force:true});return;}
      await fs.writeFile(file + '.tmp', text, { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    });
    this.queue = operation;
    return operation;
  }
  async remove(id) {
    await this.queue.catch(() => {});
    await fs.rm(path.join(this.directory, id + '.json'), { force: true });
  }
}
module.exports = { SessionStore,hasConversationContent };
