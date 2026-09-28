// Keeps the app working offline. The build prepends FILES (every file it
// wrote) and CACHE (named from their contents, so each deploy gets its own).
/* global FILES, CACHE */

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Pages come from the network when it answers, so a new deploy shows at once;
// the cached page, whatever its query, stands in offline. Everything else is
// named by content or fixed, so the cache answers first. Module scripts send\n// an Origin header, which would miss entries cached without one if the server\n// varies on it.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./', { cacheName: CACHE })
      .then((cached) => cached ?? Response.error())));
    return;
  }
  event.respondWith(caches.match(request, { cacheName: CACHE, ignoreSearch: true, ignoreVary: true })
    .then((cached) => cached ?? fetch(request)));
});