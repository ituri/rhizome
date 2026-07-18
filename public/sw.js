/* Rhizome service worker — offline shell cache.
   Shell renders from cache instantly (so a browser-unloaded tab doesn't flash grey
   on return); the network refreshes the cache in the background. */
'use strict';

const CACHE = 'rhizome-shell-v7';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/app2.js', '/pages.js', '/serialize-worker.js',
  '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;

  // Versioned assets (…?v=N) are immutable — serve straight from cache once stored.
  const immutable = url.searchParams.has('v');

  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request);
    if (cached && immutable) return cached;

    const fromNetwork = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => null);

    // stale-while-revalidate: cached now, refreshed for next time
    if (cached) { fromNetwork.catch(() => {}); return cached; }
    return (await fromNetwork) || cache.match('/index.html');
  }));
});
