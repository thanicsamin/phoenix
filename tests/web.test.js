import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../extensions/auth.js';
import web, { createWebServer } from '../extensions/web.js';
import { createLogger } from '../src/log.js';

test('direct HTTPS origin preserves login, secure cookies and host checks on a custom port', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-direct-'));
  const host = { auth: await createAuth(directory, { password: 'direct-test-password' }), cleanups: [], extensions: {}, changed() {} };
  let start;
  web({ on(event, callback) { if (event === 'session_start') start = callback; } }, host, { port: 0, url: 'https://203.0.113.10:24843' });
  await start();
  t.after(async () => { for (const cleanup of host.cleanups) await cleanup(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(host.publicUrl, 'https://203.0.113.10:24843');
  const call = (path, headers, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: host.port, path, method: body ? 'POST' : 'GET', headers }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const headers = { Host: '203.0.113.10:24843', Origin: host.publicUrl, 'Content-Type': 'application/json' };
  assert.equal((await call('/health', headers)).status, 200);
  assert.equal((await call('/api/state', headers)).status, 401);
  const login = await call('/api/login', headers, { password: 'direct-test-password' });
  assert.equal(login.status, 200); assert.match(login.cookie, /; Secure$/);
  assert.equal((await call('/api/login', { ...headers, Origin: 'https://evil.example' }, { password: 'direct-test-password' })).status, 403);
  assert.equal((await call('/health', { Host: '203.0.113.10:8080' })).status, 403);
});

test('VPS environment selects the default public port, honors an override, and rejects invalid addresses', async t => {
  const original = { ip: process.env.PHOENIX_PUBLIC_IP, port: process.env.PHOENIX_HTTPS_PORT };
  t.after(() => {
    for (const [name, value] of [['PHOENIX_PUBLIC_IP', original.ip], ['PHOENIX_HTTPS_PORT', original.port]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.PHOENIX_PUBLIC_IP = '203.0.113.10'; delete process.env.PHOENIX_HTTPS_PORT;
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-public-env-'));
  const auth = await createAuth(directory, { password: 'public-env-test-password' });
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [port, expected] of [[undefined, 'https://203.0.113.10:24843'], ['26443', 'https://203.0.113.10:26443'], ['99999', undefined]]) {
    if (port === undefined) delete process.env.PHOENIX_HTTPS_PORT; else process.env.PHOENIX_HTTPS_PORT = port;
    const host = { auth, config: { extensions: {} }, cleanups: [], extensions: {}, changed() {} };
    let start;
    web({ on(event, callback) { if (event === 'session_start') start = callback; } }, host, { port: 0 });
    await start();
    assert.equal(host.publicUrl, expected);
    assert.equal(host.extensions.web, expected ? 'ready' : 'failed');
    for (const cleanup of host.cleanups) await cleanup();
  }
  process.env.PHOENIX_PUBLIC_IP = '203.0.113.10/evil';
  const host = { auth, cleanups: [], extensions: {}, changed() {} };
  let start;
  web({ on(event, callback) { if (event === 'session_start') start = callback; } }, host, { port: 0 });
  await start(); assert.equal(host.extensions.web, 'failed');
  for (const cleanup of host.cleanups) await cleanup();
  process.env.PHOENIX_PUBLIC_IP = 'auto'; delete process.env.PHOENIX_HTTPS_PORT;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const [status, ip, expected] of [[200, '203.0.113.10\n', 'https://203.0.113.10:24843'], [503, '', undefined], [200, 'bad-address', undefined]]) {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.ipify.org'); assert.ok(options.signal instanceof AbortSignal);
      return new Response(ip, { status });
    };
    const host = { auth, config: { extensions: {} }, cleanups: [], extensions: {}, changed() {} };
    let start;
    web({ on(event, callback) { if (event === 'session_start') start = callback; } }, host, { port: 0 });
    await start(); assert.equal(host.publicUrl, expected); assert.equal(host.extensions.web, expected ? 'ready' : 'failed');
    for (const cleanup of host.cleanups) await cleanup();
  }
});

test('web gates agent/config access, checks origin and CSRF, accepts only valid prompts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-web-'));
  const messages = [];
  const host = {
    auth: await createAuth(directory, { password: 'a-secure-test-password' }),
    config: { name: 'Safe setup', model: { provider: 'opencode', id: 'big-pickle' } }, revision: 1, pending: 0,
    submit: async message => messages.push(message), state: () => ({ revision: 1, messages }),
    getChat: async () => ({ pending: 0 }), exportSetup() { return this.config; },
  };
  const server = createWebServer(host);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host.port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/setup`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await post('/api/login', { password: 'a-secure-test-password' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/login', { password: 'wrong' })).status, 401);
  const login = await post('/api/login', { password: 'a-secure-test-password' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const { csrf } = await login.json();
  assert.equal((await post('/api/prompt', { message: 'hello' }, { Cookie: cookie })).status, 403);
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  let routes = 0;
  host.internet = { pair: async () => 'Connector source', toggle: async () => { routes++; return {}; }, revoke: async () => {} };
  assert.equal((await post('/api/internet/pair', {}, { Cookie: cookie })).status, 403);
  assert.equal((await post('/api/internet/pair', {}, { ...headers, Origin: 'https://evil.example' })).status, 403);
  const preview = host.auth.preview();
  assert.equal((await post('/api/internet/pair', {}, { Cookie: `phoenix=${preview.token}`, 'X-CSRF-Token': preview.csrf })).status, 403);
  assert.deepEqual(await (await post('/api/internet/pair', {}, headers)).json(), { client: 'Connector source' });
  assert.equal((await post('/api/internet/route', { enabled: true }, headers)).status, 200); assert.equal(routes, 1);
  assert.equal((await post('/api/prompt', { message: 'hello' }, { ...headers, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/prompt', { message: '  ' }, headers)).status, 400);
  assert.equal((await post('/api/prompt', { message: 'hello' }, headers)).status, 202);
  assert.deepEqual(messages, ['hello']);
  const setup = await fetch(`${base}/api/setup`, { headers: { Cookie: cookie } });
  assert.deepEqual(await setup.json(), host.config);
  assert.equal((await fetch(`${base}/api/state?after=1`, { headers: { Cookie: cookie } })).status, 204);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await post('/api/logout', {}, headers)).status, 200);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 401);
});

test('file and workspace endpoints require auth/CSRF, isolate chats and return safe downloads', async t => {
  const { Host } = await import('../src/host.js'); const { loadConfig } = await import('../src/config.js');
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-web-files-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const host = new Host(await loadConfig('agent.json'), directory, join(directory, 'workspace')); await host.initialize();
  host.auth = await createAuth(directory, { password: 'file-test-password' }); host.getChat = async () => ({ pending: 0 });
  const prompts = []; host.submit = async (...args) => prompts.push(args);
  const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${host.port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'file-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0]; const { csrf } = await login.json();
  const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf };
  const upload = extra => fetch(`${base}/api/files?name=notes.txt`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', ...extra }, body: 'File contents.' });
  assert.equal((await upload({ 'X-CSRF-Token': '' })).status, 403);
  const file = await (await upload()).json(); assert.equal(file.name, 'notes.txt');
  const download = `/api/files/download?id=${file.id}`;
  assert.equal((await fetch(base + download)).status, 401);
  const response = await fetch(base + download, { headers: { Cookie: cookie } }); assert.equal(await response.text(), 'File contents.');
  assert.match(response.headers.get('content-disposition'), /attachment/); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const side = await host.createChat('Side');
  const image = await host.files.add('main', 'picture.png', [Buffer.from([137,80,78,71,13,10,26,10])]);
  const inline = `${base}/api/files/image?chat=main&id=${image.id}`;
  assert.equal((await fetch(inline)).status, 401);
  const previewImage = await fetch(inline, { headers: { Cookie: cookie } }); assert.equal(previewImage.headers.get('content-type'), 'image/png'); assert.equal(previewImage.headers.get('content-disposition'), 'inline');
  assert.equal((await fetch(`${inline.replace('chat=main', `chat=${side.id}`)}`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/files/image?id=${file.id}`, { headers: { Cookie: cookie } })).status, 415);
  assert.equal((await fetch(base + '/api/chat/archive', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: side.id, archived: true }) })).status, 401);
 assert.equal((await fetch(`${base}${download}&chat=${side.id}`, { headers: { Cookie: cookie } })).status, 404);
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/prompt', { message: '', attachments: [file.id] })).status, 202);
  assert.equal(prompts[0][3][0], file.id);
  assert.equal((await post('/api/prompt', { message: 'wrong', chatId: side.id, attachments: [file.id] })).status, 404);
  assert.equal((await post('/api/chat/archive', { chatId: side.id, archived: true })).status, 200); assert.equal(host.record(side.id).archived, true);
  assert.equal((await post('/api/chat/archive', { chatId: side.id, archived: false })).status, 200); assert.equal(host.record(side.id).archived, false);
  assert.equal((await post('/api/chat/archive', { chatId: 'main', archived: true })).status, 409);
  assert.equal((await post('/api/chat/archive', { chatId: side.id, archived: 'true' })).status, 400);
  assert.equal((await post('/api/chat/pin', { chatId: side.id, pinned: true })).status, 200); assert.equal(host.record(side.id).pinned, true);
  assert.equal((await post('/api/chat/pin', { chatId: 'main', pinned: false })).status, 409);
  assert.equal((await post('/api/chat/pin', { chatId: side.id, pinned: 'true' })).status, 400);
  const preview = host.auth.preview();
  assert.equal((await fetch(base + '/api/chat/archive', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', Cookie: `phoenix=${preview.token}`, 'X-CSRF-Token': preview.csrf }, body: JSON.stringify({ chatId: side.id, archived: true }) })).status, 403);
  assert.equal((await post('/api/workspace/file', { path: 'AGENTS.md', text: 'Updated prompt.' })).status, 200);
  const prompt = await fetch(`${base}/api/workspace/file?path=AGENTS.md`, { headers: { Cookie: cookie } }); assert.equal((await prompt.json()).text, 'Updated prompt.');
  assert.equal((await fetch(`${base}/api/workspace/file?path=../auth.json`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/workspace/download?path=memory`, { headers: { Cookie: cookie } })).status, 400);
});

test('request logs correlate failures without recording passwords, headers, bodies or query strings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-web-logs-'));
  const lines = [];
  const host = { auth: await createAuth(directory, { password: 'logging-test-password' }),
    exportSetup() { throw new Error('Fixture backend failure'); } };
  const server = createWebServer(host, createLogger('web-test', { level: 'debug', write: line => lines.push(line) }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  await fetch(`${base}/health`); assert.equal(lines.length, 0);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Request-Id': 'untrusted-id' }, body: JSON.stringify({ password: 'logging-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0]; const { csrf } = await login.json();
  const response = await fetch(`${base}/api/setup?private=private-query-value`, { headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
  assert.equal(response.status, 500); const body = await response.json();
  assert.equal(body.requestId, response.headers.get('x-request-id')); assert.notEqual(body.requestId, 'untrusted-id');
  const records = lines.map(line => JSON.parse(line));
  const failure = records.find(record => record.event === 'http.failed');
  const request = records.find(record => record.event === 'http.request' && record.status === 500);
  assert.equal(failure.requestId, body.requestId); assert.equal(request.requestId, body.requestId);
  assert.equal(request.route, '/api/setup'); assert.ok(request.durationMs >= 0);
  for (const value of ['logging-test-password', cookie, csrf, 'private-query-value', 'untrusted-id']) assert.ok(!lines.join('').includes(value));
});
