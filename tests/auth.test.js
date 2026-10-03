import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../extensions/auth.js';

test('passwords are hashed; persisted password, expiry, logout and throttling work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000;
  const auth = await createAuth(directory, { password: 'a-secure-test-password', now: () => now });
  const record = await readFile(join(directory, 'password.json'), 'utf8');
  assert.ok(!record.includes('a-secure-test-password'));
  assert.equal((await stat(join(directory, 'password.json'))).mode & 0o777, 0o600);
  assert.equal((await auth.login('wrong')).status, 401);
  const login = await auth.login('a-secure-test-password');
  assert.equal(login.status, 200);
  assert.equal(auth.get(login.token).csrf, login.csrf);
  auth.logout(login.token);
  assert.equal(auth.get(login.token), undefined);
  const second = await auth.login('a-secure-test-password');
  now += 12 * 60 * 60 * 1000;
  assert.equal(auth.get(second.token), undefined);
  for (let index = 0; index < 10; index++) await auth.login('wrong');
  assert.equal((await auth.login('a-secure-test-password')).status, 429);
  now += 61000;
  assert.equal((await auth.login('a-secure-test-password')).status, 200);
  const reopened = await createAuth(directory);
  assert.equal((await reopened.login('a-secure-test-password')).status, 200);
});

test('generated password is shown once and is restored without reprinting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lines = [];
  const auth = await createAuth(directory, { log: line => lines.push(line) });
  const password = lines[0].split(': ').at(-1);
  assert.ok(password.length >= 32);
  assert.equal((await auth.login(password)).status, 200);
  await createAuth(directory, { log: line => lines.push(line) });
  assert.equal(lines.length, 1);
});
