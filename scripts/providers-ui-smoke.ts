import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium } from 'patchright-core';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Host } from '../src/host.ts';
import { loadConfig } from '../src/config.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';

const data = await mkdtemp(join(tmpdir(), 'phoenix-providers-ui-'));
const host = new Host(await loadConfig('agent.json'), data, join(data, 'workspace')); await host.initialize();
host.auth = await createAuth(data, { password: 'provider-ui-fixture-password' });
host.modelRuntime = await ModelRuntime.create({ authPath: join(data, 'pi', 'auth.json'), modelsPath: join(data, 'pi', 'models.json') });
host.ui = { root: fileURLToPath(new URL('../web/', import.meta.url)), version: 'provider-fixture' };
let selected = host.modelRuntime.getModel(host.config.model.provider, host.config.model.id);
let thinking = 'off';
const chat = { pending: 0, error: '', session: { get model() { return selected; }, async setModel(model) { selected = model; }, setThinkingLevel(level) { thinking = level; }, get thinkingLevel() { return thinking; } },
  state: () => ({ name: 'Phoenix', revision: host.revision, model: selected, thinking, thinkingLevels: ['off', 'low', 'high'], configured: host.modelRuntime.hasConfiguredAuth(selected.provider), busy: false, steerable: false, current: '', tool: '', error: '', messages: [] }) };
host.getChat = async () => chat;
host.loaded.set('main', chat);
const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
const base = `http://127.0.0.1:${host.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, chromiumSandbox: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base); await page.getByLabel('Password', { exact: true }).fill('provider-ui-fixture-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#settings').click(); await page.getByLabel('Provider', { exact: true }).selectOption('openrouter');
  await page.getByLabel('API key', { exact: true }).fill('fixture-openrouter-ui-key'); await page.getByRole('button', { name: 'Save key', exact: true }).click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
  assert.equal(selected.provider, 'opencode-go', 'Adding a provider changed the chat model');
  const model = host.modelRuntime.getModels('openrouter').find(model => model.api === 'openai-completions' && model.id.includes('/'));
  await page.locator('#model').selectOption(`openrouter/${model.id}`);
  await page.locator('#key-banner').waitFor({ state: 'hidden' });
  assert.equal(selected.provider, 'openrouter'); assert.equal(selected.id, model.id);
  assert.equal(host.record('main').model.id, model.id);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(width > 700 ? '#settings' : '#mobile-settings').click();
    assert.equal(await page.getByLabel('Provider', { exact: true }).inputValue(), 'openrouter');
    assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('#provider-status').textContent(), 'Key configured');
    await page.getByLabel('API key', { exact: true }).fill('discard-this-provider-draft');
    await page.getByLabel('Provider', { exact: true }).selectOption('openai'); assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#settings').click();
  for (const [provider, port] of [['ollama', 11434], ['lmstudio', 1234], ['local', 8000]]) {
    await page.getByLabel('Provider', { exact: true }).selectOption(provider);
    assert.equal(await page.getByLabel('Server URL', { exact: true }).inputValue(), `http://host.docker.internal:${port}/v1`);
    assert.equal(await page.getByLabel('API key', { exact: true }).evaluate(input => input.required), false);
  }
  await page.getByLabel('Provider', { exact: true }).selectOption('ollama');
  await page.getByLabel('Server URL', { exact: true }).fill('http://model-host:11434/v1');
  await page.getByLabel('Model IDs', { exact: true }).fill('namespace/model:latest, other-model');
  await page.getByText('Model options', { exact: true }).click();
  await page.getByLabel('Images', { exact: true }).check();
  await page.getByLabel('Context tokens', { exact: true }).fill('16384');
  await page.getByRole('button', { name: 'Save server', exact: true }).click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
  assert.equal(selected.provider, 'openrouter', 'Saving a server changed the chat model');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/model') && response.request().postDataJSON().model.provider === 'ollama'), page.locator('#model').selectOption('ollama/namespace/model:latest')]);
  assert.equal(selected.provider, 'ollama'); assert.equal(selected.id, 'namespace/model:latest');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(width > 700 ? '#settings' : '#mobile-settings').click();
    assert.equal(await page.getByLabel('Server URL', { exact: true }).inputValue(), 'http://model-host:11434/v1');
    assert.equal(await page.getByLabel('Model IDs', { exact: true }).inputValue(), 'namespace/model:latest, other-model');
    assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('#provider-status').textContent(), 'Server configured');
    assert.equal(await page.getByLabel('Context tokens', { exact: true }).inputValue(), '16384');
    assert.equal(await page.getByLabel('Images', { exact: true }).isChecked(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#settings').click();
  await page.getByLabel('Server URL', { exact: true }).fill('http://new-model-host:11434/v1');
  await page.getByRole('button', { name: 'Save server', exact: true }).click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
  assert.equal(selected.baseUrl, 'http://new-model-host:11434/v1', 'Existing session kept its old server');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/model') && response.request().postDataJSON().model.provider === 'openrouter'), page.locator('#model').selectOption(`openrouter/${model.id}`)]);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#model').inputValue(), `openrouter/${model.id}`);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#settings').click();
  await page.getByLabel('API key', { exact: true }).fill('clear-on-logout-fixture');
  await page.locator('#logout').click(); await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('Provider UI passed: cloud keys, local server presets, optional keys, model options, idle session rebinding, namespaced models, draft clearing, logout, refresh and 320/390/1280px layouts. No paid API calls.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(data, { recursive: true, force: true }); }
