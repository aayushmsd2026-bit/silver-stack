/* Offline support: network-first for everything on this site, with the cache as the offline fallback.
   Requests revalidate with the server (cache: 'no-cache') so a new release shows up on the next
   launch instead of waiting out GitHub Pages' 10-minute browser cache. */
const VERSION = 'stack-v10';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/charts.js', 'js/cloud.js', 'js/firebase-config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isData = url.pathname.includes('/data/');
  const key = isData ? new Request(url.origin + url.pathname) : e.request;
  // A navigation request can't be re-issued with new options, so rebuild it from its URL.
  const req = new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' });
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
