import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Generations } from '../src/generations.ts';
const data = '/data/generation-check'; const app = join(data, 'workspace', 'phoenix');
await rm(data, { recursive: true, force: true });
for (const folder of ['src','extensions','web']) await mkdir(join(app, folder), { recursive: true });
await writeFile(join(app, 'package.json'), '{"type":"module"}'); await writeFile(join(app, 'src/main.js'), 'export const version = 1;');
await writeFile(join(data, 'workspace/MEMORY.md'), 'Keep my memory.');
const generations = new Generations(data); await generations.initialize();
assert.equal((await generations.history()).generations.length, 1);
await writeFile(join(app, 'src/main.js'), 'export const version = 2;'); await generations.apply();
const history = await generations.history(); assert.equal(history.generations.length, 2); assert.equal(history.generations.find(item => item.current).id, 2);
await writeFile(join(app, 'src/main.js'), 'export const broken = ;'); await assert.rejects(generations.apply()); assert.equal((await generations.history()).generations.length, 2);
await generations.switch(1); assert.equal(await readFile(join(app, 'src/main.js'), 'utf8'), 'export const version = 1;');
assert.equal(await readFile(join(data, 'workspace/MEMORY.md'), 'utf8'), 'Keep my memory.');
await generations.switch(2); assert.equal(await readFile(join(app, 'src/main.js'), 'utf8'), 'export const version = 2;');
await access(join(data, 'agent-profile-1-link')); await access(join(data, 'agent-profile-2-link'));
console.log('Nix generations passed: immutable snapshots, syntax rejection, rollback/forward, editable source restoration and memory preservation.');

// Exercise the real supervisor with a legacy JavaScript generation that fails at startup.
await mkdir(join(data, 'workspace/nix'), { recursive: true });
await writeFile(join(data, 'workspace/nix/flake.nix'), '{}');
await writeFile(join(app, 'src/main.js'), "process.send?.({ ready: true }); console.log(process.env.PHOENIX_RECOVERED ? 'FIXTURE_RECOVERED' : 'FIXTURE_READY'); setInterval(() => {}, 1000);");
await generations.apply();
async function boot(expected) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/bootstrap.ts', import.meta.url))], { env: { ...process.env, PHOENIX_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', chunk => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Supervisor timed out: ${output}`)), 30000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes(expected)) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Supervisor exited ${code}: ${output}`)); });
    });
    for (let attempt = 0; attempt < 50 && await readFile(join(data, '.working-generation'), 'utf8').catch(() => '') !== '3'; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(join(data, '.working-generation'), 'utf8'), '3');
    return output;
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
  }
}
await boot('FIXTURE_READY');
await writeFile(join(app, 'src/main.js'), "throw new Error('Intentional startup failure');");
await generations.apply();
assert.match(await boot('FIXTURE_RECOVERED'), /"event":"generation.recovered"/);
assert.equal((await generations.history()).generations.find(item => item.current).id, 3);
assert.match(await readFile(join(app, 'src/main.js'), 'utf8'), /Intentional startup failure/);
assert.equal(await readFile(join(data, 'workspace/MEMORY.md'), 'utf8'), 'Keep my memory.');
console.log('Supervisor recovery passed: startup failure restored the known working generation and kept the candidate source for repair.');

// TypeScript publication checks types before switching and preserves both the
// editable sources and their matching compiled browser files through rollback.
const typedData = '/data/typescript-generation-check'; const typedApp = join(typedData, 'workspace/phoenix');
await rm(typedData, { recursive: true, force: true });
for (const folder of ['src', 'extensions', 'web']) await mkdir(join(typedApp, folder), { recursive: true });
await writeFile(join(typedApp, 'package.json'), '{"type":"module"}');
await writeFile(join(typedApp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2024', module: 'NodeNext', types: [] }, include: ['src/*.ts', 'web/*.ts'] }));
const { symlink } = await import('node:fs/promises');
await symlink('/app/node_modules', join(typedApp, 'node_modules'));
await writeFile(join(typedApp, 'src/main.ts'), 'export const version: number = 1;');
await writeFile(join(typedApp, 'web/app.ts'), 'const version: number = 1;');
const typed = new Generations(typedData); await typed.initialize();
await writeFile(join(typedApp, 'src/main.ts'), 'export const version: number = 2;');
await writeFile(join(typedApp, 'web/app.ts'), 'const version: number = 2;'); await typed.apply();
await writeFile(join(typedApp, 'src/main.ts'), "export const version: number = 'bad';");
await assert.rejects(typed.apply(), /TypeScript check failed/); assert.equal((await typed.history()).generations.length, 2);
await typed.switch(1); assert.match(await readFile(join(typedApp, 'src/main.ts'), 'utf8'), /number = 1/); assert.match(await readFile(join(typedApp, 'web/app.js'), 'utf8'), /version\s*= 1/);
await typed.switch(2); assert.match(await readFile(join(typedApp, 'src/main.ts'), 'utf8'), /number = 2/); assert.match(await readFile(join(typedApp, 'web/app.js'), 'utf8'), /version\s*= 2/);
console.log('TypeScript Nix generations passed: type-error rejection before switching, matching browser assets, rollback and forward restore.');
