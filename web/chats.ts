import type { API } from './globals.d.ts';
import type { ChatState, ChatSummary } from '../src/contracts.ts';

window.initChats = ({ api, selectChat, refresh, openSidebar, openMemory }) => {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const search = get<HTMLInputElement>('chat-search'); const filter = get<HTMLSelectElement>('chat-folder-filter');
  const list = get<HTMLElement>('chat-list'); const dialog = get<HTMLDialogElement>('chat-dialog');
  const title = get<HTMLInputElement>('chat-name'); const folder = get<HTMLSelectElement>('chat-folder');
  const deletion = get<HTMLDialogElement>('delete-chat-dialog');
  const folderDialog = get<HTMLDialogElement>('folders-dialog'); const target = get<HTMLSelectElement>('folder-target'); const name = get<HTMLInputElement>('folder-name');
  let state: ChatState | undefined; let archived = false; let editing: string | undefined; let rendered = ''; let creating = false; let generation = 0;
  const options = (element: HTMLSelectElement, entries: [string, string][], value: string) => {
    element.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
    element.value = entries.some(entry => entry[0] === value) ? value : entries[0][0];
  };
  const error = (id: string, caught: unknown) => { get(id).textContent = caught instanceof Error ? caught.message : String(caught); };
  function edit(chat: ChatSummary) {
    editing = chat.id; title.value = chat.title; get('chat-error').textContent = '';
    get('delete-chat').hidden = chat.id === 'main';
    options(folder, [['', 'Unfiled'], ...(state?.folders || []).map(name => [name, name] as [string, string])], chat.folder || '');
    dialog.showModal(); title.focus(); title.select();
  }
  async function create() {
    if (creating || !state) return;
    creating = true; get<HTMLButtonElement>('new-chat').disabled = true;
    const epoch = generation;
    try {
      const chat = await api('/api/new', { fromChatId: state.chatId, ...(filter.value.startsWith('name:') ? { folder: filter.value.slice(5) } : {}) });
      if (epoch === generation) { search.value = ''; await selectChat(chat.id); }
    } catch (caught) { if (epoch === generation) error('agent-error', caught); }
    finally { creating = false; get<HTMLButtonElement>('new-chat').disabled = false; }
  }
  function render(next = state, showArchived = archived) {
    if (!next) return; state = next; archived = showArchived;
    const entries: [string, string][] = [['all', 'All chats'], ['unfiled', 'Unfiled'], ...(state.folders || []).map(name => [`name:${name}`, name] as [string, string])];
    const value = filter.value;
    if (JSON.stringify(entries) !== filter.dataset.options) { options(filter, entries, value); filter.dataset.options = JSON.stringify(entries); }
    const key = JSON.stringify([state.chatId, state.chats, archived, filter.value, search.value]);
    if (rendered === key) return; rendered = key;
    const query = search.value.trim().toLocaleLowerCase();
    const chats = state.chats.filter(chat => !!chat.archived === archived && (!query || chat.title.toLocaleLowerCase().includes(query))
      && (filter.value === 'all' || (filter.value === 'unfiled' ? !chat.folder : chat.folder === filter.value.slice(5))));
    list.replaceChildren(...chats.map(chat => {
      const row = document.createElement('div'); row.className = 'chat-row';
      const button = document.createElement('button'); button.className = `chat-link${chat.id === state?.chatId ? ' selected' : ''}`;
      button.setAttribute('aria-current', String(chat.id === state?.chatId));
      const label = document.createElement('span'); label.textContent = chat.title;
      const status = document.createElement('small'); status.textContent = (chat.pinned ? '⌖ ' : '') + (chat.approval ? 'Approval' : chat.busy ? 'Working' : chat.jobs ? `${chat.jobs} job${chat.jobs === 1 ? '' : 's'}` : '');
      if (chat.pinned) button.title = 'Pinned chat';
      button.append(label, status);
      let held = false; let timer: ReturnType<typeof setTimeout> | undefined;
      let origin: { x: number; y: number } | undefined;
      const clear = () => { clearTimeout(timer); timer = undefined; origin = undefined; };
      button.addEventListener('pointermove', event => { if (origin && Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y) > 12) clear(); });
      button.addEventListener('pointerdown', event => { if (event.button !== 0) return; clear(); held = false; origin = { x: event.clientX, y: event.clientY };
        timer = setTimeout(() => { if (button.isConnected && !dialog.open) { held = true; edit(chat); } }, 600);
      });
      for (const event of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(event, clear);
      button.addEventListener('click', () => { if (!held) selectChat(chat.id).catch(caught => error('agent-error', caught)); });
      button.addEventListener('contextmenu', event => { event.preventDefault(); clear(); if (!dialog.open) edit(chat); });
      const more = document.createElement('button'); more.className = 'chat-more'; more.textContent = '⋯'; more.setAttribute('aria-label', `Edit ${chat.title}`);
      more.addEventListener('click', () => edit(chat)); row.append(button, more); return row;
    }));
    if (!chats.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = query ? 'No matching chats.' : 'No chats here yet.'; list.append(empty); }
  }
  search.addEventListener('input', () => render()); filter.addEventListener('change', () => render());
  get('new-chat').addEventListener('click', create);
  get('chat-details').addEventListener('click', () => { const chat = state?.chats.find(chat => chat.id === state?.chatId); if (chat) edit(chat); });
  get('close-chat').addEventListener('click', () => dialog.close());
  get<HTMLFormElement>('chat-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!editing) return;
    const button = event.submitter as HTMLButtonElement; button.disabled = true;
    const epoch = generation;
    try { await api('/api/chat/update', { chatId: editing, title: title.value, folder: folder.value }); if (epoch === generation) { dialog.close(); await refresh(); } }
    catch (caught) { if (epoch === generation) error('chat-error', caught); } finally { button.disabled = false; }
  });
  get('chat-memory').addEventListener('click', () => { if (editing) { dialog.close(); openMemory(editing).catch(caught => error('agent-error', caught)); } });
  get('delete-chat').addEventListener('click', () => {
    if (!editing || editing === 'main') return;
    get('delete-chat-name').textContent = state?.chats.find(chat => chat.id === editing)?.title || '';
    get('delete-chat-error').textContent = ''; deletion.showModal(); get('cancel-delete-chat').focus();
  });
  get('cancel-delete-chat').addEventListener('click', () => deletion.close());
  get('confirm-delete-chat').addEventListener('click', async () => {
    if (!editing || editing === 'main') return;
    const id = editing; const epoch = generation; const button = get<HTMLButtonElement>('confirm-delete-chat'); button.disabled = true;
    try {
      await api('/api/chat/delete', { chatId: id });
      if (epoch === generation) { deletion.close(); dialog.close(); if (state?.chatId === id) await selectChat('main'); else await refresh(); }
    } catch (caught) { if (epoch === generation) error('delete-chat-error', caught); } finally { button.disabled = false; }
  });
  const folderFields = () => { name.value = target.value; get<HTMLButtonElement>('remove-folder').hidden = !target.value; get('folder-error').textContent = ''; };
  get('manage-folders').addEventListener('click', () => {
    options(target, [['', 'New folder'], ...(state?.folders || []).map(name => [name, name] as [string, string])], filter.value.startsWith('name:') ? filter.value.slice(5) : '');
    folderFields(); folderDialog.showModal(); name.focus();
  });
  target.addEventListener('change', folderFields); get('close-folders').addEventListener('click', () => folderDialog.close());
  async function saveFolder(remove = false) {
    const buttons = folderDialog.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(button => { button.disabled = true; });
    const epoch = generation;
    try {
      await api('/api/folders', { ...(target.value ? { previous: target.value } : {}), ...(remove ? { remove: true } : { name: name.value }) });
      if (epoch === generation) { filter.value = 'all'; folderDialog.close(); await refresh(); }
    } catch (caught) { if (epoch === generation) error('folder-error', caught); } finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  get<HTMLFormElement>('folders-form').addEventListener('submit', event => { event.preventDefault(); saveFolder(); });
  get('remove-folder').addEventListener('click', () => saveFolder(true));
  document.addEventListener('keydown', event => {
    if (!state || get('app').hidden || document.querySelector('dialog[open]') || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openSidebar(); search.focus(); search.select(); }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') { event.preventDefault(); create(); }
  });
  return { render, reset() {
    generation++; state = undefined; editing = undefined; search.value = ''; title.value = ''; name.value = ''; rendered = ''; list.replaceChildren(); get('delete-chat-name').textContent = '';
    options(filter, [['all', 'All chats']], 'all'); delete filter.dataset.options;
    options(folder, [['', 'Unfiled']], ''); options(target, [['', 'New folder']], '');
  } };
};
export type ChatController = ReturnType<typeof window.initChats>;
export type ChatOptions = { api: API; selectChat: (id: string) => Promise<void>; refresh: () => Promise<void>; openSidebar: () => void; openMemory: (id: string) => Promise<void> };
