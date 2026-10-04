import type { GenerationHistory } from './types.ts';
import { checkProject, compileWeb, isTypeScriptProject } from './build.ts';
import { errorOf } from './errors.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, cp, rename, mkdir, chmod, stat, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
export async function makeWritable(directory: string) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(file);
    else if (entry.isFile()) await chmod(file, 0o600 | ((await stat(file)).mode & 0o111));
  }
}

// Nix owns snapshots, atomic profile switches, history and GC roots. Memory and
// conversations live outside this profile and are never rolled back with code.
export class Generations {
  app: string; profile: string; folders: string[]; working: string; available: boolean;
  constructor(data: string, app = join(data, 'workspace', 'phoenix'), { profile = 'agent-profile', folders = ['src', 'extensions', 'web'] } = {}) {
    this.app = app; this.profile = join(data, profile); this.folders = folders; this.working = join(data, '.working-generation'); this.available = false;
  }
  async initialize(source = this.app) {
    try { await run('nix-env', ['--version']); }
    catch (caught) { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; return; }
    this.available = true;
    try { await access(this.profile); } catch { await this.apply(source); }
  }
  async history(): Promise<GenerationHistory> {
    if (!this.available) return { available: false, generations: [] };
    const { stdout } = await run('nix-env', ['--profile', this.profile, '--list-generations']);
    return { available: true, generations: stdout.split('\n').map(line => {
      const match = /^\s*(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\S+)(.*)$/.exec(line);
      return match ? { id: Number(match[1]), date: `${match[2]} ${match[3]}`, current: match[4].includes('current') } : null;
    }).filter(item => item !== null) };
  }
  async validate(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await this.validate(path);
      else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) await run(process.execPath, ['--check', path]);
    }
  }
  async apply(source = this.app) {
    if (!this.available) throw Object.assign(new Error('Install Nix to use agent generations.'), { status: 409 });
    if (this.folders.length > 1 && await isTypeScriptProject(source)) { await checkProject(source); await compileWeb(join(source, 'web')); }
    for (const folder of this.folders) await this.validate(join(source, folder));
    const { stdout } = await run('nix-store', ['--add', source], { maxBuffer: 1024 * 1024 });
    const path = stdout.trim();
    if (!/^\/nix\/store\/[a-z0-9]{32}-[^\s]+$/.test(path)) throw new Error('Nix did not create a valid generation.');
    await run('nix-env', ['--profile', this.profile, '--set', path]);
    return this.history();
  }
  async switch(id?: number, restore = true) {
    if (!this.available) throw Object.assign(new Error('Install Nix to use agent generations.'), { status: 409 });
    const history = await this.history();
    const target = id === undefined ? history.generations.filter(item => item.id < (history.generations.find(item => item.current)?.id ?? Infinity)).at(-1)?.id : id;
    if (!Number.isInteger(target) || !history.generations.some(item => item.id === target)) throw Object.assign(new Error('Choose an existing generation.'), { status: 400 });
    let backup;
    if (restore) {
      const temporary = `${this.app}.${randomUUID()}.tmp`;
      await cp(await realpath(`${this.profile}-${target}-link`), temporary, { recursive: true });
      await makeWritable(temporary);
      const folder = this.folders.length === 1 ? `${this.profile}-backups` : join(this.app, '..', '.phoenix-before-rollback'); await mkdir(folder, { recursive: true });
      backup = join(folder, randomUUID());
      await rename(this.app, backup); await rename(temporary, this.app);
    }
    try { await run('nix-env', ['--profile', this.profile, '--switch-generation', String(target)]); }
    catch (caught) { const error = errorOf(caught); if (backup) { await rm(this.app, { recursive: true, force: true }); await rename(backup, this.app); } throw error; }
    return this.history();
  }
  async markWorking(id: number) {
    await writeFile(`${this.working}.tmp`, String(id), { mode: 0o600 }); await rename(`${this.working}.tmp`, this.working);
  }
  async recover() {
    const history = await this.history();
    const current = history.generations.find(item => item.current)?.id;
    const working = Number(await readFile(this.working, 'utf8').catch(caught => { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; return ''; }));
    return this.switch(working && working !== current ? working : undefined, false);
  }
}
