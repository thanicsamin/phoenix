import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parseEndpoint, saveEndpoint } from '../src/local-models.ts';
import { modelChoices, providerChoices, openCodeSessionHeaders } from '../src/models.ts';
import { Host } from '../src/host.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-local-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const create = () => ModelRuntime.create({ authPath: join(directory, 'pi/auth.json'), modelsPath: join(directory, 'pi/models.json') });
  return { directory, create, runtime: await create() };
}
const endpoint = (extra = {}) => ({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/', modelIds: ['test/model:latest'], ...extra });

test('local endpoints persist in private Pi configuration, preserve other providers, and treat keys literally', async t => {
  const { directory, create, runtime } = await fixture(t);
  await mkdir(join(directory, 'pi'), { recursive: true });
  const unrelated = { baseUrl: 'https://example.com/v1', api: 'openai-completions', apiKey: 'other-key', models: [{ id: 'other-model' }] };
  await writeFile(join(directory, 'pi/models.json'), JSON.stringify({ providers: { unrelated } }));
  const key = '!must-not-run-${PATH}-$HOME';
  await saveEndpoint(runtime, directory, parseEndpoint(endpoint({ apiKey: key, vision: true, reasoning: true })));
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'pi/models.json'), 'utf8')).providers.unrelated, unrelated);
  assert.equal((await stat(join(directory, 'pi/models.json'))).mode & 0o777, 0o600);
  for (const current of [runtime, await create()]) {
    assert.equal((await current.getAuth('ollama')).auth.apiKey, key);
    const model = current.getModel('ollama', 'test/model:latest');
    assert.deepEqual(model.input, ['text', 'image']); assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 32768); assert.ok(modelChoices(current).some(model => model.provider === 'ollama'));
    assert.ok(!JSON.stringify(providerChoices(current)).includes(key));
  }
  await saveEndpoint(runtime, directory, parseEndpoint(endpoint()));
  assert.equal((await runtime.getAuth('ollama')).auth.apiKey, key, 'Blank keeps the same server key');
  await runtime.login('ollama', 'api_key', { prompt: async () => 'stored-old-server-key', notify() {} });
  await runtime.setRuntimeApiKey('ollama', 'runtime-old-server-key');
  await saveEndpoint(runtime, directory, parseEndpoint(endpoint({ baseUrl: 'http://new-server:11434/v1' })));
  for (const current of [runtime, await create()]) assert.equal((await current.getAuth('ollama')).auth.apiKey, 'phoenix-local', 'Old credentials followed a changed URL');
});

test('invalid endpoint inputs and broken Pi files do not overwrite configuration', async t => {
  const { directory, runtime } = await fixture(t);
  for (const extra of [{ baseUrl: 'file:///etc/passwd' }, { baseUrl: 'https://user:secret@example.com/v1' }, { baseUrl: 'https://example.com/v1?key=secret' }, { modelIds: [] }, { modelIds: ['bad model'] }, { contextWindow: 0 }, { apiKey: 'key\nInjected: header' }, { provider: 'openai' }]) assert.throws(() => parseEndpoint(endpoint(extra)));
  await mkdir(join(directory, 'pi'), { recursive: true });
  const path = join(directory, 'pi/models.json'); await writeFile(path, 'invalid-json');
  await assert.rejects(saveEndpoint(runtime, directory, parseEndpoint(endpoint())), /models.json is invalid/);
  assert.equal(await readFile(path, 'utf8'), 'invalid-json');
});

test('server changes reject active chats and removed models, and refresh idle session bindings', async t => {
  const { directory, runtime } = await fixture(t);
  const host = new Host({ name: 'Phoenix', model: { provider: 'opencode-go', id: 'space-bunny-free' }, chats: [] }, directory, join(directory, 'workspace'));
  await host.initialize(); host.modelRuntime = runtime; t.after(() => host.close());
  await host.configureEndpoint(endpoint());
  const record = host.record('main'); record.model = { provider: 'ollama', id: 'test/model:latest' };
  let model = runtime.getModel('ollama', record.model.id);
  const chat = { pending: 1, session: { get model() { return model; }, async setModel(updated) { model = updated; }, abort() {}, dispose() {} }, queue: Promise.resolve() };
  host.loaded.set('main', chat);
  assert.throws(() => host.configureEndpoint(endpoint({ baseUrl: 'http://new-server/v1' })), /active chats/);
  chat.pending = 0;
  assert.throws(() => host.configureEndpoint(endpoint({ modelIds: ['replacement'] })), /before removing/);
  const updating = host.configureEndpoint(endpoint({ baseUrl: 'http://new-server/v1', vision: true }));
  assert.equal(host.providerUpdating, true);
  assert.throws(() => host.configureEndpoint(endpoint()), /provider changes/);
  await updating;
  assert.equal(host.providerUpdating, false); assert.equal(model.baseUrl, 'http://new-server/v1'); assert.deepEqual(model.input, ['text', 'image']);
});

test('real Pi streams local servers with tool calls, image inputs, compaction and restart', async t => {
  const { directory, create, runtime } = await fixture(t);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; const parsed = JSON.parse(body);
    requests.push({ path: request.url, auth: request.headers.authorization, session: request.headers['x-opencode-session'], body: parsed });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const invoke = parsed.tools?.length && !parsed.messages.some(message => message.role === 'tool');
    const delta = invoke ? { role: 'assistant', tool_calls: [{ index: 0, id: 'local-call', type: 'function', function: { name: 'local_echo', arguments: '{"text":"checked"}' } }] } : { role: 'assistant', content: 'Local server connected.' };
    response.write(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  let tools = 0;
  for (const provider of ['ollama', 'lmstudio', 'local']) {
    await saveEndpoint(runtime, directory, parseEndpoint(endpoint({ provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: provider === 'local' ? 'fixture-local-key' : '', vision: true })));
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { keepRecentTokens: 1, reserveTokens: 128 } });
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, settingsManager,
      extensionFactories: [openCodeSessionHeaders('local-session'), pi => pi.registerTool({ name: 'local_echo', label: 'Echo', description: 'Echo fixture', parameters: Type.Object({ text: Type.String() }), execute: async () => { tools++; return { content: [{ type: 'text', text: 'checked' }], details: {} }; } })] });
    await resourceLoader.reload();
    const sessionDir = join(directory, 'sessions', provider);
    const manager = SessionManager.continueRecent(directory, sessionDir);
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model: runtime.getModel(provider, 'test/model:latest'), resourceLoader, settingsManager, noTools: true, sessionManager: manager });
    try {
      await session.bindExtensions({ mode: 'sdk' });
      await session.prompt('Check the local server', { images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==' }] });
      await session.waitForIdle(); assert.equal(session.messages.at(-1).stopReason, 'stop');
      assert.ok(session.messages.some(message => message.role === 'toolResult' && message.toolName === 'local_echo'));
      await session.compact();
    } finally { session.dispose(); }
    const restored = await create();
    const { session: resumed } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: restored, model: restored.getModel(provider, 'test/model:latest'), resourceLoader, settingsManager, noTools: true, sessionManager: SessionManager.continueRecent(directory, sessionDir) });
    try { await resumed.bindExtensions({ mode: 'sdk' }); await resumed.prompt('After restart'); await resumed.waitForIdle(); assert.equal(resumed.model.provider, provider); assert.equal(resumed.messages.at(-1).stopReason, 'stop'); }
    finally { resumed.dispose(); }
  }
  assert.ok(tools >= 3);
  assert.ok(requests.every(request => request.path === '/v1/chat/completions' && request.session === undefined));
  assert.ok(requests.some(request => request.auth === 'Bearer fixture-local-key'));
  assert.ok(requests.some(request => JSON.stringify(request.body.messages).includes('image_url')));
  assert.ok(requests.every(request => request.body.store === undefined && request.body.max_completion_tokens === undefined));
});
