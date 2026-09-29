// Service worker: permite instalar la página como app y recibir notificaciones push.
const CACHE = 'fletes-v7';
const SHELL = ['/login.html', '/chofer.html', '/cliente.html', '/admin.html', '/css/app.css', '/js/common.js', '/js/driver.js', '/js/shipment.js', '/js/client.js', '/js/admin.js', '/js/admin-payments.js', '/js/admin-site.js', '/js/maps.js', '/icons/favicon.png', '/img/logo.png', '/icons/icon-192.png', '/icons/badge-72.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero; si no hay señal se muestra la última versión guardada de la página.
// La API nunca se guarda en caché (los viajes siempre deben estar al día).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Aviso', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Nuevo aviso', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: data.tag,
        renotify: Boolean(data.tag),
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300],
        data: { url: data.url || '/' },
      }),
      // Avisa a las pestañas abiertas para que recarguen la lista.
      self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage({ type: 'push' }))),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).pathname === new URL(target).pathname && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
