// Shows the site's alerts on phones, where a page can't raise notifications itself, and brings
// the site forward when one is tapped. It does nothing else: no caching, no handling of requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((tabs) => (tabs.length ? tabs[0].focus() : self.clients.openWindow(self.registration.scope))),
  );
});
