// Service worker. The cache name IS the update mechanism.
//
// `space deploy` stamps the deployed commit into CACHE_NAME below (the same
// way it stamps BUILD into index.html), so every deploy ships a byte-different
// sw.js. The browser re-fetches sw.js on every load (the vhost serves it
// no-cache), a changed worker installs, precaches the whole app under the new
// name with the browser's HTTP cache bypassed, activates, and takes over the
// open pages -- which then show "Update ready" (index.html). One request per
// load when nothing changed; one full download per deploy. Everything a page
// runs comes from one cache, so one deploy, never a mix.
//
// Unstamped ('space-dev', a checkout that was not deployed) the worker is
// network-first instead, so local work never serves a stale file; cache-first
// with a name that never changes would.
//
// The stamp pattern is a contract with bin/space (its sed is anchored to
// this exact declaration line) and test/sw.test.js pins it.
const CACHE_NAME = 'space-dev';
const DEV = CACHE_NAME === 'space-dev';

// Every file the app loads. Under cache-first, a same-origin file missing
// from this list is fetched from the network on first use and cached from
// there, through the browser's own heuristic HTTP cache -- which is exactly
// how a page ends up running two builds at once. test/sw.test.js checks
// every js/ module is here.
const PRECACHE_URLS = [
  './',
  'index.html',
  'css/style.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/main.js',
  'js/core/rng.js',
  'js/core/vehicle.js',
  'js/core/resolver.js',
  'js/core/orbit.js',
  'js/core/moon.js',
  'js/core/tree.js',
  'js/core/economy.js',
  'js/core/contracts.js',
  'js/core/state.js',
  'js/core/save.js',
  'js/data/components.js',
  'js/data/tree.js',
  'js/data/missions.js',
  'js/ui/ascent.js',
  'js/ui/map.js',
  'js/ui/surface.js',
  'js/ui/shop.js',
  'js/ui/hud.js',
  'js/ui/screens.js',
];

// Install: precache the whole app, all or nothing. `cache: 'reload'` makes
// every fetch go to the server rather than the HTTP cache, so the new cache
// holds the deployed files and not whatever the browser had lying around.
// If any file fails, install fails and the previous worker keeps serving its
// own complete build; the browser retries on the next sw.js check.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      ))
      .then(() => self.skipWaiting()),
  );
});

// Activate: drop every other build's cache and take over open pages now,
// which fires `controllerchange` in them (index.html shows the prompt).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// Fetch, same-origin GET only. Deployed: cache-first, and a miss (a file not
// in PRECACHE_URLS) is fetched and kept for this build. Dev: network-first
// with the HTTP cache told to revalidate, falling back to the cache offline.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (DEV) {
        try {
          const fresh = await fetch(request, { cache: 'no-cache' });
          if (fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          if (cached) return cached;
          throw err;
        }
      }
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }),
  );
});
