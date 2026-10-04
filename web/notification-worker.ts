/// <reference lib="webworker" />
const workerScope = self as unknown as ServiceWorkerGlobalScope;
workerScope.addEventListener('install', event => event.waitUntil(workerScope.skipWaiting()));
workerScope.addEventListener('activate', event => event.waitUntil(workerScope.clients.claim()));
workerScope.addEventListener('notificationclick', event => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  if (typeof chatId !== 'string' || !/^(main|[0-9a-f-]{36})$/.test(chatId)) return;
  event.waitUntil((async () => {
    const windows = await workerScope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(client => new URL(client.url).origin === workerScope.location.origin);
    if (client) { await client.focus(); client.postMessage({ type: 'open-chat', chatId }); }
    else await workerScope.clients.openWindow(`/?chat=${encodeURIComponent(chatId)}`);
  })());
});

export {};
