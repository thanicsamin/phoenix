import type { GenerationHistory } from './types.ts';
import { checkProject, compileWeb, isTypeScriptProject } from './build.ts';
import { errorOf } from './errors.ts';
import { access, readFile, writeFile, rename, realpath, readdir, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Generations, makeWritable } from './generations.ts';

// UI snapshots contain only the small web folder. Publishing never restarts Pi.
export class Interface extends Generations {
  baseFile: string; queue: Promise<unknown>; root: string; version = "";
  constructor(data: string, app: string) {
    super(data, join(app, 'web'), { profile: 'ui-profile', folders: ['.'] });
    this.root = this.app; this.baseFile = join(data, '.ui-base'); this.queue = Promise.resolve();
  }
  async initialize(base = this.app) {
    const existed = await access(this.profile).then(() => true, () => false);
    await super.initialize(base);
    const currentBase = await realpath(base);
    const previousBase = await readFile(this.baseFile, 'utf8').catch(caught => { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; return ''; });
    // A full agent reload/rollback must bring its matching UI contract with it.
    if (this.available && existed && previousBase !== currentBase) await this.apply(base);
    await writeFile(`${this.baseFile}.tmp`, currentBase, { mode: 0o600 }); await rename(`${this.baseFile}.tmp`, this.baseFile);
    await this.update();
  }
  async update() {
    this.root = this.available ? await realpath(this.profile) : this.app;
    this.version = this.available ? basename(this.root) : '';
  }
  async validate(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('UI snapshots must contain regular files, not symlinks.');
    }
    await super.validate(directory);
  }
  change(action: () => Promise<GenerationHistory>) {
    const result = this.queue.then(async () => { const history = await action(); await this.update(); return history; });
    this.queue = result.catch(() => {}); return result;
  }
  apply(source = this.app) { return this.change(async () => {
    await this.validate(source);
    const project = join(source, '..');
    if (await isTypeScriptProject(project)) await checkProject(project, true);
    const temporary = await mkdtemp(join(tmpdir(), 'phoenix-ui-'));
    try {
      const web = join(temporary, 'web'); await cp(source, web, { recursive: true });
      await makeWritable(web); await compileWeb(web); return await super.apply(web);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }); }
  switch(id?: number) { return this.change(() => super.switch(id)); }
}
