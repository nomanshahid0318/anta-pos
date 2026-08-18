// ANTA POS service worker — makes the app itself (HTML/CSS/JS) load with
// zero internet, so a cashier can open POS and see the offline sales
// queue / cached catalog even with no connection at all. API calls are
// intentionally left alone here — offline handling for sales/catalog data
// lives in app.js (see the offline sales queue), since caching POST
// requests isn't meaningful and live data should always win when it's
// reachable.
const CACHE_NAME = 'anta-pos-shell-v7';
const APP_SHELL = [
  '/pos/',
  '/css/styles.css',
  '/js/app.js?v=20260810h',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
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

  // API calls: always go straight to the network. Never intercepted here.
  if (url.pathname.startsWith('/api/')) return;

  // Loading the POS page itself: try network first (latest version when
  // online), fall back to the cached shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match('/pos/'))
    );
    return;
  }

  // Static assets (css/js/icons): serve from cache instantly, refresh the
  // cache in the background when online.
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
