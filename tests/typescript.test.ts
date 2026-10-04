import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { checkProject, compileWeb } from '../src/build.ts';
import { Generations } from '../src/generations.ts';

test('a type error blocks generation publication before Nix can change its profile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['src/*.ts'] }));
  await writeFile(join(root, 'src/main.ts'), 'const port: number = "invalid";');
  const generations = new Generations(root, root); generations.available = true;
  await assert.rejects(generations.apply(), /TypeScript check failed:[\s\S]*not assignable/);
  await writeFile(join(root, 'src/main.ts'), 'const port: number = 8080;');
  await checkProject(root);
});

test('browser publication emits ordinary JavaScript and rejects broken syntax', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-web-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'app.ts'), 'import type { Config } from "../src/types.ts"; const value: number = 7; globalThis.answer = value;');
  await compileWeb(root);
  const code = await readFile(join(root, 'app.js'), 'utf8');
  const context: { answer?: number } = {}; runInNewContext(code, context);
  assert.equal(context.answer, 7); assert.doesNotMatch(code, /import type|export \{\}/);
  await writeFile(join(root, 'app.ts'), 'const value: = ;');
  await assert.rejects(compileWeb(root));
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), code);
});
