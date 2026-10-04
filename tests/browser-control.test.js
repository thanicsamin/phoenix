import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import permissions from '../extensions/permissions.js';
import { BrowserControl } from '../src/browser-control.js';
import { Chat, Host } from '../src/host.js';
import { createAuth } from '../extensions/auth.js';
import { createWebServer } from '../extensions/web.js';

function fixture() {
  const page = new EventEmitter(); const inputs = []; let viewport = { width: 800, height: 600 };
  const cdp = new EventEmitter(); cdp.send = async () => {}; cdp.detach = async () => {};
  Object.assign(page, { context: () => ({ newCDPSession: async () => cdp }), url: () => 'https://example.com/path?private=secret',
    viewportSize: () => viewport, setViewportSize: async size => { viewport = size; }, bringToFront: async () => {},
    keyboard: { insertText: async text => inputs.push(text), press: async key => inputs.push(key) }, mouse: { click: async () => {}, wheel: async () => {} } });
  const host = { changed() {}, loaded: new Map(), approvals: new Map() }; let cleared = 0;
  const control = new BrowserControl(host, 'main', { ensure: async () => page, use() {}, idle() {}, close: async () => {}, clearSecrets: async () => { cleared++; } });
  const socket = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  return { host, control, socket, inputs, page, cleared: () => cleared };
}

test('takeover pauses queued model work; disconnect stays paused and handback clears secrets first', async () => {
  const { host, control, socket, inputs, cleared } = fixture();
  const chat = new Chat({}, '/tmp', '/tmp'); chat.browserControl = control;
  const prompts = [];
  chat.attach({ messages: [], subscribe: () => () => {}, prompt: async text => prompts.push(text), waitForIdle: async () => {} });
  host.loaded.set('main', chat);
  await control.claim(socket, 800, 600);
  const queued = chat.submit('Queued owner task'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prompts, []);
  await control.input(socket, { type: 'text', text: 'private-login-password' });
  await control.disconnect(socket); assert.equal(control.state().controlled, true); assert.equal(control.state().connected, false);
  assert.deepEqual(prompts, []); assert.deepEqual(chat.session.messages, []);
  await assert.rejects(chat.steer('Correction'), /Return browser control/);
  await control.release(); await queued; await chat.queue;
  assert.equal(cleared(), 1); assert.deepEqual(prompts, ['Queued owner task']); assert.deepEqual(inputs, ['private-login-password']);
  await control.close();
});

test('takeover aborts active work before opening the page and resumes only on explicit handback', async () => {
  const { host, control, socket } = fixture(); const events = [];
  host.loaded.set('main', { pending: 1, session: { abort: async () => events.push('abort'), waitForIdle: async () => events.push('idle') }, submit: async text => events.push(text) });
  const ensure = control.browser.ensure; control.browser.ensure = async () => { events.push('open'); return ensure(); };
  await control.claim(socket, 800, 600);
  assert.deepEqual(events, ['abort', 'idle', 'open']);
  await assert.rejects(control.claim({}, 800, 600), /another window/);
  await control.disconnect(socket); assert.equal(events.length, 3);
  host.loaded.get('main').pending = 0; await control.release();
  assert.match(events[3], /Continue the previous task/); await control.close();
});

test('viewing preserves active work and viewport; takeover and handback keep the live viewer connected', async () => {
  const { host, control, socket, page, cleared } = fixture(); let aborted = 0;
  host.loaded.set('main', { pending: 1, session: { abort: async () => aborted++, waitForIdle: async () => {} } });
  await control.view(socket, 320, 700);
  assert.equal(aborted, 0); assert.equal(control.controlled, false);
  assert.deepEqual(page.viewportSize(), { width: 800, height: 600 });
  assert.throws(() => control.input(socket, { type: 'text', text: 'ignored' }), /control has ended/);
  await control.claim(socket, 400, 700); assert.equal(aborted, 1);
  assert.deepEqual(page.viewportSize(), { width: 400, height: 700 });
  await control.disconnect(socket); await control.view(socket, 320, 650);
  assert.deepEqual(page.viewportSize(), { width: 320, height: 650 }); assert.equal(aborted, 1);
  host.loaded.get('main').pending = 0; host.loaded.get('main').submit = async () => {};
  await control.release(); assert.equal(cleared(), 1);
  assert.equal(control.controlled, false); assert.equal(control.socket, socket); assert.ok(control.cdp);
  await control.claim(socket, 400, 700); assert.equal(control.controlled, true);
  await control.close();
});

test('failed secret cleanup leaves browser paused and viewer connected', async () => {
  const { control, socket } = fixture(); await control.claim(socket, 800, 600);
  control.browser.clearSecrets = async () => { throw Error('Private failure'); };
  await assert.rejects(control.release(), /Could not clear login fields/);
  assert.equal(control.controlled, true); assert.equal(control.socket, socket); assert.equal(control.releasing, false);
  await control.close();
});

test('Stop cancels messages waiting on human control without unlocking the browser', async () => {
  const { control, socket } = fixture(); await control.claim(socket, 800, 600);
  const chat = new Chat({}, '/tmp', '/tmp'); chat.browserControl = control;
  chat.attach({ messages: [], subscribe: () => () => {}, prompt: async () => assert.fail('Cancelled model request ran') });
  const queued = chat.submit('Cancel me'); const rejected = assert.rejects(queued, /Request cancelled/);
  await new Promise(resolve => setImmediate(resolve)); chat.cancelQueued(); await rejected; await chat.queue;
  assert.equal(chat.pending, 0); assert.equal(control.controlled, true); await control.close();
});

test('browser socket rejects missing auth, foreign origins, preview sessions and missing CSRF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-browser-socket-'));
  const host = { ...fixture().host, auth: await createAuth(directory, { password: 'browser-socket-password' }), cleanups: [],
    record: id => { if (id !== 'main') throw Error('Unknown chat'); }, getChat: async id => { if (id !== 'main') throw Error('Unknown chat'); } };
  let claims = 0; let views = 0; let releases = 0; const inputs = [];
  const control = { controlled: false, view: async socket => { views++; control.socket = socket; socket.send(JSON.stringify({ type: 'ready', controlled: false })); }, claim: async socket => { claims++; control.controlled = true; socket.send(JSON.stringify({ type: 'ready', controlled: true })); await new Promise(resolve => setTimeout(resolve, 40)); }, input: async (_socket, data) => { if (!control.controlled) throw Error('View only'); inputs.push(data); }, disconnect: async () => {}, release: async () => { releases++; } };
  host.browserControls = new Map([['main', control]]);
  const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
  t.after(async () => { for (const cleanup of host.cleanups) await cleanup(); server.closeWebSockets(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${host.port}`; const url = `ws://127.0.0.1:${host.port}/api/browser/socket`;
  const auth = await host.auth.login('browser-socket-password'); const preview = host.auth.preview();
  for (const headers of [{ Origin: origin }, { Origin: 'https://evil.example', Cookie: `phoenix=${auth.token}` }, { Origin: origin, Cookie: `phoenix=${preview.token}` }]) {
    const denied = new WebSocket(url, { headers }); assert.match((await once(denied, 'error'))[0].message, /403/);
  }
  const handback = (cookie, csrf, requestOrigin = origin) => fetch(origin + '/api/browser/release', { method: 'POST', headers: { Origin: requestOrigin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'main' }) });
  assert.equal((await handback('', '')).status, 401);
  assert.equal((await handback(`phoenix=${auth.token}`, '')).status, 403);
  assert.equal((await handback(`phoenix=${auth.token}`, auth.csrf, 'https://evil.example')).status, 403);
  assert.equal((await handback(`phoenix=${preview.token}`, preview.csrf)).status, 403);
  assert.equal(releases, 0);
  assert.equal((await handback(`phoenix=${auth.token}`, auth.csrf)).status, 200); assert.equal(releases, 1);
  const open = async () => { const socket = new WebSocket(url, { headers: { Origin: origin, Cookie: `phoenix=${auth.token}` } }); await once(socket, 'open'); return socket; };
  for (const extra of [{ csrf: '' }, { csrf: auth.csrf, chatId: 'other' }, { csrf: auth.csrf, width: 4000 }]) {
    const socket = await open(); const closed = once(socket, 'close'); socket.send(JSON.stringify({ type: 'start', chatId: 'main', width: 800, height: 600, ...extra }));
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(claims, 0);
  const socket = await open(); const ready = once(socket, 'message'); socket.send(JSON.stringify({ type: 'start', chatId: 'main', csrf: auth.csrf, width: 800, height: 600 }));
  assert.equal(JSON.parse((await ready)[0]).controlled, false); assert.equal(claims, 0); assert.equal(views, 1);
  const deniedInput = once(socket, 'message'); socket.send(JSON.stringify({ type: 'text', text: 'must-not-type' }));
  assert.equal(JSON.parse((await deniedInput)[0]).type, 'error'); assert.equal(inputs.length, 0);
  const taken = once(socket, 'message'); socket.send(JSON.stringify({ type: 'take' }));
  assert.equal(JSON.parse((await taken)[0]).controlled, true); assert.equal(claims, 1);
  socket.send(JSON.stringify({ type: 'text', text: 'private-login-input' })); await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(inputs[0].text, 'private-login-input');
  host.auth.logout(auth.token); const closed = once(socket, 'close'); socket.send(JSON.stringify({ type: 'key', key: 'Enter' })); assert.equal((await closed)[0], 1008);
});


test('verification approval is one-time, clears on stop, and cannot be remembered', async () => {
  const permissions = ['browser_verification'];
  const host = Object.assign(Object.create(Host.prototype), { approvals: new Map(), record: () => ({ permissions }), changed() {}, save: async () => assert.fail('Verification permission was saved') });
  const first = host.requestApproval('main', 'browser_verification', { site: 'https://example.com' });
  assert.equal(host.approvals.size, 1);
  await host.approve([...host.approvals.keys()][0], true, true); assert.equal(await first, true);
  const controller = new AbortController();
  const second = host.requestApproval('main', 'browser_verification', {}, controller.signal);
  assert.equal(host.approvals.size, 1); controller.abort(); assert.equal(await second, false); assert.equal(host.approvals.size, 0);
  const third = host.requestApproval('main', 'browser_verification', {});
  await host.approve([...host.approvals.keys()][0], false); assert.equal(await third, false);
});


test('CAPTCHA consent replaces a duplicate click approval, but never other website or send approvals', async () => {
  let hook; let consent = true; const approvals = [];
  const host = { extensions: {}, getChat: async () => ({ source: 'web' }), browserPages: new Map([['main', () => 'https://example.com']]), browserControls: new Map([['main', { verificationAllowed: async () => consent }]]), requestApproval: async (_id, name) => { approvals.push(name); return true; } };
  permissions({ on: (_event, handler) => { hook = handler; } }, host, {});
  await hook({ toolName: 'browser', input: { action: 'click' } }); assert.deepEqual(approvals, []);
  await hook({ toolName: 'email_send', input: {} }); assert.deepEqual(approvals, ['email_send']);
  consent = false; await hook({ toolName: 'browser', input: { action: 'click' } }); assert.deepEqual(approvals, ['email_send', 'browser']);
});
