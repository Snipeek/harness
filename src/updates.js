'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const origin = 'https://ebuilde.ru';
const releasesPath = '/harness/releases/';
const intervalMs = 30 * 60_000;

function isNewer(next, current) {
  const versions = [next, current].map(version =>
    typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(BigInt));
  if (!versions.every(Boolean)) return false;
  const [candidate, installed] = versions;
  const changed = candidate.findIndex((part, index) => part !== installed[index]);
  return changed >= 0 && candidate[changed] > installed[changed];
}

function packageAsset(value, version) {
  if (typeof value !== 'string' || !value) throw Error('Нет файла пакета в описании релиза.');
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password ||
      url.pathname !== releasesPath + 'Harness-' + version + '.vsix' || url.search || url.hash) {
    throw Error('Неподходящий адрес файла релиза.');
  }
  return url;
}

async function request(url, timeout, headers) {
  const response = await fetch(url, {headers, redirect: 'error', signal: AbortSignal.timeout(timeout)});
  if (!response.ok) throw Error('Реестр вернул HTTP ' + response.status);
  return response;
}

class HarnessUpdates {
  constructor({version, install, changed, log}) {
    Object.assign(this, {version, install, changed, log});
    this.phase = 'idle';
  }

  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
  }

  get state() {
    if (this.release) return {version: this.release.version, phase: this.phase, error: this.error};
  }

  check() {
    if (this.disposed || this.phase !== 'idle') return;
    return this.checking ||= this.fetchRelease().finally(() => { this.checking = undefined; });
  }

  async fetchRelease() {
    try {
      const response = await request(origin + '/harness/download', 10_000, {Accept: 'application/json'});
      const latest = await response.json();
      if (this.disposed || this.phase === 'installing' || this.phase === 'installed') return;
      this.release = isNewer(latest.version, this.version) ? latest : undefined;
      this.changed();
      return this.release ? 'available' : 'current';
    } catch (error) {
      if (!this.disposed) this.log('Harness update check: ' + error.message);
      return 'failed';
    }
  }

  async apply() {
    if (this.disposed || !this.release || this.phase !== 'idle') return;
    this.phase = 'installing';
    this.error = undefined;
    this.changed();
    const {version, files} = this.release;
    let directory;
    try {
      const downloadUrl = packageAsset(files?.download, version);
      const checksum = files?.sha256;
      if (!/^[a-f0-9]{64}$/i.test(checksum)) throw Error('Некорректная контрольная сумма пакета.');
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-update-'));
      const file = path.join(directory, 'Harness-' + version + '.vsix');
      const response = await request(downloadUrl, 120_000);
      const hash = createHash('sha256');
      const tap = new Transform({transform(chunk, encoding, done) {hash.update(chunk); done(null, chunk);}});
      await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(file, {flags: 'wx'}));
      if (hash.digest('hex') !== checksum.toLowerCase()) throw Error('Контрольная сумма пакета не совпала.');
      if (this.disposed) return;
      await this.install(file);
      this.phase = 'installed';
      this.log('Harness ' + version + ' installed from the update button (SHA-256 verified)');
    } catch (error) {
      this.phase = 'idle';
      this.error = error.message;
    } finally {
      if (directory) await fs.rm(directory, {recursive: true, force: true}).catch(error => this.log(error.message));
      if (!this.disposed) this.changed();
    }
  }
}

module.exports = { HarnessUpdates };
