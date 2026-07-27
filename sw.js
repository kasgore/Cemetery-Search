/* Cemetery Search — service worker: precache app shell + data for full offline use.
   Strategy: cache-first for instant offline loads, with background revalidation so
   deploys reach users on their next visit without a cache-name bump. */
const CACHE = 'cemsearch-v2';
const ASSETS = [
  './',
  './index.html',
  './app-core.js',
  './app-map.js',
  './app-ui.js',
  './oakgrove-data.js',
  './xlsx.full.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // cache assets individually so one miss doesn't abort the whole install
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // same-origin: stale-while-revalidate (serve cache instantly, refresh in background)
  if (url.origin === location.origin) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request, { ignoreSearch: url.pathname.endsWith('/') }).then(hit => {
          const net = fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => hit);
          return hit || net;
        })
      ).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // fonts: stale-while-revalidate; accept opaque responses so the CSS caches too
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(hit => {
          const net = fetch(e.request).then(res => {
            if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
            return res;
          }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
