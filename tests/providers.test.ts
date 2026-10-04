import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { saveProviderKey, modelChoices, providerChoices } from '../src/models.ts';
import { configSchema } from '../src/config.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';
import { once } from 'node:events';

test('provider keys survive restart, stay separate, and replace both legacy OpenCode overrides', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-providers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, 'pi', 'auth.json');
  const create = () => ModelRuntime.create({ authPath, modelsPath: join(directory, 'models.json') });
  const runtime = await create();
  for (const provider of ['opencode', 'opencode-go']) await runtime.setRuntimeApiKey(provider, 'legacy-opencode-key');
  await Promise.all([saveProviderKey(runtime, 'openrouter', 'fixture-openrouter-key'), saveProviderKey(runtime, 'openai', 'fixture-openai-key')]);
  await saveProviderKey(runtime, 'opencode-go', 'new-shared-opencode-key');
  for (const current of [runtime, await create()]) {
    for (const [provider, key] of [['openrouter', 'fixture-openrouter-key'], ['openai', 'fixture-openai-key'], ['opencode', 'new-shared-opencode-key'], ['opencode-go', 'new-shared-opencode-key']]) {
      assert.equal((await current.getAuth(provider)).auth.apiKey, key);
      assert.equal(current.hasConfiguredAuth(provider), true);
    }
    const router = current.getModels('openrouter').find(model => model.id.includes('/'));
    assert.ok(modelChoices(current).some(model => model.provider === 'openrouter' && model.id === router.id));
    assert.equal(configSchema.parse({ model: { provider: 'openrouter', id: router.id }, extensions: {} }).model.id, router.id);
    assert.ok(!JSON.stringify(providerChoices(current)).includes('fixture-openrouter-key'));
  }
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  const before = await readFile(authPath);
  await assert.rejects(saveProviderKey(runtime, '../invalid', 'fixture-key'), /supported provider/);
  await assert.rejects(saveProviderKey(runtime, 'openrouter', '        '), /valid API key/);
  assert.deepEqual(await readFile(authPath), before);
});

test('provider key API requires owner login and CSRF, and never returns secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-provider-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json') });
  const auth = await createAuth(directory, { password: 'fixture-owner-password' });
  const host = { auth, modelRuntime, changed() {} };
  const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${host.port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const body = { provider: 'openrouter', apiKey: 'fixture-router-api-key' };
  assert.equal((await post('/api/provider', body)).status, 401);
  const login = await post('/api/login', { password: 'fixture-owner-password' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json(); const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  assert.equal((await post('/api/provider', body, { Cookie: cookie })).status, 403);
  assert.equal((await post('/api/provider', body, { ...headers, Origin: 'https://evil.example' })).status, 403);
  const preview = auth.preview();
  assert.equal((await post('/api/provider', body, { Cookie: `phoenix=${preview.token}`, 'X-CSRF-Token': preview.csrf })).status, 403);
  assert.equal((await post('/api/provider', { ...body, provider: 'unknown' }, headers)).status, 400);
  const saved = await post('/api/provider', body, headers); assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {});
  assert.equal((await modelRuntime.getAuth('openrouter')).auth.apiKey, body.apiKey);
});
