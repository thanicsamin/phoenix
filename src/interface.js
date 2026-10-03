import { access, readFile, writeFile, rename, realpath, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Generations } from './generations.js';

// UI snapshots contain only the small web folder. Publishing never restarts Pi.
export class Interface extends Generations {
  constructor(data, app) {
    super(data, join(app, 'web'), { profile: 'ui-profile', folders: ['.'] });
    this.baseFile = join(data, '.ui-base'); this.queue = Promise.resolve();
  }
  async initialize(base = this.app) {
    const existed = await access(this.profile).then(() => true, () => false);
    await super.initialize(base);
    const currentBase = await realpath(base);
    const previousBase = await readFile(this.baseFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    // A full agent reload/rollback must bring its matching UI contract with it.
    if (this.available && existed && previousBase !== currentBase) await this.apply(base);
    await writeFile(`${this.baseFile}.tmp`, currentBase, { mode: 0o600 }); await rename(`${this.baseFile}.tmp`, this.baseFile);
    await this.update();
  }
  async update() {
    this.root = this.available ? await realpath(this.profile) : this.app;
    this.version = this.available ? basename(this.root) : '';
  }
  async validate(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('UI snapshots must contain regular files, not symlinks.');
    }
    await super.validate(directory);
  }
  change(action) {
    const result = this.queue.then(async () => { const history = await action(); await this.update(); return history; });
    this.queue = result.catch(() => {}); return result;
  }
  apply(source = this.app) { return this.change(() => super.apply(source)); }
  switch(id) { return this.change(() => super.switch(id)); }
}
