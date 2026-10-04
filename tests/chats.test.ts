import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Host } from '../src/host.ts';
import { loadConfig, configSchema } from '../src/config.ts';
import { saveSetup } from '../src/setup.ts';
import chatsExtension from '../extensions/chats.ts';
import memoryExtension from '../extensions/memory.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-chat-details-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig('agent.json'); const host = new Host(config, directory, join(directory, 'workspace')); await host.initialize(); t.after(() => host.close());
  host.createSession = async id => ({ model: host.record(id).model || config.model, thinkingLevel: host.record(id).thinking || 'off', modelRuntime: { hasConfiguredAuth: () => true }, messages: [],
    subscribe: () => () => {}, bindExtensions: async () => {}, prompt: async () => {}, waitForIdle: async () => {}, abort: async () => {}, dispose() {} });
  return { host, directory, config };
}
test('one-click chats start first, inherit the current model, and get a safe prompt title without extra inference', async t => {
  const { host } = await fixture(t);
  const first = await host.createChat('First'); const source = host.record('main'); source.model = { provider: 'ollama', id: 'local-model' }; source.thinking = 'high';
  const fresh = await host.createChat(undefined, undefined, 'Shopping', 'main');
  assert.equal(fresh.autoTitle, true); assert.equal(fresh.title, 'New chat'); assert.deepEqual(fresh.model, source.model); assert.equal(fresh.thinking, 'high');
  assert.deepEqual((await host.state()).chats.map(chat => chat.id), ['main', fresh.id, first.id]);
  await host.submit('Find a compact coffee grinder for my kitchen', 'web', fresh.id);
  assert.equal(fresh.title, 'Find a compact coffee grinder for my kitchen');
  await host.updateChat(fresh.id, { title: 'Coffee grinders', automatic: true }); assert.equal(fresh.autoTitle, false);
  await host.updateChat(fresh.id, { title: 'My choice' }); await host.updateChat(fresh.id, { title: 'Wrong automatic title', automatic: true }); assert.equal(fresh.title, 'My choice');
  await host.submit('Different request', 'web', fresh.id); assert.equal(fresh.title, 'My choice');
  const background = await host.createChat(); await host.submit('Do not name from background work', 'Scheduled task: QA', background.id); assert.equal(background.title, 'New chat');
  const privateChat = await host.createChat(); await host.submit('Use api_key=secret-credential to test', 'web', privateChat.id); assert.doesNotMatch(privateChat.title, /secret-credential/);
  await host.pinChat(first.id, true); assert.equal((await host.state()).chats[1].id, first.id);
});
test('folders rename and remove without losing jobs, pins or archived chats; legacy chat arrays remain readable', async t => {
  const { host, directory, config } = await fixture(t); const chat = await host.createChat('Keep my work', undefined, 'Shopping');
  await host.pinChat(chat.id, true); await host.archiveChat(chat.id, true); await host.addJob(chat.id, { name: 'Check', prompt: 'Keep running', everyMinutes: 60 });
  await host.updateFolder({ previous: 'Shopping', name: 'Groceries' }); assert.equal(chat.folder, 'Groceries');
  await assert.rejects(host.updateFolder({ name: 'groceries' }), /already exists/); await assert.rejects(host.updateChat(chat.id, { folder: 'missing' }), /existing folder/);
  await assert.rejects(host.updateChat(chat.id, { title: 'bad\nname' }), /chat name/);
  await host.updateFolder({ name: '旅行' }); await host.updateChat(chat.id, { folder: '旅行' });
  assert.ok(Array.isArray(JSON.parse(await readFile(join(directory, 'chats.json'), 'utf8'))));
  const reopened = new Host(config, directory, host.workspace); await reopened.initialize(); t.after(() => reopened.close());
  assert.equal(reopened.record(chat.id).folder, '旅行'); assert.equal((await stat(join(directory, 'folders.json'))).mode & 0o777, 0o600);
  await reopened.updateFolder({ previous: '旅行', remove: true }); const restored = reopened.record(chat.id);
  assert.equal(restored.folder, undefined); assert.equal(restored.jobs.length, 1); assert.equal(restored.archived, true); assert.equal(restored.pinned, true);
  await assert.rejects(reopened.updateFolder({ remove: true }), /existing folder/);
});
test('setup sharing round-trips renamed main chats, duplicate titles, folders and their separate jobs', async t => {
  const { host, directory, config } = await fixture(t); host.modelRuntime = { getModel: () => config.model };
  await host.updateChat('main', { title: 'Home' });
  const a = await host.createChat('Shopping', undefined, 'Shopping'); const b = await host.createChat('Shopping', undefined, 'Diary');
  await host.addJob(a.id, { name: 'First job', prompt: 'First', everyMinutes: 60 }); await host.addJob(b.id, { name: 'Second job', prompt: 'Second', everyMinutes: 120 });
  const exported = configSchema.parse(await host.exportSetup()); await saveSetup(host, exported);
  assert.equal(host.records.length, 3); assert.equal(host.record('main').title, 'Home'); assert.equal(host.record(a.id).jobs[0].name, 'First job'); assert.equal(host.record(b.id).jobs[0].name, 'Second job');
  assert.equal(host.record(a.id).folder, 'Shopping'); assert.equal(host.record(b.id).folder, 'Diary');
  const freshDir = join(directory, 'fresh'); const fresh = new Host(exported, freshDir, join(freshDir, 'workspace')); await fresh.initialize(); t.after(() => fresh.close());
  assert.equal(fresh.record('main').title, 'Home'); assert.equal(fresh.records.length, 3); assert.deepEqual(fresh.folders, host.folders);
});
test('chat naming is an owner tool; personal memory is active and shared while diary notes remain isolated', async t => {
  const { host } = await fixture(t); const a = await host.createChat(); const b = await host.createChat();
  const hooks = new Map(); const tools = new Map();
  for (const id of [a.id, b.id]) {
    await host.getChat(id); const pi = { on: (name, hook) => { const list = hooks.get(id) || []; list.push({ name, hook }); hooks.set(id, list); }, registerTool: tool => { const list = tools.get(id) || {}; list[tool.name] = tool; tools.set(id, list); } };
    chatsExtension(pi, host, {}, id); memoryExtension(pi, host, {}, id);
  }
  const prompt = async id => { let systemPrompt = 'Base'; for (const { hook } of hooks.get(id)) systemPrompt = (await hook({ systemPrompt }))?.systemPrompt || systemPrompt; return systemPrompt; };
  assert.match(await prompt(a.id), /automatic=true/); assert.match(await prompt(a.id), /Actively maintain memory/);
  await tools.get(a.id).chat.execute('name', { title: 'Owner journal', automatic: true }); assert.equal(a.title, 'Owner journal');
  await host.updateChat(a.id, { title: 'Manual title' }); await tools.get(a.id).chat.execute('late', { title: 'Late title', automatic: true }); assert.equal(a.title, 'Manual title');
  await tools.get(a.id).memory.execute('remember', { action: 'remember', scope: 'owner', text: 'Owner prefers short replies.' });
  await tools.get(a.id).memory.execute('remember', { action: 'remember', scope: 'chat', text: 'Private diary detail.' });
  assert.match(await prompt(b.id), /Owner prefers short replies/); assert.doesNotMatch(await prompt(b.id), /Private diary detail/);
  host.loaded.get(a.id).source = 'Incoming email';
  assert.doesNotMatch(await prompt(a.id), /Owner prefers short replies|Private diary detail|automatic=true/);
  await assert.rejects(tools.get(a.id).chat.execute('name', { title: 'External title' }), /owner conversations/);
  await assert.rejects(tools.get(a.id).memory.execute('read', { action: 'read', scope: 'owner' }), /Private memory/);
});
test('chat and folder APIs require owner auth and CSRF; previews cannot modify them', async t => {
  const { host } = await fixture(t); host.auth = await createAuth(host.dataDir, { password: 'chat-api-fixture-password' });
  const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port; t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${host.port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const login = await post('/api/login', { password: 'chat-api-fixture-password' }); const { csrf } = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0]; const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  for (const [path, body] of [['/api/chat/update', { chatId: 'main', title: 'Renamed' }], ['/api/folders', { name: 'Work' }]]) {
    assert.equal((await post(path, body)).status, 401); assert.equal((await post(path, body, { Cookie: cookie })).status, 403);
    assert.equal((await post(path, body, { ...headers, Origin: 'https://evil.example' })).status, 403);
    const preview = host.auth.preview(); assert.equal((await post(path, body, { Cookie: `phoenix=${preview.token}`, 'X-CSRF-Token': preview.csrf })).status, 403);
    assert.equal((await post(path, null, headers)).status, 400); assert.equal((await post(path, body, headers)).status, 200);
  }
  const response = await post('/api/new', {}, headers); assert.equal(response.status, 201); const chat = await response.json(); assert.equal(chat.title, 'New chat');
  assert.equal((await post('/api/chat/update', { chatId: chat.id, folder: 'Work' }, headers)).status, 200);
  assert.equal((await post('/api/new', { fromChatId: 1 }, headers)).status, 400);
  for (const missing of [{}, { Cookie: cookie }]) assert.equal((await post('/api/chat/delete', { chatId: chat.id }, missing)).status, missing.Cookie ? 403 : 401);
  const preview = host.auth.preview(); assert.equal((await post('/api/chat/delete', { chatId: chat.id }, { Cookie: `phoenix=${preview.token}`, 'X-CSRF-Token': preview.csrf })).status, 403);
  assert.equal((await post('/api/chat/delete', { chatId: 'main' }, headers)).status, 409);
  assert.equal((await post('/api/chat/delete', { chatId: chat.id }, headers)).status, 200);
  assert.equal((await post('/api/chat/delete', { chatId: chat.id }, headers)).status, 404);
});
test('deletion cancels approvals and removes only the chosen chat’s durable data; deleted jobs cannot return', async t => {
  const { host, directory, config } = await fixture(t); const chosen = await host.createChat('Delete me'); const keep = await host.createChat('Keep me');
  await host.addJob(chosen.id, { name: 'Delete job', prompt: 'No more work', everyMinutes: 60 });
  async function* bytes() { yield Buffer.from('Private attachment'); }
  const removed = await host.files.add(chosen.id, 'chosen.txt', bytes()); const retained = await host.files.add(keep.id, 'keep.txt', bytes());
  await host.files.prepare('Used upload', [removed.id], chosen.id); assert.equal(host.files.get(removed.id, chosen.id).used, true);
  const folders = [join(directory, 'pi', 'sessions', chosen.id), join(directory, 'browser', chosen.id), join(host.workspace, 'memory', 'chats', chosen.id)];
  for (const folder of folders) { await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'fixture'), 'chat-owned data'); }
  await mkdir(join(host.workspace, 'memory', 'owner'), { recursive: true }); await writeFile(join(host.workspace, 'memory', 'owner', 'shared'), 'Owner facts'); await writeFile(join(host.workspace, 'output.txt'), 'Shared output');
  const approval = host.requestApproval(chosen.id, 'bash', {});
  await host.deleteChat(chosen.id); assert.equal(await approval, false); assert.equal(host.approvals.size, 0);
  assert.throws(() => host.record(chosen.id), /not found/); assert.throws(() => host.files.get(removed.id, chosen.id), /not found/); assert.equal(host.files.get(retained.id, keep.id).name, 'keep.txt');
  for (const folder of [...folders, join(directory, 'attachments', removed.id), join(host.workspace, 'uploads', chosen.id)]) await assert.rejects(stat(folder), { code: 'ENOENT' });
  assert.equal(await readFile(join(host.workspace, 'memory', 'owner', 'shared'), 'utf8'), 'Owner facts'); assert.equal(await readFile(join(host.workspace, 'output.txt'), 'utf8'), 'Shared output');
  const reopened = new Host(config, directory, host.workspace); await reopened.initialize(); t.after(() => reopened.close()); assert.throws(() => reopened.record(chosen.id), /not found/); assert.equal(reopened.record(keep.id).title, 'Keep me');
  await assert.rejects(host.deleteChat('../'), /not found/); await assert.rejects(host.deleteChat('main'), /main chat/);
});
test('interrupted deletions finish before scheduler startup and uploads block deletion', async t => {
  const { host, directory, config } = await fixture(t); const chat = await host.createChat('Interrupted delete');
  await host.addJob(chat.id, { name: 'Never revive', prompt: 'Cancelled', everyMinutes: 0, nextRunAt: new Date(0).toISOString() });
  host.files.uploading = 1; await assert.rejects(host.deleteChat(chat.id), /uploads/); host.files.uploading = 0;
  chat.deleted = true; await host.save();
  const folder = join(directory, 'pi', 'sessions', chat.id); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'fixture'), 'Old history');
  const reopened = new Host(config, directory, host.workspace); await reopened.initialize(); t.after(() => reopened.close());
  assert.throws(() => reopened.record(chat.id), /not found/); await assert.rejects(stat(folder), { code: 'ENOENT' }); assert.equal(JSON.parse(await readFile(join(directory, 'chats.json'), 'utf8')).length, 1);
});
test('deleting an active chat stops its queued work without touching another chat', async t => {
  const { host } = await fixture(t); const record = await host.createChat('Running'); const keep = await host.createChat('Separate');
  const chat = await host.getChat(record.id); let release; const delivered = [];
  chat.session.prompt = async text => { delivered.push(text); await new Promise(resolve => { release = resolve; }); };
  chat.session.abort = async () => { release?.(); };
  const running = host.submit('Active', 'web', record.id); while (!release) await new Promise(resolve => setImmediate(resolve));
  const queued = host.submit('Queued', 'web', record.id); const cancelled = assert.rejects(queued, /cancelled|shutting down/);
  await new Promise(resolve => setImmediate(resolve)); await host.deleteChat(record.id); await running; await cancelled;
  assert.deepEqual(delivered, ['Active']); assert.equal(host.loaded.has(record.id), false); assert.equal(host.chats.has(record.id), false); assert.equal(host.record(keep.id).title, 'Separate');
});
