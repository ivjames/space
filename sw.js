const CACHE_NAME = 'space-v1';

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
  'js/core/tree.js',
  'js/core/economy.js',
  'js/core/contracts.js',
  'js/core/state.js',
  'js/core/save.js',
  'js/data/components.js',
  'js/data/tree.js',
  'js/data/missions.js',
  'js/ui/ascent.js',
  'js/ui/shop.js',
  'js/ui/hud.js',
  'js/ui/screens.js',
];

// Install: precache app shell and core modules
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Use Promise.allSettled so a missing module doesn't break install
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          fetch(url).then(response => {
            if (response.ok) {
              return cache.put(url, response);
            }
            // Network error or non-2xx response; skip this file
            return Promise.resolve();
          }).catch(() => {
            // Network fetch failed; skip this file
            return Promise.resolve();
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(name => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: stale-while-revalidate for same-origin GET. The cached copy is
// served immediately (offline works), and the network copy refreshes the
// cache in the background, so a deploy is live on the *next* load without a
// cache-name bump. First-time requests go to the network.
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== location.origin) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(request).then(cached => {
        const refresh = fetch(request).then(response => {
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        }).catch(() => cached);
        return cached || refresh;
      })
    )
  );
});
