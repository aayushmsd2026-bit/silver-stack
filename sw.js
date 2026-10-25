/* Offline support: app shell is cached; rate data is network-first with cache fallback. */
const VERSION = 'stack-v6';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/charts.js', 'js/cloud.js', 'js/firebase-config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isData = url.pathname.includes('/data/');
  // Network-first for data and code so updates show up immediately; cache is the offline fallback.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        const key = isData ? new Request(url.origin + url.pathname) : e.request;
        caches.open(VERSION).then(c => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(isData ? new Request(url.origin + url.pathname) : e.request, { ignoreSearch: true }))
  );
});
