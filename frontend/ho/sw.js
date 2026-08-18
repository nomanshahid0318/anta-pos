// ANTA HO service worker — caches the HO panel's app shell (HTML/CSS/JS)
// so it still loads with zero internet. Unlike POS, HO does NOT queue
// offline writes (GRN, sales data, financial entries) — those all touch
// shared company-wide data and queuing them offline risks conflicting
// updates from multiple admins. This only makes the app itself openable
// offline; every actual save still requires a live connection, same as
// before.
const CACHE_NAME = 'anta-ho-shell-v3';
const APP_SHELL = [
  '/ho/',
  '/ho/css/styles.css',
  '/ho/js/app.js?v=20260810d',
  '/ho/manifest.json',
  '/ho/icon-192.png',
  '/ho/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls always go straight to the network — never cached/queued
  // here. HO writes need to be live.
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match('/ho/'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
