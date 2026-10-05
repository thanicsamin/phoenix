import type { Attachment } from './types.ts';
import type { Config, Cleanup, QueuedMessage, SteeringMessage, ChatRecord, NativeExtension, Job, Notice, ChatSnapshot, ChatState } from './types.ts';
import type { AgentSession, ModelRuntime, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { BrowserControl } from './browser-control.ts';
import type { Plaid } from './plaid.ts';
import type { Internet } from '../extensions/internet.ts';
import type { createAuth } from '../extensions/auth.ts';
import type { Interface } from './interface.ts';
import type { Generations } from './generations.ts';
import type { WebServer } from './socket.ts';
import { errorOf } from './errors.ts';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { modelChoices, providerChoices } from './models.ts';
import { parseEndpoint, saveEndpoint } from './local-models.ts';
import { jobSchema, jobUpdateSchema, modelSchema, thinkingSchema, folderSchema, foldersSchema, validLabel } from './config.ts';
import { Files } from './files.ts';
import { Workspace } from './workspace.ts';
import { log, redact } from './log.ts';

export function textOf(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) return '';
  const content = message.content;
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((part: unknown): part is { type: 'text'; text: string } => !!part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string').map(part => part.text).join('\n') : '';
}

function attachmentOf(details: unknown): Attachment | undefined {
  if (!details || typeof details !== 'object' || !('attachment' in details)) return;
  const value = details.attachment;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value as Attachment;
}

// Each conversation has its own queue and Pi session. Other chats keep running.
export class Chat extends EventEmitter {
  config: Config; dataDir: string; workspace: string;
  revision = 0; pending = 0; closing = false; extensions: Record<string, string> = {};
  current = ''; tool = ''; error = ''; queue: Promise<void>; cleanups: Cleanup[];
  source: string; queued: QueuedMessage[]; steering: SteeringMessage[]; generation: number;
  waitAbort: AbortController; session!: AgentSession; files?: Files; chatId = 'main';
  browserControl?: BrowserControl; lastUsed = Date.now(); unsubscribe?: () => void; notice?: Notice;
  constructor(config: Config, dataDir: string, workspace: string) {
    super();
    this.config = config; this.dataDir = dataDir; this.workspace = workspace;
    this.queue = Promise.resolve();
    this.cleanups = [];
    this.source = 'web';
    this.queued = [];
    this.steering = [];
    this.generation = 0;
    this.waitAbort = new AbortController();
  }
  changed() { this.revision++; this.emit('change'); }
  attach(session: AgentSession) {
    this.session = session;
    this.unsubscribe = session.subscribe(event => {
      if (event.type === 'message_start' && event.message.role === 'user') {
        const delivered = this.steering.find(item => item.message === textOf(event.message));
        if (delivered) { this.steering = this.steering.filter(item => item !== delivered); this.source = 'web'; }
      }
      if (event.type === 'message_start' && event.message.role === 'assistant') this.current = '';
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') this.current += event.assistantMessageEvent.delta;
      if (event.type === 'message_end' && event.message.role === 'assistant') this.current = '';
      if (event.type === 'tool_execution_start') {
        this.tool = event.toolName;
        log.debug('tool.started', { chatId: this.chatId, tool: event.toolName });
      }
      if (event.type === 'tool_execution_end') {
        this.tool = '';
        log[event.isError ? 'warn' : 'debug']('tool.finished', { chatId: this.chatId, tool: event.toolName, failed: !!event.isError });
      }
      this.changed();
    });
  }
  submit(message: string, source = 'web', images: ImageContent[] = []) {
    if (this.closing) return Promise.reject(new Error('Agent is shutting down.'));
    if (typeof message !== 'string' || !message.trim() || message.length > 40000 || (this.files?.display(message, this.chatId).text || message).length > 32000) return Promise.reject(new Error('Message must contain 1–32000 characters.'));
    if (this.pending >= 10) return Promise.reject(new Error('Agent queue is full. Try again shortly.'));
    this.pending++;
    const runId = randomUUID();
    const queued: QueuedMessage = { id: runId, version: 0, message, source, images };
    const origin = source === 'web' ? 'web' : source.startsWith('Scheduled task:') ? 'scheduler' : source === 'Incoming email' ? 'email' : 'channel';
    const generation = this.generation;
    const waitSignal = this.waitAbort.signal;
    this.queued.push(queued);
    this.changed();
    const job = this.queue.then(async () => {
      await this.browserControl?.wait(waitSignal);
      if (this.closing) throw new Error('Agent is shutting down.');
      if (generation !== this.generation) throw new Error('Request cancelled.');
      this.queued = this.queued.filter(item => item !== queued);
      this.error = '';
      this.source = source;
      const started = performance.now();
      log.info('run.started', { runId, chatId: this.chatId, origin, queued: this.pending - 1 });
      const start = this.session.messages.length;
      try {
        await this.session.prompt(source === 'web' ? queued.message : `[${source}]\n${queued.message}`, { expandPromptTemplates: false, images: queued.images });
        await this.session.waitForIdle();
        const replies = this.session.messages.slice(start).filter(item => item.role === 'assistant');
        if (replies.some(item => item.stopReason === 'aborted')) throw new Error('Request cancelled.');
        const failed = replies.find(item => item.stopReason === 'error');
        if (failed) throw new Error(failed.errorMessage || 'The model request failed.');
        log.info('run.finished', { runId, chatId: this.chatId, durationMs: Math.round(performance.now() - started) });
        this.notice = { id: runId, type: 'reply' };
        return replies.map(textOf).filter(Boolean).join('\n\n') || 'Done.';
      } catch (caught) { const error = errorOf(caught);
        if (error.message !== 'Request cancelled.') this.notice = { id: runId, type: 'error' };
        log[error.message === 'Request cancelled.' ? 'info' : 'error']('run.failed', { runId, chatId: this.chatId, durationMs: Math.round(performance.now() - started), error });
        throw error;
      }
    });
    this.queue = job.then(() => {}).catch(caught => { const error = errorOf(caught); this.error = error.message; }).finally(() => {
      this.pending--;
      this.queued = this.queued.filter(item => item !== queued);
      this.current = '';
      this.tool = '';
      this.source = 'web';
      this.steering = [];
      this.changed();
    });
    return job;
  }
  editable(id: string, version: number) {
    const queued = this.queued.find(item => item.id === id && item.source === 'web');
    if (!queued) throw Object.assign(Error('This message has already started or was cancelled.'), { status: 409 });
    if (queued.version !== version) throw Object.assign(Error('This queued message changed in another window. Reopen it to edit.'), { status: 409 });
    return queued;
  }
  async steer(message: string, images: ImageContent[] = []) {
    if (this.browserControl?.controlled) throw Object.assign(new Error('Return browser control to the agent first.'), { status: 409 });
    if (this.closing || !this.pending || !this.session.isStreaming) throw Object.assign(new Error('Steer is available while the agent is responding.'), { status: 409 });
    if (!message.trim() || message.length > 40000 || (this.files?.display(message, this.chatId).text || message).length > 32000 || this.steering.length >= 10) throw Object.assign(new Error('Write a steering message of up to 32000 characters.'), { status: 400 });
    const queued: SteeringMessage = { message, source: 'web', steered: true }; this.steering.push(queued); this.changed();
    try { await this.session.prompt(message, { expandPromptTemplates: false, streamingBehavior: 'steer', images }); }
    catch (caught) { const error = errorOf(caught); this.steering = this.steering.filter(item => item !== queued); this.changed(); throw error; }
  }
  cancelQueued() { this.generation++; this.waitAbort.abort(Error('Request cancelled.')); this.waitAbort = new AbortController(); }
  state(): ChatSnapshot {
    // Only the visible tail is needed, even after thousands of tool calls.
    const history = this.session.messages; const messages: ChatSnapshot['messages'] = [];
    for (let index = history.length - 1; index >= 0 && messages.length < 100; index--) {
      const message = history[index];
      if (message.role === 'toolResult') {
        const attachment = message.toolName === 'attach_file' && attachmentOf(message.details);
        if (attachment) messages.push({ role: 'assistant', text: '', attachments: [attachment] });
      } else if (message.role === 'user' || message.role === 'assistant') {
        const text = textOf(message); const display = this.files?.display(text, this.chatId) || { text };
        if (display.text || display.attachments?.length) messages.push({ role: message.role, ...display });
      }
    }
    messages.reverse();
    return {
      revision: this.revision, name: this.config.name, model: this.session.model || this.config.model,
      thinking: this.session.thinkingLevel || 'off', thinkingLevels: this.session.getAvailableThinkingLevels?.() || ['off'],
      configured: this.session.modelRuntime.hasConfiguredAuth((this.session.model || this.config.model).provider),
      extensions: this.extensions, busy: this.pending > 0, steerable: this.pending > 0 && !!this.session.isStreaming, current: this.current, tool: this.tool, error: this.error,
      messages: [...messages,
        ...[...this.queued, ...this.steering].map(({ id, version, source, message, steered }) => ({ role: 'user', ...(this.files?.display(message, this.chatId) || { text: message }), queued: true, steered, ...(source === 'web' && !steered ? { queueId: id, version } : {}) }))],
    };
  }
  async close() {
    this.closing = true;
    await this.session?.abort();
    await this.queue;
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch (caught) { const error = errorOf(caught); log.error('extension.cleanup_failed', { chatId: this.chatId, error }); }
    }
    this.unsubscribe?.();
    this.session?.dispose();
  }
}

export class Host extends EventEmitter {
  config: Config; dataDir: string; workspace: string; revision = 0; closing = false;
  extensions: Record<string, string> = {}; chats = new Map<string, Promise<Chat>>();
  records: ChatRecord[] = []; loaded = new Map<string, Chat>();
  folders: string[] = [];
  deleting = new Set<string>();
  approvals = new Map<string, { id: string; chatId: string; tool: string; args: unknown; reason?: string; resolve: (allow: boolean) => void; timer: NodeJS.Timeout; cleanup: Cleanup }>();
  cleanups: Cleanup[] = []; sessionExtensions: NativeExtension[] = []; startedExtensions = new Set<string>();
  writeQueue: Promise<void>; files!: Files; workspaceFiles!: Workspace;
  createSession!: (id: string) => Promise<AgentSession>; modelRuntime!: ModelRuntime;
  providerUpdating = false; providerWrite: Promise<void> = Promise.resolve();
  browserControls?: Map<string, BrowserControl>; internet?: Internet; plaid?: Plaid; auth!: Awaited<ReturnType<typeof createAuth>>;
  memoryQueue: Promise<unknown> = Promise.resolve(); display?: Promise<string>;
  browserPages?: Map<string, () => string | undefined>; browserClosers?: Map<string, Cleanup>;
  ui!: Interface; generations!: Generations; restarting = false; publicUrl?: string;
  port?: number; webServer?: WebServer; tunnelUrl?: string;
  applySetup!: (input: unknown) => Promise<void>; requestRestart!: () => void;
  runJob!: (chatId: string, id: string) => Promise<void>;
  constructor(config: Config, dataDir: string, workspace: string) {
    super();
    this.config = config; this.dataDir = dataDir; this.workspace = workspace;
    this.writeQueue = Promise.resolve();
  }
  changed() { this.revision++; this.emit('change'); }
  async initialize() {
    this.files = new Files(this.dataDir, this.workspace); await this.files.initialize();
    this.workspaceFiles = new Workspace(this.workspace); await this.workspaceFiles.initialize(this.config);
    try { this.records = JSON.parse(await readFile(join(this.dataDir, 'chats.json'), 'utf8')); }
    catch (caught) { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(this.records) || this.records.some(record => !/^(main|[0-9a-f-]{36})$/.test(record.id)
      || (record.archived !== undefined && typeof record.archived !== 'boolean') || (record.pinned !== undefined && typeof record.pinned !== 'boolean')
      || (record.lastSentAt !== undefined && (!Number.isSafeInteger(record.lastSentAt) || record.lastSentAt < 0))
      || (record.folder !== undefined && !folderSchema.safeParse(record.folder).success)
      || (record.autoTitle !== undefined && typeof record.autoTitle !== 'boolean')
      || (record.deleted !== undefined && typeof record.deleted !== 'boolean')
      || (record.readRisk !== undefined && (!Number.isInteger(record.readRisk) || record.readRisk < 0 || record.readRisk > 3))
      || typeof record.title !== 'string' || !Array.isArray(record.jobs) || !Array.isArray(record.permissions))) throw new Error('Invalid chat metadata.');
    if (!this.records.length) {
      this.records.push({ id: 'main', title: 'Main chat', jobs: [], permissions: [] });
      let mainApplied = false;
      for (const template of this.config.chats) {
        const useMain = template.main === true || !mainApplied && template.main === undefined && template.name === 'Main chat';
        const record = useMain ? this.records[0] : { id: randomUUID(), title: template.name, jobs: [], permissions: [] };
        if (useMain) { mainApplied = true; record.title = template.name; }
        record.model = template.model; record.thinking = template.thinking; record.folder = template.folder;
        record.jobs = template.jobs.map(job => this.jobRecord(job));
        if (record.id !== 'main') this.records.push(record);
      }
      await this.save();
    }
    try { this.folders = foldersSchema.parse(JSON.parse(await readFile(join(this.dataDir, 'folders.json'), 'utf8'))); }
    catch (caught) { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; this.folders = [...(this.config.folders || ['Diary', 'Shopping', 'Todo'])]; }
    // Keep chats accessible after a partial folder update or an older-generation rollback.
    for (const record of this.records) if (record.folder) {
      const existing = this.folders.find(folder => folder.toLowerCase() === record.folder!.toLowerCase());
      if (existing) record.folder = existing;
      else if (this.folders.length < 32) this.folders.push(record.folder);
      else delete record.folder;
    }
    await this.saveFolders();
    // Complete interrupted deletions before any sessions or scheduled jobs start.
    for (const record of [...this.records]) if (record.deleted) await this.deleteChat(record.id);
    const timer = setInterval(() => {
      for (const chat of this.loaded.values()) {
        if (chat.chatId !== 'main' && !chat.pending && !chat.browserControl?.controlled && Date.now() - chat.lastUsed > 5 * 60000 && ![...this.approvals.values()].some(item => item.chatId === chat.chatId)) this.unload(chat.chatId).catch(() => {});
      }
    }, 60000);
    timer.unref(); this.cleanups.push(() => { clearInterval(timer); });
  }
  save() {
    const body = JSON.stringify(this.records, null, 2);
    const path = join(this.dataDir, 'chats.json');
    const save = this.writeQueue.then(async () => { await writeFile(`${path}.tmp`, body, { mode: 0o600 }); await rename(`${path}.tmp`, path); });
    this.writeQueue = save.catch(() => {});
    this.changed(); return save;
  }
  record(id = 'main') {
    const record = this.records.find(chat => chat.id === id);
    if (!record || record.deleted || this.deleting.has(id)) throw Object.assign(new Error('Chat not found.'), { status: 404 });
    return record;
  }
  saveFolders() {
    const body = JSON.stringify(this.folders); const path = join(this.dataDir, 'folders.json');
    const save = this.writeQueue.then(async () => { await writeFile(`${path}.tmp`, body, { mode: 0o600 }); await rename(`${path}.tmp`, path); });
    this.writeQueue = save.catch(() => {}); this.changed(); return save;
  }
  async updateFolder(input: { name?: unknown; previous?: unknown; remove?: unknown }) {
    const previous = input.previous;
    if (previous !== undefined && (typeof previous !== 'string' || !this.folders.includes(previous))) throw Object.assign(Error('Choose an existing folder.'), { status: 400 });
    if (input.remove !== undefined && typeof input.remove !== 'boolean') throw Object.assign(Error('Choose whether to remove the folder.'), { status: 400 });
    if (input.remove) {
      if (!previous) throw Object.assign(Error('Choose an existing folder.'), { status: 400 });
      this.folders = this.folders.filter(name => name !== previous);
      for (const record of this.records) if (record.folder === previous) delete record.folder;
    } else {
      const parsed = folderSchema.safeParse(input.name);
      if (!parsed.success) throw Object.assign(Error('Choose a folder name of up to 60 characters.'), { status: 400 });
      const name = parsed.data;
      if (this.folders.some(folder => folder !== previous && folder.toLowerCase() === name.toLowerCase())) throw Object.assign(Error('That folder already exists.'), { status: 409 });
      if (previous === undefined && this.folders.length >= 32) throw Object.assign(Error('Folder limit reached.'), { status: 409 });
      this.folders = previous === undefined ? [...this.folders, name] : this.folders.map(folder => folder === previous ? name : folder);
      for (const record of this.records) if (previous !== undefined && record.folder === previous) record.folder = name;
    }
    await this.saveFolders(); await this.save(); return {};
  }
  async updateChat(id: unknown, input: { title?: unknown; folder?: unknown; automatic?: boolean }) {
    if (typeof id !== 'string') throw Object.assign(Error('Choose a chat.'), { status: 400 });
    const record = this.record(id);
    if (input.automatic && !record.autoTitle) return record; // Never overwrite an owner's chosen title.
    if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100 || !validLabel(input.title))) throw Object.assign(Error('Choose a chat name of up to 100 characters.'), { status: 400 });
    if (input.folder !== undefined && (typeof input.folder !== 'string' || input.folder && !this.folders.includes(input.folder))) throw Object.assign(Error('Choose an existing folder.'), { status: 400 });
    if (input.title !== undefined) { record.title = redact((input.title as string).trim()); record.autoTitle = false; }
    if (input.folder !== undefined) record.folder = (input.folder as string) || undefined;
    await this.save(); return record;
  }
  async createChat(title?: string, route?: string, folder?: string, fromChatId?: string) {
    if (this.records.length >= 100) throw Object.assign(new Error('Chat limit reached.'), { status: 409 });
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 100 || !validLabel(title))) throw Object.assign(new Error('Choose a chat name of up to 100 characters.'), { status: 400 });
    if (folder !== undefined && (typeof folder !== 'string' || folder && !this.folders.includes(folder))) throw Object.assign(Error('Choose an existing folder.'), { status: 400 });
    if (fromChatId !== undefined && typeof fromChatId !== 'string') throw Object.assign(Error('Choose a source chat.'), { status: 400 });
    const source = fromChatId === undefined ? undefined : this.record(fromChatId);
    const record: ChatRecord = { id: randomUUID(), title: title?.trim() || 'New chat', autoTitle: !title && !route, lastSentAt: this.nextActivity(), folder: folder || undefined, jobs: [], permissions: [], ...(route ? { route } : {}) };
    if (source) { record.model = source.model || this.config.model; record.thinking = this.loaded.get(source.id)?.session.thinkingLevel || source.thinking; }
    this.records.push(record); await this.save(); return record;
  }
  async archiveChat(id: unknown, archived: unknown) {
    if (typeof id !== 'string' || typeof archived !== 'boolean') throw Object.assign(new Error('Choose whether to archive this chat.'), { status: 400 });
    const record = this.record(id);
    if (id === 'main' && archived) throw Object.assign(new Error('The main chat stays available. Archive a side chat instead.'), { status: 409 });
    record.archived = archived; await this.save();
    return { id, archived };
  }
  async deleteChat(id: string) {
    const record = this.records.find(record => record.id === id);
    if (!record || this.deleting.has(id)) throw Object.assign(Error('Chat not found.'), { status: 404 });
    if (id === 'main') throw Object.assign(Error('The main chat stays available.'), { status: 409 });
    if (this.files.uploading || this.providerUpdating || this.closing || this.restarting) throw Object.assign(Error('Wait for uploads or setup changes to finish.'), { status: 409 });
    this.deleting.add(id);
    try {
      const jobs = record.jobs;
      record.deleted = true;
      record.jobs = []; // Older generations cannot revive interrupted deleted jobs either.
      try { await this.save(); } catch (error) { delete record.deleted; record.jobs = jobs; throw error; }
      for (const approval of [...this.approvals.values()]) if (approval.chatId === id) await this.approve(approval.id, false);
      const chat = await this.chats.get(id)?.catch(() => undefined);
      chat?.cancelQueued();
      await this.browserControls?.get(id)?.close();
      if (chat) await chat.close();
      await this.browserClosers?.get(id)?.();
      this.loaded.delete(id); this.chats.delete(id);
      await this.memoryQueue;
      for (const file of [...this.files.items]) if (file.chatId === id) await this.files.remove(file.id, id, true);
      for (const path of [join(this.dataDir, 'pi', 'sessions', id), join(this.dataDir, 'browser', id), join(this.workspace, 'uploads', id), join(this.workspace, 'memory', 'chats', id)]) await rm(path, { recursive: true, force: true });
      const previous = this.records;
      this.records = previous.filter(record => record.id !== id);
      try { await this.save(); } catch (error) { this.records = previous; throw error; }
      log.info('chat.deleted', { chatId: id });
      return { id };
    } finally { this.deleting.delete(id); this.changed(); }
  }
  async pinChat(id: unknown, pinned: unknown) {
    if (typeof id !== 'string' || typeof pinned !== 'boolean') throw Object.assign(Error('Choose whether to pin this chat.'), { status: 400 });
    const record = this.record(id);
    if (id === 'main') throw Object.assign(Error('The main chat already stays at the top.'), { status: 409 });
    record.pinned = pinned; await this.save(); return { id, pinned };
  }
  sent(id: string) {
    // A queue submission counts immediately; replies and scheduled runs do not.
    this.record(id).lastSentAt = this.nextActivity();
    this.save().catch(error => log.error('chat.order_save_failed', { error }));
  }
  nextActivity() { return Math.max(Date.now(), ...this.records.map(record => (record.lastSentAt || 0) + 1)); }
  async routeChat(route: string, title: string) {
    return this.records.find(chat => chat.route === route) || await this.createChat(title, route);
  }
  async getChat(id = 'main') {
    this.record(id);
    if (this.providerUpdating) await this.providerWrite;
    if (!this.chats.has(id)) {
      const pending = Promise.resolve().then(async () => {
        while (this.chats.size > 3) {
          const idle = [...this.loaded.values()].filter(chat => chat.chatId !== 'main' && !chat.pending && !chat.closing && !chat.browserControl?.controlled && ![...this.approvals.values()].some(item => item.chatId === chat.chatId)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (!idle) throw Object.assign(new Error('Three chats are active. Wait for one to finish.'), { status: 409 });
          await this.unload(idle.chatId);
        }
        const session = await this.createSession(id);
        const chat = new Chat(this.config, this.dataDir, this.workspace);
        chat.files = this.files; chat.chatId = id;
        chat.browserControl = this.browserControls?.get(id);
        chat.lastUsed = Date.now();
        chat.changed = () => this.changed();
        chat.attach(session);
        this.loaded.set(id, chat);
        await session.bindExtensions({ onError: error => log.error('pi.extension_failed', { chatId: id, error }) });
        return chat;
      });
      this.chats.set(id, pending);
      pending.catch(() => { this.chats.delete(id); this.loaded.delete(id); });
    }
    const chat = await this.chats.get(id)!; chat.lastUsed = Date.now(); return chat;
  }
  async unload(id: string) {
    const chat = this.loaded.get(id);
    if (!chat || chat.pending || chat.closing || chat.browserControl?.controlled) return;
    await chat.close(); this.loaded.delete(id); this.chats.delete(id);
  }
  async submit(message: string, source = 'web', id = 'main', attachmentIds: string[] = []) {
    if (this.closing) throw new Error('Agent is shutting down.');
    const chat = await this.getChat(id);
    const input = await this.files.prepare(message, attachmentIds, id, chat.session.model);
    await this.markAttachments(id, attachmentIds);
    const pending = chat.pending;
    if (this.providerUpdating) throw Object.assign(Error('Provider settings are being updated. Try again shortly.'), { status: 409 });
    const result = chat.submit(input.message, source, input.images);
    if (source === 'web' && chat.pending > pending) {
      const record = this.record(id);
      if (record.autoTitle && record.title === 'New chat') record.title = [...redact(message.trim() || 'Attachments').replace(/\s+/g, ' ')].filter(char => validLabel(char)).join('').split(' ').slice(0, 10).join(' ').slice(0, 80) || 'New chat';
      this.sent(id);
    }
    return result;
  }
  async steer(message: string, id = 'main', attachmentIds: string[] = []) {
    const chat = await this.getChat(id);
    const input = await this.files.prepare(message, attachmentIds, id, chat.session.model);
    await this.markAttachments(id, attachmentIds);
    const result = chat.steer(input.message, input.images);
    if (chat.steering.some(item => item.message === input.message)) this.sent(id);
    return result;
  }
  async editQueued(id: string, queueId: string, version: number, message: string, attachments: string[] = []) {
    const chat = await this.getChat(id);
    chat.editable(queueId, version);
    const input = await this.files.prepare(message, attachments, id, chat.session.model);
    await this.markAttachments(id, attachments);
    const queued = chat.editable(queueId, version); // Upload preparation can yield to the running task.
    queued.message = input.message; queued.images = input.images; queued.version++;
    chat.changed();
  }
  async markAttachments(id: string, attachments: string[]) {
    if (!attachments.length || !this.config.extensions?.permissions) return;
    const record = this.record(id);
    // Uploaded documents/images may contain private data and outside instructions.
    if (record.readRisk !== 3) { record.readRisk = 3; await this.save(); }
  }
  async state(id = 'main'): Promise<ChatState> {
    const chat = await this.getChat(id);
    const record = this.record(id);
    const snapshot = chat.state();
    return { ...snapshot, browser: this.browserControls?.get(id)?.state(), models: this.modelRuntime ? modelChoices(this.modelRuntime, snapshot.model) : [], providers: this.modelRuntime ? providerChoices(this.modelRuntime) : [], revision: this.revision, uiVersion: this.ui?.version, internet: this.internet?.status(), chatId: id, title: record.title, folder: record.folder, folders: this.folders, archived: !!record.archived, pinned: !!record.pinned, extensions: this.extensions,
      chats: this.records.filter(chat => !chat.deleted).sort((a, b) => Number(b.id === 'main') - Number(a.id === 'main') || Number(!!b.pinned) - Number(!!a.pinned) || (b.lastSentAt || 0) - (a.lastSentAt || 0)).map(({ id, title, jobs, archived, pinned, folder }) => ({ id, title, folder, archived: !!archived, pinned: !!pinned, jobs: jobs.filter(job => job.enabled).length,
        busy: (this.loaded.get(id)?.pending || 0) > 0, notice: this.loaded.get(id)?.notice, approval: [...this.approvals.values()].find(item => item.chatId === id)?.id || false as const })), jobs: record.jobs,
      approvals: [...this.approvals.values()].filter(approval => approval.chatId === id).map(({ id, tool, args, reason }) => ({ id, tool, args, reason })),
    };
  }
  async exportSetup() {
    const workspace = await this.workspaceFiles.export();
    return { ...this.config, folders: this.folders, workspace, instructions: workspace['AGENTS.md'] || this.config.instructions, chats: this.records.filter(chat => !chat.route && !chat.deleted).map(chat => ({ name: chat.title, main: chat.id === 'main', ...(chat.folder ? { folder: chat.folder } : {}), ...(chat.model ? { model: chat.model } : {}), ...(chat.thinking ? { thinking: chat.thinking } : {}),
      jobs: chat.jobs.filter(job => job.enabled).map(({ name, prompt, everyMinutes, nextRunAt }) => ({ name, prompt, everyMinutes, ...(nextRunAt ? { nextRunAt } : {}) })),
    })) };
  }
  async setModel(chatId: string, input: { model?: unknown; thinking?: unknown }) {
    if (this.providerUpdating) throw Object.assign(Error('Provider settings are being updated. Try again shortly.'), { status: 409 });
    const selection = modelSchema.safeParse(input.model);
    const thinking = thinkingSchema.safeParse(input.thinking);
    if (!selection.success || !thinking.success) throw Object.assign(new Error('Choose a valid model and thinking level.'), { status: 400 });
    const chat = await this.getChat(chatId);
    if (this.providerUpdating) throw Object.assign(Error('Provider settings are being updated. Try again shortly.'), { status: 409 });
    if (chat.pending) throw Object.assign(new Error('Wait for this chat to finish.'), { status: 409 });
    const model = this.modelRuntime.getModel(selection.data.provider, selection.data.id);
    if (!model) throw Object.assign(new Error('Unknown model.'), { status: 400 });
    if (!this.modelRuntime.hasConfiguredAuth(model.provider)) throw Object.assign(new Error('Connect a provider in Settings first.'), { status: 400 });
    await chat.session.setModel(model);
    chat.session.setThinkingLevel(thinking.data);
    const record = this.record(chatId);
    record.model = selection.data; record.thinking = chat.session.thinkingLevel;
    chat.error = ''; await this.save();
  }
  configureEndpoint(input: unknown) {
    const endpoint = parseEndpoint(input);
    if (this.closing || this.restarting || this.providerUpdating || [...this.chats.keys()].some(id => !this.loaded.has(id)) || [...this.loaded.values()].some(chat => chat.pending)) throw Object.assign(Error('Wait for active chats or provider changes to finish.'), { status: 409 });
    const selections = [this.config.model, ...this.records.map(chat => chat.model).filter(model => model !== undefined), ...[...this.loaded.values()].map(chat => chat.session.model).filter(model => model !== undefined)];
    if (selections.some(model => model.provider === endpoint.provider && !endpoint.modelIds.includes(model.id))) throw Object.assign(Error('Change chats using a model before removing it from this server.'), { status: 409 });
    this.providerUpdating = true;
    this.providerWrite = (async () => {
      await saveEndpoint(this.modelRuntime, this.dataDir, endpoint);
      for (const chat of this.loaded.values()) if (chat.session.model?.provider === endpoint.provider) {
        await chat.session.setModel(this.modelRuntime.getModel(endpoint.provider, chat.session.model.id)!);
      }
      this.changed();
    })().finally(() => { this.providerUpdating = false; });
    return this.providerWrite;
  }
  jobRecord(input: unknown): Job {
    const job = jobSchema.parse(input);
    return { ...job, id: randomUUID(), enabled: true,
      nextRunAt: job.nextRunAt || new Date(Date.now() + Math.max(1, job.everyMinutes) * 60000).toISOString(), lastError: '' };
  }
  async addJob(chatId: string, input: unknown) {
    const record = this.record(chatId);
    if (record.jobs.length >= 20) throw Object.assign(new Error('Job limit reached for this chat.'), { status: 409 });
    const job = this.jobRecord(input); record.jobs.push(job); await this.save(); return job;
  }
  async updateJob(chatId: string, id: string, input: unknown) {
    const job = this.record(chatId).jobs.find(job => job.id === id);
    if (!job) throw Object.assign(Error('Job not found in this chat.'), { status: 404 });
    if (job.running) throw Object.assign(Error('Wait for this job to finish.'), { status: 409 });
    const changes = jobUpdateSchema.parse(input);
    const nextRunAt = changes.nextRunAt ?? (changes.everyMinutes !== undefined && changes.everyMinutes !== job.everyMinutes
      ? new Date(Date.now() + Math.max(1, changes.everyMinutes) * 60000).toISOString() : job.nextRunAt);
    if ((changes.enabled ?? job.enabled) && !nextRunAt) throw Error('Set nextRunAt when restarting a completed task.');
    Object.assign(job, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)), { nextRunAt });
    await this.save(); return job;
  }
  async removeJob(chatId: string, id: string) {
    const record = this.record(chatId); const job = record.jobs.find(job => job.id === id);
    if (!job) throw Object.assign(Error('Job not found in this chat.'), { status: 404 });
    if (job.running) throw Object.assign(Error('Wait for this job to finish.'), { status: 409 });
    record.jobs = record.jobs.filter(item => item !== job); await this.save();
  }
  async requestApproval(chatId: string, tool: string, args: unknown, signal?: AbortSignal, reason?: string): Promise<boolean> {
    if (!reason && tool !== 'browser_verification' && this.record(chatId).permissions.includes(tool)) return true;
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => this.approve(id, false).catch(() => {}), 10 * 60 * 1000);
      const abort = () => this.approve(id, false).catch(() => {});
      this.approvals.set(id, { id, chatId, tool, args, reason, resolve, timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true }); this.changed();
    });
  }
  async approve(id: string, allow: boolean, remember = false) {
    const approval = this.approvals.get(id);
    if (!approval) throw Object.assign(new Error('Approval expired.'), { status: 404 });
    if (remember && allow && !approval.reason && approval.tool !== 'browser_verification') {
      const permissions = this.record(approval.chatId).permissions;
      if (!permissions.includes(approval.tool)) permissions.push(approval.tool);
      await this.save();
    }
    clearTimeout(approval.timer); approval.cleanup?.(); this.approvals.delete(id); approval.resolve(allow); this.changed();
  }
  async close() {
    this.closing = true;
    for (const control of this.browserControls?.values() || []) await control.close();
    await this.providerWrite.catch(() => {});
    for (const approval of [...this.approvals.values()]) await this.approve(approval.id, false);
    for (const pending of this.chats.values()) {
      const chat = await pending.catch(() => undefined);
      if (chat) { chat.closing = true; await chat.session.abort(); await chat.queue; chat.unsubscribe?.(); chat.session.dispose(); }
    }
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch (caught) { const error = errorOf(caught); log.error('extension.cleanup_failed', { error }); }
    }
    await this.writeQueue;
    await this.files.writes;
  }
}

// Native Pi lifecycle; also keep cleanups available for host shutdown/startup failure.
export function lifecycle(pi: ExtensionAPI, host: Host, name: string, start: Cleanup, stop?: Cleanup) {
  const displayName = name.split(':')[0];
  let closed = false;
  let started = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    await stop?.();
  };
  host.cleanups.push(cleanup);
  pi.on('session_start', async () => {
    if (started) return;
    if (host.startedExtensions?.has(name)) return;
    started = true;
    host.startedExtensions?.add(name);
    try { await start(); host.extensions[displayName] = 'ready'; log.info('extension.ready', { extension: displayName }); }
    catch (caught) { const error = errorOf(caught); host.extensions[displayName] = 'failed'; log.error('extension.start_failed', { extension: displayName, error }); }
    host.changed();
  });
  pi.on('session_shutdown', cleanup);
}
