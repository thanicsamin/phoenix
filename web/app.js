const $ = selector => document.querySelector(selector);
let csrf = '';
let revision = -1;
let latest;
let signedIn = false;
let polling = false;
let chatId = 'main';
let showingArchived = false;
let socket;
let reconnect;
const drafts = new Map();
const draftMessages = new Map();
let uploading = 0;
let mutations = 0;
let queueEdit;
const notifications = window.initNotifications({ selectChat: async id => { if (!signedIn) return; switchChat(id); closeChats(); await refresh().catch(() => {}); } });
const attachments = () => drafts.get(chatId) || [];
const loadedUI = $('meta[name="ui-version"]')?.content;
let pendingUI;
let restoringScroll;
try {
  const saved = JSON.parse(sessionStorage.getItem('phoenix-drafts') || 'null');
  if (saved) { chatId = saved.chatId || 'main'; for (const item of saved.messages || []) draftMessages.set(...item); for (const item of saved.files || []) drafts.set(...item); restoringScroll = saved.scroll; queueEdit = saved.queueEdit; }
} catch { /* Storage may be disabled. */ }
const linkedChat = new URLSearchParams(location.search).get('chat');
if (linkedChat && /^(main|[0-9a-f-]{36})$/.test(linkedChat)) { chatId = linkedChat; history.replaceState(null, '', location.pathname); }
$('#message').value = draftMessages.get(chatId) || '';
$('#queue-edit').hidden = !queueEdit;
function persistDrafts() {
  draftMessages.set(chatId, $('#message').value);
  try { sessionStorage.setItem('phoenix-drafts', JSON.stringify({ chatId, messages: [...draftMessages], files: [...drafts], queueEdit, scroll: $('#chat-scroll').scrollTop })); } catch { /* Storage may be full or disabled. */ }
}
function sizeComposer() { const input = $('#message'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
function refreshInterface() {
  if (!pendingUI || document.querySelector('dialog[open]') || queueEdit || uploading || mutations || $('#microphone').getAttribute('aria-pressed') === 'true') return;
  persistDrafts(); location.reload();
}
function checkInterface(version) {
  if (!loadedUI || !version || version === loadedUI) return;
  pendingUI = version; $('#refresh-ui').hidden = false; refreshInterface();
}
// Preserve focus and selections when background state changes.
function stableChildren(selector, signature, build) {
  const element = $(selector); const key = JSON.stringify(signature);
  if (element.dataset.state !== key) { element.replaceChildren(...build()); element.dataset.state = key; }
}
function updateLatest() { const scroll = $('#chat-scroll'); $('#latest-message').hidden = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120; }
$('#chat-scroll').addEventListener('scroll', updateLatest);
$('#latest-message').addEventListener('click', () => { $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight; updateLatest(); });
$('#refresh-ui').addEventListener('click', refreshInterface);
window.addEventListener('pagehide', persistDrafts);
$('#message').addEventListener('input', () => { sizeComposer(); persistDrafts(); });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', refreshInterface);
function switchChat(id) {
  cancelQueueEdit();
  window.resetPreviews();
  notifications.read();
  window.stopVoice?.(); draftMessages.set(chatId, $('#message').value);
  chatId = id; $('#message').value = draftMessages.get(id) || ''; renderDrafts(); sizeComposer(); persistDrafts();
}

function connectSocket() {
  if (!signedIn) return;
  const url = new URL('/api/socket', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connection = new WebSocket(url); socket = connection;
  connection.addEventListener('open', () => connection.send(JSON.stringify({ chatId })));
  connection.addEventListener('message', event => {
    try { const state = JSON.parse(event.data); if (signedIn && state.chatId === chatId) render({ ...(latest?.chatId === chatId ? latest : {}), ...state }); } catch { /* polling remains available */ }
  });
  connection.addEventListener('close', () => { if (signedIn && socket === connection) reconnect = setTimeout(connectSocket, 2000); });
}


async function api(path, body) {
  if (body !== undefined) mutations++;
  try {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(result.error || 'Something went wrong.');
  }
  return result;
  } finally { if (body !== undefined) mutations--; }
}
async function refresh() {
  const requestedChat = chatId;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ chatId }));
  const state = await api(`/api/state?chat=${encodeURIComponent(requestedChat)}`);
  if (state && requestedChat === chatId) render(state);
}
function showLogin() { cancelQueueEdit(); notifications.reset(); window.resetPreviews(true); signedIn = false; pendingUI = undefined; drafts.clear(); draftMessages.clear(); $('#message').value = ''; try { sessionStorage.removeItem('phoenix-drafts'); } catch { /* Storage may be disabled. */ } window.stopVoice?.(); document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); closeChats(); signedIn = false; clearTimeout(reconnect); socket?.close(); $('#login').hidden = false; $('#app').hidden = true; }
function showApp() { signedIn = true; connectSocket(); revision = -1; $('#login').hidden = true; $('#app').hidden = false; renderDrafts(); sizeComposer(); refresh().catch(error => { $('#agent-error').textContent = error.message; }); poll(); }
let promptBaseline = '';
async function openSettings() {
  closeChats();
  $('#settings-model').textContent = latest ? `${latest.model.provider === 'opencode-go' ? 'OpenCode Go' : 'OpenCode Zen'} · ${latest.model.id}` : '';
  $('#settings-dialog').showModal();
  try { $('#system-prompt').value = promptBaseline = (await api('/api/workspace/file?path=AGENTS.md')).text || ''; $('#prompt-status').textContent = ''; }
  catch (error) { $('#prompt-status').textContent = error.message; }
}
function fileLink(file) {
  const link = document.createElement('a'); link.href = `/api/files/download?chat=${encodeURIComponent(file.chatId)}&id=${encodeURIComponent(file.id)}`; link.download = file.name;
  if (file.mime.startsWith('image/') || file.mime === 'application/pdf') {
    link.className = 'file-card';
    const preview = document.createElement('img'); preview.className = 'file-preview'; preview.alt = file.mime === 'application/pdf' ? `First page of ${file.name}` : file.name; preview.loading = 'lazy';
    if (file.mime === 'application/pdf') window.previewPDF(preview, link.href);
    else preview.src = `/api/files/image?chat=${encodeURIComponent(file.chatId)}&id=${encodeURIComponent(file.id)}`;
    preview.addEventListener('error', () => { preview.remove(); link.title = 'Preview unavailable · Download file'; }, { once: true });
    link.append(preview);
  }
  const name = document.createElement('span'); name.textContent = file.name; link.append(name); return link;
}
function beginQueueEdit(item) {
  if (!item?.queueId) return;
  cancelQueueEdit();
  queueEdit = { id: item.queueId, version: item.version, message: $('#message').value, files: [...attachments()] };
  $('#message').value = item.text; drafts.set(chatId, (item.attachments || []).map(file => ({ ...file, queued: true })));
  $('#queue-edit').hidden = false; sizeComposer(); renderDrafts(); $('#message').focus(); if (latest) render(latest);
}
function cancelQueueEdit() {
  if (!queueEdit) return;
  const previous = queueEdit; queueEdit = undefined;
  // Keep any files uploaded during editing available in the restored draft.
  drafts.set(chatId, [...previous.files, ...attachments().filter(file => !file.queued && !previous.files.some(item => item.id === file.id))]);
  $('#message').value = previous.message; $('#queue-edit').hidden = true;
  sizeComposer(); renderDrafts(); if (latest) render(latest);
}
$('#cancel-queue-edit').addEventListener('click', cancelQueueEdit);
function messageNode(role, text, queued = false, files = [], steered = false, item) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'message-label';
  if (role === 'assistant') { const icon = document.createElement('span'); icon.className = 'mark'; icon.setAttribute('aria-hidden', 'true'); const bird = document.createElement('img'); bird.src = '/bird.svg'; bird.alt = ''; icon.append(bird); label.append(icon); }
  label.append(document.createTextNode(role === 'user' ? queued ? steered ? 'You · Steering' : 'You · Queued' : 'You' : latest.name));
  if (item?.queueId) {
    article.dataset.queueId = item.queueId;
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'edit-queued'; edit.textContent = 'Edit'; edit.setAttribute('aria-label', 'Edit queued message'); edit.addEventListener('click', () => beginQueueEdit(item)); label.append(edit);
    article.addEventListener('contextmenu', event => { event.preventDefault(); beginQueueEdit(item); });
    let hold; let start;
    const clear = () => { clearTimeout(hold); hold = undefined; };
    article.addEventListener('pointerdown', event => { if (event.button !== 0 || event.target.closest('a,button')) return; start = { x: event.clientX, y: event.clientY }; hold = setTimeout(() => beginQueueEdit(item), 550); });
    article.addEventListener('pointermove', event => { if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) clear(); });
    for (const event of ['pointerup', 'pointercancel', 'pointerleave']) article.addEventListener(event, clear);
  }
  const body = document.createElement('div'); body.className = 'message-body markdown'; body.append(window.renderMarkdown(text));
  if (role === 'assistant' && text) window.addReadAloud?.(label, body);
  const links = document.createElement('div'); links.className = 'attachments';
  for (const file of files) links.append(fileLink(file));
  article.append(label, body, links); return article;
}
function render(state) {
  latest = state;
  notifications.update(state.chats, state.chatId);
  revision = state.revision;
  $('#agent-name').textContent = state.name;
  $('#chat-title').textContent = state.title;
  const modelValue = `${state.model.provider}/${state.model.id}`;
  if ($('#model').dataset.catalog !== JSON.stringify(state.models)) {
    $('#model').replaceChildren();
    for (const provider of ['opencode-go', 'opencode']) {
      const group = document.createElement('optgroup'); group.label = provider === 'opencode-go' ? 'Go' : 'Zen';
      for (const model of state.models.filter(model => model.provider === provider)) {
        const option = document.createElement('option'); option.value = `${provider}/${model.id}`; option.textContent = model.name; group.append(option);
      }
      $('#model').append(group);
    }
    $('#model').dataset.catalog = JSON.stringify(state.models);
  }
  $('#model').value = modelValue;
  $('#model').title = modelValue;
  $('#model').disabled = state.busy || !state.configured;
  if ($('#thinking').dataset.levels !== JSON.stringify(state.thinkingLevels)) {
    $('#thinking').replaceChildren(...state.thinkingLevels.map(level => {
      const option = document.createElement('option'); option.value = level; option.textContent = level === 'xhigh' ? 'Very high' : level === 'off' ? 'Off' : level[0].toUpperCase() + level.slice(1); return option;
    }));
    $('#thinking').dataset.levels = JSON.stringify(state.thinkingLevels);
  }
  $('#thinking').value = state.thinking;
  $('#thinking').disabled = state.busy || !state.configured || state.thinkingLevels.length < 2;
  $('#internet-settings').hidden = !state.internet?.available;
  if (state.internet) {
    $('#internet-status').textContent = state.internet.enabled ? state.internet.connected ? 'Using your internet' : 'Waiting for your computer · Requests paused' : 'Using VPS internet';
    $('#internet-toggle').textContent = state.internet.enabled ? 'Use VPS internet' : 'Use my internet';
    $('#internet-forget').hidden = !state.internet.paired;
  }
  $('#connection').textContent = state.busy ? 'Working' : '';
  $('#archive-chat').hidden = chatId === 'main';
  $('#pin-chat').hidden = chatId === 'main';
  $('#pin-chat').textContent = state.pinned ? 'Unpin chat' : 'Pin chat';
  $('#pin-chat').setAttribute('aria-pressed', String(state.pinned));
  $('#archive-chat').textContent = state.archived ? 'Restore chat' : 'Archive chat';
  $('#archive-chat').setAttribute('aria-label', state.archived ? 'Restore chat' : 'Archive chat');
  $('#archive-chat').title = state.archived ? 'Restore chat' : 'Archive chat';
  $('#archived-chats').hidden = !showingArchived && !state.chats.some(chat => chat.archived);
  $('#archived-chats').textContent = showingArchived ? 'Back to chats' : 'Archived';
  $('#archived-chats').setAttribute('aria-pressed', String(showingArchived));
  $('#browser').hidden = !state.browser?.available;
  $('#browser').textContent = state.browser?.controlled ? 'Resume browser' : 'Browser';
  $('#agent-error').textContent = state.error;
  $('#key-banner').hidden = state.configured;
  $('#send').disabled = !state.configured || uploading > 0; $('#send').title = state.busy ? 'Send after the current task' : 'Send message';
  $('#send').textContent = queueEdit ? 'Save' : state.busy ? 'Queue' : '↑'; $('#send').classList.toggle('queued', state.busy || !!queueEdit); $('#send').setAttribute('aria-label', queueEdit ? 'Save queued message' : state.busy ? 'Queue message' : 'Send message');
  $('#steer').hidden = !!queueEdit || !state.steerable || state.browser?.controlled; $('#steer').disabled = uploading > 0;
  $('#stop').hidden = !state.busy;
  $('#activity').textContent = state.browser?.controlled ? 'You control the browser · Agent paused' : state.approvals.length ? 'Waiting for your approval…' : state.tool ? `Using ${state.tool}…` : state.busy ? 'Thinking…' : '';
  stableChildren('#chat-list', [chatId, showingArchived, state.chats], () => state.chats.filter(chat => !!chat.archived === showingArchived).map(chat => {
    const button = document.createElement('button'); button.className = `chat-link${chat.id === chatId ? ' selected' : ''}`;
    button.setAttribute('aria-current', String(chat.id === chatId));
    const title = document.createElement('span'); title.textContent = chat.title;
    const status = document.createElement('small'); status.textContent = (chat.pinned ? '⌖ ' : '') + (chat.approval ? 'Approval' : chat.busy ? 'Working' : chat.jobs ? `${chat.jobs} job${chat.jobs === 1 ? '' : 's'}` : '');
    if (chat.pinned) button.title = 'Pinned chat';
    button.append(title, status); button.addEventListener('click', async () => {
      switchChat(chat.id); revision = -1; closeChats(); $('#messages').replaceChildren();
      try { await refresh(); } catch (error) { $('#agent-error').textContent = error.message; }
    });
    return button;
  }));
  stableChildren('#approvals', state.approvals, () => state.approvals.map(approval => {
    const card = document.createElement('div'); card.className = 'approval-card';
    const verification = approval.tool === 'browser_verification';
    const title = document.createElement('strong'); title.textContent = verification ? approval.args.attempts ? 'Still blocked after 3 tries' : 'Website needs verification' : `Allow ${approval.tool}?`;
    const preview = document.createElement('pre'); preview.textContent = verification ? approval.args.site : JSON.stringify(approval.args, null, 2);
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    if (verification) {
      const take = document.createElement('button'); take.textContent = 'Take control';
      take.addEventListener('click', () => window.openBrowser(true)); actions.append(take);
    }
    for (const [label, allow, remember] of verification ? [['Try CAPTCHA', true, false], ['Stop', false, false]] : [['Deny', false, false], ['Allow once', true, false], ['Allow in this chat', true, true]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.addEventListener('click', async () => { try { await api('/api/approval', { id: approval.id, allow, remember }); revision = -1; } catch (error) { $('#agent-error').textContent = error.message; } });
      actions.append(button);
    }
    card.append(title, preview, actions); return card;
  }));
  renderJobs();
  stableChildren('#extensions', state.extensions, () => Object.entries(state.extensions).map(([name, status]) => {
    const item = document.createElement('div'); item.className = `extension ${status}`;
    const label = document.createElement('span'); label.textContent = name;
    const badge = document.createElement('span'); badge.textContent = status === 'ready' ? 'Ready' : 'Needs attention';
    item.append(label, badge); return item;
  }));
  $('#welcome').hidden = state.messages.length > 0 || !!state.current;
  const scroll = $('#chat-scroll');
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  const messages = state.messages.filter(item => item.text || item.attachments?.length);
  if (state.current) messages.push({ role: 'assistant', text: state.current });
  const previous = [...$('#messages').children];
  messages.forEach((item, index) => {
    const key = JSON.stringify([state.chatId, state.name, item.role, item.text, !!item.queued, item.attachments, !!item.steered, item.queueId, item.version]);
    if (previous[index]?.messageKey === key) return;
    const node = messageNode(item.role, item.text, item.queued, item.attachments, item.steered, item); node.messageKey = key;
    if (previous[index]) previous[index].replaceWith(node); else $('#messages').append(node);
  });
  previous.slice(messages.length).forEach(node => node.remove());
  if (restoringScroll !== undefined) { scroll.scrollTop = restoringScroll; restoringScroll = undefined; }
  else if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  updateLatest(); checkInterface(state.uiVersion);
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    while (signedIn) {
      try {
        const requestedChat = chatId;
        const state = socket?.readyState === WebSocket.OPEN ? null : await api(`/api/state?chat=${encodeURIComponent(chatId)}&after=${revision}`);
        if (state && requestedChat === chatId) render(state);
      }
      catch (error) { $('#connection').textContent = 'Reconnecting…'; $('#agent-error').textContent = error.message; }
      await new Promise(resolve => setTimeout(resolve, document.hidden ? 5000 : 800));
    }
  } finally { polling = false; }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const result = await api('/api/login', { password: $('#password').value }); csrf = result.csrf; $('#password').value = ''; $('#login-error').textContent = ''; showApp(); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#composer').addEventListener('submit', async event => {
  event.preventDefault(); window.stopDictation?.();
  const input = $('#message').value; const message = input.trim(); const files = [...attachments()];
  if (uploading || (!message && !files.length)) return;
  const id = chatId; const steering = event.submitter?.id === 'steer';
  $('#send').disabled = true; $('#steer').disabled = true;
  try {
    if (queueEdit) {
      const edit = queueEdit;
      await api('/api/queue/edit', { chatId: id, queueId: edit.id, version: edit.version, message, attachments: files.map(file => file.id) });
      if (chatId === id && queueEdit === edit) { drafts.set(id, []); cancelQueueEdit(); persistDrafts(); await refresh(); }
      return;
    }
    await api(steering ? '/api/steer' : '/api/prompt', { message, chatId: id, attachments: files.map(file => file.id) });
    drafts.set(id, (drafts.get(id) || []).filter(file => !files.includes(file)));
    if (draftMessages.get(id) === input) draftMessages.set(id, '');
    if (id === chatId) { if ($('#message').value === input) $('#message').value = ''; sizeComposer(); renderDrafts(); persistDrafts(); revision = -1; await refresh(); }
  } catch (error) { $('#agent-error').textContent = error.message; }
  finally { $('#send').disabled = !latest?.configured || uploading > 0; $('#steer').disabled = uploading > 0; }
});
$('#message').addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Escape' && queueEdit) { event.preventDefault(); cancelQueueEdit(); }
  if (event.key === 'ArrowUp' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !$('#message').value && !queueEdit) {
    const item = latest?.messages.findLast(item => item.queueId); if (item) { event.preventDefault(); beginQueueEdit(item); }
  }
  if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(pointer: coarse), (max-width: 620px)').matches) { event.preventDefault(); $('#composer').requestSubmit(); }
});
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('#message').value = button.dataset.prompt; $('#message').focus(); });
$('#stop').addEventListener('click', async () => { try { await api('/api/cancel', { chatId }); } catch (error) { $('#agent-error').textContent = error.message; } });
$('#new-chat').addEventListener('click', async () => {
  closeChats(); $('#chat-dialog').showModal(); $('#chat-name').focus();
});
$('#close-chat').addEventListener('click', () => $('#chat-dialog').close());
$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try { const chat = await api('/api/new', { title: $('#chat-name').value }); switchChat(chat.id); revision = -1; $('#chat-name').value = ''; $('#chat-error').textContent = ''; $('#chat-dialog').close(); await refresh(); }
  catch (error) { $('#chat-error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
$('#settings').addEventListener('click', openSettings);
$('#mobile-settings').addEventListener('click', openSettings);
$('#connect-key').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', async () => { if (await discardChanges($('#system-prompt').value !== promptBaseline)) $('#settings-dialog').close(); });
$('#settings-dialog').addEventListener('cancel', async event => { event.preventDefault(); if (await discardChanges($('#system-prompt').value !== promptBaseline)) $('#settings-dialog').close(); });
$('#key-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try { await api('/api/provider', { apiKey: $('#api-key').value }); $('#api-key').value = ''; $('#key-error').textContent = ''; $('#settings-dialog').close(); revision = -1; await refresh(); }
  catch (error) { $('#key-error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
$('#logout').addEventListener('click', async () => { try { await api('/api/logout', {}); showLogin(); } catch (error) { $('#agent-error').textContent = error.message; } });
api('/api/session').then(result => { csrf = result.csrf; result.authenticated ? showApp() : showLogin(); }).catch(error => { showLogin(); $('#login-error').textContent = error.message; });
$('#archived-chats').addEventListener('click', () => { showingArchived = !showingArchived; if (latest) render(latest); });
$('#pin-chat').addEventListener('click', async () => {
  try { await api('/api/chat/pin', { chatId, pinned: !latest.pinned }); await refresh(); }
  catch (error) { $('#agent-error').textContent = error.message; }
});
$('#archive-chat').addEventListener('click', async () => {
  try {
    const archived = !latest.archived;
    await api('/api/chat/archive', { chatId, archived });
    if (archived) { switchChat('main'); $('#messages').replaceChildren(); }
    showingArchived = false; revision = -1; closeChats(); await refresh();
  } catch (error) { $('#agent-error').textContent = error.message; }
});
window.initBrowserControl({ api, chat: () => chatId, csrf: () => csrf, refresh });

function renderJobs() {
  if (!latest) return;
  $('#jobs-chat').textContent = latest.title;
  stableChildren('#job-list', [chatId, latest.jobs], () => latest.jobs.map(job => {
    const item = document.createElement('div'); item.className = 'job-item';
    const name = document.createElement('strong'); name.textContent = job.name;
    const detail = document.createElement('p'); detail.textContent = job.running ? 'Running…' : job.nextRunAt ? `Next: ${new Date(job.nextRunAt).toLocaleString()}` : 'Completed';
    const error = document.createElement('p'); error.className = 'error'; error.textContent = job.lastError || '';
    const actions = document.createElement('div'); actions.className = 'job-actions';
    for (const [label, path] of [['Run now', '/api/jobs/run'], ['Remove', '/api/jobs/remove']]) {
      const button = document.createElement('button'); button.textContent = label; button.disabled = job.running;
      button.addEventListener('click', async () => { try { await api(path, { chatId, id: job.id }); revision = -1; } catch (error) { $('#job-error').textContent = error.message; } }); actions.append(button);
    }
    item.append(name, detail, error, actions); return item;
  }));
}
$('#jobs').addEventListener('click', () => {
  const date = new Date(Date.now() + 5 * 60000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  $('#job-start').value = date.toISOString().slice(0, 16);
  renderJobs(); $('#jobs-dialog').showModal();
});
$('#close-jobs').addEventListener('click', () => $('#jobs-dialog').close());
$('#job-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    await api('/api/jobs', { chatId, name: $('#job-name').value, prompt: $('#job-prompt').value,
      everyMinutes: Number($('#job-repeat').value), nextRunAt: new Date($('#job-start').value).toISOString() });
    $('#job-name').value = ''; $('#job-prompt').value = ''; $('#job-error').textContent = ''; revision = -1; await refresh();
  } catch (error) { $('#job-error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});

async function changeModel() {
  const [provider, ...id] = $('#model').value.split('/');
  $('#model').disabled = true; $('#thinking').disabled = true;
  try { await api('/api/model', { chatId, model: { provider, id: id.join('/') }, thinking: $('#thinking').value }); await refresh(); }
  catch (error) { await refresh().catch(() => {}); $('#agent-error').textContent = error.message; }
}
$('#model').addEventListener('change', changeModel);
$('#thinking').addEventListener('change', changeModel);

const mobileSidebar = window.matchMedia('(max-width: 620px)');
try { $('#app').classList.toggle('sidebar-collapsed', localStorage.getItem('phoenix-sidebar-collapsed') === 'true'); } catch { /* Preferences are optional. */ }
function syncSidebar() {
  const open = mobileSidebar.matches ? $('#app').classList.contains('sidebar-open') : !$('#app').classList.contains('sidebar-collapsed');
  $('#chat-menu').setAttribute('aria-expanded', String(open)); $('#chat-backdrop').hidden = !mobileSidebar.matches || !open;
}
function closeChats() { $('#app').classList.remove('sidebar-open'); syncSidebar(); }
$('#chat-menu').addEventListener('click', () => {
  if (mobileSidebar.matches) $('#app').classList.toggle('sidebar-open');
  else {
    const collapsed = $('#app').classList.toggle('sidebar-collapsed');
    try { localStorage.setItem('phoenix-sidebar-collapsed', String(collapsed)); } catch { /* Preferences are optional. */ }
  }
  syncSidebar();
});
mobileSidebar.addEventListener('change', closeChats); syncSidebar();
$('#chat-backdrop').addEventListener('click', closeChats);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeChats(); });

$('#import-setup').addEventListener('click', () => $('#setup-file').click());
$('#setup-file').addEventListener('change', async () => {
  const file = $('#setup-file').files[0]; if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Setup file is too large.');
    const config = JSON.parse(await file.text());
    await api('/api/setup', config); $('#settings-dialog').close(); closeChats(); $('#connection').textContent = 'Restarting…';
  } catch (error) { closeChats(); $('#agent-error').textContent = error.message; }
  finally { $('#setup-file').value = ''; }
});

function renderDrafts() {
  persistDrafts();
  $('#draft-files').replaceChildren(...attachments().map(file => {
    const chip = document.createElement('span'); chip.className = 'file-chip';
    const link = fileLink(file);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', async () => {
      const id = chatId; remove.disabled = true;
      try { if (!file.queued) await api('/api/files/remove', { id: file.id, chatId: id }); drafts.set(id, (drafts.get(id) || []).filter(item => item !== file)); renderDrafts(); }
      catch (error) { $('#agent-error').textContent = error.message; remove.disabled = false; }
    });
    chip.append(link, remove); return chip;
  }));
}
$('#attach').addEventListener('click', () => $('#attachment-files').click());
$('#attachment-files').addEventListener('change', async () => {
  const files = [...$('#attachment-files').files]; $('#attachment-files').value = ''; await uploadFiles(files);
});
$('#message').addEventListener('paste', event => {
  const files = [...event.clipboardData.files];
  if (files.length) { event.preventDefault(); uploadFiles(files); }
});
$('#composer').addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
$('#composer').addEventListener('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); uploadFiles([...event.dataTransfer.files]); } });
async function uploadFiles(files) {
  if (!signedIn || uploading) return;
  const id = chatId;
  uploading++; $('#attach').disabled = true; $('#send').disabled = true; $('#steer').disabled = true;
  try {
    if ((drafts.get(id) || []).length + files.length > 8) throw new Error('Attach up to eight files.');
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) throw new Error('Files must be 20 MB or smaller.');
      const response = await fetch(`/api/files?chat=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: file });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed.');
      drafts.set(id, [...(drafts.get(id) || []), result]); if (id === chatId) renderDrafts();
    }
  } catch (error) { $('#agent-error').textContent = error.message; }
  finally { uploading--; $('#attach').disabled = false; $('#send').disabled = !latest?.configured; $('#steer').disabled = false; persistDrafts(); }
}
$('#prompt-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true; const text = $('#system-prompt').value;
  try { await api('/api/workspace/file', { path: 'AGENTS.md', text }); promptBaseline = text; $('#prompt-status').textContent = 'Saved'; }
  catch (error) { $('#prompt-status').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
let directory = ''; let editing;
function dirtyFile() { return editing?.editable && $('#file-text').value !== editing.text; }
let resolveDiscard;
function discardFile() { return discardChanges(dirtyFile()); }
function discardChanges(dirty) {
  if (!dirty) return Promise.resolve(true);
  if (resolveDiscard) return Promise.resolve(false);
  $('#discard-dialog').showModal();
  return new Promise(resolve => { resolveDiscard = resolve; });
}
function answerDiscard(discard) { const resolve = resolveDiscard; resolveDiscard = undefined; $('#discard-dialog').close(); resolve?.(discard); }
$('#keep-editing').addEventListener('click', () => answerDiscard(false));
$('#discard-file').addEventListener('click', () => answerDiscard(true));
$('#discard-dialog').addEventListener('cancel', event => { event.preventDefault(); answerDiscard(false); });
function updateFileSave() { $('#file-save').disabled = !dirtyFile(); $('#file-dirty').textContent = dirtyFile() ? 'Unsaved' : ''; }
function clearEditor() { editing = undefined; $('#file-editor').hidden = true; $('#file-empty').hidden = false; $('#files-dialog').classList.remove('editing'); }
async function listFiles(path = '') {
  const result = await api(`/api/workspace?path=${encodeURIComponent(path)}`); directory = result.path;
  $('#file-directory').textContent = directory || '/'; $('#file-directory').title = directory || '/'; $('#file-back').disabled = !directory;
  $('#file-list').replaceChildren(...result.entries.map(file => {
    const button = document.createElement('button'); button.textContent = `${file.directory ? '▸ ' : ''}${file.name}`; button.dataset.path = file.path;
    button.classList.toggle('selected', file.path === editing?.path); button.setAttribute('aria-current', String(file.path === editing?.path));
    button.addEventListener('click', async () => {
      if (!(await discardFile())) return;
      try { if (file.directory) { await listFiles(file.path); clearEditor(); } else await editFile(file.path); }
      catch (error) { $('#file-status').textContent = error.message; }
    }); return button;
  }));
}
async function editFile(path) {
  const file = await api(`/api/workspace/file?path=${encodeURIComponent(path)}`); editing = file;
  $('#file-editor').hidden = false; $('#file-empty').hidden = true; $('#files-dialog').classList.add('editing');
  $('#file-name').textContent = file.path.split('/').at(-1); $('#file-name').title = file.path;
  $('#file-download').href = `/api/workspace/download?path=${encodeURIComponent(path)}`;
  $('#file-text').hidden = !file.editable; $('#file-text').value = file.text || '';
  $('#file-rendered').hidden = true; $('#file-preview').textContent = 'Preview'; $('#file-preview').setAttribute('aria-pressed', 'false');
  $('#file-save').hidden = !file.editable; $('#file-preview').hidden = !file.editable || !/\.(md|markdown)$/i.test(path);
  $('#file-status').textContent = file.editable ? '' : 'Download to view this file.'; updateFileSave();
  for (const button of $('#file-list').children) { const selected = button.dataset.path === path; button.classList.toggle('selected', selected); button.setAttribute('aria-current', String(selected)); }
}
async function loadHistory() {
  for (const [kind, selector] of [['ui', '#ui-generation-list'], ['agent', '#generation-list']]) {
    const history = await api(kind === 'ui' ? '/api/ui/generations' : '/api/generations');
    $(kind === 'ui' ? '#apply-ui' : '#reload-agent').hidden = !history.available;
    $(selector).replaceChildren(...history.generations.slice().reverse().map(generation => {
      const row = document.createElement('div'); row.className = 'generation';
      const label = document.createElement('span'); label.textContent = `${generation.id} · ${generation.date}${generation.current ? ' · Current' : ''}`; row.append(label);
      if (!generation.current) {
        const button = document.createElement('button'); button.textContent = 'Restore'; button.setAttribute('aria-label', `Restore ${kind === 'ui' ? 'interface' : 'agent'} generation ${generation.id}`);
        button.addEventListener('click', async () => {
          if (!(await discardFile())) return; button.disabled = true;
          try { await api(kind === 'ui' ? '/api/ui/switch' : '/api/generations/switch', { generation: generation.id }); clearEditor(); $('#files-dialog').close(); if (kind === 'ui') await refresh(); else $('#connection').textContent = 'Reloading…'; }
          catch (error) { $('#file-status').textContent = error.message; button.disabled = false; }
        }); row.append(button);
      } return row;
    }));
  }
}
$('#files').addEventListener('click', async () => {
  closeChats(); clearEditor(); $('#new-file-form').hidden = true; $('#file-status').textContent = ''; $('#files-dialog').showModal();
  try { await listFiles(); await loadHistory(); } catch (error) { $('#file-status').textContent = error.message; }
});
$('#close-files').addEventListener('click', async () => { if (await discardFile()) $('#files-dialog').close(); });
$('#files-dialog').addEventListener('cancel', async event => { event.preventDefault(); if (await discardFile()) $('#files-dialog').close(); });
$('#file-list-back').addEventListener('click', async () => { if (await discardFile()) { clearEditor(); $('#file-list').querySelector('[aria-current="true"]')?.focus(); } });
$('#file-back').addEventListener('click', async () => {
  if (!(await discardFile())) return;
  try { await listFiles(directory.split('/').slice(0, -1).join('/')); clearEditor(); } catch (error) { $('#file-status').textContent = error.message; }
});
$('#file-text').addEventListener('input', updateFileSave);
$('#file-save').addEventListener('click', async () => {
  const file = editing; const text = $('#file-text').value; $('#file-save').disabled = true;
  try { await api('/api/workspace/file', { path: file.path, text }); file.text = text; $('#file-status').textContent = 'Saved'; }
  catch (error) { $('#file-status').textContent = error.message; }
  finally { updateFileSave(); }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && $('#files-dialog').open && !$('#discard-dialog').open) { event.preventDefault(); if (dirtyFile()) $('#file-save').click(); }
});
$('#file-preview').addEventListener('click', () => {
  const preview = $('#file-rendered').hidden; $('#file-rendered').hidden = !preview; $('#file-text').hidden = preview;
  $('#file-preview').textContent = preview ? 'Edit' : 'Preview'; $('#file-preview').setAttribute('aria-pressed', String(preview)); $('#file-rendered').replaceChildren(window.renderMarkdown($('#file-text').value));
});
$('#new-file').addEventListener('click', () => { $('#new-file-form').hidden = !$('#new-file-form').hidden; if (!$('#new-file-form').hidden) $('#new-file-name').focus(); });
$('#new-file-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!(await discardFile())) return; const name = $('#new-file-name').value.trim();
  if (!name || /[/\\]/.test(name) || name === '.' || name === '..') { $('#file-status').textContent = 'Choose a file name.'; return; }
  const path = [directory, name].filter(Boolean).join('/'); event.submitter.disabled = true;
  try {
    try { await api(`/api/workspace/file?path=${encodeURIComponent(path)}`); throw new Error('A file with this name already exists.'); }
    catch (error) { if (error.message !== 'File not found.') throw error; }
    await api('/api/workspace/file', { path, text: '' }); await listFiles(directory); await editFile(path); $('#new-file-form').hidden = true; $('#new-file-name').value = '';
  } catch (error) { $('#file-status').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
for (const [selector, endpoint] of [['#reload-agent', '/api/restart'], ['#apply-ui', '/api/ui/apply']]) $(selector).addEventListener('click', async () => {
  if (!(await discardFile())) return; const button = $(selector); button.disabled = true;
  try {
    await api(endpoint, {}); $('#files-dialog').close();
    if (selector === '#apply-ui') await refresh(); else $('#connection').textContent = 'Reloading…';
  } catch (error) { $('#file-status').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#internet-toggle').addEventListener('click', async () => {
  if (!latest.internet?.paired) { $('#internet-dialog').showModal(); return; }
  try { await api('/api/internet/route', { enabled: !latest.internet.enabled }); $('#internet-error').textContent = ''; }
  catch (error) { $('#internet-error').textContent = error.message; }
});
$('#internet-forget').addEventListener('click', async () => {
  try { await api('/api/internet/revoke', {}); $('#internet-error').textContent = ''; }
  catch (error) { $('#internet-error').textContent = error.message; }
});
$('#close-internet').addEventListener('click', () => $('#internet-dialog').close());
$('#internet-download').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const { client } = await api('/api/internet/pair', {});
    const url = URL.createObjectURL(new Blob([client], { type: 'text/javascript' }));
    const link = document.createElement('a'); link.href = url; link.download = 'phoenix-connect.mjs'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $('#internet-pair-status').textContent = 'Downloaded. Run the connector on your computer to connect.';
  } catch (error) { $('#internet-pair-status').textContent = error.message; }
  finally { button.disabled = false; }
});
