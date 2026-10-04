import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Host } from '../src/host.js';
import browser from '../extensions/browser.js';
import { createAuth } from '../extensions/auth.js';
import { createWebServer } from '../extensions/web.js';
import { createLogger } from '../src/log.js';

const data = process.env.PHOENIX_TEST_DATA || '/data/browser-control-check'; await rm(data, { recursive: true, force: true }); await mkdir(data, { recursive: true });
const password = 'privateBrowserTest_92851'; let signedIn = false;
const website = createServer(async (request, response) => {
  if (request.url === '/framed') return response.end('<h1>Widget test</h1><iframe src="/verify"></iframe>');
  if (request.url === '/blocked') return response.end(`<h1>Verify you are human</h1><button id=verify onclick="this.textContent='Retry verification'">Verify</button>`);
  if (request.url === '/verify') return response.end(`<h1>Verify you are human</h1><button id=verify onclick="document.body.innerHTML='<h1>Verified</h1>'">Verify</button>`);
  if (request.method === 'POST' && request.url === '/login') {
    let body = ''; for await (const bytes of request) body += bytes;
    assert.equal(new URLSearchParams(body).get('password'), password); signedIn = true;
    response.writeHead(303, { Location: '/account', 'Set-Cookie': 'site-session=fixture; HttpOnly; SameSite=Strict; Path=/' }); return response.end();
  }
  if (request.url === '/account') return response.end(request.headers.cookie?.includes('site-session=fixture') ? '<h1>Signed in</h1><p>Your account is ready.</p>' : '<h1>Signed out</h1>');
  response.end('<html><body><h1>Sign in</h1><form method="post" action="/login"><label>Password <input type="password" name="password" autofocus autocomplete="current-password"></label><button>Sign in</button></form></body></html>');
});
website.listen(0, '127.0.0.1'); await once(website, 'listening');
const site = `http://127.0.0.1:${website.address().port}`;
const logs = []; const host = new EventEmitter();
Object.assign(host, { dataDir: data, extensions: {}, cleanups: [], approvals: new Map(), changed() { this.emit('change'); }, record(id) { assert.equal(id, 'main'); return { permissions: [] }; }, requestApproval: Host.prototype.requestApproval, approve: Host.prototype.approve, save: async () => {}, getChat: async () => chat });
host.auth = await createAuth(data, { password: 'browser-owner-fixture' });
const chat = { pending: 0 }; host.loaded = new Map([['main', chat]]);
let tool; const hooks = {};
browser({ on(name, handler) { hooks[name] = handler; }, registerTool(value) { tool = value; } }, host, { headless: process.env.PHOENIX_TEST_HEADLESS === '1' }, 'main');
const control = host.browserControls.get('main');
const server = createWebServer(host, createLogger('test', { write: line => logs.push(line) }));
server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
const base = `http://127.0.0.1:${host.port}`; const auth = await host.auth.login('browser-owner-fixture');
let socket;
try {
  await tool.execute('fixture', { action: 'navigate', url: site });
  const connect = async () => {
    const connection = new WebSocket(`ws://127.0.0.1:${host.port}/api/browser/socket`, { headers: { Origin: base, Cookie: `phoenix=${auth.token}` } });
    let frames = 0; let ready;
    const started = new Promise(resolve => { ready = resolve; });
    connection.on('message', (bytes, binary) => { if (binary) frames++; else { const message = JSON.parse(bytes); if (message.type === 'ready') ready(); assert.notEqual(message.type, 'error'); } });
    await once(connection, 'open'); connection.send(JSON.stringify({ type: 'start', chatId: 'main', csrf: auth.csrf, width: 800, height: 600 }));
    await Promise.race([started, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Viewer did not become ready')), 10000); timer.unref(); })]); return { socket: connection, frames: () => frames };
  };
  const viewer = await connect(); socket = viewer.socket;
  assert.equal(control.controlled, false);
  assert.equal(hooks.tool_call({ toolName: 'bash' }), undefined);
  await tool.execute('fixture', { action: 'snapshot' });
  await control.claim(control.socket, 800, 600);
  assert.equal(control.controlled, true); assert.equal(hooks.tool_call({ toolName: 'bash' }).block, true);
  for (let attempt = 0; attempt < 50 && !viewer.frames(); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(viewer.frames() > 0, 'Live Chromium JPEG frames received');
  socket.send(JSON.stringify({ type: 'text', text: password })); socket.send(JSON.stringify({ type: 'key', key: 'Enter' }));
  for (let attempt = 0; attempt < 50 && !signedIn; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(signedIn, true);
  const closed = once(socket, 'close'); socket.close(); await closed;
  for (let attempt = 0; attempt < 20 && control.socket; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(control.controlled, true); assert.equal(control.socket, undefined);
  socket = (await connect()).socket;
  const returned = await fetch(`${base}/api/browser/release`, { method: 'POST', headers: { Origin: base, Cookie: `phoenix=${auth.token}`, 'X-CSRF-Token': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'main' }) });
  assert.equal(returned.status, 200); assert.equal(control.controlled, false);
  const result = await tool.execute('fixture', { action: 'snapshot' }); assert.match(result.content[0].text, /Signed in/); assert.ok(!result.content[0].text.includes(password));
  assert.ok(!logs.join('').includes(password));
  const preferences = JSON.parse(await readFile(join(data, 'browser/main/Default/Preferences')));
  assert.equal(preferences.credentials_enable_service, false); assert.equal(preferences.profile.password_manager_enabled, false);
  await host.browserClosers.get('main')();
  const restored = await tool.execute('fixture', { action: 'navigate', url: `${site}/account` }); assert.match(restored.content[0].text, /Signed in/);
  // A half-completed login never appears in the agent's next page snapshot.
  await control.disconnect(socket); socket.terminate();
  socket = (await connect()).socket;
  await control.claim(control.socket, 800, 600);
  await control.input(control.socket, { type: 'navigate', url: site }); await control.input(control.socket, { type: 'text', text: password });
  await control.release();
  const clean = await tool.execute('fixture', { action: 'snapshot' }); assert.ok(!clean.content[0].text.includes(password));
  // The owner policy permits three interactions; inspection uses no attempts.
  const waitApproval = async () => { for (let i = 0; i < 100 && !host.approvals.size; i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(host.approvals.size, 1); return [...host.approvals.keys()][0]; };
  const retry = await tool.execute('fixture', { action: 'navigate', url: `${site}/verify` });
  assert.match(retry.content[0].text, /0 of 3 interactions completed; 3 remaining/); assert.equal(host.approvals.size, 0);
  const solved = await tool.execute('fixture', { action: 'click', selector: '#verify', durationMs: 150 }); assert.match(solved.content[0].text, /Verified/); assert.equal(solved.details.blocked, false);
  await tool.execute('fixture', { action: 'navigate', url: `${site}/blocked` });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await tool.execute('fixture', { action: 'snapshot' });
    const result = await tool.execute('fixture', { action: 'click', selector: '#verify' });
    assert.match(result.content[0].text, new RegExp(`${attempt} of 3 interactions completed; ${3 - attempt} remaining`)); assert.equal(host.approvals.size, 0);
  }
  const third = tool.execute('fixture', { action: 'click', selector: '#verify' });
  const id = await waitApproval(); assert.equal(host.approvals.get(id).args.attempts, 3);
  await host.approve(id, false); assert.match((await third).content[0].text, /No CAPTCHA attempt/);
  const deniedInteraction = tool.execute('fixture', { action: 'click', selector: '#verify' });
  await host.approve(await waitApproval(), false); assert.equal((await deniedInteraction).details.blocked, true);
  const abort = new AbortController(); chat.pending = 1;
  chat.session = { abort: async () => abort.abort(), waitForIdle: async () => {} };
  chat.submit = async () => {};
  const takingOver = tool.execute('fixture', { action: 'snapshot' }, abort.signal);
  const rejected = assert.rejects(takingOver, /abort/i); await waitApproval();
  await control.claim(control.socket, 800, 600); await rejected; chat.pending = 0;
  assert.ok(host.browserPages.get('main')().endsWith('/blocked'), 'Takeover preserved the challenge page');
  assert.equal(host.approvals.size, 0); await control.release();
  const approved = tool.execute('fixture', { action: 'snapshot' });
  await host.approve(await waitApproval(), true); assert.match((await approved).content[0].text, /0 of 3 interactions completed; 3 remaining/);
  const framed = await tool.execute('fixture', { action: 'navigate', url: `${site}/framed` });
  assert.match(framed.content[0].text, /Frame iframe/); assert.match(framed.content[0].text, /Verify you are human/);
  const framedSolved = await tool.execute('fixture', { action: 'click', frame: 'iframe', selector: '#verify' });
  assert.equal(framedSolved.details.blocked, false);
  await tool.execute('fixture', { action: 'wait', durationMs: 50 });
  console.log('Verification policy passed: three automatic interactions, inspection does not consume attempts, fresh consent after three failures, and takeover preserves the page.');
  console.log('Browser takeover passed: real frames/keyboard/login, session persistence, disconnect/reconnect, owner-only handback, password-manager off and password-free snapshots/logs.');
} finally {
  socket?.terminate(); await control.close(); await host.browserClosers.get('main')();
  for (const cleanup of host.cleanups.reverse()) await cleanup();
  host.auth.close(); server.closeWebSockets(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  website.closeAllConnections(); await new Promise(resolve => website.close(resolve));
}
