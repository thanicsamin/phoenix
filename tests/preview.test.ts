import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../extensions/auth.ts';
import browser, { previewCookie } from '../extensions/browser.ts';

test('agent preview signs in only on the exact local UI origin and expires independently', async t => {
  const data = await mkdtemp(join(tmpdir(), 'phoenix-preview-')); t.after(() => rm(data, { recursive: true, force: true }));
  let now = Date.now(); const auth = await createAuth(data, { password: 'preview-test-password', now: () => now });
  const host = { auth, port: 8085 }; const owner = await auth.login('preview-test-password');
  for (const url of ['https://example.com', 'http://localhost:8086/', 'https://localhost:8085/', 'http://localhost.evil:8085/', 'http://user@localhost:8085/']) assert.equal(previewCookie(host, new URL(url)), undefined);
  const { cookie, session } = previewCookie(host, new URL('http://localhost:8085/'));
  assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict'); assert.equal(cookie.url, 'http://localhost:8085');
  assert.equal(auth.get(session.token).preview, true);
  assert.equal(previewCookie(host, new URL('http://127.0.0.1:8085/'), session).session.token, session.token);
  now += 5 * 60000; assert.equal(auth.get(session.token), undefined); assert.ok(auth.get(owner.token));
  const second = previewCookie(host, new URL('http://localhost:8085/'), session).session;
  assert.notEqual(second.token, session.token); auth.logout(second.token); assert.equal(auth.get(second.token), undefined);
  assert.ok(auth.get(owner.token));
  host.loaded = new Map([['inbox', { source: 'Incoming email' }]]);
  assert.equal(previewCookie(host, new URL('http://localhost:8085/'), undefined, 'inbox'), undefined);
  host.dataDir = data; host.cleanups = []; host.extensions = {};
  let tool; browser({ on() {}, registerTool(value) { tool = value; } }, host, {}, 'inbox');
  await assert.rejects(tool.execute('test', { action: 'navigate', url: 'http://localhost:8085/' }), /only in owner-requested chats/);
});
