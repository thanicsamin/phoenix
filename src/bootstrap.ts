import type { ChildProcess } from 'node:child_process';
import { errorOf } from './errors.ts';
import { spawn } from 'node:child_process';
import { mkdir, cp, access, chmod, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Generations, makeWritable } from './generations.ts';
import { createLogger, installProcessLogging } from './log.ts';

installProcessLogging('supervisor');
const log = createLogger('supervisor');
log.info('supervisor.starting');

// Keep the seed immutable; the owner's running copy survives container replacement.
const seed = dirname(dirname(fileURLToPath(import.meta.url)));
// Read from the packaged seed, never from the agent's mutable generations.
const corePrompt = await readFile(join(seed, 'PHOENIX.md'), 'utf8');
const data = resolve(process.env.PHOENIX_DATA || '.phoenix');
const app = join(data, 'workspace', 'phoenix');
await mkdir(join(data, 'workspace', 'nix'), { recursive: true });
await mkdir(join(data, 'tmp'), { recursive: true });
try { await access(join(app, 'src', 'main.ts')).catch(() => access(join(app, 'src', 'main.js'))); }
catch {
  await mkdir(app, { recursive: true });
  for (const name of ['src', 'extensions', 'web', 'nix', 'package.json', 'package-lock.json', 'flake.lock', 'agent.json', 'tsconfig.json', 'tsconfig.web.json', 'node_modules']) {
    await cp(join(seed, name), join(app, name), { recursive: true, dereference: name !== 'node_modules' });
    if (['src', 'extensions', 'web', 'nix', 'node_modules'].includes(name)) await makeWritable(join(app, name));
    else await chmod(join(app, name), 0o600);
  }
}
try { await access(join(data, 'workspace', 'nix', 'flake.nix')); }
catch {
  // Imported setups may declare their own flake; Workspace initializes those files.
  let config;
  for (const path of [join(data, 'setup.json'), resolve(process.env.PHOENIX_CONFIG || 'agent.json')]) {
    try { config = JSON.parse(await readFile(path, 'utf8')); break; }
    catch (caught) { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; }
  }
  if (!config?.workspace?.['nix/flake.nix']) {
    await cp(join(seed, 'nix', 'agent-flake.nix'), join(data, 'workspace', 'nix', 'flake.nix'));
    await cp(join(seed, 'flake.lock'), join(data, 'workspace', 'nix', 'flake.lock'));
    await chmod(join(data, 'workspace', 'nix', 'flake.nix'), 0o600);
    await chmod(join(data, 'workspace', 'nix', 'flake.lock'), 0o600);
  }
}

const generations = new Generations(data, app);
await generations.initialize();

let child: ChildProcess | undefined;
let stopping = false;
let recovered = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; log.info('supervisor.stopping', { signal }); child?.kill(signal); });
while (!stopping) {
  let ready = false;
  const runtime = generations.available ? generations.profile : app;
  const generation = generations.available ? (await generations.history()).generations.find(item => item.current)?.id : undefined;
  const entry = await access(join(runtime, 'src', 'main.ts')).then(() => 'main.ts', () => 'main.js');
  child = spawn(process.execPath, [join(runtime, 'src', entry)], { cwd: app, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...process.env, TMPDIR: join(data, 'tmp'), PHOENIX_CORE_PROMPT: corePrompt, PHOENIX_CONFIG: resolve(process.env.PHOENIX_CONFIG || 'agent.json'), PHOENIX_DATA: data, PHOENIX_APP: app, PHOENIX_RECOVERED: recovered ? '1' : '' } });
  log.info('agent.starting', { generation });
  child.on('message', message => { if (typeof message === 'object' && message !== null && 'ready' in message && message.ready) { ready = true; recovered = false; if (generation) generations.markWorking(generation).catch(error => log.error('generation.record_failed', { error, generation })); } });
  const { code, signal } = await new Promise<{ code: number; signal?: NodeJS.Signals | null }>(resolve => {
    child!.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
    child!.once('error', error => { log.error('agent.spawn_failed', { error }); resolve({ code: 1 }); });
  });
  log[code && code !== 42 && !stopping ? 'error' : 'info']('agent.exited', { code, signal, ready, generation });
  if (code !== 42 || stopping) {
    if (code && !ready && !stopping && !recovered && generations.available) {
      try { await generations.recover(); recovered = true; log.warn('generation.recovered', { generation }); continue; }
      catch (caught) { const error = errorOf(caught); log.error('generation.recovery_failed', { error }); }
    }
    process.exitCode = stopping ? 0 : code; break;
  }
  log.info('agent.reloading');
}
