import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebServer } from '../src/socket.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
import { errorOf } from '../src/errors.ts';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { attachWebSocket } from './websocket.ts';
import { lifecycle } from '../src/host.ts';
import { randomUUID, createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { log } from '../src/log.ts';
import { attachBrowserSocket } from './browser-socket.ts';
import { saveProviderKey } from '../src/models.ts';
import { localProviders } from '../src/local-models.ts';

const files: Record<string, [URL, string]> = {
  '/': [new URL('../web/index.html', import.meta.url), 'text/html; charset=utf-8'],
  '/plaid.js': [new URL('../web/plaid.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/app.js': [new URL('../web/app.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/chats.js': [new URL('../web/chats.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/voice.js': [new URL('../web/voice.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/theme.js': [new URL('../web/theme.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/browser.js': [new URL('../web/browser.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/markdown.js': [new URL('../web/markdown.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/notifications.js': [new URL('../web/notifications.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/notification-worker.js': [new URL('../web/notification-worker.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/previews.js': [new URL('../web/previews.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/style.css': [new URL('../web/style.css', import.meta.url), 'text/css; charset=utf-8'],
  '/bird.svg': [new URL('../web/bird.svg', import.meta.url), 'image/svg+xml'],
};
for (const [url, path, type] of [
  ['/vendor/markdown-it.js', 'markdown-it/dist/browser/markdown-it.umd.min.js', 'text/javascript'],
  ['/vendor/texmath.js', 'markdown-it-texmath/texmath.js', 'text/javascript'],
  ['/vendor/purify.js', 'dompurify/dist/purify.min.js', 'text/javascript'],
  ['/vendor/katex/katex.min.js', 'katex/dist/katex.min.js', 'text/javascript'],
  ['/vendor/katex/katex.min.css', 'katex/dist/katex.min.css', 'text/css'],
  ['/vendor/pdfjs/pdf.mjs', 'pdfjs-dist/legacy/build/pdf.min.mjs', 'text/javascript'],
  ['/vendor/pdfjs/pdf.worker.mjs', 'pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'text/javascript'],
]) files[url] = [new URL(`../node_modules/${path}`, import.meta.url), type];
for (const folder of ['cmaps', 'wasm']) {
  const root = new URL(`../node_modules/pdfjs-dist/${folder}/`, import.meta.url);
  for (const name of readdirSync(root).filter(name => /\.(bcmap|wasm)$/.test(name))) files[`/vendor/pdfjs/${folder}/${name}`] = [new URL(name, root), name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'];
}
const fonts = new URL('../node_modules/katex/dist/fonts/', import.meta.url);
for (const name of readdirSync(fonts).filter(name => name.endsWith('.woff2'))) {
  files[`/vendor/katex/fonts/${name}`] = [new URL(name, fonts), 'font/woff2'];
}
export const tokenFrom = (request: IncomingMessage) => /(?:^|;\s*)phoenix=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || '')?.[1];

async function readJson(request: IncomingMessage, limit = 40000) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON required.'), { status: 415 });
  request.setEncoding('utf8');
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

// JSON is untrusted: validate shared request fields before calling typed code.
const bodySchema = z.looseObject({
  chatId: z.string().default('main'), id: z.string().default(''), queueId: z.string().default(''),
  title: z.string().default('Side chat'), message: z.string().default(''), path: z.string().default(''),
  text: z.string().default(''), attachments: z.array(z.string()).default([]), version: z.number().default(-1),
  model: z.unknown(), thinking: z.unknown(), generation: z.number().int().positive().optional(), password: z.unknown(), apiKey: z.unknown(),
  archived: z.unknown(), pinned: z.unknown(), allow: z.unknown(), enabled: z.unknown(), remember: z.unknown(),
});
async function readBody(request: IncomingMessage, limit = 40000) {
  const result = bodySchema.safeParse(await readJson(request, limit));
  if (!result.success) throw Object.assign(Error('Invalid request fields.'), { status: 400 });
  return result.data;
}

export function createWebServer(host: Host, logger = log) {
  const allowedHost = (authority: string | undefined) => {
    const hosts = [`localhost:${host.port}`, `127.0.0.1:${host.port}`, `[::1]:${host.port}`];
    if (host.publicUrl) hosts.push(new URL(host.publicUrl).host);
    return hosts.includes(authority || '');
  };
  const server: WebServer = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = performance.now();
    const path = (request.url || '/').split('?')[0];
    // Never log bodies, headers, query strings, file names or arbitrary URLs.
    const route = /^\/api\/[a-z/-]+$/.test(path) ? path : files[path] ? path : path === '/health' ? path : '/unknown';
    response.setHeader('X-Request-Id', requestId);
    response.once('finish', () => {
      if (route === '/health' && response.statusCode < 400) return;
      const level = response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : request.method === 'GET' ? 'debug' : 'info';
      logger[level]('http.request', { requestId, method: request.method, route, status: response.statusCode, durationMs: Math.round(performance.now() - started) });
    });
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const authority = request.headers.host;
      if (!allowedHost(authority)) return send(403, { error: 'Unrecognized host.' });
      const plaidNonce = host.plaid ? randomUUID().replaceAll('-', '') : '';
      const plaidScript = plaidNonce ? ` 'nonce-${plaidNonce}' https://cdn.plaid.com/link/v2/stable/link-initialize.js` : '';
      const plaidStyle = plaidNonce ? ` 'nonce-${plaidNonce}'` : '';
      const plaidNetwork = plaidNonce ? ' https://sandbox.plaid.com https://production.plaid.com' : '';
      response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${plaidScript}; style-src 'self'${plaidStyle}; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws://${authority} wss://${authority}${plaidNetwork}; frame-src ${plaidNonce ? 'https://cdn.plaid.com' : "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      const path = new URL(request.url || '/', `http://${authority}`).pathname;
      if (request.method === 'GET' && path === '/health') return send(200, { ok: true });
      if (request.method === 'GET' && files[path]) {
        const [file, contentType] = files[path];
        const webFile = !path.startsWith('/vendor/') && host.ui ? join(host.ui.root, path === '/' ? 'index.html' : path.slice(1)) : file;
        if (!path.startsWith('/vendor/') && host.ui && !(await realpath(webFile)).startsWith(`${await realpath(host.ui.root)}/`)) return send(404, { error: 'File not found.' });
        let content = await readFile(webFile);
        if (path !== '/') {
          // Keep public code on the owner's device, without caching API data or
          // retaining asset buffers on the VPS. Content hashes also honor rollback.
          const etag = `"${createHash('sha256').update(content).digest('base64url')}"`;
          response.setHeader('Cache-Control', 'private, no-cache'); response.setHeader('ETag', etag);
          if (request.headers['if-none-match']?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) {
            response.writeHead(304); return response.end();
          }
        }
        if (path === '/' && plaidNonce) content = Buffer.from(content.toString('utf8').replace(/<\/head>/i, `<meta name="plaid-nonce" content="${plaidNonce}"></head>`));
        if (path === '/' && host.ui?.version) content = Buffer.from(content.toString('utf8').replace(/<\/head>/i, `<meta name="ui-version" content="${host.ui.version}"></head>`));
        response.writeHead(200, { 'Content-Type': contentType });
        return response.end(content);
      }
      const token = tokenFrom(request);
      const auth = host.auth.get(token);
      if (request.method === 'GET' && path === '/api/session') return send(200, { authenticated: !!auth, csrf: auth?.csrf });
      if (request.method !== 'GET') {
        let origin;
        try { origin = new URL(request.headers.origin || ''); } catch { return send(403, { error: 'Origin required.' }); }
        if (origin.host !== authority || !['http:', 'https:'].includes(origin.protocol)) return send(403, { error: 'Invalid origin.' });
        if (request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site request blocked.' });
        if (path === '/api/login' && request.method === 'POST') {
          const result = await host.auth.login((await readBody(request)).password);
          if (result.status !== 200) return send(result.status, { error: result.status === 429 ? 'Too many attempts. Try again in a minute.' : 'Incorrect password.' });
          response.setHeader('Set-Cookie', `phoenix=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin.protocol === 'https:' ? '; Secure' : ''}`);
          return send(200, { csrf: result.csrf });
        }
        if (!auth) return send(401, { error: 'Sign in to continue.' });
        if (request.headers['x-csrf-token'] !== auth.csrf) return send(403, { error: 'Invalid session token.' });
      } else if (!auth) return send(401, { error: 'Sign in to continue.' });
      if (auth.preview && request.method !== 'GET' && path !== '/api/logout') return send(403, { error: 'Agent previews are read-only. Sign in as the owner to make changes.' });
      const query = new URL(request.url || '/', `http://${authority}`).searchParams;
      if (path.startsWith('/api/plaid/')) {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to manage finances.' });
        if (!host.plaid) return send(409, { error: 'Plaid is not enabled in this setup.' });
        if (request.method === 'GET' && path === '/api/plaid/status') return send(200, host.plaid.status());
        if (request.method === 'POST') {
          if (path === '/api/plaid/configure') { const result = await host.plaid.configure(await readJson(request, 2000)); host.changed(); return send(200, result); }
          if (path === '/api/plaid/complete') { const result = await host.plaid.complete(await readJson(request, 2000)); host.changed(); return send(200, result); }
          const body = z.strictObject({ itemId: z.string().min(1).max(100).optional() }).safeParse(await readJson(request, 2000));
          if (!body.success) return send(400, { error: 'Invalid bank connection ID.' });
          if (path === '/api/plaid/link') return send(200, await host.plaid.link(body.data.itemId, request.headers.origin));
          if (path === '/api/plaid/disconnect' && body.data.itemId) { const result = await host.plaid.disconnect(body.data.itemId); host.changed(); return send(200, result); }
        }
        return send(404, { error: 'Unknown finance endpoint.' });
      }
      if (request.method === 'POST' && path === '/api/browser/release') {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to control the browser.' });
        const { chatId = 'main' } = await readBody(request); host.record(chatId);
        const control = host.browserControls?.get(chatId);
        if (!control) return send(409, { error: 'Browser control is unavailable.' });
        await control.release(); return send(200, {});
      }
      if (request.method === 'POST' && path.startsWith('/api/internet/')) {
        if (auth.preview) return send(403, { error: 'Use an owner sign-in to connect your computer.' });
        if (!host.internet) return send(409, { error: 'Internet connector is unavailable.' });
        if (path === '/api/internet/pair') return send(200, { client: await host.internet.pair(request.headers.origin || '') });
        if (path === '/api/internet/route') return send(200, await host.internet.toggle((await readBody(request)).enabled));
        if (path === '/api/internet/revoke') { await host.internet.revoke(); return send(200, {}); }
      }
      if (request.method === 'GET' && ['/api/files/download', '/api/files/image'].includes(path)) {
        const chatId = query.get('chat') || 'main'; host.record(chatId);
        const file = host.files.get(query.get('id'), chatId);
        if (path !== '/api/files/download') {
          if (path === '/api/files/image' && !file.mime.startsWith('image/')) return send(415, { error: 'Choose an image.' });
          const preview = { path: host.files.path(file), mime: file.mime };
          response.setHeader('Content-Type', preview.mime);
          response.setHeader('Content-Disposition', 'inline');
          await pipeline(createReadStream(preview.path), response); return;
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        response.setHeader('Content-Length', file.size);
        await pipeline(createReadStream(host.files.path(file)), response); return;
      }
      if (request.method === 'GET' && path === '/api/state') {
        const after = new URL(request.url || '/', `http://${authority}`).searchParams.get('after');
        if (after !== null && Number(after) === host.revision) { response.writeHead(204); return response.end(); }
        return send(200, await host.state(new URL(request.url || '/', `http://${authority}`).searchParams.get('chat') || 'main'));
      }
      if (request.method === 'GET' && path === '/api/setup') {
        response.setHeader('Content-Disposition', 'attachment; filename="agent.json"');
        return send(200, await host.exportSetup());
      }
      if (request.method === 'POST' && path === '/api/setup') {
        await host.applySetup(await readJson(request, 1024 * 1024)); return send(200, { restarting: true });
      }
      if (request.method === 'POST' && path === '/api/chat/archive') {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to archive chats.' });
        const { chatId, archived } = await readBody(request);
        return send(200, await host.archiveChat(chatId, archived));
      }
      if (request.method === 'POST' && path === '/api/chat/pin') {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to pin chats.' });
        const { chatId, pinned } = await readBody(request);
        return send(200, await host.pinChat(chatId, pinned));
      }
      if (request.method === 'POST' && path === '/api/chat/delete') {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to delete chats.' });
        const { chatId } = await readBody(request);
        return send(200, await host.deleteChat(chatId));
      }
      if (request.method === 'POST' && path === '/api/chat/update') {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to organize chats.' });
        const input = await readJson(request, 40000);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'Choose a chat name or folder.' });
        return send(200, await host.updateChat(input.chatId, { title: input.title, folder: input.folder }));
      }
      if (request.method === 'POST' && path === '/api/folders') {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to manage folders.' });
        const input = await readJson(request, 40000);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'Choose a folder.' });
        return send(200, await host.updateFolder(input));
      }
      if (request.method === 'POST' && path === '/api/logout') {
        host.auth.logout(token); host.changed?.();
        response.setHeader('Set-Cookie', 'phoenix=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(200, {});
      }
      if (request.method !== 'GET' && host.restarting) return send(409, { error: 'Reloading setup. Try again shortly.' });
      if (request.method === 'GET' && path === '/api/ui/generations') return send(200, await host.ui.history());
      if (request.method === 'POST' && path === '/api/ui/apply') {
        const history = await host.ui.apply(); host.changed(); return send(200, history);
      }
      if (request.method === 'POST' && path === '/api/ui/switch') {
        const { generation } = await readBody(request);
        const history = await host.ui.switch(generation); host.changed(); return send(200, history);
      }
      if (request.method === 'POST' && path === '/api/restart') {
        if ([...host.loaded.values()].some(chat => chat.pending)) return send(409, { error: 'Wait for active chats to finish before reloading.' });
        await host.generations.apply();
        host.requestRestart(); return send(202, {});
      }
      if (request.method === 'GET' && path === '/api/generations') return send(200, await host.generations.history());
      if (request.method === 'POST' && path === '/api/generations/switch') {
        if ([...host.loaded.values()].some(chat => chat.pending)) return send(409, { error: 'Wait for active chats to finish before rolling back.' });
        const { generation } = await readBody(request);
        await host.generations.switch(generation); host.requestRestart(); return send(202, {});
      }
      if (request.method === 'GET' && path === '/api/workspace') return send(200, await host.workspaceFiles.list(query.get('path') || ''));
      if (request.method === 'GET' && path === '/api/workspace/file') return send(200, await host.workspaceFiles.read(query.get('path') || ''));
      if (request.method === 'POST' && path === '/api/workspace/file') {
        const { path: file, text } = await readBody(request, 220000);
        await host.workspaceFiles.write(file, text); host.changed(); return send(200, {});
      }
      if (request.method === 'GET' && path === '/api/workspace/download') {
        const file = await host.workspaceFiles.path(query.get('path') || '');
        if (!(await stat(file)).isFile()) return send(400, { error: 'Choose a file.' });
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.split('/').pop() || 'file')}`);
        await pipeline(createReadStream(file), response); return;
      }
      if (request.method === 'POST' && path === '/api/files') {
        const chatId = query.get('chat') || 'main'; host.record(chatId);
        if (!request.headers['content-type']?.startsWith('application/octet-stream')) return send(415, { error: 'A file upload is required.' });
        return send(201, await host.files.add(chatId, query.get('name') || '', request));
      }
      if (request.method === 'POST' && path === '/api/files/remove') {
        const { id, chatId = 'main' } = await readBody(request); host.record(chatId);
        await host.files.remove(id, chatId); return send(200, {});
      }
      if (request.method === 'POST' && path === '/api/prompt') {
        const { message, chatId = 'main', attachments = [] } = await readBody(request);
        if (!Array.isArray(attachments) || attachments.length > 8 || new Set(attachments).size !== attachments.length) return send(400, { error: 'Attach up to eight files.' });
        if (typeof message !== 'string' || (!message.trim() && !attachments.length) || message.length > 32000) return send(400, { error: 'Write a message or attach a file.' });
        for (const id of attachments) host.files.get(id, chatId);
        const chat = await host.getChat(chatId);
        if (chat.pending >= 10 || host.closing) return send(409, { error: 'Agent is busy. Try again shortly.' });
        host.submit(message || 'Please inspect the attached files.', 'web', chatId, attachments).catch(caught => { const error = errorOf(caught); chat.error = error.message; host.changed(); });
        return send(202, {});
      }
      if (request.method === 'POST' && path === '/api/steer') {
        const { message, chatId = 'main', attachments = [] } = await readBody(request);
        if (typeof message !== 'string' || !Array.isArray(attachments) || (!message.trim() && !attachments.length) || message.length > 32000) return send(400, { error: 'Write a steering message.' });
        await host.steer(message || 'Please inspect the attached files.', chatId, attachments); return send(202, {});
      }
      if (request.method === 'POST' && path === '/api/autoreview') {
        const { chatId = 'main', enabled } = await readBody(request);
        if (typeof enabled !== 'boolean') return send(400, { error: 'Choose whether to use automatic review.' });
        const record = host.record(chatId); const previous = record.autoReview;
        record.autoReview = enabled;
        try { await host.save(); } catch (error) { record.autoReview = previous; throw error; }
        host.changed(); return send(200, {});
      }
      if (request.method === 'POST' && path === '/api/queue/edit') {
        const { chatId = 'main', queueId, version, message, attachments = [] } = await readBody(request);
        if (!Array.isArray(attachments) || typeof queueId !== 'string' || !Number.isInteger(version) || version < 0 || typeof message !== 'string' || (!message.trim() && !attachments.length)) return send(400, { error: 'Write a message or attach a file.' });
        await host.editQueued(chatId, queueId, version, message || 'Please inspect the attached files.', attachments);
        return send(200, {});
      }
      if (request.method === 'POST' && path === '/api/cancel') {
        const { chatId = 'main' } = await readBody(request);
        for (const approval of [...host.approvals.values()]) if (approval.chatId === chatId) await host.approve(approval.id, false);
        const chat = await host.getChat(chatId); chat.cancelQueued();
        await chat.session.abort(); chat.session.clearQueue?.(); chat.steering = []; host.changed(); return send(200, {});
      }
      if (request.method === 'POST' && path === '/api/new') {
        const input = await readJson(request, 40000);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'Choose a chat name or folder.' });
        return send(201, await host.createChat(input.title, undefined, input.folder, input.fromChatId));
      }
      if (request.method === 'POST' && path === '/api/approval') {
        const { id, allow, remember = false } = await readBody(request);
        if (typeof allow !== 'boolean' || typeof remember !== 'boolean') return send(400, { error: 'Choose allow or deny.' });
        await host.approve(id, allow, remember); return send(200, {});
      }
      if (request.method === 'POST' && path === '/api/jobs') {
        const { chatId = 'main', ...input } = await readBody(request);
        return send(201, await host.addJob(chatId, { name: input.name, prompt: input.prompt, everyMinutes: input.everyMinutes, nextRunAt: input.nextRunAt }));
      }
      if (request.method === 'POST' && path === '/api/jobs/run') {
        const { chatId = 'main', id } = await readBody(request);
        await host.runJob(chatId, id); return send(202, {});
      }
      if (request.method === 'POST' && path === '/api/jobs/remove') {
        const { chatId = 'main', id } = await readBody(request);
        await host.removeJob(chatId, id); return send(200, {});
      }
      if (request.method === 'POST' && path === '/api/model') {
        const { chatId = 'main', ...selection } = await readBody(request);
        await host.setModel(chatId, selection); return send(200, {});
      }
      if (request.method === 'POST' && path === '/api/provider') {
        if (auth.preview) return send(403, { error: 'Sign in as the owner to manage API keys.' });
        const input = await readJson(request, 40000);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(Error('Invalid provider settings.'), { status: 400 });
        const { provider = 'opencode-go', apiKey } = input;
        if ((localProviders as readonly unknown[]).includes(provider)) await host.configureEndpoint(input);
        else await saveProviderKey(host.modelRuntime, provider, apiKey);
        host.changed(); return send(200, {});
      }
      return send(404, { error: 'Not found.' });
    } catch (caught) { const error = errorOf(caught);
      if (!error.status || error.status >= 500) logger.error('http.failed', { requestId, route, error });
      if (!response.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Request failed. Check the container logs.', requestId });
      else response.end();
    }
  });
  attachWebSocket(server, host, tokenFrom, allowedHost);
  attachBrowserSocket(server, host, tokenFrom, allowedHost);
  host.webServer = server; host.internet?.attach(server);
  return server;
}

export default function web(pi: ExtensionAPI, host: Host, options: ExtensionOptions<'web'>) {
  let server: WebServer | undefined;
  lifecycle(pi, host, 'web', async () => {
    if (!host.auth) throw new Error('Authentication extension is required.');
    if (process.env.PHOENIX_PUBLIC_IP) {
      const port = Number(process.env.PHOENIX_HTTPS_PORT || 24843);
      if (host.config?.extensions.tunnel) throw new Error('Choose direct HTTPS or a tunnel.');
      let ip = process.env.PHOENIX_PUBLIC_IP;
      if (ip === 'auto') {
        const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Public IP discovery failed. Set PHOENIX_PUBLIC_IP explicitly.');
        ip = (await response.text()).trim();
      }
      if (!isIPv4(ip) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set a valid PHOENIX_PUBLIC_IP and PHOENIX_HTTPS_PORT.');
      host.publicUrl = `https://${ip}:${port}`;
    }
    if (options.url) host.publicUrl = options.url;
    server = createWebServer(host);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(options.port, process.env.PHOENIX_BIND || '127.0.0.1', resolve);
    });
    host.port = (server.address() as AddressInfo).port;
    log.info('web.ready', { url: host.publicUrl || `http://localhost:${host.port}` });
  }, async () => { if (server) await new Promise<void>(resolve => { server!.closeWebSockets?.(); server!.close(() => resolve()); server!.closeAllConnections(); }); });
}
