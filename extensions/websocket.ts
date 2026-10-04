import { PhoenixSocket } from '../src/socket.ts';
import type { WebServer, TokenFrom, AllowedHost } from '../src/socket.ts';
import type { Host } from '../src/host.ts';
import { WebSocketServer, WebSocket } from 'ws';

// The socket only delivers state. Mutations keep the HTTP API's CSRF checks.
export function attachWebSocket(server: WebServer, host: Host, tokenFrom: TokenFrom, allowedHost: AllowedHost) {
  const sockets = new WebSocketServer({ WebSocket: PhoenixSocket, noServer: true, maxPayload: 4096, perMessageDeflate: false });
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  async function publish(socket: PhoenixSocket) {
    if (closed || socket.readyState !== WebSocket.OPEN || socket.sending) return;
    if (!host.auth.get(socket.token)) return socket.close(1008, 'Session expired');
    if (socket.bufferedAmount > 1024 * 1024) return socket.terminate();
    socket.sending = true;
    const chatId = socket.chatId;
    try {
      const state = await host.state(chatId);
      if (chatId === socket.chatId && socket.readyState === WebSocket.OPEN) {
        // Don't resend the model catalog and full history for every streamed token.
        if (socket.previousChat !== chatId) { socket.previous = new Map(); socket.previousChat = chatId; }
        const patch: Record<string, unknown> = { chatId };
        for (const [name, value] of Object.entries(state)) {
          const serialized = JSON.stringify(value);
          if (socket.previous.get(name) !== serialized) { patch[name] = value; socket.previous.set(name, serialized); }
        }
        if (Object.keys(patch).length > 1) socket.send(JSON.stringify(patch));
      }
    } catch { socket.close(1008, 'Invalid chat'); }
    finally { socket.sending = false; }
  }
  const changed = () => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = undefined; for (const socket of sockets.clients) publish(socket); }, 60);
  };
  host.on?.('change', changed);
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/api/internet/socket' && host.internet || request.url === '/api/browser/socket') return;
    let origin;
    try { origin = new URL(request.headers.origin || ''); } catch { /* rejected below */ }
    if (request.url !== '/api/socket' || !allowedHost(request.headers.host)
      || origin?.host !== request.headers.host || !['http:', 'https:'].includes(origin?.protocol || '')
      || !host.auth.get(tokenFrom(request)) || sockets.clients.size >= 32) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, connection => {
      connection.token = tokenFrom(request); connection.chatId = 'main'; connection.alive = true;
      connection.on('error', () => {});
      connection.on('pong', () => { connection.alive = true; });
      connection.on('message', data => {
        try {
          const { chatId } = JSON.parse(data.toString());
          if (!host.auth.get(connection.token) || typeof chatId !== 'string') throw new Error('Invalid subscription');
          host.record(chatId); connection.chatId = chatId; publish(connection);
        } catch { connection.close(1008, 'Invalid subscription'); }
      });
      publish(connection);
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive || !host.auth.get(socket.token)) { socket.terminate(); continue; }
      socket.alive = false; socket.ping();
    }
  }, 30000);
  heartbeat.unref();
  server.closeWebSockets = () => {
    closed = true; clearTimeout(timer); clearInterval(heartbeat); host.off?.('change', changed);
    for (const socket of sockets.clients) socket.terminate(); sockets.close();
  };
  server.on('close', server.closeWebSockets!);
}
