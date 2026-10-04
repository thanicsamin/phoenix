import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { modelChoices } from './models.js';
import { jobSchema, modelSchema, thinkingSchema } from './config.js';
import { Files } from './files.js';
import { Workspace } from './workspace.js';
import { log } from './log.js';

export const textOf = (message) => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

// Each conversation has its own queue and Pi session. Other chats keep running.
export class Chat extends EventEmitter {
  constructor(config, dataDir, workspace) {
    super();
    Object.assign(this, { config, dataDir, workspace, revision: 0, pending: 0, closing: false, extensions: {}, current: '', tool: '', error: '' });
    this.queue = Promise.resolve();
    this.cleanups = [];
    this.source = 'web';
    this.queued = [];
    this.steering = [];
    this.generation = 0;
    this.waitAbort = new AbortController();
  }
  changed() { this.revision++; this.emit('change'); }
  attach(session) {
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
  submit(message, source = 'web', images = []) {
    if (this.closing) return Promise.reject(new Error('Agent is shutting down.'));
    if (typeof message !== 'string' || !message.trim() || message.length > 40000 || (this.files?.display(message, this.chatId).text || message).length > 32000) return Promise.reject(new Error('Message must contain 1–32000 characters.'));
    if (this.pending >= 10) return Promise.reject(new Error('Agent queue is full. Try again shortly.'));
    this.pending++;
    const runId = randomUUID();
    const queued = { id: runId, version: 0, message, source, images };
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
      } catch (error) {
        if (error.message !== 'Request cancelled.') this.notice = { id: runId, type: 'error' };
        log[error.message === 'Request cancelled.' ? 'info' : 'error']('run.failed', { runId, chatId: this.chatId, durationMs: Math.round(performance.now() - started), error });
        throw error;
      }
    });
    this.queue = job.catch(error => { this.error = error.message; }).finally(() => {
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
  editable(id, version) {
    const queued = this.queued.find(item => item.id === id && item.source === 'web');
    if (!queued) throw Object.assign(Error('This message has already started or was cancelled.'), { status: 409 });
    if (queued.version !== version) throw Object.assign(Error('This queued message changed in another window. Reopen it to edit.'), { status: 409 });
    return queued;
  }
  async steer(message, images = []) {
    if (this.browserControl?.controlled) throw Object.assign(new Error('Return browser control to the agent first.'), { status: 409 });
    if (this.closing || !this.pending || !this.session.isStreaming) throw Object.assign(new Error('Steer is available while the agent is responding.'), { status: 409 });
    if (!message.trim() || message.length > 40000 || (this.files?.display(message, this.chatId).text || message).length > 32000 || this.steering.length >= 10) throw Object.assign(new Error('Write a steering message of up to 32000 characters.'), { status: 400 });
    const queued = { message, source: 'web', steered: true }; this.steering.push(queued); this.changed();
    try { await this.session.prompt(message, { expandPromptTemplates: false, streamingBehavior: 'steer', images }); }
    catch (error) { this.steering = this.steering.filter(item => item !== queued); this.changed(); throw error; }
  }
  cancelQueued() { this.generation++; this.waitAbort.abort(Error('Request cancelled.')); this.waitAbort = new AbortController(); }
  state() {
    return {
      revision: this.revision, name: this.config.name, model: this.session.model || this.config.model,
      thinking: this.session.thinkingLevel || 'off', thinkingLevels: this.session.getAvailableThinkingLevels?.() || ['off'],
      configured: this.session.modelRuntime.hasConfiguredAuth((this.session.model || this.config.model).provider),
      extensions: this.extensions, busy: this.pending > 0, steerable: this.pending > 0 && !!this.session.isStreaming, current: this.current, tool: this.tool, error: this.error,
      messages: [...this.session.messages.filter(message => ['user', 'assistant'].includes(message.role) || message.role === 'toolResult' && message.toolName === 'attach_file' && message.details?.attachment)
        .slice(-100).map(message => message.role === 'toolResult'
          ? { role: 'assistant', text: '', attachments: [message.details.attachment] }
          : { role: message.role, ...(this.files?.display(textOf(message), this.chatId) || { text: textOf(message) }) }),
        ...[...this.queued, ...this.steering].map(({ id, version, source, message, steered }) => ({ role: 'user', ...(this.files?.display(message, this.chatId) || { text: message }), queued: true, steered, ...(source === 'web' && !steered ? { queueId: id, version } : {}) }))],
    };
  }
  async close() {
    this.closing = true;
    await this.session?.abort();
    await this.queue;
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch (error) { log.error('extension.cleanup_failed', { chatId: this.chatId, error }); }
    }
    this.unsubscribe?.();
    this.session?.dispose();
  }
}

export class Host extends EventEmitter {
  constructor(config, dataDir, workspace) {
    super();
    Object.assign(this, { config, dataDir, workspace, revision: 0, closing: false, extensions: {}, chats: new Map(),
      records: [], loaded: new Map(), approvals: new Map(), cleanups: [], sessionExtensions: [], startedExtensions: new Set() });
    this.writeQueue = Promise.resolve();
  }
  changed() { this.revision++; this.emit('change'); }
  async initialize() {
    this.files = new Files(this.dataDir, this.workspace); await this.files.initialize();
    this.workspaceFiles = new Workspace(this.workspace); await this.workspaceFiles.initialize(this.config);
    try { this.records = JSON.parse(await readFile(join(this.dataDir, 'chats.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(this.records) || this.records.some(record => !/^(main|[0-9a-f-]{36})$/.test(record.id)
      || (record.archived !== undefined && typeof record.archived !== 'boolean') || (record.pinned !== undefined && typeof record.pinned !== 'boolean')
      || (record.lastSentAt !== undefined && (!Number.isSafeInteger(record.lastSentAt) || record.lastSentAt < 0))
      || typeof record.title !== 'string' || !Array.isArray(record.jobs) || !Array.isArray(record.permissions))) throw new Error('Invalid chat metadata.');
    if (!this.records.length) {
      this.records.push({ id: 'main', title: 'Main chat', jobs: [], permissions: [] });
      for (const template of this.config.chats) {
        const record = template.name === 'Main chat' ? this.records[0] : { id: randomUUID(), title: template.name, jobs: [], permissions: [] };
        record.model = template.model; record.thinking = template.thinking;
        record.jobs = template.jobs.map(job => this.jobRecord(job));
        if (record.id !== 'main') this.records.push(record);
      }
      await this.save();
    }
    const timer = setInterval(() => {
      for (const chat of this.loaded.values()) {
        if (chat.chatId !== 'main' && !chat.pending && !chat.browserControl?.controlled && Date.now() - chat.lastUsed > 5 * 60000 && ![...this.approvals.values()].some(item => item.chatId === chat.chatId)) this.unload(chat.chatId).catch(() => {});
      }
    }, 60000);
    timer.unref(); this.cleanups.push(() => clearInterval(timer));
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
    if (!record) throw Object.assign(new Error('Chat not found.'), { status: 404 });
    return record;
  }
  async createChat(title = 'Side chat', route) {
    if (this.records.length >= 100) throw Object.assign(new Error('Chat limit reached.'), { status: 409 });
    if (typeof title !== 'string' || !title.trim() || title.length > 100) throw Object.assign(new Error('Choose a chat name of up to 100 characters.'), { status: 400 });
    const record = { id: randomUUID(), title: title.trim(), jobs: [], permissions: [], ...(route ? { route } : {}) };
    this.records.push(record); await this.save(); return record;
  }
  async archiveChat(id, archived) {
    if (typeof id !== 'string' || typeof archived !== 'boolean') throw Object.assign(new Error('Choose whether to archive this chat.'), { status: 400 });
    const record = this.record(id);
    if (id === 'main' && archived) throw Object.assign(new Error('The main chat stays available. Archive a side chat instead.'), { status: 409 });
    record.archived = archived; await this.save();
    return { id, archived };
  }
  async pinChat(id, pinned) {
    if (typeof id !== 'string' || typeof pinned !== 'boolean') throw Object.assign(Error('Choose whether to pin this chat.'), { status: 400 });
    const record = this.record(id);
    if (id === 'main') throw Object.assign(Error('The main chat already stays at the top.'), { status: 409 });
    record.pinned = pinned; await this.save(); return { id, pinned };
  }
  sent(id) {
    // A queue submission counts immediately; replies and scheduled runs do not.
    this.record(id).lastSentAt = Math.max(Date.now(), ...this.records.map(record => (record.lastSentAt || 0) + 1));
    this.save().catch(error => log.error('chat.order_save_failed', { error }));
  }
  async routeChat(route, title) {
    return this.records.find(chat => chat.route === route) || await this.createChat(title, route);
  }
  async getChat(id = 'main') {
    this.record(id);
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
        await session.bindExtensions({ mode: 'sdk', onError: error => log.error('pi.extension_failed', { chatId: id, error }) });
        return chat;
      });
      this.chats.set(id, pending);
      pending.catch(() => { this.chats.delete(id); this.loaded.delete(id); });
    }
    const chat = await this.chats.get(id); chat.lastUsed = Date.now(); return chat;
  }
  async unload(id) {
    const chat = this.loaded.get(id);
    if (!chat || chat.pending || chat.closing || chat.browserControl?.controlled) return;
    await chat.close(); this.loaded.delete(id); this.chats.delete(id);
  }
  async submit(message, source = 'web', id = 'main', attachmentIds = []) {
    if (this.closing) throw new Error('Agent is shutting down.');
    const chat = await this.getChat(id);
    const input = await this.files.prepare(message, attachmentIds, id, chat.session.model);
    const pending = chat.pending;
    const result = chat.submit(input.message, source, input.images);
    if (source === 'web' && chat.pending > pending) this.sent(id);
    return result;
  }
  async steer(message, id = 'main', attachmentIds = []) {
    const chat = await this.getChat(id);
    const input = await this.files.prepare(message, attachmentIds, id, chat.session.model);
    const result = chat.steer(input.message, input.images);
    if (chat.steering.some(item => item.message === input.message)) this.sent(id);
    return result;
  }
  async editQueued(id, queueId, version, message, attachments = []) {
    const chat = await this.getChat(id);
    chat.editable(queueId, version);
    const input = await this.files.prepare(message, attachments, id, chat.session.model);
    const queued = chat.editable(queueId, version); // Upload preparation can yield to the running task.
    queued.message = input.message; queued.images = input.images; queued.version++;
    chat.changed();
  }
  async state(id = 'main') {
    const chat = await this.getChat(id);
    const record = this.record(id);
    return { ...chat.state(), browser: this.browserControls?.get(id)?.state(), models: this.modelRuntime ? modelChoices(this.modelRuntime) : [], revision: this.revision, uiVersion: this.ui?.version, internet: this.internet?.status(), chatId: id, title: record.title, archived: !!record.archived, pinned: !!record.pinned, extensions: this.extensions,
      chats: [...this.records].sort((a, b) => Number(b.id === 'main') - Number(a.id === 'main') || Number(!!b.pinned) - Number(!!a.pinned) || (b.lastSentAt || 0) - (a.lastSentAt || 0)).map(({ id, title, jobs, archived, pinned }) => ({ id, title, archived: !!archived, pinned: !!pinned, jobs: jobs.filter(job => job.enabled).length,
        busy: (this.loaded.get(id)?.pending || 0) > 0, notice: this.loaded.get(id)?.notice, approval: [...this.approvals.values()].find(item => item.chatId === id)?.id || false })), jobs: record.jobs,
      approvals: [...this.approvals.values()].filter(approval => approval.chatId === id).map(({ id, tool, args }) => ({ id, tool, args })),
    };
  }
  async exportSetup() {
    const workspace = await this.workspaceFiles.export();
    return { ...this.config, workspace, instructions: workspace['AGENTS.md'] || this.config.instructions, chats: this.records.filter(chat => !chat.route).map(chat => ({ name: chat.title, ...(chat.model ? { model: chat.model } : {}), ...(chat.thinking ? { thinking: chat.thinking } : {}),
      jobs: chat.jobs.filter(job => job.enabled).map(({ name, prompt, everyMinutes, nextRunAt }) => ({ name, prompt, everyMinutes, ...(nextRunAt ? { nextRunAt } : {}) })),
    })) };
  }
  async setModel(chatId, input) {
    const selection = modelSchema.safeParse(input.model);
    const thinking = thinkingSchema.safeParse(input.thinking);
    if (!selection.success || !thinking.success) throw Object.assign(new Error('Choose a valid model and thinking level.'), { status: 400 });
    const model = this.modelRuntime.getModel(selection.data.provider, selection.data.id);
    if (!model) throw Object.assign(new Error('Unknown OpenCode model.'), { status: 400 });
    if (!this.modelRuntime.hasConfiguredAuth(model.provider)) throw Object.assign(new Error('Connect your OpenCode key first.'), { status: 400 });
    const chat = await this.getChat(chatId);
    if (chat.pending) throw Object.assign(new Error('Wait for this chat to finish.'), { status: 409 });
    await chat.session.setModel(model);
    chat.session.setThinkingLevel(thinking.data);
    const record = this.record(chatId);
    record.model = selection.data; record.thinking = chat.session.thinkingLevel;
    chat.error = ''; await this.save();
  }
  jobRecord(input) {
    const job = jobSchema.parse(input);
    return { ...job, id: randomUUID(), enabled: true,
      nextRunAt: job.nextRunAt || new Date(Date.now() + Math.max(1, job.everyMinutes) * 60000).toISOString(), lastError: '' };
  }
  async addJob(chatId, input) {
    const record = this.record(chatId);
    if (record.jobs.length >= 20) throw Object.assign(new Error('Job limit reached for this chat.'), { status: 409 });
    const job = this.jobRecord(input); record.jobs.push(job); await this.save(); return job;
  }
  async requestApproval(chatId, tool, args, signal) {
    if (tool !== 'browser_verification' && this.record(chatId).permissions.includes(tool)) return true;
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.approve(id, false).catch(() => {}), 10 * 60 * 1000);
      const abort = () => this.approve(id, false).catch(() => {});
      this.approvals.set(id, { id, chatId, tool, args, resolve, timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true }); this.changed();
    });
  }
  async approve(id, allow, remember = false) {
    const approval = this.approvals.get(id);
    if (!approval) throw Object.assign(new Error('Approval expired.'), { status: 404 });
    if (remember && allow && approval.tool !== 'browser_verification') {
      const permissions = this.record(approval.chatId).permissions;
      if (!permissions.includes(approval.tool)) permissions.push(approval.tool);
      await this.save();
    }
    clearTimeout(approval.timer); approval.cleanup?.(); this.approvals.delete(id); approval.resolve(allow); this.changed();
  }
  async close() {
    this.closing = true;
    for (const control of this.browserControls?.values() || []) await control.close();
    for (const approval of [...this.approvals.values()]) await this.approve(approval.id, false);
    for (const pending of this.chats.values()) {
      const chat = await pending.catch(() => undefined);
      if (chat) { chat.closing = true; await chat.session.abort(); await chat.queue; chat.unsubscribe?.(); chat.session.dispose(); }
    }
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch (error) { log.error('extension.cleanup_failed', { error }); }
    }
    await this.writeQueue;
    await this.files.writes;
  }
}

// Native Pi lifecycle; also keep cleanups available for host shutdown/startup failure.
export function lifecycle(pi, host, name, start, stop) {
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
    catch (error) { host.extensions[displayName] = 'failed'; log.error('extension.start_failed', { extension: displayName, error }); }
    host.changed();
  });
  pi.on('session_shutdown', cleanup);
}
