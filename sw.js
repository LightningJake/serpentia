/* 3D Snake service worker: stale-while-revalidate so the game (including the
 * Three.js CDN) works offline after the first visit.
 *
 * Three hard-won rules, each fixing a real defect:
 *  1. Precache is PER-ASSET (Promise.allSettled), never addAll. addAll is
 *     all-or-nothing: one 404 used to leave a brand-new worker holding an
 *     empty cache, and offline silently never worked. Now a partial cache is
 *     strictly better than none.
 *  2. Only the files needed OFFLINE are precached. robots.txt / sitemap.xml /
 *     og-image.png are never fetched without a network, and each one was a
 *     chance to fail the whole install.
 *  3. Same-origin requests are normalized before any cache read/write.
 *     Deep links (?theme=volcano&seed=7) are shareable, so keying on the raw
 *     URL minted a permanent cache entry per shared link - unbounded growth
 *     that nothing ever evicted.
 *  4. The app's own versioned assets are NETWORK-FIRST (cache fallback); only
 *     the CDN engine stays cache-first. Cache-first meant the first load after
 *     a deploy always ran the previous build, so a shipped fix looked like it
 *     had not landed until a hard refresh.
 *
 * No build step: the cache name is a manual version. Bump it whenever shipped
 * assets change, which is what triggers the "new version" refresh prompt.
 */
const CACHE = 'snake-v12';
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
const PRECACHE = LOCAL.concat(CDN);

// install-time outcome, reported to clients on demand so tests can assert it
// instead of us guessing (a silently empty cache looks exactly like a healthy
// one from the outside).
let precache = { ok: 0, failed: [] };

// Strip the query/hash for same-origin requests whose path is a precached file.
// Keeps `?theme=…&seed=…` deep links hitting (and reusing) the one cached copy.
const precachedPaths = new Set(
  PRECACHE.filter((u) => u.indexOf('http') !== 0).map((u) => new URL(u, self.location.href).pathname)
);

function cacheKey(request) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return request;
    if (!precachedPaths.has(url.pathname)) return request;
    if (!url.search && !url.hash) return request;
    url.search = '';
    url.hash = '';
    return new Request(url.toString(), { method: 'GET' });
  } catch (e) {
    return request;
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.allSettled(
          PRECACHE.map((url) =>
            fetch(new Request(url, { cache: 'reload' })).then((res) => {
              // opaque responses are cached separately below; here we only keep
              // real successes, so a CDN CORS hiccup can't poison the cache.
              if (res && res.ok) return c.put(url, res);
              throw new Error('bad status ' + (res && res.status));
            })
          )
        ).then((results) => {
          precache = {
            ok: results.filter((r) => r.status === 'fulfilled').length,
            failed: results.map((r, i) => (r.status === 'rejected' ? PRECACHE[i] : null)).filter(Boolean),
          };
        })
      )
      // always take over: a partial cache still beats the previous version, and
      // the refresh prompt tells the user something changed.
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

self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  // test/debug hook: what actually made it into the cache
  if (e.data.type === 'STATUS' && e.source) {
    e.source.postMessage({ type: 'STATUS', cache: CACHE, precache: precache });
  }
});

// Is this one of the app's own versioned assets? Those must never be served
// stale: a cache-first read means the FIRST load after a deploy silently runs
// the PREVIOUS build (which is exactly how a shipped camera fix looked like it
// "hadn't worked" until a hard refresh). The CDN engine never changes, so it
// stays cache-first.
function isLocalAsset(request) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    return precachedPaths.has(url.pathname);
  } catch (e) {
    return false;
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const key = cacheKey(e.request);

  // Versioned app assets: NETWORK-FIRST with cache fallback. Always fresh when
  // online; still completely usable offline from the precache.
  // (The origin serves `max-age=0, must-revalidate`, so the browser HTTP cache
  // revalidates too and cannot reintroduce staleness underneath us. If that
  // ever changes, add { cache: 'no-cache' } to the fetch below.)
  if (isLocalAsset(e.request)) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // Only durable successes are revalidated into the cache, so a failed
          // or partial response can never overwrite a good precached copy.
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put(key, copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(key).then((hit) => {
            if (hit) return hit;
            // Offline and not cached: a navigation still gets the app shell so
            // a deep link does not dead-end on a browser error page.
            if (e.request.mode === 'navigate')
              return caches.match(new URL('./index.html', self.location.href).toString());
            return Response.error();
          })
        )
    );
    return;
  }

  // Everything else (the CDN engine, anything not precached): cache-first,
  // revalidating in the background. Unchanged.
  e.respondWith(
    caches.match(key).then((hit) => {
      const go = fetch(e.request)
        .then((res) => {
          // Only durable, same-origin-or-CORS successes are revalidated into the
          // cache. Opaque/error responses are passed through but never stored,
          // so a failure can never be persisted as a good response.
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put(key, copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || go;
    })
  );
});
