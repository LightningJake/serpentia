/* 3D Snake service worker: cache-first so the game (including the
 * Three.js CDN) works offline after the first visit. */
const CACHE = 'snake-v1';
const LOCAL = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './logic.js',
  './i18n.js',
  './manifest.json',
  './icon.svg',
];
const CDN = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/0.149.0/three.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(LOCAL.concat(CDN)))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const go = fetch(e.request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put(e.request, copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || go;
    })
  );
});
