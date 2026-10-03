import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, registerSecret } from '../src/log.js';
import { secret } from '../src/config.js';

test('logs are filtered JSON lines with timestamps, severity and bounded context', () => {
  const lines = []; const logger = createLogger('test', { write: line => lines.push(line) });
  logger.debug('hidden'); logger.info('ready', { status: 200 });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.component, 'test'); assert.equal(record.level, 'info'); assert.equal(record.event, 'ready');
  assert.equal(record.status, 200); assert.ok(Number.isFinite(Date.parse(record.time)));
  const circular = {}; circular.self = circular;
  logger.warn('circular', { circular }); assert.equal(JSON.parse(lines[1]).circular.self, '[circular]');
  logger.error('oversized', Object.fromEntries(Array.from({ length: 25 }, (_, i) => [i, 'x'.repeat(20000)])));
  assert.ok(Buffer.byteLength(lines[2]) <= 16384); assert.equal(JSON.parse(lines[2]).truncated, true);
  assert.doesNotThrow(() => createLogger('broken-sink', { write() { throw Error('disk full'); } }).error('failed'));
  createLogger('silent', { level: 'silent', write() { assert.fail('silent log written'); } }).fatal('hidden');
});

test('logs redact nested credentials, known secrets, URL queries and error stacks', () => {
  const lines = []; const logger = createLogger('test', { write: line => lines.push(line) });
  const privateValue = 'unique-private-test-value'; registerSecret(privateValue);
  const error = new Error(`Failed with ${privateValue} and oc_sk_not_a_real_key`);
  error.cause = new Error('Bearer not-a-real-token');
  logger.error('failed', { error, options: { apiKey: privateValue, cookie: 'private-cookie', prompt: 'private question', body: 'private file contents' },
    endpoint: 'https://name:pass@example.com/?key=private-query', detail: 'token=not-a-real-token' });
  const line = lines[0];
  for (const value of [privateValue, 'oc_sk_not_a_real_key', 'not-a-real-token', 'private-cookie', 'private question', 'private file contents', 'name:pass', 'private-query']) assert.ok(!line.includes(value), value);
  const record = JSON.parse(line); assert.equal(record.error.name, 'Error'); assert.match(record.error.stack, /log.test.js/);
});

test('credentials loaded from secret files are also redacted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-log-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'secret'); const value = 'file-loaded-private-value';
  await writeFile(path, value, { mode: 0o600 }); process.env.PHOENIX_LOG_TEST_FILE = path;
  t.after(() => { delete process.env.PHOENIX_LOG_TEST_FILE; });
  assert.equal(await secret('PHOENIX_LOG_TEST'), value);
  const lines = []; createLogger('test', { write: line => lines.push(line) }).error('failed', { error: new Error(value) });
  assert.ok(!lines[0].includes(value));
});

test('unexpected exceptions and rejected promises log a redacted fatal event and exit', () => {
  const module = new URL('../src/log.js', import.meta.url).href;
  for (const action of ["setImmediate(() => { throw Error(process.env.OPENCODE_API_KEY); });", "Promise.reject(Error(process.env.OPENCODE_API_KEY));"]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {installProcessLogging} from ${JSON.stringify(module)}; installProcessLogging('fixture'); ${action}`],
      { encoding: 'utf8', env: { ...process.env, PHOENIX_LOG_LEVEL: 'info', OPENCODE_API_KEY: 'private-fixture-key' }, timeout: 5000 });
    assert.equal(result.status, 1); assert.equal(result.stderr, ''); assert.ok(!result.stdout.includes('private-fixture-key'));
    assert.equal(JSON.parse(result.stdout).level, 'fatal');
  }
});
