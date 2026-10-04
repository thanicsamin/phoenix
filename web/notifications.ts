// Opt-in notifications while the page is connected. The worker only displays
// notifications; it never caches chats, files or credentials.
window.initNotifications = ({ selectChat }) => {
  const button = document.querySelector<HTMLButtonElement>('#notifications')!;
  const status = document.querySelector<HTMLElement>('#notification-status')!;
  const seen = new Map<string, { notice?: string; approval: string | false }>(); let initialized = false; let unread = 0; let enabled = false; let registration: ServiceWorkerRegistration | undefined; let generation = 0;
  const supported = window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator;
  try { enabled = localStorage.getItem('phoenix-notifications') === 'true'; } catch { /* Optional preference. */ }
  function preference() {
    enabled &&= supported && Notification.permission === 'granted';
    button.disabled = !supported;
    button.textContent = enabled ? 'Disable notifications' : 'Enable notifications';
    button.setAttribute('aria-pressed', String(enabled));
    status.textContent = !supported ? window.isSecureContext ? 'This browser does not support notifications.' : 'Notifications need HTTPS or localhost.' : Notification.permission === 'denied' ? 'Allow notifications in your browser’s site settings.' : enabled ? 'Replies and approvals · while Phoenix is open' : '';
  }
  async function worker() {
    registration ||= await navigator.serviceWorker.register('/notification-worker.js');
    return navigator.serviceWorker.ready;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (enabled) { enabled = false; generation++; }
      else {
        // Permission must be requested directly from this user gesture.
        enabled = await Notification.requestPermission() === 'granted';
        if (enabled) await worker();
      }
      try { localStorage.setItem('phoenix-notifications', String(enabled)); } catch { /* Optional preference. */ }
      preference();
    } catch { enabled = false; preference(); status.textContent = 'Notifications could not be enabled.'; }
  });
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'open-chat' && typeof event.data.chatId === 'string') selectChat(event.data.chatId);
  });
  function clearUnread() { if (!document.hidden && document.hasFocus()) { unread = 0; document.title = 'Phoenix'; } }
  window.addEventListener('focus', clearUnread); document.addEventListener('visibilitychange', clearUnread);
  preference();
  return {
    read: clearUnread,
    update(chats, activeChat) {
      const ids = new Set(chats.map(chat => chat.id));
      const removed = new Set([...seen.keys()].filter(id => !ids.has(id)));
      for (const id of removed) seen.delete(id);
      if (registration && removed.size) registration.getNotifications().then(items => items.filter(item => removed.has(item.data?.chatId)).forEach(item => item.close())).catch(() => {});
      for (const chat of chats) {
        const previous = seen.get(chat.id);
        const next = { notice: chat.notice?.id, approval: chat.approval };
        seen.set(chat.id, next);
        if (!initialized) continue;
        const approval = next.approval && next.approval !== previous?.approval;
        const reply = next.notice && next.notice !== previous?.notice;
        if (!(approval || reply) || chat.id === activeChat && !document.hidden && document.hasFocus()) continue;
        document.title = `(${++unread}) Phoenix`;
        const epoch = generation;
        if (enabled && Notification.permission === 'granted') worker().then(worker => {
          const current = seen.get(chat.id);
          if (epoch !== generation || !enabled || !current || current.notice !== next.notice || current.approval !== next.approval) return;
          return worker.showNotification('Phoenix', {
          body: approval ? 'Your agent needs your approval.' : chat.notice?.type === 'error' ? 'A task needs your attention.' : 'Your agent has a new reply.',
          tag: `phoenix-${chat.id}`, icon: '/bird.svg', data: { chatId: chat.id, epoch },
          }).then(async () => {
            if (epoch !== generation || !enabled || !seen.has(chat.id)) for (const item of await worker.getNotifications()) if (item.tag === `phoenix-${chat.id}` && item.data?.epoch === epoch) item.close();
          });
        }).catch(() => { if (epoch === generation) status.textContent = 'Your browser could not display a notification.'; });
      }
      initialized = true;
    },
    reset() {
      generation++; seen.clear(); initialized = false; unread = 0; document.title = 'Phoenix';
      if (registration) registration.getNotifications().then(items => items.forEach(item => item.close())).catch(() => {});
    },
  };
};
