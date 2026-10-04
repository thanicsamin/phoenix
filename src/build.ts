import { stripTypeScriptTypes } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export async function checkProject(root: string, webOnly = false) {
  try {
    await run(process.execPath, [webOnly ? '--max-old-space-size=256' : '--max-old-space-size=1024', join(root, 'node_modules/typescript/bin/tsc'), '--project', join(root, webOnly ? 'tsconfig.web.json' : 'tsconfig.json'), '--pretty', 'false'], { maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const output = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) || ('stderr' in error ? String(error.stderr) : String(error)) : String(error);
    throw Object.assign(Error(`TypeScript check failed:\n${output.slice(0, 32000)}`), { status: 400 });
  }
}
export async function compileWeb(directory: string) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'));
  if (!files.length) return; // Earlier JavaScript generations remain restorable.
  // Parse the whole candidate before replacing any currently served asset.
  const outputs: { name: string; text: string }[] = [];
  for (const name of files) {
    const outputText = stripTypeScriptTypes(await readFile(join(directory, name), 'utf8'));
    // Classic scripts preserve early theme application and vendor loading order.
    outputs.push({ name: name.slice(0, -3) + '.js', text: outputText.replace(/^export \{\};\s*$/gm, '') });
  }
  for (const output of outputs) await writeFile(join(directory, output.name), output.text, { mode: 0o600 });
}
export async function isTypeScriptProject(root: string) {
  return access(join(root, 'src/main.ts')).then(() => true, () => false);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  await checkProject(root); await compileWeb(join(root, 'web'));
}
