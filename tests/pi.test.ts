import test from 'node:test';
import { configureOpenCode, openCodeSessionHeaders, saveProviderKey } from '../src/models.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';

test('real Pi streams through Zen and Go APIs and restores separate histories', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-pi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, auth: request.headers.authorization || `Bearer ${request.headers['x-api-key']}`, session: request.headers['x-opencode-session'], agent: request.headers['user-agent'], body: JSON.parse(body) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (request.url.startsWith('/v1/messages')) {
      const events = [
        {type:'message_start', message:{id:'fixture',type:'message',role:'assistant',model:'minimax-m2.7',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello from the OpenCode fixture.'}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:8}},
        {type:'message_stop'},
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return response.end();
    }
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: JSON.parse(body).model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello from the OpenCode fixture.' }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const [provider, id] of [['opencode', 'big-pickle'], ['opencode-go', 'minimax-m2.7']]) {
    const agentDir = join(directory, provider); await mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
    configureOpenCode(modelRuntime);
    assert.ok(modelRuntime.getModels('opencode-go').length > 1);
    await modelRuntime.setRuntimeApiKey(provider, 'test-opencode-api-key');
    const model = { ...modelRuntime.getModel(provider, id), baseUrl: `http://127.0.0.1:${server.address().port}${provider === 'opencode-go' ? '' : '/v1'}` };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { keepRecentTokens: 1, reserveTokens: 128 } });
    const sessionDir = join(agentDir, 'sessions');
    const sessionManager = SessionManager.continueRecent(directory, sessionDir);
    const sessionId = sessionManager.getSessionId();
    let extensionStarted = false;
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => pi.on('session_start', () => { extensionStarted = true; }), openCodeSessionHeaders(sessionId)],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir, model, modelRuntime, settingsManager, resourceLoader,
      noTools: true, sessionManager });
    await session.bindExtensions({ mode: 'sdk' });
    assert.equal(extensionStarted, true);
    let streamed = '';
    session.subscribe(event => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') streamed += event.assistantMessageEvent.delta; });
    await session.prompt(`Hello ${provider}`);
    await session.waitForIdle();
    assert.equal(streamed, 'Hello from the OpenCode fixture.', JSON.stringify({provider, requests:requests.map(r=>r.path), messages:session.messages}));
    if (provider === 'opencode-go') {
      session.setThinkingLevel('high');
      assert.equal(session.thinkingLevel, 'high');
    }
    await session.setModel({ ...model, id: `${id}-switched` });
    await session.prompt('Second turn');
    await session.waitForIdle();
    await session.compact();
    session.dispose();
    const restoredManager = SessionManager.continueRecent(directory, sessionDir);
    assert.equal(restoredManager.getSessionId(), sessionId);
    await resourceLoader.reload();
    const { session: restored } = await createAgentSession({ cwd: directory, agentDir, model, modelRuntime, settingsManager, resourceLoader,
      noTools: true, sessionManager: restoredManager });
    await restored.bindExtensions({ mode: 'sdk' });
    await restored.prompt('After restart'); await restored.waitForIdle(); restored.dispose();
    const chatRequests = requests.filter(request => request.body.model === id || request.body.model === `${id}-switched`);
    assert.ok(chatRequests.length >= 4, 'Includes normal turns, compaction and restart');
    assert.ok(chatRequests.every(request => request.session === sessionId));
    assert.ok(chatRequests.every(request => request.agent === 'phoenix-agent/0.1.0'));
  }
  assert.deepEqual([...new Set(requests.map(request => request.path.split('?')[0]))], ['/v1/chat/completions', '/v1/messages']);
  assert.equal(new Set(requests.map(request => request.session)).size, 2, 'Separate chats have distinct IDs');
  assert.ok(requests.every(request => request.auth === 'Bearer test-opencode-api-key'));
});

test('real Pi accepts steering while streaming and sends it in the next model turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-pi-steer-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = []; let firstResponse; let entered;
  const first = new Promise(resolve => { entered = resolve; });
  const finish = (response, text) => {
    const chunk = { id: 'steer', object: 'chat.completion.chunk', created: 1, model: 'big-pickle', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`); chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; requests.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    if (requests.length === 1) { firstResponse = response; entered(); } else finish(response, 'Correction received.');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json') }); configureOpenCode(modelRuntime); await modelRuntime.setRuntimeApiKey('opencode', 'fixture-key');
  const model = { ...modelRuntime.getModel('opencode', 'big-pickle'), baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }); await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime, settingsManager, resourceLoader, noTools: true, sessionManager: SessionManager.inMemory(directory) });
  t.after(() => session.dispose()); await session.bindExtensions({ mode: 'sdk' });
  const running = session.prompt('Initial task', { expandPromptTemplates: false }); await first;
  assert.equal(session.isStreaming, true);
  await session.prompt('/literal correction', { streamingBehavior: 'steer', expandPromptTemplates: false });
  assert.equal(session.isStreaming, true); finish(firstResponse, 'Initial response.'); await running; await session.waitForIdle();
  assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1].messages), /\/literal correction/);
  assert.equal(session.messages.filter(message => message.role === 'user').length, 2);
});

test('real Pi streams OpenRouter and OpenAI with separate keys and namespaced models', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-pi-providers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ path: request.url, auth: request.headers.authorization, session: request.headers['x-opencode-session'], agent: request.headers['user-agent'], body: parsed });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (request.url.endsWith('/responses')) {
      const item = { id: 'message-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Provider connected.', annotations: [] }] };
      const events = [
        { type: 'response.created', response: { id: 'response-fixture' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'Provider connected.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return response.end();
    }
    const chunk = { id: 'provider-fixture', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Provider connected.' }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json') });
  for (const provider of ['openrouter', 'openai']) {
    await saveProviderKey(runtime, provider, `fixture-${provider}-key`);
    const source = runtime.getModels(provider).find(model => model.api === (provider === 'openai' ? 'openai-responses' : 'openai-completions') && (provider !== 'openrouter' || model.id.includes('/')));
    assert.ok(source); if (provider === 'openrouter') assert.equal(source.baseUrl, 'https://openrouter.ai/api/v1');
    const model = { ...source, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [openCodeSessionHeaders('fixture-conversation')] });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime: runtime, resourceLoader, noTools: true, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), sessionManager: SessionManager.inMemory(directory) });
    try {
      await session.bindExtensions({ mode: 'sdk' }); let text = '';
      session.subscribe(event => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') text += event.assistantMessageEvent.delta; });
      await session.prompt('Hello'); await session.waitForIdle();
      assert.equal(text, 'Provider connected.');
      const sent = requests.at(-1); assert.equal(sent.body.model, model.id);
      assert.equal(sent.auth, `Bearer fixture-${provider}-key`); assert.equal(sent.session, undefined);
      assert.equal(sent.agent, 'phoenix-agent/0.1.0'); assert.equal(sent.path, provider === 'openai' ? '/v1/responses' : '/v1/chat/completions');
    } finally { session.dispose(); }
  }
  assert.equal(requests.length, 2);
});
