import { createServer, request as httpRequest, Agent } from 'node:http';
import { Duplex } from 'node:stream';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { lifecycle } from '../src/host.js';
import { log, registerSecret } from '../src/log.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const problem = message => Object.assign(Error(message), { status: 409 });
export class Internet {
  constructor(host) { this.host = host; this.file = join(host.dataDir, 'internet.json'); this.streams = new Map(); this.counter = 0; this.enabled = false; this.saveQueue = Promise.resolve(); }
  async initialize() {
    this.record = await readFile(this.file, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return {}; });
    this.enabled = this.record.enabled === true;
    this.server = createServer((request, response) => {
      let url; try { url = new URL(request.url); if (url.protocol !== 'http:' || url.username || url.password) throw Error(); } catch { response.writeHead(400); return response.end(); }
      const stream = this.open(url.hostname, Number(url.port || 80));
      stream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      stream.once('ready', () => {
        const headers = { ...request.headers, host: url.host }; delete headers['proxy-connection']; delete headers['proxy-authorization'];
        const agent = new Agent({ keepAlive: false }); agent.createConnection = () => stream;
        const upstream = httpRequest({ host: url.hostname, port: url.port || 80, method: request.method, path: url.pathname + url.search, headers, agent }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
        response.on('close', () => { upstream.destroy(); agent.destroy(); });
      });
    });
    this.server.on('connect', (request, socket, head) => {
      let url; try { url = new URL('http://' + request.url); if (url.username || url.password || url.pathname !== '/') throw Error(); } catch { return socket.destroy(); }
      const stream = this.open(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 443));
      stream.once('error', () => socket.destroy()); socket.on('error', () => stream.destroy()); socket.on('close', () => stream.destroy());
      stream.once('ready', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) stream.write(head); socket.pipe(stream).pipe(socket); });
    });
    this.server.requestTimeout = 15000;
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve)); this.proxy = 'http://127.0.0.1:' + this.server.address().port;
    if (this.host.webServer) this.attach(this.host.webServer);
  }
  status() { return { available: true, enabled: this.enabled, paired: !!this.record?.hash, connected: this.socket?.readyState === WebSocket.OPEN }; }
  save() { const text = JSON.stringify({ ...this.record, enabled: this.enabled }); this.saveQueue = this.saveQueue.catch(() => {}).then(async () => { await writeFile(this.file + '.tmp', text, { mode: 0o600 }); await rename(this.file + '.tmp', this.file); }); return this.saveQueue; }
  control(value) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  open(host, port) {
    const id = ++this.counter; const relay = this;
    const stream = new Duplex({ highWaterMark: 65536, read() { relay.control({ type: 'resume', id }); },
      write(bytes, _encoding, callback) {
        const send = () => {
          if (relay.socket?.readyState !== WebSocket.OPEN) return callback(Error('Connector offline.'));
          if (relay.socket.bufferedAmount > 4 * 1024 * 1024) return callback(Error('Relay buffer limit.'));
          for (let offset = 0; offset < bytes.length; offset += 65536) {
            const payload = Buffer.alloc(4 + Math.min(65536, bytes.length - offset)); payload.writeUInt32BE(id); bytes.copy(payload, 4, offset, offset + 65536);
            relay.socket.send(payload, offset + 65536 >= bytes.length ? callback : undefined);
          }
        };
        if (stream.peerPaused) stream.resumeWrite = send; else send();
      }, final(callback) { relay.control({ type: 'end', id }); callback(); },
      destroy(error, callback) { relay.streams.delete(id); clearTimeout(stream.deadline); relay.control({ type: 'close', id }); if (stream.resumeWrite) { stream.peerPaused = false; stream.resumeWrite(); stream.resumeWrite = undefined; } callback(error); },
    });
    stream.on('error', () => {});
    if (!this.enabled || this.socket?.readyState !== WebSocket.OPEN || ![80,443].includes(port) || this.streams.size >= 32 || id > 0xffffffff) { queueMicrotask(() => stream.destroy(Error('Internet connector unavailable.'))); return stream; }
    this.streams.set(id, stream); stream.deadline = setTimeout(() => stream.destroy(Error('Relay timed out.')), 60000); stream.deadline.unref();
    this.control({ type: 'open', id, host, port }); return stream;
  }
  async pair(origin) {
    const url = new URL(origin); if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw problem('Use an HTTPS Phoenix link to connect your computer.');
    const token = randomBytes(32).toString('base64url'); registerSecret(token); this.socket?.close(1008, 'Repaired'); this.record = { hash: digest(token) }; this.enabled = true; await this.save(); await this.closeBrowsers();
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/api/internet/socket'; url.search = ''; url.hash = '';
    const source = await readFile(new URL('./internet-client.mjs', import.meta.url), 'utf8');
    this.host.changed(); return source + '\nstartConnector(' + JSON.stringify(url.href) + ', ' + JSON.stringify(token) + ');\n';
  }
  async closeBrowsers() { await Promise.all([...this.host.browserClosers?.values() || []].map(close => close())); }
  async toggle(enabled) { if (typeof enabled !== 'boolean') throw problem('Choose a route.'); if (enabled && !this.record.hash) throw problem('Connect your computer first.'); this.enabled = enabled; for (const stream of this.streams.values()) stream.destroy(); await this.closeBrowsers(); await this.save(); this.host.changed(); return this.status(); }
  async revoke() { await this.toggle(false); this.record = {}; this.socket?.close(1008, 'Disconnected'); await rm(this.file, { force: true }); this.host.changed(); }
  attach(server) {
    if (this.attached) return; this.attached = true;
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: 65540, perMessageDeflate: false, handleProtocols: () => 'phoenix-relay' });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/internet/socket') return;
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()) || [];
      const token = protocols[1]; let origin;
      try { if (request.headers.origin) origin = new URL(request.headers.origin); } catch { origin = {}; }
      const authority = [`localhost:${this.host.port}`, `127.0.0.1:${this.host.port}`, this.host.publicUrl && new URL(this.host.publicUrl).host];
      if (!authority.includes(request.headers.host) || origin && origin.host !== request.headers.host || protocols[0] !== 'phoenix-relay' || !/^[\w-]{43}$/.test(token || '') || !this.record.hash || !timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(this.record.hash, 'hex')) || this.socket?.readyState === WebSocket.OPEN) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      this.sockets.handleUpgrade(request, socket, head, connection => {
        this.socket = connection; this.alive = true; this.host.changed(); log.info('internet.connected');
        connection.on('error', error => log.warn('internet.connection_failed', { error })); connection.on('pong', () => { this.alive = true; });
        connection.on('close', code => { if (this.socket !== connection) return; log.info('internet.disconnected', { code }); this.socket = undefined; for (const stream of this.streams.values()) stream.destroy(Error('Connector disconnected.')); this.host.changed(); });
        connection.on('message', (data, binary) => {
          try {
            if (binary) { if (data.length < 4) throw Error(); const id = data.readUInt32BE(); const stream = this.streams.get(id); if (stream && !stream.push(data.subarray(4))) this.control({ type: 'pause', id }); }
            else {
              const { type, id } = JSON.parse(data.toString()); const stream = this.streams.get(id); if (!stream) return;
              if (type === 'ready') { stream.connected = true; stream.emit('ready'); }
              else if (type === 'end') stream.push(null);
              else if (type === 'close') { if (!stream.connected) stream.destroy(Error('Destination connection failed.')); else { stream.push(null); stream.end(); } }
              else if (type === 'pause') stream.peerPaused = true;
              else if (type === 'resume') { stream.peerPaused = false; const send = stream.resumeWrite; stream.resumeWrite = undefined; send?.(); }
              else throw Error();
            }
          } catch { connection.close(1008, 'Invalid relay message'); }
        });
      });
    });
    this.heartbeat = setInterval(() => { if (!this.socket) return; if (!this.alive) return this.socket.terminate(); this.alive = false; this.socket.ping(); }, 30000); this.heartbeat.unref();
  }
  async close() { clearInterval(this.heartbeat); this.socket?.terminate(); this.sockets?.close(); for (const stream of this.streams.values()) stream.destroy(); this.server?.closeAllConnections(); await new Promise(resolve => this.server ? this.server.close(resolve) : resolve()); }
}
export default function internet(pi, host, _options, chatId = 'main') {
  if (chatId === 'main') lifecycle(pi, host, 'internet', async () => { host.internet = new Internet(host); await host.internet.initialize(); }, () => host.internet?.close());
  pi.on('tool_call', event => {
    if (event.toolName !== 'bash' || !host.internet?.enabled) return;
    const proxy = host.internet.proxy;
    event.input.command = `export http_proxy=${proxy} https_proxy=${proxy} HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} ALL_PROXY=${proxy} NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 NODE_USE_ENV_PROXY=1;\n${event.input.command}`;
  });
}
