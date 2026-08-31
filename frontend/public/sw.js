/* Service worker mínimo de FIREtech RAG.
   - /api/*: NUNCA se intercepta ni se cachea (incluye streams SSE).
   - Navegaciones: network-first con copia en caché como fallback offline.
   - /assets/* (hasheados por Vite): cache-first, inmutables.
   - activate: limpia caches de versiones anteriores. */

const VERSION = 'firetech-v1';
const PAGES = `${VERSION}-pages`;
const ASSETS = `${VERSION}-assets`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API y SSE: directo a la red, sin tocar. Jamás en caché.
  if (url.pathname.startsWith('/api')) return;

  // Navegaciones: red primero; si falla, la última copia buena. Solo se
  // cachean respuestas OK: una página de error (500 de Vercel, etc.) no
  // debe quedar como "última copia buena" para el modo offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/', { cacheName: PAGES })),
    );
    return;
  }

  // Assets hasheados: caché primero, red como relleno.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req, { cacheName: ASSETS }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
