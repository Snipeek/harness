'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

class ProjectMemory {
  constructor(directory) {
    this.directory = directory;
    this.writes = new Map();
  }

  async file(root, scope) {
    const key = createHash('sha256').update(await fs.realpath(root)).digest('hex');
    return path.join(this.directory, key + (scope ? '-'+scope : '') + '.json');
  }

  async read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async list(root, scope) {
    return this.read(await this.file(root, scope));
  }

  async update(root, { action, key, note }, scope) {
    const file = await this.file(root, scope);
    const previous = this.writes.get(file) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const entries = (await this.read(file)).filter(entry => entry.key !== key);
      if (action === 'save') entries.unshift({ key, note });
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(entries.slice(0, 20)), { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    this.writes.set(file, write);
    try { await write; }
    finally { if (this.writes.get(file) === write) this.writes.delete(file); }
  }
}

const memoryTool = { type: 'function', function: {
  name: 'project_memory',
  description: 'List, save or forget durable project notes shared by new chats. Save only stable project facts and cite sources in the note. Never save secrets or user message transcripts.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { enum: ['list', 'save', 'forget'] },
    key: { type: 'string', minLength: 1, maxLength: 80 },
    note: { type: 'string', minLength: 1, maxLength: 600 }
  } }
} };

module.exports = { ProjectMemory, memoryTool };
