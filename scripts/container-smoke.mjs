import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const guide = await readFile('/app/PHOENIX.md', 'utf8');
await assert.rejects(open('/app/PHOENIX.md', 'a'), error => ['EROFS', 'EACCES'].includes(error.code));
assert.equal(await readFile('/app/PHOENIX.md', 'utf8'), guide);
const { stdout } = await promisify(execFile)('/app/node_modules/.bin/pi', ['--version']);
assert.match(stdout, /1\.0\.0/);
console.log('Packaged guide is read-only; Pi CLI and /usr/bin/env work.');
await import('./browser-smoke.mjs');
await import('./browser-control-smoke.mjs');
await import('./generations-smoke.mjs');
await import('./ui-generations-smoke.mjs');
await import('./ergonomics-ui-smoke.mjs');
