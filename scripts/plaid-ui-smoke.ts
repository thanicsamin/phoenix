/* global document, window, sessionStorage */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright-core';
import { Host } from '../src/host.ts';
import { loadConfig } from '../src/config.ts';
import { Plaid } from '../src/plaid.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';

const data = await mkdtemp(join(tmpdir(), 'phoenix-plaid-ui-'));
const host = new Host(await loadConfig('agent.json'), data, join(data, 'workspace')); await host.initialize();
host.auth = await createAuth(data, { password: 'plaid-ui-fixture-password' });
const calls = []; let sequence = 0; let failExchange = false;
host.plaid = await Plaid.open(data, host.config.extensions.plaid, async (url, init) => {
  const body = JSON.parse(init.body); const path = new URL(url).pathname; calls.push({ path, body });
  if (path === '/item/public_token/exchange' && failExchange) return Response.json({ error_code: 'INTERNAL_SERVER_ERROR' }, { status: 500 });
  return Response.json(path === '/link/token/create' ? { link_token: `link-${++sequence}`, expiration: new Date(Date.now() + 3600000).toISOString() } : path === '/item/public_token/exchange' ? { item_id: `item-${sequence}`, access_token: `private-${sequence}` } : {});
});
// Only state is needed; this fixture never invokes a real model or bank.
host.state = async () => ({ revision: host.revision, chatId: 'main', name: 'Phoenix', pending: 0, messages: [], current: '', tool: '', error: '', extensions: { plaid: 'ready' }, model: { id: 'space-bunny-free', provider: 'opencode-go' }, hasKey: true, thinking: 'off', models: [], chats: [{ id: 'main', title: 'Main chat', pending: 0, notice: {} }], jobs: [], approvals: [], uiVersion: '', workspace: { app: 'phoenix' } });
const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
const base = `http://127.0.0.1:${host.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, chromiumSandbox: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; const violations = []; const external = [];
page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().includes('plaid.com')) external.push(request.url()); });
await page.addInitScript(() => { document.addEventListener('securitypolicyviolation', event => { window.fixtureViolations ||= []; window.fixtureViolations.push(event.violatedDirective); }); });
await page.route('https://cdn.plaid.com/link/v2/stable/link-initialize.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.Plaid = { create(options) {
  window.fixtureReceivedRedirect = options.receivedRedirectUri;
  const iframe = document.createElement('iframe'); iframe.title = 'Bank sign-in'; iframe.src = 'https://cdn.plaid.com/fixture'; document.body.append(iframe);
  const receive = event => { if (event.origin !== 'https://cdn.plaid.com') return; if(event.data === 'success') options.onSuccess('public-fixture', {institution:{name:'Fixture bank'}}); if(event.data === 'exit') options.onExit(null); };
  window.addEventListener('message', receive);
  return { open() {}, destroy() { iframe.remove(); window.removeEventListener('message', receive); } };
} };` }));
await page.route('https://cdn.plaid.com/fixture', route => route.fulfill({ contentType: 'text/html', body: `<button onclick="parent.postMessage('success', 'http://127.0.0.1:${host.port}')">Complete sign-in</button><button onclick="parent.postMessage('exit', 'http://127.0.0.1:${host.port}')">Cancel</button>` }));
const clickBank = async name => { await page.frameLocator('iframe[title="Bank sign-in"]').getByRole('button', { name, exact: true }).click(); };
try {
  await page.goto(base); await page.getByLabel('Password', { exact: true }).fill('plaid-ui-fixture-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#settings').click(); await page.getByText('Finances', { exact: true }).click(); assert.equal(external.length, 0, 'Plaid loaded before linking was requested');
  await page.getByLabel('Client ID', { exact: true }).fill('fixture-client'); await page.getByLabel('Secret', { exact: true }).fill('fixture-secret'); await page.getByRole('button', { name: 'Save Plaid credentials', exact: true }).click();
  await page.getByRole('button', { name: 'Connect bank', exact: true }).waitFor({ state: 'visible' }); assert.equal(await page.getByLabel('Secret', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Connect bank', exact: true }).click(); await clickBank('Cancel');
  await page.locator('#settings-dialog').waitFor({ state: 'visible' }); assert.equal(host.plaid.status().items.length, 0);
  await page.getByRole('button', { name: 'Connect bank', exact: true }).click(); await page.locator('#settings-dialog').waitFor({ state: 'hidden' }); assert.equal(await page.locator('#settings-dialog').isVisible(), false, 'Settings modal blocked the Plaid iframe');
  failExchange = true; await clickBank('Complete sign-in'); await page.getByRole('button', { name: 'Retry saving connection', exact: true }).waitFor({ state: 'visible' });
  assert.equal(host.plaid.status().items.length, 0); failExchange = false; await page.getByRole('button', { name: 'Retry saving connection', exact: true }).click();
  await page.locator('#plaid-items').getByText('Fixture bank', { exact: true }).waitFor({ state: 'visible' }); assert.equal(host.plaid.status().items.length, 1);
  assert.equal(await page.getByLabel('Client ID', { exact: true }).isDisabled(), true);
  const exchanges = calls.filter(call => call.path === '/item/public_token/exchange').length;
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await clickBank('Complete sign-in'); await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  assert.equal(calls.filter(call => call.path === '/item/public_token/exchange').length, exchanges); assert.ok(!('products' in calls.filter(call => call.path === '/link/token/create').at(-1).body));
  for (const width of [320, 390, 1280]) { await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); }
  await page.setViewportSize({ width: 390, height: 844 });
  // Simulate returning from a mobile OAuth bank page in the same tab.
  const session = await (await page.request.get(base + '/api/session')).json();
  const link = await (await page.request.post(base + '/api/plaid/link', { headers: { Origin: base, 'X-CSRF-Token': session.csrf }, data: { itemId: host.plaid.status().items[0].id } })).json();
  await page.evaluate(link => sessionStorage.setItem('phoenix-plaid-link', JSON.stringify(link)), link);
  await page.goto(base + '/?oauth_state_id=fixture-state'); await clickBank('Complete sign-in'); await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.fixtureReceivedRedirect, undefined, {}, false), base + '/?oauth_state_id=fixture-state'); assert.equal(new URL(page.url()).search, '');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#plaid-status').textContent.includes('0 connected'));
  assert.equal(host.plaid.status().items.length, 0); assert.ok(await page.locator('#plaid-items').textContent() === '');
  violations.push(...await page.evaluate(() => window.fixtureViolations || [], undefined, {}, false)); assert.deepEqual(violations, []); assert.deepEqual(errors, []);
  console.log('Plaid browser passed: lazy SDK, credential clearing, clickable bank iframe, cancellation, save retry, reconnect without a new Item, mobile OAuth return, disconnect and 320/390/1280px layouts. No live banks or model calls.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await host.close(); await rm(data, { recursive: true, force: true }); }
