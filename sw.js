// Service Worker pro Stopovačku (100% offline provoz v terénu na iPhone / Android / Desktop)
const CACHE_NAME = 'stopovacka-v14';

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

  // Network-first s fallbackem na cache: online vždy konzistentní nová verze (žádné rozbití mezi index.html a JS moduly),
  // offline v terénu spolehlivě funguje z mezipaměti.
  event.respondWith(
    fetch(event.request).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
      }
      return networkResponse;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});
