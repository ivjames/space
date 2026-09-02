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

// Fetch: cache-first for same-origin GET, fallback to network
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only cache same-origin GET requests
  if (request.method !== 'GET' || url.origin !== location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then(response => {
      // Return cached response if available
      if (response) {
        return response;
      }
      // Fall back to network
      return fetch(request).then(response => {
        // Only cache successful same-origin responses
        if (response.ok && url.origin === location.origin) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseToCache);
          });
        }
        return response;
      });
    }).catch(() => {
      // Network error; return cached response or offline fallback
      return caches.match(request);
    })
  );
});
