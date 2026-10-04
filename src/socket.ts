import { WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';

export class PhoenixSocket extends WebSocket {
  alive = true; sending = false; token?: string; ownerToken?: string;
  chatId = 'main'; previousChat?: string; previous = new Map<string, string | undefined>();
}
export type WebServer = Server & { closeWebSockets?: () => void };
export type TokenFrom = (request: IncomingMessage) => string | undefined;
export type AllowedHost = (authority: string | undefined) => boolean;
