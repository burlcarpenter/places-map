// Service worker: app shell precache + opportunistic map-tile caching.
//
// Offline behaviour, honestly stated:
//   - App shell, category data, and your places (IndexedDB) work fully offline.
//   - Map tiles only work offline for areas you have already looked at, because
//     they are fetched on demand from Carto and cached as they arrive. Panning
//     somewhere new while offline shows blank tiles.
//   - GitHub API calls are never cached; a refresh while offline fails cleanly
//     and the app keeps showing cached places.

const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const TILES = `tiles-${VERSION}`;
const TILE_LIMIT = 900;

const SHELL_ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/sync.js',
  './js/categories.js',
  './data/categories.json',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll is all-or-nothing; add individually so one CDN hiccup cannot
    // abort the whole install and leave the app uninstallable.
    await Promise.all(SHELL_ASSETS.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(() => {})
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, TILES]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
}

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the data API — a stale places file would be worse than an error.
  if (url.hostname === 'api.github.com') return;

  // Basemap style, glyphs, sprites and tiles: serve from cache, fill in behind.
  if (url.hostname.endsWith('cartocdn.com')) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) { cache.put(request, res.clone()); trimCache(TILES, TILE_LIMIT); }
        return res;
      } catch {
        return new Response('', { status: 504, statusText: 'Offline: tile not cached' });
      }
    })());
    return;
  }

  // App shell: network first, cache as fallback. Cache-first would keep serving
  // stale code after every edit, which is intolerable while the app is still
  // being built. Offline still works — the cache is written on every success.
  e.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res.ok && (url.origin === location.origin || url.hostname === 'unpkg.com')) {
        const cache = await caches.open(SHELL);
        cache.put(request, res.clone());
      }
      return res;
    } catch {
      const hit = await caches.match(request);
      if (hit) return hit;
      if (request.mode === 'navigate') {
        return (await caches.match('./index.html')) ?? Response.error();
      }
      return Response.error();
    }
  })());
});
