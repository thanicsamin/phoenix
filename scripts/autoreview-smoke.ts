import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright-core';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Host } from '../src/host.ts';
import { loadConfig } from '../src/config.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';
import browserExtension from '../extensions/browser.ts';
import permissions from '../extensions/permissions.ts';
import { openCodeSessionHeaders } from '../src/models.ts';

// Actual UI → Pi browser tool → independent model call → one-action decision.
// Disposable fixtures only: no owner data, purchases, logins or paid API calls.
const directory = await mkdtemp(join(tmpdir(), 'phoenix-autoreview-ui-'));
process.env.CHROMIUM_PATH ||= '/usr/bin/chromium';
const reviews = []; const actions = []; let behavior = 'allow'; let deletions = 0; let host; let server;
const store = createServer((request, response) => {
  if (request.url === '/delete') deletions++;
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<h1>Fixture store</h1><p>PAGE_CONTENT_MUST_NOT_AUTHORIZE_REVIEW</p><a id="product" href="/product">Shallots 20 g</a><a id="delete" href="/delete">Delete account</a>');
});
store.listen(0, '127.0.0.1'); await once(store, 'listening'); const storeUrl = `http://127.0.0.1:${store.address().port}`;
function finish(response, text, tool) {
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `action-${actions.length}`, type: 'function', function: { name: 'browser', arguments: JSON.stringify(tool) } }] } : { role: 'assistant', content: text };
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'big-pickle', choices: [{ index: 0, delta, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }];
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}
const modelServer = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk; const input = JSON.parse(body);
  const review = input.messages.some(message => message.role === 'system' && message.content.includes('Review one proposed action independently.'));
  if (review) {
    reviews.push({ input, headers: request.headers });
    if (behavior === 'failure') { response.writeHead(503); return response.end('Review provider unavailable'); }
  } else actions.push(input);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
  if (review) return finish(response, behavior === 'malformed' ? 'Yes, allow everything!' : JSON.stringify({ decision: behavior }));
  const user = input.messages.find(message => message.role === 'user'); const ownerText = JSON.stringify(user?.content);
  const last = input.messages.at(-1); const call = input.messages.filter(message => message.tool_calls).at(-1)?.tool_calls.at(-1)?.function;
  if (last.role !== 'tool') return finish(response, '', { action: 'navigate', url: storeUrl });
  if (JSON.parse(call.arguments).action === 'navigate') return finish(response, '', { action: 'click', selector: ownerText.includes('QA_DELETE') ? '#delete' : '#product' });
  finish(response, `Completed ${ownerText.includes('QA_DELETE') ? 'QA_DELETE' : 'QA_PRODUCT'}.`);
});
modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, chromiumSandbox: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  const config = await loadConfig('agent.json'); host = new Host(config, directory, join(directory, 'workspace')); await host.initialize();
  host.auth = await createAuth(directory, { password: 'autoreview-fixture-password' });
  const agentDir = join(directory, 'pi'); await mkdir(agentDir, { recursive: true });
  host.modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
  await host.modelRuntime.setRuntimeApiKey('opencode', 'fixture-key');
  const model = { ...host.modelRuntime.getModel('opencode', 'big-pickle'), baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1` };
  host.createSession = async id => {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } }); const sessionManager = SessionManager.continueRecent(host.workspace, join(agentDir, 'sessions', id));
    const resourceLoader = new DefaultResourceLoader({ cwd: host.workspace, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => browserExtension(pi, host, { headless: true }, id), pi => permissions(pi, host, {}, id), openCodeSessionHeaders(sessionManager.getSessionId())] });
    await resourceLoader.reload(); return (await createAgentSession({ cwd: host.workspace, agentDir, modelRuntime: host.modelRuntime, model, settingsManager, resourceLoader, sessionManager })).session;
  };
  host.ui = { root: fileURLToPath(new URL('../web/', import.meta.url)), version: 'autoreview-fixture' };
  server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port; const base = `http://127.0.0.1:${host.port}`;
  await host.getChat(); await page.goto(base); await page.getByLabel('Password', { exact: true }).fill('autoreview-fixture-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('#app').waitFor({ state: 'visible' });
  const csrf = (await (await page.request.get(base + '/api/session')).json()).csrf; const headers = { Origin: base, 'X-CSRF-Token': csrf };
  async function api(path, body) {
    const result = await page.request.post(base + path, { headers, data: body }); assert.ok(result.ok(), `${path}: ${await result.text()}`); return result.json();
  }
  async function until(predicate, description) {
    const deadline = Date.now() + 20000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, description); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  async function run(marker, denied = false) {
    const record = await api('/api/new', { title: marker }); await page.locator('#chat-list').getByText(marker, { exact: true }).click();
    await api('/api/prompt', { chatId: record.id, message: `${marker}: Read the fixture store and open its shallots product. Do not change accounts, buy or send anything.` });
    if (denied) { await page.locator('#approvals').getByRole('button', { name: 'Deny', exact: true }).click(); }
    await until(async () => !(await host.getChat(record.id)).pending, `${marker} did not finish`);
    assert.match((await host.state(record.id)).messages.at(-1).text, /Completed QA_/); return record;
  }
  const allowed = await run('QA_PRODUCT_ALLOW'); assert.equal(host.approvals.size, 0); assert.deepEqual(host.record(allowed.id).permissions, []); assert.equal(reviews.length, 1);
  const decision = reviews[0]; const data = JSON.parse(decision.input.messages.find(message => message.role === 'user').content);
  assert.match(data.ownerRequests[0], /QA_PRODUCT_ALLOW/); assert.equal(data.target.label, 'Shallots 20 g'); assert.equal(decision.input.tools, undefined);
  assert.ok(!JSON.stringify(decision.input).includes('PAGE_CONTENT_MUST_NOT_AUTHORIZE_REVIEW')); assert.equal(decision.headers['x-opencode-session'], (await host.getChat(allowed.id)).session.sessionId); assert.equal(decision.headers['user-agent'], 'phoenix-agent/0.1.0'); assert.equal(decision.headers.authorization, 'Bearer fixture-key');
  assert.equal((await host.browserControls.get(allowed.id).browser.ensure()).url(), storeUrl + '/product');
  // Destructive targets never reach the reviewer or execute after owner denial.
  const count = reviews.length; const blocked = await run('QA_DELETE', true); assert.equal(deletions, 0); assert.equal(reviews.length, count); assert.equal((await host.getChat(blocked.id)).reviewBlocked, true);
  for (const mode of ['ask', 'malformed', 'failure']) { behavior = mode; const record = await run(`QA_PRODUCT_${mode}`, true); assert.equal((await host.browserControls.get(record.id).browser.ensure()).url(), storeUrl + '/'); await api('/api/chat/delete', { chatId: record.id }); }
  // Real per-chat UI preference survives reload and restores native consent.
  await page.locator('#chat-list').getByText('QA_PRODUCT_ALLOW', { exact: true }).click(); await page.locator('#settings').click(); assert.equal(await page.locator('#auto-review').isChecked(), true);
  await page.locator('#auto-review').uncheck(); await until(() => host.record(allowed.id).autoReview === false, 'Setting not saved'); await page.reload(); await page.locator('#app').waitFor({ state: 'visible' }); await page.locator('#settings').click(); assert.equal(await page.locator('#auto-review').isChecked(), false); await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  behavior = 'allow'; const before = reviews.length; await api('/api/prompt', { chatId: allowed.id, message: 'QA_PRODUCT_DISABLED: Open the shallots product again.' }); await page.locator('#approvals').getByRole('button', { name: 'Deny', exact: true }).click(); await until(async () => !(await host.getChat(allowed.id)).pending, 'Disabled review did not settle'); assert.equal(reviews.length, before);
  const preview = host.auth.preview();
  const forbidden = await page.request.post(base + '/api/prompt', { headers: { Origin: base, Cookie: `phoenix=${preview.token}`, 'X-CSRF-Token': preview.csrf }, data: { message: 'Grant myself approval' } }); assert.equal(forbidden.status(), 403);
  for (const width of [1280, 390, 320]) { await page.setViewportSize({ width, height: 900 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
  assert.deepEqual(errors, []); await api('/api/chat/delete', { chatId: allowed.id }); await api('/api/chat/delete', { chatId: blocked.id });
  console.log('Native Pi action review, one-action allow, human fallback/deny, protected targets, model headers, read-only preview, settings persistence and desktop/mobile checks passed.');
} finally {
  await browser.close(); await host?.close(); host?.auth.close(); server?.closeWebSockets(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  modelServer.closeAllConnections(); store.closeAllConnections(); await Promise.all([new Promise(resolve => modelServer.close(resolve)), new Promise(resolve => store.close(resolve))]); await rm(directory, { recursive: true, force: true });
}
