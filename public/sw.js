// Offline cache for the installed PWA: stale-while-revalidate over the static
// assets, so the editor opens instantly and works with no network. CI stamps
// __BUILD__ with the deploy's commit hash: each deploy precaches a complete
// fresh set and drops the old cache on activate, so assets can never mix
// across versions.
const CACHE = 'thr10-editor-__BUILD__';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/midi.js',
  './js/panel.js',
  './js/protocol.js',
  './js/library.js',
  './icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // no-cache: precache this deploy's actual bytes, not stale HTTP-cache hits
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const cached = caches.match(e.request, { ignoreSearch: true });
  const fetched = fetch(e.request).then(res => {
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy)));
    }
    return res;
  });
  // waitUntil: without it the browser may kill the worker as soon as the
  // cached response is delivered, losing (or half-applying) the refresh.
  e.waitUntil(fetched.then(() => {}, () => {}));
  e.respondWith(cached.then(hit => hit || fetched.catch(() => hit)));
});
