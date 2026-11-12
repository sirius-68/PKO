// Offline app shell for the web (PWA) build. Content and media are cached on use;
// the API bundle is always fetched fresh first and falls back to cache when offline.
const SHELL = 'pko-shell-v1';
const RUNTIME = 'pko-runtime-v1';
const ASSETS = ['./', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest', 'icons/logo.webp', 'icons/icon-192.png',
  'js/main.js', 'js/lib.js', 'js/api.js', 'js/store.js', 'js/native.js', 'js/ui.js', 'js/views.js', 'js/media.js', 'js/pages.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, RUNTIME].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/live/') || req.headers.has('range')) return; // streams and video ranges go straight to network
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  if (url.pathname.startsWith('/media/') && /\.(webp|jpg|png|gif|avif)$/.test(url.pathname)) {
    e.respondWith(caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === location.origin) {
    // network-first for the shell so updates land immediately
    e.respondWith(fetch(req).then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone())); return res; }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
  }
});
