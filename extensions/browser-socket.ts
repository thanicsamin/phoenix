import { PhoenixSocket } from '../src/socket.ts';
import type { WebServer, TokenFrom, AllowedHost } from '../src/socket.ts';
import type { Host } from '../src/host.ts';
import type { BrowserControl } from '../src/browser-control.ts';
import { WebSocketServer } from 'ws';

// Owner-only stream. CSRF is checked in the first message, never placed in a URL.
export function attachBrowserSocket(server: WebServer, host: Host, tokenFrom: TokenFrom, allowedHost: AllowedHost) {
  const sockets = new WebSocketServer({ WebSocket: PhoenixSocket, noServer: true, maxPayload: 16384, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/browser/socket') return;
    let origin; try { origin = new URL(request.headers.origin || ''); } catch { /* Rejected below. */ }
    const token = tokenFrom(request); const auth = host.auth.get(token);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin?.hostname || '');
    if (!allowedHost(request.headers.host) || origin?.host !== request.headers.host || !['http:', 'https:'].includes(origin?.protocol || '')
      || !origin || origin.protocol !== 'https:' && !local || !auth || auth.preview || sockets.clients.size >= 8) {
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
    sockets.handleUpgrade(request, socket, head, connection => {
      let control: BrowserControl | undefined; let starting = false; let closed = false; let taking = false; let prepared: Promise<void> | undefined; let takeover: Promise<void> | undefined;
      let width = 1280; let height = 900;
      connection.alive = true; connection.ownerToken = token;
      const timer = setTimeout(() => connection.close(1008, 'Start browser control'), 5000); timer.unref();
      const fail = () => { if (connection.readyState === 1) connection.send(JSON.stringify({ type: 'error', error: 'Browser action failed. Try again or reconnect.' })); };
      connection.on('error', () => {}); connection.on('pong', () => { connection.alive = true; });
      connection.on('close', () => { closed = true; clearTimeout(timer); control?.disconnect(connection).catch(() => {}); });
      connection.on('message', async (bytes, binary) => {
        // Never log message bytes or exception text: both can contain passwords.
        const current = host.auth.get(token);
        if (!current || current.preview || binary) { connection.close(1008, 'Owner sign-in required'); return; }
        try {
          const data = JSON.parse(bytes.toString());
          if (!control) {
            if (starting || data.type !== 'start' || data.csrf !== current.csrf || typeof data.chatId !== 'string'
              || !Number.isInteger(data.width) || data.width < 320 || data.width > 1280
              || !Number.isInteger(data.height) || data.height < 320 || data.height > 900) throw Error();
            starting = true; clearTimeout(timer);
            await host.getChat(data.chatId);
            if (closed) return;
            control = host.browserControls?.get(data.chatId);
            if (!control) throw Error();
            width = data.width; height = data.height;
            prepared = control.view(connection, width, height); await prepared;
          } else if (data.type === 'take') {
            if (taking || control.controlled) throw Error();
            taking = true;
            takeover = (async () => { await prepared; if (!closed) await control!.claim(connection, width, height); })();
            try { await takeover; }
            finally { taking = false; }
          } else {
            // The ready frame can reach the owner before CDP finishes setup.
            // Preserve immediate input instead of rejecting that first click.
            await prepared; await takeover; if (closed) return;
            await control.input(connection, data);
          }
          starting = false;
        } catch { if (!control || control.socket !== connection) connection.close(1008, 'Browser control unavailable'); else fail(); }
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive || socket.ownerToken && !host.auth.get(socket.ownerToken)) { socket.terminate(); continue; }
      socket.alive = false; socket.ping();
    }
  }, 15000); heartbeat.unref();
  const validate = () => { for (const socket of sockets.clients) if (!host.auth.get(socket.ownerToken)) socket.terminate(); };
  host.on?.('change', validate);
  let closed = false;
  const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); host.off?.('change', validate); for (const socket of sockets.clients) socket.terminate(); sockets.close(); };
  host.cleanups?.push(close); server.once('close', close);
}
