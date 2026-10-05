import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Chat } from '../src/host.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';

// Synthetic data only. Print measurements, not timing assertions that vary by CPU.
const messages = Array.from({ length: 30000 }, (_, index) => ({ role: index % 3 === 0 ? 'toolResult' : index % 3 === 1 ? 'user' : 'assistant', content: `Synthetic ${index}: ${'x'.repeat(800)}` }));
const chat = new Chat({ name: 'Performance fixture', model: { provider: 'opencode', id: 'big-pickle' } }, '/tmp', '/tmp');
chat.session = { messages, modelRuntime: { hasConfiguredAuth: () => true } };
for (let index = 0; index < 20; index++) chat.state();
const samples = [];
for (let batch = 0; batch < 7; batch++) {
  const start = performance.now();
  for (let index = 0; index < 200; index++) chat.state();
  samples.push((performance.now() - start) / 200);
}
assert.equal(chat.state().messages.length, 100);
const directory = await mkdtemp(join(tmpdir(), 'phoenix-performance-'));
const host = new EventEmitter(); host.revision = 0; let reads = 0;
host.auth = await createAuth(directory, { password: 'performance-fixture-password' }); host.record = () => {};
host.state = async chatId => { reads++; return { chatId, revision: host.revision, messages: [], current: String(host.revision) }; };
host.ui = { root: fileURLToPath(new URL('../web/', import.meta.url)), version: 'performance-fixture' };
const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
const base = `http://127.0.0.1:${host.port}`; const sockets = [];
try {
  const login = await host.auth.login('performance-fixture-password');
  for (let index = 0; index < 4; index++) {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/socket', { headers: { Origin: base, Cookie: `phoenix=${login.token}` } }); sockets.push(socket);
    await once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  }
  const initial = reads;
  const updates = sockets.map(socket => once(socket, 'message', { signal: AbortSignal.timeout(2000) }));
  host.revision++; host.emit('change'); await Promise.all(updates);
  const assets = [];
  for (const path of ['/app.js', '/vendor/pdfjs/pdf.worker.mjs']) {
    const first = await fetch(base + path); const initialBytes = (await first.arrayBuffer()).byteLength;
    const second = await fetch(base + path, { headers: { 'If-None-Match': first.headers.get('etag') || 'baseline-no-etag' } });
    assets.push({ path, initialBytes, repeatStatus: second.status, repeatBytes: (await second.arrayBuffer()).byteLength });
  }
  console.log(JSON.stringify({ historyEntries: messages.length, displayedMessages: 100, medianSnapshotMs: samples.sort((a, b) => a - b)[3], stateReadsForFourWindows: reads - initial, assets }));
} finally {
  for (const socket of sockets) socket.terminate();
  server.closeWebSockets(); server.closeAllConnections(); host.auth.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
