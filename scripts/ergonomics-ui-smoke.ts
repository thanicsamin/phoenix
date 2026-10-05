/* global document, innerWidth, ClipboardEvent, ClipboardItem, DataTransfer */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'patchright-core';
import { Host } from '../src/host.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';
import browserExtension from '../extensions/browser.ts';
import filesExtension from '../extensions/files.ts';
import { loadConfig } from '../src/config.ts';

// Real HTTP, WebSockets, storage, rendering and Chromium; deterministic model
// fixture keeps queue timing reproducible and never sends QA files to a provider.
const data = await mkdtemp(join(tmpdir(), 'phoenix-ergonomics-'));
const host = new Host(await loadConfig('agent.json'), data, join(data, 'workspace')); await host.initialize();
host.auth = await createAuth(data, { password: 'ergonomics-fixture-password' });
const sessions = new Map(); const tools = new Map();
host.createSession = async id => {
  const emitter = new EventEmitter(); let release; const hooks = {};
  const session = {
    model: { provider: 'opencode-go', id: 'space-bunny-free', input: ['text', 'image'] }, thinkingLevel: 'off', messages: [], isStreaming: false,
    modelRuntime: { hasConfiguredAuth: () => true }, subscribe: handler => { emitter.on('event', handler); return () => emitter.off('event', handler); },
    bindExtensions: async () => { await hooks.session_start?.(); }, waitForIdle: async () => {}, dispose() {}, abort: async () => { session.aborts++; release?.(); }, aborts: 0,
    prompt: async (text, options) => {
      if (options.streamingBehavior === 'steer') return;
      session.isStreaming = true; session.messages.push({ role: 'user', content: text }); emitter.emit('event', { type: 'message_start', message: session.messages.at(-1) });
      if (text.startsWith('Hold')) await new Promise(resolve => { release = resolve; });
      session.messages.push({ role: 'assistant', content: 'Fixture reply.' }); session.isStreaming = false;
      emitter.emit('event', { type: 'message_end', message: session.messages.at(-1) });
    },
    finish: () => release?.(),
  };
  sessions.set(id, session);
  const pi = { on: (name, handler) => { hooks[name] = handler; }, registerTool: tool => { const registered = tools.get(id) || {}; registered[tool.name] = tool; tools.set(id, registered); } };
  browserExtension(pi, host, { headless: true }, id); filesExtension(pi, host, {}, id);
  return session;
};
const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
const base = `http://127.0.0.1:${host.port}`;
const website = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Live browser fixture</h1><input type=password aria-label=Password>'); });
website.listen(0, '127.0.0.1'); await once(website, 'listening');
const chromiumBrowser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, chromiumSandbox: false });
const context = await chromiumBrowser.newContext({ viewport: { width: 1280, height: 900 } });
await context.grantPermissions(['notifications', 'clipboard-read', 'clipboard-write'], { origin: base });
const page = await context.newPage(); const errors = []; const requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
let headers; let chatId;
async function api(path, body) {
  const response = await page.request.fetch(base + path, { headers, ...(body === undefined ? {} : { method: 'POST', data: body }) });
  const result = await response.json(); assert.ok(response.ok(), result.error); return result;
}
let png;
// Small valid first-page PDF, with offsets generated instead of a binary fixture.
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const stream = 'BT /F1 20 Tf 25 100 Td (Phoenix preview) Tj ET'; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
let pdfText = '%PDF-1.4\n'; const offsets = [0];
objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdfText)); pdfText += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdfText); pdfText += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
try {
  await page.goto(base); await page.getByLabel('Password', { exact: true }).fill('ergonomics-fixture-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#app').waitFor({ state: 'visible' }); headers = { Origin: base, 'X-CSRF-Token': (await api('/api/session')).csrf };
  png = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 128; const context = canvas.getContext('2d'); context.fillStyle = '#526e52'; context.fillRect(0, 0, 192, 128); context.fillStyle = '#fbfaf7'; context.beginPath(); context.moveTo(28, 30); context.lineTo(158, 50); context.lineTo(64, 100); context.closePath(); context.fill(); return canvas.toDataURL('image/png').split(',')[1]; }), 'base64');
  const chat = await api('/api/new', { title: 'Ergonomics QA' }); chatId = chat.id;
  await page.locator('#chat-list').getByRole('button', { name: chat.title, exact: true }).click();
  assert.ok(!requests.some(url => url.includes('/vendor/pdfjs/')), 'PDF renderer was loaded with no PDFs');
  // Holding the real response reproduces repeated Enter while a send is pending.
  let promptRequests = 0; let releasePrompt; let promptReceived;
  const promptGate = new Promise(resolve => { releasePrompt = resolve; });
  const receivedPrompt = new Promise(resolve => { promptReceived = resolve; });
  const holdPrompt = async route => {
    promptRequests++; const response = await route.fetch(); promptReceived();
    await promptGate; await route.fulfill({ response });
  };
  await page.route('**/api/prompt', holdPrompt);
  try {
    await page.locator('#message').fill('One keyboard submission'); await page.locator('#message').press('Enter');
    await receivedPrompt;
    await page.locator('#message').press('Enter'); await page.locator('#message').press('Enter');
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.locator('#message').fill('Draft typed while waiting');
  } finally { releasePrompt(); await page.unrouteAll({ behavior: 'wait' }); }
  assert.equal(promptRequests, 1, 'Repeated Enter submitted duplicate messages');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  assert.equal(await page.locator('#message').inputValue(), 'Draft typed while waiting');
  // A failed send leaves the draft available and releases the guard for retry.
  await page.route('**/api/prompt', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture temporary failure' }) }), { times: 1 });
  await page.locator('#message').press('Enter');
  await page.locator('#agent-error').getByText('Fixture temporary failure', { exact: true }).waitFor();
  assert.equal(await page.locator('#message').inputValue(), 'Draft typed while waiting');
  await page.locator('#message').press('Enter');
  await page.waitForFunction(() => document.querySelector('#message').value === '');
  assert.equal(sessions.get(chatId).messages.filter(message => message.role === 'user' && message.content === 'One keyboard submission').length, 1);
  // Native clipboard path: actual Ctrl+V of an image, then ordinary text paste.
  await page.evaluate(async bytes => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]); }, [...png]);
  await page.locator('#message').focus(); await page.keyboard.press('Control+v');
  await page.getByLabel('Remove image.png', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#draft-files img')?.naturalWidth > 0);
  await page.evaluate(() => navigator.clipboard.writeText('Ordinary pasted text')); await page.keyboard.press('Control+v');
  assert.equal(await page.locator('#message').inputValue(), 'Ordinary pasted text');
  // Pasted file path (clipboard FileList), and PDF file picker.
  await page.locator('#message').evaluate(element => { const data = new DataTransfer(); data.items.add(new File(['pasted bytes'], 'pasted.txt', { type: 'text/plain' })); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
  await page.getByLabel('Remove pasted.txt', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('#attachment-files').setInputFiles({ name: 'preview.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfText) });
  await page.waitForFunction(() => [...document.querySelectorAll('#draft-files img')].some(image => image.dataset.pdf && image.src.startsWith('blob:') && image.naturalWidth > 0));
  assert.ok(requests.some(url => url.includes('/vendor/pdfjs/pdf.worker.mjs')));
  assert.ok(!requests.some(url => url.includes('/api/files/preview')), 'Server-side PDF preview requested');
  await page.locator('#message').fill('Hold current task'); await page.locator('#send').click();
  await page.locator('#message').fill('Original queued text'); await page.locator('#send').click();
  await page.locator('.message[data-queue-id]').waitFor({ state: 'visible' });
  await page.locator('#message').press('ArrowUp'); assert.equal(await page.locator('#message').inputValue(), 'Original queued text');
  await page.locator('#message').fill('Edited with arrow'); await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
  await page.locator('.message[data-queue-id]').getByText('Edited with arrow', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('#message').fill('Preserve my draft');
  await page.locator('.message[data-queue-id]').click({ button: 'right' });
  assert.equal(await page.locator('#message').inputValue(), 'Edited with arrow');
  await page.getByRole('button', { name: 'Cancel editing queued message', exact: true }).click(); assert.equal(await page.locator('#message').inputValue(), 'Preserve my draft');
  await page.locator('.message[data-queue-id]').click({ button: 'right' });
  // A slow save must preserve text and uploads created after it was submitted.
  for (const change of ['text', 'file']) {
    let releaseEdit; let editReceived;
    const editGate = new Promise(resolve => { releaseEdit = resolve; });
    const receivedEdit = new Promise(resolve => { editReceived = resolve; });
    await page.route('**/api/queue/edit', async route => {
      const response = await route.fetch(); editReceived(); await editGate; await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: 'Save queued message', exact: true }).click(); await receivedEdit;
      if (change === 'text') await page.locator('#message').fill('Still writing the queued edit');
      else {
        await page.locator('#attachment-files').setInputFiles({ name: 'late-upload.png', mimeType: 'image/png', buffer: png });
        await page.getByLabel('Remove late-upload.png', { exact: true }).waitFor();
      }
    } finally { releaseEdit(); await page.unrouteAll({ behavior: 'wait' }); }
    await page.waitForFunction(() => !document.querySelector('#send').disabled);
    assert.equal(await page.locator('#message').inputValue(), 'Still writing the queued edit', `Late ${change} change erased by save`);
    assert.equal(await page.locator('#queue-edit').isVisible(), true);
    if (change === 'file') assert.equal(await page.getByLabel('Remove late-upload.png', { exact: true }).count(), 1);
  }
  // Failure keeps unsaved text/files and does not advance the queue version.
  await page.route('**/api/queue/edit', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture queued edit failure' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
  await page.locator('#agent-error').getByText('Fixture queued edit failure', { exact: true }).waitFor();
  assert.equal(await page.locator('#message').inputValue(), 'Still writing the queued edit');
  assert.equal(await page.getByLabel('Remove late-upload.png', { exact: true }).count(), 1);
  // Successive saves use the new version; an unchanged save restores the old draft.
  await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#message').value === 'Preserve my draft');
  await page.locator('.message[data-queue-id]').getByText('Still writing the queued edit', { exact: true }).waitFor();
  await page.locator('.message[data-queue-id]').getByText('late-upload.png', { exact: true }).waitFor();
  await page.locator('.message[data-queue-id]').click({ button: 'right' });
  await page.getByLabel('Remove late-upload.png', { exact: true }).click();
  await page.locator('#message').fill('Final queued text'); await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#message').value === 'Preserve my draft');
  const session = sessions.get(chatId); session.finish(); await host.loaded.get(chatId).queue;
  assert.equal(session.messages.filter(message => message.role === 'user').at(-1).content, 'Final queued text');
  // Agent attachment and Markdown image both render inline.
  await writeFile(join(host.workspace, 'answer.png'), png);
  const artifact = await tools.get(chatId).attach_file.execute('fixture', { path: 'answer.png' });
  session.messages.push({ role: 'toolResult', toolName: 'attach_file', details: artifact.details }, { role: 'assistant', content: `Here is the image.\n![Inline answer](/api/files/image?chat=${chatId}&id=${artifact.details.attachment.id})` }); host.changed();
  await page.waitForFunction(() => document.querySelector('.message.assistant .markdown img')?.naturalWidth > 0);

  session.messages.push({ role: 'assistant', content: '| Product | Item | Shipping | Total |\n| --- | --- | --- | --- |\n| [Shallots, 20 g](https://shop.example/products/shallots?size=20&ref=compare) | $8.00 | $3.00 | $11.00 |\n| [Shallots, 20 g](https://other.example/item/123) | $9.00 | Unknown | Unknown |' }); host.changed();
  const product = page.locator('.message.assistant table a').first(); await product.waitFor();
  assert.equal(await product.getAttribute('href'), 'https://shop.example/products/shallots?size=20&ref=compare');
  assert.equal(await product.getAttribute('target'), '_blank');
  assert.match(await product.getAttribute('rel'), /noopener/);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Shopping table at ${width}px`);
    await product.focus(); assert.equal(await product.evaluate(element => element === document.activeElement), true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Watching doesn't abort the active session. Taking and returning keep the viewer.
  await tools.get(chatId).browser.execute('fixture', { action: 'navigate', url: `http://127.0.0.1:${website.address().port}` });
  await api('/api/prompt', { chatId, message: 'Hold for viewing' });
  const before = session.aborts;
  await page.locator('#browser').click(); await page.getByText('Watching · Agent in control', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(session.aborts, before); assert.equal(host.browserControls.get(chatId).controlled, false);
  assert.equal(await page.locator('#browser-keyboard').isDisabled(), true);
  await page.getByRole('button', { name: 'Take control', exact: true }).click(); await page.getByText('You’re in control', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(session.aborts, before + 1);
  await page.getByRole('button', { name: 'Return to agent', exact: true }).click(); await page.getByText('Watching · Agent in control', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#browser-dialog').isVisible(), true);
  await page.getByRole('button', { name: 'Close browser view', exact: true }).click();
  // Notifications use the real worker. A reply in another chat triggers one.
  await page.locator('#settings').click(); await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Disable notifications', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const other = await api('/api/new', { title: 'Background QA' }); await api('/api/prompt', { chatId: other.id, message: 'Hold for notifications' });
  await page.locator('#chat-list').getByText(other.title, { exact: true }).waitFor({ state: 'visible' });
  sessions.get(other.id).finish(); await host.loaded.get(other.id).queue;
  // Service-worker APIs require the page's main world in Patchright.
  let notifications = [];
  for (let i = 0; i < 50; i++) {
    notifications = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(item => ({ title: item.title, body: item.body, chatId: item.data.chatId })), undefined, {}, false);
    if (notifications.some(item => item.chatId === other.id && /new reply/.test(item.body))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(notifications.some(item => item.chatId === other.id && /new reply/.test(item.body)), 'Worker notification did not arrive');
  const chatOrder = () => page.locator('#chat-list .chat-link span').allTextContents();
  assert.deepEqual(await chatOrder(), ['Main chat', 'Background QA', 'Ergonomics QA']);
  await page.getByRole('button', { name: 'Pin chat', exact: true }).click();
  await page.getByRole('button', { name: 'Unpin chat', exact: true }).waitFor({ state: 'visible' });
  assert.deepEqual(await chatOrder(), ['Main chat', 'Ergonomics QA', 'Background QA']);
  await page.getByRole('button', { name: 'Unpin chat', exact: true }).click();
  await page.getByRole('button', { name: 'Pin chat', exact: true }).waitFor({ state: 'visible' });
  assert.deepEqual(await chatOrder(), ['Main chat', 'Background QA', 'Ergonomics QA']);
  await api('/api/prompt', { chatId, message: 'Owner bumps this chat' });
  await page.waitForFunction(() => document.querySelectorAll('#chat-list .chat-link span')[1]?.textContent === 'Ergonomics QA');
  // Desktop animation and responsive layouts, including long press on mobile.
  const expanded = await page.locator('#sidebar').boundingBox(); await page.locator('#chat-menu').click();
  await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width < 224 && document.querySelector('#sidebar').getBoundingClientRect().width > 0);
  assert.equal(expanded.width, 224); await page.locator('#chat-menu').click();
  const output = process.env.PHOENIX_QA_OUTPUT || '/tmp/phoenix-ux-qa'; await mkdir(output, { recursive: true });
  await page.locator('#message').fill('');
  await page.screenshot({ path: join(output, 'desktop.png') });
  for (const width of [320, 390, 620]) {
    await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}`);
    await page.locator('#chat-menu').click(); await page.locator('#chat-backdrop').click({ position: { x: width - 10, y: 400 } });
    await page.locator('#browser').click(); await page.getByText('Watching · Agent in control', { exact: true }).waitFor({ state: 'visible' });
    for (const selector of ['#browser-url', '#return-browser', '#browser-screen']) { const bounds = await page.locator(selector).boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${selector} overflow`); }
    await page.getByRole('button', { name: 'Take control', exact: true }).click(); await page.getByText('You’re in control', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Return to agent', exact: true }).click(); await page.getByText('Watching · Agent in control', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Close browser view', exact: true }).click();
    if (width === 390) await page.screenshot({ path: join(output, 'mobile.png') });
  }
  await api('/api/prompt', { chatId, message: 'Hold long press fixture' }); await api('/api/prompt', { chatId, message: 'Long press queued' });
  await page.locator('.message[data-queue-id]').waitFor({ state: 'visible' });
  await page.locator('.message[data-queue-id] .message-body').scrollIntoViewIfNeeded();
  const queued = await page.locator('.message[data-queue-id] .message-body').boundingBox();
  await page.mouse.move(queued.x + 10, queued.y + 10); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
  assert.equal(await page.locator('#message').inputValue(), 'Long press queued');
  await page.locator('#message').fill('Edit survives refresh'); await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#message').inputValue(), 'Edit survives refresh'); await page.getByRole('button', { name: 'Cancel editing queued message', exact: true }).click();
  sessions.get(chatId).finish(); await host.loaded.get(chatId).queue;
  // Invisible tool-only turns cannot displace the question or earlier product links.
  session.messages.push(...Array.from({ length: 150 }, () => ({ role: 'assistant', content: [{ type: 'toolCall', name: 'browser', arguments: { action: 'snapshot' } }] })), { role: 'assistant', content: 'Research QA complete.' }); host.changed();
  await page.locator('#messages .message.assistant').getByText('Research QA complete.', { exact: true }).waitFor();
  assert.equal(await page.locator('#messages .message.user').getByText('Hold long press fixture', { exact: true }).count(), 1);
  assert.equal(await page.locator('#messages .message.assistant table a').count(), 2);
  // Consent identifies the site without changing the existing denial flow.
  const consent = host.requestApproval(chatId, 'browser', { action: 'click', selector: '#size', site: 'https://shop.example:8443' }, undefined, 'This chat has read outside content.');
  const approvalTitle = page.locator('#approvals strong');
  await approvalTitle.getByText('Allow browser on shop.example:8443?', { exact: true }).waitFor();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Browser consent at ${width}px`);
  }
  assert.equal(await page.getByRole('button', { name: 'Allow in this chat', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Deny', exact: true }).click(); assert.equal(await consent, false);
  const fallback = host.requestApproval(chatId, 'browser', { action: 'click', selector: '#size' }, undefined, 'This chat has read outside content.');
  await approvalTitle.getByText('Allow browser?', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Deny', exact: true }).click(); assert.equal(await fallback, false);
  // An older HTTP refresh must not erase a newer socket reply while its
  // notification waits for the worker. Delay both to make the race repeatable.
  await page.setViewportSize({ width: 1280, height: 900 });
  const background = await api('/api/new', { title: 'Notification race QA' });
  await page.locator('#chat-list').getByText(background.title, { exact: true }).waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const serviceWorker = navigator.serviceWorker; const ready = serviceWorker.ready;
    let release; window.releaseNotificationWorker = () => { delete serviceWorker.ready; release(ready); };
    window.pendingNotificationWorkers = 0;
    const delayed = new Promise(resolve => { release = resolve; });
    Object.defineProperty(serviceWorker, 'ready', { configurable: true, get: () => { window.pendingNotificationWorkers++; return delayed; } });
  }, undefined, {}, false);
  let releaseRefresh; let capturedRefresh; let fulfilledRefresh;
  const captured = new Promise(resolve => { capturedRefresh = resolve; });
  const fulfilled = new Promise(resolve => { fulfilledRefresh = resolve; });
  const delayedRefresh = new Promise(resolve => { releaseRefresh = resolve; });
  const refreshURL = `${base}/api/state?chat=${chatId}`;
  await page.route(refreshURL, async route => {
    const response = await route.fetch(); capturedRefresh(); await delayedRefresh;
    await route.fulfill({ response }); fulfilledRefresh();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Pin chat', exact: true }).click(); await captured;
  await api('/api/prompt', { chatId: background.id, message: 'Immediate background reply' });
  let waitingForWorker = false;
  for (let attempt = 0; attempt < 120 && !waitingForWorker; attempt++) {
    waitingForWorker = await page.evaluate(() => window.pendingNotificationWorkers > 0, undefined, {}, false);
    if (!waitingForWorker) await page.waitForTimeout(100);
  }
  assert.ok(waitingForWorker, 'The background reply did not reach notification dispatch');
  session.messages.push({ role: 'assistant', content: 'Newer socket result.' }); host.changed();
  await page.locator('#messages').getByText('Newer socket result.', { exact: true }).waitFor();
  releaseRefresh(); await fulfilled;
  await page.waitForTimeout(100);
  await page.evaluate(() => window.releaseNotificationWorker(), undefined, {}, false);
  for (let attempt = 0; attempt < 50; attempt++) {
    notifications = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(item => ({ chatId: item.data.chatId })), undefined, {}, false);
    if (notifications.some(item => item.chatId === background.id)) break;
    await page.waitForTimeout(100);
  }
  assert.ok(notifications.some(item => item.chatId === background.id), 'An older HTTP refresh erased a pending background reply notification');
  assert.equal(await page.locator('#messages').getByText('Newer socket result.', { exact: true }).count(), 1, 'An older HTTP refresh replaced the newer conversation');
  // A fresh connection accepts a reset server counter, and excludes a response
  // started on the previous connection even if its old counter was higher.
  const capturedAgain = new Promise(resolve => { capturedRefresh = resolve; });
  const fulfilledAgain = new Promise(resolve => { fulfilledRefresh = resolve; });
  const delayedAgain = new Promise(resolve => { releaseRefresh = resolve; });
  await page.route(refreshURL, async route => {
    const response = await route.fetch(); capturedRefresh(); await delayedAgain;
    await route.fulfill({ response }); fulfilledRefresh();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Unpin chat', exact: true }).click(); await capturedAgain;
  host.revision = 0; session.messages.push({ role: 'assistant', content: 'After reconnect with a reset counter.' });
  await page.evaluate('socket.close()', undefined, {}, false);
  await page.locator('#messages').getByText('After reconnect with a reset counter.', { exact: true }).waitFor({ timeout: 10000 });
  releaseRefresh(); await fulfilledAgain; await page.waitForTimeout(100);
  assert.equal(await page.locator('#messages').getByText('After reconnect with a reset counter.', { exact: true }).count(), 1, 'An old connection response replaced the restarted server state');
  assert.deepEqual(errors, []);
  console.log('Ergonomics UI passed: native image paste, file paste, normal text paste, local image/PDF thumbnails, agent images, duplicate Enter prevention/error retry/draft preservation, queue edits/late text and upload preservation/error retry/draft restore/refresh/long press, real browser view/take/return, worker notifications, chat order/pin/unpin, animated desktop sidebar and 320/390/620px mobile layouts.');
} finally {
  for (const session of sessions.values()) session.finish();
  // Fixture sessions do not have Pi's disposal lifecycle.
  for (const close of host.browserClosers?.values() || []) await close();
  await chromiumBrowser.close(); await host.close(); host.auth.close(); server.closeWebSockets(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  website.closeAllConnections(); await new Promise(resolve => website.close(resolve)); await rm(data, { recursive: true, force: true });
}
