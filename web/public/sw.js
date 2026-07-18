// RT-099 — PWA service worker. This app is entirely session/API-driven
// (agent chat, budgets, approvals, ...), so the caching strategy is
// deliberately conservative: only static, content-hashed build assets and
// the app shell are cached. API calls (/v1/*) are always network-only —
// caching those would risk showing stale budgets/approvals/chat history,
// which is worse than a failed offline request.
const CACHE_VERSION = 'o2n-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/');
}

function isStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/') || url.pathname === '/manifest.json' || url.pathname.startsWith('/icon-');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || url.origin !== self.location.origin || isApiRequest(url)) {
    return; // network passthrough — never intercept API calls or mutations
  }

  if (isStaticAsset(url)) {
    // Content-hashed by Next.js (or rarely-changing icons) — safe to serve
    // from cache first, falling back to network and populating the cache.
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(event.request).then(
          (cached) =>
            cached ||
            fetch(event.request).then((response) => {
              if (response.ok) cache.put(event.request, response.clone());
              return response;
            }),
        ),
      ),
    );
    return;
  }

  // Page navigations: network-first so signed-in users always see fresh
  // data when online; cache is only a fallback for the offline case.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
