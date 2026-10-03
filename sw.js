// =============================================================
// Service worker - what lets the app be installed on a phone's home screen.
// Every request goes to the network first, so an update is seen at once; the
// copy kept here is used only when there is no connection, so the app still
// opens (with the data it last showed) on a site with no signal.
// Data from Supabase and photo links are never kept: they are always live.
// =============================================================
const CACHE = 'cpmg-pm-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only the app's own files (and the libraries it loads) are kept for offline.
  const own = url.origin === self.location.origin;
  const library = /^(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|cdn\.tailwindcss\.com|fonts\.(googleapis|gstatic)\.com)$/.test(url.hostname);
  if (!own && !library) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      if (fresh.ok) (await caches.open(CACHE)).put(request, fresh.clone());
      return fresh;
    } catch {
      const kept = await caches.match(request);
      if (kept) return kept;
      throw new Error('offline');
    }
  })());
});
