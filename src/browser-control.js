// Human input goes directly to Chromium; never through Pi messages or tools.
export class BrowserControl {
  constructor(host, chatId, browser) {
    Object.assign(this, { host, chatId, browser, controlled: false, socket: undefined, closed: false });
    this.waiters = new Set();
    this.inputs = Promise.resolve();
  }
  state() { return { available: true, controlled: this.controlled, connected: !!this.socket }; }
  async wait(signal) {
    while (this.controlled && !this.closed) await new Promise((resolve, reject) => {
      const cleanup = () => { this.waiters.delete(done); signal?.removeEventListener('abort', abort); };
      const done = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.waiters.add(done);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
    if (this.closed || this.host.closing) throw Error('Browser is closing.');
    signal?.throwIfAborted();
  }
  async claim(socket, width, height) {
    if (this.closed || this.releasing || this.claiming || this.socket && this.socket !== socket) throw Error('Browser is already controlled in another window.');
    this.claiming = true;
    try {
      this.socket = socket; clearTimeout(this.idle);
      const chat = this.host.loaded?.get(this.chatId);
      this.interrupted ||= !this.controlled && !!chat?.pending;
      this.controlled = true; this.host.changed();
      // Stop active model/tool work before displaying the private login surface.
      for (const approval of [...this.host.approvals?.values() || []]) if (approval.chatId === this.chatId) await this.host.approve(approval.id, false);
      if (chat?.pending) { await chat.session.abort(); await chat.session.waitForIdle(); }
      if (chat) { chat.error = ''; this.host.changed(); }
      if (this.socket !== socket) return;
      const page = await this.browser.ensure();
      await page.setViewportSize({ width, height });
      await this.watch(page, socket);
    } finally { this.claiming = false; }
  }
  async view(socket) {
    if (this.closed || this.releasing || this.socket && this.socket !== socket) throw Error('Browser is already open in another window.');
    this.socket = socket; clearTimeout(this.idle); this.host.changed();
    try { await this.watch(await this.browser.ensure(), socket); if (!this.controlled) this.browser.idle(); }
    catch (error) { await this.disconnect(socket); throw error; }
  }
  async watch(page, socket = this.socket) {
    if (!socket || this.socket !== socket || this.closed) return;
    const revision = this.watchRevision = (this.watchRevision || 0) + 1;
    await this.detach();
    if (this.socket !== socket) return;
    const cdp = await page.context().newCDPSession(page);
    if (this.socket !== socket || revision !== this.watchRevision) { await cdp.detach(); return; }
    this.viewport = page.viewportSize() || this.viewport || { width: 1280, height: 900 };
    // Watching must not resize the website or interrupt the agent's navigation.
    if (this.controlled) { await page.setViewportSize(this.viewport); await page.bringToFront(); }
    if (this.socket !== socket || revision !== this.watchRevision) { await cdp.detach(); return; }
    this.cdp = cdp; if (this.controlled) this.browser.use(page);
    const location = () => {
      if (this.socket !== socket) return;
      let origin = 'about:blank'; try { origin = new URL(page.url()).origin; } catch { /* Initial page. */ }
      const { width, height } = page.viewportSize() || this.viewport;
      socket.send(JSON.stringify({ type: 'ready', width, height, origin, controlled: this.controlled }));
    };
    page.on('framenavigated', location);
    const closed = () => {
      if (this.socket === socket && socket.readyState === 1) this.browser.ensure().then(page => this.watch(page, socket)).catch(() => {});
    };
    page.once('close', closed);
    this.unwatch = () => { page.off('framenavigated', location); page.off('close', closed); };
    location();
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      // Acknowledge at most four frames per second. Chromium bounds its own
      // in-flight frames; slow clients never build up a screenshot history.
      if (this.socket === socket && socket.readyState === 1 && socket.bufferedAmount < 1024 * 1024 && Date.now() - (this.lastFrame || 0) >= 250) {
        this.lastFrame = Date.now(); socket.send(Buffer.from(data, 'base64'));
      }
      const timer = setTimeout(() => cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}), 250);
      timer.unref();
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 900 });
  }
  input(socket, data) {
    if (this.socket !== socket || !this.controlled || this.closed || this.releasing) throw Error('Browser control has ended.');
    if ((this.pending || 0) >= 32) throw Error('Too many browser inputs.');
    this.pending = (this.pending || 0) + 1;
    const job = this.inputs.then(async () => {
      if (this.socket !== socket || !this.controlled || this.closed) return;
      const page = await this.browser.ensure();
      const { width, height } = page.viewportSize();
      if (data.type === 'click') {
        if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || data.x < 0 || data.x >= width || data.y < 0 || data.y >= height) throw Error('Invalid position.');
        await page.mouse.click(data.x, data.y);
      } else if (data.type === 'scroll') {
        if (!Number.isFinite(data.y) || Math.abs(data.y) > 2000) throw Error('Invalid scroll.');
        await page.mouse.wheel(0, data.y);
      } else if (data.type === 'text') {
        if (typeof data.text !== 'string' || data.text.length > 4096) throw Error('Invalid text.');
        await page.keyboard.insertText(data.text);
      } else if (data.type === 'key') {
        if (typeof data.key !== 'string' || !/^(?:(?:Control|Meta|Alt|Shift)\+)*(?:Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|[A-Za-z])$/.test(data.key)) throw Error('Invalid key.');
        await page.keyboard.press(data.key);
      } else if (data.type === 'navigate') {
        const url = new URL(data.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP or HTTPS address.');
        await this.browser.navigate(url.href);
      } else if (data.type === 'back') await page.goBack({ timeout: 15000, waitUntil: 'domcontentloaded' });
      else if (data.type === 'reload') await page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' });
      else throw Error('Unknown browser input.');
    });
    this.inputs = job.catch(() => {}).finally(() => { this.pending--; });
    return job;
  }
  async detach() {
    this.unwatch?.(); this.unwatch = undefined;
    const cdp = this.cdp; this.cdp = undefined;
    if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); }
  }
  async disconnect(socket) {
    if (this.socket !== socket) return;
    this.socket = undefined; await this.detach(); this.host.changed();
    // Keep the agent paused, but release Chromium RAM after a dropped viewer.
    if (this.controlled) { this.idle = setTimeout(() => this.browser.close().catch(() => {}), 3 * 60000); this.idle.unref(); }
    else this.browser.idle();
  }
  async release() {
    if (!this.controlled || this.closed || this.releasing || this.claiming) throw Object.assign(Error('Browser is not ready for handback.'), { status: 409 });
    this.releasing = true;
    clearTimeout(this.idle);
    await this.inputs;
    // Don't expose unfinished password/one-time-code fields in the next snapshot.
    try { await this.browser.clearSecrets(); await this.browser.persist?.(); }
    catch { this.releasing = false; throw Object.assign(Error('Could not clear login fields. Reconnect before handing back.'), { status: 409 }); }
    const interrupted = this.interrupted; this.interrupted = false;
    this.controlled = false; for (const done of this.waiters) done(); this.host.changed();
    this.releasing = false;
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'control', controlled: false }));
    this.browser.idle();
    const chat = this.host.loaded?.get(this.chatId);
    if (interrupted && chat && !chat.pending && !this.host.closing) {
      chat.submit('I have returned browser control to you. Continue the previous task using the current page.', 'web').catch(() => {});
    }
  }
  async close() {
    this.closed = true; this.controlled = false; clearTimeout(this.idle);
    this.socket?.close(1001, 'Browser closing'); this.socket = undefined;
    for (const done of this.waiters) done(); await this.detach();
  }
}
