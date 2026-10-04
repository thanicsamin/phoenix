self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  if (typeof chatId !== 'string' || !/^(main|[0-9a-f-]{36})$/.test(chatId)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (client) { await client.focus(); client.postMessage({ type: 'open-chat', chatId }); }
    else await self.clients.openWindow(`/?chat=${encodeURIComponent(chatId)}`);
  })());
});
