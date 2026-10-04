import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, loadConfig } from '../src/config.js';

test('default setup enables protected web and browser without a third-party tunnel; only OpenCode providers', async () => {
  const config = await loadConfig('agent.json');
  assert.equal(config.model.provider, 'opencode-go');
  assert.ok(config.extensions.auth);
  assert.ok(config.extensions.browser);
  assert.equal(config.extensions.tunnel, undefined);
  assert.equal(config.extensions.web.port, 8080);
  assert.throws(() => configSchema.parse({ ...config, model: { provider: 'openai', id: 'gpt-5' } }));
});
test('channel extensions fail closed without allowlists and secrets cannot be embedded', async () => {
  const config = await loadConfig('agent.json');
  for (const name of ['telegram', 'slack', 'discord']) {
    assert.throws(() => configSchema.parse({ ...config, extensions: { ...config.extensions, [name]: { allowUsers: [] } } }));
  }
  assert.throws(() => configSchema.parse({ ...config, apiKey: 'must-never-share' }));
  assert.throws(() => configSchema.parse({ ...config, extensions: { ...config.extensions, telegram: { allowUsers: ['123'], token: 'secret' } } }));
  assert.throws(() => configSchema.parse({ ...config, extensions: { ...config.extensions, tunnel: { mode: 'named' } } }));
});

test('direct web URL accepts a custom HTTPS port and rejects unsafe origins or a competing tunnel', async () => {
  const config = await loadConfig('agent.json');
  delete config.extensions.tunnel;
  config.extensions.web.url = 'https://203.0.113.10:24843';
  assert.equal(configSchema.parse(config).extensions.web.url, config.extensions.web.url);
  for (const url of ['http://203.0.113.10:24843', 'https://user:password@example.com', 'https://example.com/chat', 'https://example.com/?key=secret', 'https://example.com/#chat']) {
    assert.throws(() => configSchema.parse({ ...config, extensions: { ...config.extensions, web: { port: 8080, url } } }));
  }
  assert.throws(() => configSchema.parse({ ...config, extensions: { ...config.extensions, tunnel: { mode: 'quick' } } }));
});
