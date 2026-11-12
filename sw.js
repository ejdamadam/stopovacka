// Service Worker pro Stopovačku (100% offline provoz v terénu na iPhone / Android / Desktop)
const CACHE_NAME = 'stopovacka-v3';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/leaflet.css',
  './css/images/layers.png',
  './css/images/layers-2x.png',
  './css/images/marker-icon.png',
  './js/vendor/cv.js',
  './js/vendor/aruco.js',
  './js/vendor/leaflet.js',
  './js/app.js',
  './js/ui/sheet.js',
  './js/ui/mapPicker.js',
  './js/ui/evaluate.js',
  './js/core/geo.js',
  './js/core/layout.js',
  './js/core/markers.js',
  './js/core/homography.js',
  './js/core/color.js',
  './js/core/edt.js',
  './js/core/gpx.js',
  './js/core/evaluate.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Požadavky třetích stran (např. online dlaždice mapy)
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response('', { status: 408, statusText: 'Offline tile' });
      })
    );
    return;
  }

  // Cache-first se stale-while-revalidate pro lokální aplikační soubory
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Na pozadí zkusíme stáhnout novější verzi, pokud je síť dostupná
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {
          // Běh v offline režimu – ignorujeme chybu sítě
        });
        return cachedResponse;
      }

      // Není v cache, stáhneme a uložíme
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});
